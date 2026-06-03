import { mkdtempSync, rmSync } from "node:fs";
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
});
