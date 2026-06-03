import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { AgentAdapter } from "./adapters/types.js";
import type { Context, NodeCtx } from "./context.js";
import { appendTurnEvent } from "./events.js";
import { ask } from "./ops.js";
import { sendLiteral } from "./tmux.js";

vi.mock("./tmux.js", () => ({
  sendEnter: vi.fn(async () => undefined),
  sendLiteral: vi.fn(async () => undefined),
}));

let tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs = [];
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "grove-ask-test-"));
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
      text: `read ${path} from ${offset}`,
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
        },
      },
    },
  };

  return { ctx, nc };
}

describe("ask compatibility", () => {
  afterEach(() => {
    vi.mocked(sendLiteral).mockReset();
  });

  test("falls back to transcript scanning when no durable event exists", async () => {
    const { ctx, nc } = makeNodeCtx("/tmp/grove-test/current.jsonl");

    const result = await ask(ctx, nc, "hello", 10, {
      eventLogDir: tempDir(),
    });

    expect(result).toBe("read /tmp/grove-test/current.jsonl from 10");
    expect(ctx.registry.nodes.worker?.pending).toBeUndefined();
  });

  test("captures event log offset before submit so ask catches fast durable completions", async () => {
    const eventLogDir = tempDir();
    const { ctx, nc } = makeNodeCtx("/tmp/grove-test/current.jsonl");
    nc.adapter.readCompletionSince = (_path: string, offset: number) => ({
      done: false,
      offset,
    });
    vi.mocked(sendLiteral).mockImplementation(async () => {
      appendTurnEvent(eventLogDir, {
        schema: 1,
        type: "turn.done",
        node: "worker",
        turnId: "worker:session-current:22",
        transcriptId: "session-current",
        transcriptOffset: 22,
        marker: "completion@22",
        ts: 1_781_000_000_000,
        nonce: "worker-session-current-22",
        status: "done",
        summary: "fast durable completion",
      });
    });

    const result = await ask(ctx, nc, "hello", 0, { eventLogDir });

    expect(result).toBe("fast durable completion");
    expect(ctx.registry.nodes.worker?.pending).toBeUndefined();
  });
});
