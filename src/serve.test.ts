import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, test } from "vitest";

import { createGroveChatServer, type GroveFacadeRuntime, StickySessionPool } from "./serve.js";

interface RuntimeCall {
  nodeName: string;
  prompt: string;
  timeoutMs: number;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

const servers: ReturnType<typeof createGroveChatServer>[] = [];

afterEach(async () => {
  while (servers.length > 0) {
    const server = servers.pop()!;
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }
});

function deferred<T>(): Deferred<T> {
  let resolve: Deferred<T>["resolve"] = () => {
    throw new Error("deferred resolve called before initialization");
  };
  let reject: Deferred<T>["reject"] = () => {
    throw new Error("deferred reject called before initialization");
  };
  const promise = new Promise<T>((resolve_, reject_) => {
    resolve = resolve_;
    reject = reject_;
  });
  return { promise, resolve, reject };
}

async function listen(runtime: GroveFacadeRuntime, nodeNames: string[]): Promise<string> {
  const server = createGroveChatServer({
    nodeNames,
    runtime,
    timeoutMs: 1234,
  });
  servers.push(server);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

async function readResponseText(response: Response): Promise<string> {
  return await response.text();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function ssePayloads(text: string): string[] {
  return text
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => line.slice("data: ".length));
}

function decodeChunk(value: unknown, opts?: { stream?: boolean }): string {
  if (!(value instanceof Uint8Array)) {
    throw new Error("expected a Uint8Array stream chunk");
  }
  return new TextDecoder().decode(value, opts);
}

function parsePayload(payload: string): unknown {
  return JSON.parse(payload) as unknown;
}

describe("grove chat completions facade", () => {
  test("does not store anonymous sessions and bounds sticky sessions by LRU and TTL", () => {
    let now = 0;
    const pool = new StickySessionPool(["maker-a", "maker-b", "maker-c"], {
      maxStickySessions: 2,
      nowMs: () => now,
      stickyTtlMs: 50,
    });

    expect(pool.nodeFor(null)).toBe("maker-a");
    expect(pool.nodeFor(null)).toBe("maker-b");
    expect(pool.stickySize()).toBe(0);

    expect(pool.nodeFor("channel-1")).toBe("maker-c");
    expect(pool.nodeFor("channel-2")).toBe("maker-a");
    expect(pool.stickySize()).toBe(2);
    expect(pool.nodeFor("channel-1")).toBe("maker-c");
    expect(pool.nodeFor("channel-3")).toBe("maker-b");
    expect(pool.stickySize()).toBe(2);
    expect(pool.nodeFor("channel-2")).toBe("maker-c");

    now = 100;
    expect(pool.nodeFor("channel-1")).toBe("maker-a");
  });

  test("streams OpenAI-compatible SSE chunks for a grove turn", async () => {
    const calls: RuntimeCall[] = [];
    const runtime: GroveFacadeRuntime = {
      async runTurn(nodeName, prompt, timeoutMs) {
        calls.push({ nodeName, prompt, timeoutMs });
        return "facade response";
      },
    };
    const baseUrl = await listen(runtime, ["maker-a"]);

    const response = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Grove-Session-Id": "channel-1",
      },
      body: JSON.stringify({
        model: "grove-cockpit",
        stream: true,
        messages: [
          { role: "system", content: "Use grove." },
          { role: "user", content: "Ship S1b." },
        ],
      }),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const payloads = ssePayloads(await readResponseText(response));

    expect(payloads.at(-1)).toBe("[DONE]");
    const chunks = payloads.slice(0, -1).map((payload) => JSON.parse(payload) as unknown);
    expect(chunks).toEqual([
      expect.objectContaining({
        object: "chat.completion.chunk",
        model: "grove-cockpit",
        choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
      }),
      expect.objectContaining({
        object: "chat.completion.chunk",
        choices: [{ index: 0, delta: { content: "facade response" }, finish_reason: null }],
      }),
      expect.objectContaining({
        object: "chat.completion.chunk",
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      }),
    ]);
    expect(calls).toEqual([
      {
        nodeName: "maker-a",
        prompt: "system: Use grove.\nuser: Ship S1b.",
        timeoutMs: 1234,
      },
    ]);
  });

  test("keeps X-Grove-Session-Id sticky to the same grove node", async () => {
    const calls: RuntimeCall[] = [];
    const runtime: GroveFacadeRuntime = {
      async runTurn(nodeName, prompt, timeoutMs) {
        calls.push({ nodeName, prompt, timeoutMs });
        return `${nodeName} answered`;
      },
    };
    const baseUrl = await listen(runtime, ["maker-a", "maker-b"]);

    for (const sessionId of ["channel-1", "channel-2", "channel-1"]) {
      const response = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Grove-Session-Id": sessionId,
        },
        body: JSON.stringify({
          model: "grove-cockpit",
          stream: false,
          messages: [{ role: "user", content: sessionId }],
        }),
      });
      expect(response.status).toBe(200);
      await readResponseText(response);
    }

    expect(calls.map((call) => call.nodeName)).toEqual(["maker-a", "maker-b", "maker-a"]);
  });

  test("keeps the SSE stream open until the grove turn resolves", async () => {
    const turn = deferred<string | null>();
    const runtime: GroveFacadeRuntime = {
      async runTurn() {
        return await turn.promise;
      },
    };
    const baseUrl = await listen(runtime, ["maker-a"]);

    const response = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Grove-Session-Id": "channel-1",
      },
      body: JSON.stringify({
        model: "grove-cockpit",
        stream: true,
        messages: [{ role: "user", content: "wait for completion" }],
      }),
    });
    expect(response.body).not.toBeNull();
    const reader = response.body!.getReader();

    const first = await reader.read();
    expect(first.done).toBe(false);
    expect(decodeChunk(first.value)).toContain('"role":"assistant"');

    let finished = false;
    const rest = (async (): Promise<string> => {
      let text = "";
      for (;;) {
        const item = await reader.read();
        if (item.done) {
          finished = true;
          return text;
        }
        text += decodeChunk(item.value, { stream: true });
      }
    })();

    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(finished).toBe(false);

    turn.resolve("turn complete");
    const text = await rest;

    expect(finished).toBe(true);
    expect(text).toContain('"content":"turn complete"');
    expect(text).toContain("data: [DONE]");
  });

  test("streams an OpenAI-compatible error and closes cleanly when the grove turn fails", async () => {
    const runtime: GroveFacadeRuntime = {
      async runTurn() {
        throw new Error("/Users/chopin/dev/grove/secret internal state");
      },
    };
    const baseUrl = await listen(runtime, ["maker-a"]);

    const response = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Grove-Session-Id": "channel-err",
      },
      body: JSON.stringify({
        model: "grove-cockpit",
        stream: true,
        messages: [{ role: "user", content: "fail" }],
      }),
    });

    expect(response.status).toBe(200);
    const payloads = ssePayloads(await readResponseText(response));
    expect(payloads.at(-1)).toBe("[DONE]");
    expect(parsePayload(payloads[1]!)).toEqual({
      error: {
        code: "grove_turn_failed",
        message: "grove turn failed",
        type: "grove_error",
      },
    });
    expect(parsePayload(payloads[2]!)).toEqual(
      expect.objectContaining({
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      }),
    );
  });

  test("sanitizes non-stream runtime failures", async () => {
    const runtime: GroveFacadeRuntime = {
      async runTurn() {
        throw new Error("/private/internal/path leaked");
      },
    };
    const baseUrl = await listen(runtime, ["maker-a"]);

    const response = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        stream: false,
        messages: [{ role: "user", content: "fail" }],
      }),
    });

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: {
        code: "grove_internal_error",
        message: "grove internal error",
      },
    });
  });

  test("propagates client aborts to the grove runtime and stops writing stream chunks", async () => {
    const aborted = deferred<void>();
    let seenSignal: AbortSignal | undefined;
    const runtime: GroveFacadeRuntime = {
      async runTurn(_nodeName, _prompt, _timeoutMs, signal) {
        seenSignal = signal;
        signal?.addEventListener("abort", () => {
          aborted.resolve();
        });
        await sleep(75);
        return "late content";
      },
    };
    const baseUrl = await listen(runtime, ["maker-a"]);

    const response = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Grove-Session-Id": "channel-abort",
      },
      body: JSON.stringify({
        model: "grove-cockpit",
        stream: true,
        messages: [{ role: "user", content: "abort" }],
      }),
    });
    const reader = response.body!.getReader();
    const first = await reader.read();
    expect(first.done).toBe(false);

    await reader.cancel();
    const didAbort = await Promise.race([
      aborted.promise.then(() => true),
      sleep(100).then(() => false),
    ]);

    expect(didAbort).toBe(true);
    expect(seenSignal?.aborted).toBe(true);
  });

  test("returns explicit 400 for malformed JSON and 413 for oversized bodies", async () => {
    const runtime: GroveFacadeRuntime = {
      async runTurn() {
        return "unused";
      },
    };
    const baseUrl = await listen(runtime, ["maker-a"]);

    const malformed = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{",
    });
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toEqual({ error: "malformed JSON request body" });

    const oversized = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "x".repeat(1024 * 1024 + 1),
    });
    expect(oversized.status).toBe(413);
    expect(await oversized.json()).toEqual({ error: "request body too large" });
  });
});
