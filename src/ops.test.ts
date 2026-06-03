import { appendFileSync, existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import type { AgentAdapter } from "./adapters/types.js";
import type { Context, NodeCtx } from "./context.js";
import { appendTurnEvent } from "./events.js";
import { waitForCompletion } from "./ops.js";

let tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs = [];
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "grove-ops-test-"));
  tempDirs.push(dir);
  return dir;
}

function makeNodeCtx(currentTranscript: string): { ctx: Context; nc: NodeCtx } {
  const adapter = {
    name: "codex",
    label: "Codex",
    submit: "enter",
    readyPattern: /ready/,
    launchCommand: () => "codex",
    transcriptForSession: () => currentTranscript,
    snapshot: () => new Map<string, number>(),
    detectNew: () => null,
    sessionIdFromPath: () => "session-current",
    size: (path: string) => (path === currentTranscript ? 10 : 0),
    readCompletionSince: (path: string, offset: number) => ({
      done: true,
      text: `read ${path}`,
      offset,
    }),
    readLast: () => null,
  } satisfies AgentAdapter;

  const nc: NodeCtx = {
    node: {
      name: "worker",
      agent: "codex",
      cwd: "/tmp/grove-test",
      children: [],
    },
    adapter,
    addr: "grove:worker",
  };

  const ctx: Context = {
    configPath: "/tmp/grove.yaml",
    config: {
      session: "grove-test",
      cwd: "/tmp/grove-test",
      defaults: { agent: "codex" },
      nodes: {
        worker: {
          agent: "codex",
          children: [],
        },
      },
    },
    nodes: [nc.node],
    byName: new Map([["worker", nc]]),
    registry: {
      session: "grove-test",
      cwd: "/tmp/grove-test",
      updatedAt: "2026-06-03T00:00:00.000Z",
      nodes: {
        worker: {
          name: "worker",
          agent: "codex",
          transcript: currentTranscript,
          pending: {
            transcript: "/tmp/grove-test/old.jsonl",
            fromOffset: 0,
            submittedAt: "2026-06-03T00:00:00.000Z",
          },
        },
      },
    },
  };

  return { ctx, nc };
}

describe("waitForCompletion", () => {
  test("rejects a pending transcript when the resolved transcript moved", async () => {
    const { ctx, nc } = makeNodeCtx("/tmp/grove-test/current.jsonl");
    const opts = {
      timeoutMs: 10,
      fromOffset: 0,
      transcript: "/tmp/grove-test/old.jsonl",
    };

    await expect(waitForCompletion(ctx, nc, opts)).rejects.toThrow(
      "transcript stale — run fleet repair",
    );
  });

  test("returns a durable completion event that was appended before wait started", async () => {
    const { ctx, nc } = makeNodeCtx("/tmp/grove-test/current.jsonl");
    const eventLogDir = tempDir();
    appendTurnEvent(eventLogDir, {
      schema: 1,
      type: "turn.done",
      node: "worker",
      turnId: "worker:session-current:42",
      transcriptId: "session-current",
      transcriptOffset: 42,
      marker: "completion@42",
      ts: 1_781_000_000_000,
      nonce: "worker-session-current-42",
      status: "done",
      summary: "durable result",
    });

    const result = await waitForCompletion(ctx, nc, {
      timeoutMs: 10,
      fromOffset: 10,
      transcript: "/tmp/grove-test/current.jsonl",
      eventLogOffset: 0,
      eventLogDir,
    });

    expect(result).toBe("durable result");
  });

  test("wakes on transcript append without waiting for the safety interval", async () => {
    const dir = tempDir();
    const transcript = join(dir, "current.jsonl");
    writeFileSync(transcript, "");
    const adapter = {
      name: "codex",
      label: "Codex",
      submit: "enter",
      readyPattern: /ready/,
      launchCommand: () => "codex",
      transcriptForSession: () => transcript,
      snapshot: () => new Map<string, number>(),
      detectNew: () => null,
      sessionIdFromPath: () => "session-current",
      size: (file: string) => (existsSync(file) ? statSync(file).size : 0),
      readCompletionSince: (file: string, offset: number) => {
        const size = existsSync(file) ? statSync(file).size : 0;
        return size > offset
          ? { done: true, offset: size, text: "append result" }
          : { done: false, offset };
      },
      readLast: () => null,
    } satisfies AgentAdapter;
    const nc: NodeCtx = {
      adapter,
      addr: "grove:worker",
      node: {
        agent: "codex",
        children: [],
        cwd: dir,
        name: "worker",
      },
    };
    const ctx: Context = {
      byName: new Map([["worker", nc]]),
      config: {
        cwd: dir,
        defaults: { agent: "codex" },
        nodes: { worker: { agent: "codex", children: [] } },
        session: "grove-test",
      },
      configPath: join(dir, "grove.yaml"),
      nodes: [nc.node],
      registry: {
        cwd: dir,
        nodes: { worker: { agent: "codex", name: "worker", transcript } },
        session: "grove-test",
        updatedAt: "2026-06-03T00:00:00.000Z",
      },
    };
    const started = Date.now();
    setTimeout(() => {
      appendFileSync(transcript, "done\n");
    }, 10);

    const result = await waitForCompletion(ctx, nc, {
      intervalMs: 2000,
      timeoutMs: 5000,
    });

    expect(result).toBe("append result");
    expect(Date.now() - started).toBeLessThan(1000);
  });

  test("fails fast with a repair hint when a bound session transcript is missing", async () => {
    const dir = tempDir();
    const missingTranscript = join(dir, "missing.jsonl");
    const { ctx, nc } = makeNodeCtx(missingTranscript);
    nc.adapter.size = () => 0;
    ctx.registry.nodes.worker = {
      agent: "codex",
      name: "worker",
      sessionId: "session-current",
      transcript: missingTranscript,
    };

    await expect(waitForCompletion(ctx, nc, { timeoutMs: 100 })).rejects.toThrow(
      "session transcript missing",
    );
  });

  test("fails fast with a repair hint when a bound session transcript is empty", async () => {
    const dir = tempDir();
    const emptyTranscript = join(dir, "empty.jsonl");
    writeFileSync(emptyTranscript, "");
    const { ctx, nc } = makeNodeCtx(emptyTranscript);
    nc.adapter.size = () => 0;
    ctx.registry.nodes.worker = {
      agent: "codex",
      name: "worker",
      sessionId: "session-current",
      transcript: emptyTranscript,
    };

    await expect(
      waitForCompletion(ctx, nc, {
        intervalMs: 1000,
        timeoutMs: 10_000,
      }),
    ).rejects.toThrow("session transcript missing");
  });
});
