import { describe, expect, test } from "vitest";
import type { AgentAdapter } from "./adapters/types.js";
import type { Context, NodeCtx } from "./context.js";
import { waitForCompletion } from "./ops.js";

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
});
