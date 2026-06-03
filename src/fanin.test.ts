import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, test } from "vitest";
import type { AgentAdapter } from "./adapters/types.js";
import type { Context, NodeCtx } from "./context.js";
import { appendTurnEvent, type GroveTurnEvent } from "./events.js";
import {
  renderGatherJson,
  renderGatherText,
  waitForFanIn,
} from "./fanin.js";

let tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs = [];
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "grove-fanin-test-"));
  tempDirs.push(dir);
  return dir;
}

function turnEvent(
  node: string,
  transcriptId: string,
  offset: number,
  overrides: Partial<GroveTurnEvent> = {},
): GroveTurnEvent {
  const status = overrides.status ?? "done";
  return {
    schema: 1,
    type: status === "failed" ? "turn.failed" : "turn.done",
    node,
    turnId: `${node}:${transcriptId}:${offset}`,
    transcriptId,
    transcriptOffset: offset,
    marker: `completion@${offset}`,
    ts: 1_781_000_000_000 + offset,
    nonce: `${node}-${transcriptId}-${offset}`,
    status,
    summary: `${node} ${status}`,
    ...overrides,
  };
}

function makeContext(
  nodeNames: string[],
  opts: {
    completions?: Record<string, { text: string; offset: number }>;
  } = {},
): Context {
  const sizes = new Map<string, number>();
  const byName = new Map<string, NodeCtx>();
  const nodes = nodeNames.map((name) => ({
    name,
    agent: "codex" as const,
    cwd: "/tmp/grove-test",
    children: [],
  }));

  for (const node of nodes) {
    const transcript = `/tmp/${node.name}-session.jsonl`;
    sizes.set(transcript, 10);
    const adapter = {
      name: "codex",
      label: "Codex",
      submit: "enter",
      readyPattern: /ready/,
      launchCommand: () => "codex",
      transcriptForSession: () => transcript,
      snapshot: () => new Map<string, number>(),
      detectNew: () => null,
      sessionIdFromPath: (path: string) =>
        path.match(/\/([^/]+)-session\.jsonl$/)?.[1] ?? null,
      size: (path: string) => sizes.get(path) ?? 0,
      readCompletionSince: (_path: string, offset: number) => {
        const completion = opts.completions?.[node.name];
        if (completion && completion.offset > offset) {
          return {
            done: true,
            text: completion.text,
            offset: completion.offset,
          };
        }
        return {
          done: false,
          offset,
        };
      },
      readLast: () => null,
    } satisfies AgentAdapter;
    byName.set(node.name, { node, adapter, addr: `grove:${node.name}` });
  }

  return {
    configPath: "/tmp/grove.yaml",
    config: {
      session: "grove-test",
      cwd: "/tmp/grove-test",
      defaults: { agent: "codex" },
      nodes: Object.fromEntries(
        nodeNames.map((name) => [name, { agent: "codex", children: [] }]),
      ),
    },
    nodes,
    byName,
    registry: {
      session: "grove-test",
      cwd: "/tmp/grove-test",
      updatedAt: "2026-06-03T00:00:00.000Z",
      nodes: Object.fromEntries(
        nodeNames.map((name) => [
          name,
          {
            name,
            agent: "codex",
            sessionId: name,
            transcript: `/tmp/${name}-session.jsonl`,
            pending: {
              transcript: `/tmp/${name}-session.jsonl`,
              fromOffset: 10,
              submittedAt: "2026-06-03T00:00:00.000Z",
              eventLogOffset: 0,
            },
          },
        ]),
      ),
    },
  };
}

describe("fan-in wait", () => {
  test("--any returns the first terminal event immediately", async () => {
    const eventLogDir = tempDir();
    const ctx = makeContext(["alpha", "beta"]);
    appendTurnEvent(eventLogDir, turnEvent("alpha", "alpha", 20));
    appendTurnEvent(eventLogDir, turnEvent("beta", "beta", 30));

    const result = await waitForFanIn(ctx, ["alpha", "beta"], {
      mode: "any",
      timeoutMs: 100,
      eventLogDir,
    });

    expect(result.completed.map((item) => item.node)).toEqual(["alpha"]);
    expect(result.failed).toEqual([]);
    expect(result.pending.map((item) => item.node)).toEqual(["beta"]);
    expect(result.order.map((item) => item.node)).toEqual(["alpha"]);
    expect(result.deadlineExceeded).toBe(false);
  });

  test("clears pending only for terminal nodes after --any returns", async () => {
    const eventLogDir = tempDir();
    const ctx = makeContext(["alpha", "beta"]);
    appendTurnEvent(eventLogDir, turnEvent("alpha", "alpha", 20));

    const result = await waitForFanIn(ctx, ["alpha", "beta"], {
      mode: "any",
      timeoutMs: 100,
      eventLogDir,
    });

    expect(result.completed.map((item) => item.node)).toEqual(["alpha"]);
    expect(ctx.registry.nodes.alpha?.pending).toBeUndefined();
    expect(ctx.registry.nodes.beta?.pending).toBeDefined();
  });

  test("--all returns completed, failed, and pending groups at the hard deadline", async () => {
    const eventLogDir = tempDir();
    const ctx = makeContext(["alpha", "beta", "gamma"]);
    appendTurnEvent(eventLogDir, turnEvent("alpha", "alpha", 20));
    appendTurnEvent(
      eventLogDir,
      turnEvent("beta", "beta", 22, {
        status: "failed",
        type: "turn.failed",
        summary: "beta failed",
      }),
    );

    const result = await waitForFanIn(ctx, ["alpha", "beta", "gamma"], {
      mode: "all",
      timeoutMs: 0,
      eventLogDir,
    });

    expect(result.completed.map((item) => item.node)).toEqual(["alpha"]);
    expect(result.failed).toEqual([
      expect.objectContaining({ node: "beta", reason: "beta failed" }),
    ]);
    expect(result.pending).toEqual([
      expect.objectContaining({
        node: "gamma",
        turnId: "gamma:gamma:10",
        transcriptOffset: 10,
      }),
    ]);
    expect(result.deadlineExceeded).toBe(true);
    expect(ctx.registry.nodes.alpha?.pending).toBeUndefined();
    expect(ctx.registry.nodes.beta?.pending).toBeUndefined();
    expect(ctx.registry.nodes.gamma?.pending).toBeDefined();
  });

  test("falls back to transcript scanning when the watch daemon has not appended events", async () => {
    const ctx = makeContext(["alpha", "beta"], {
      completions: {
        alpha: { text: "alpha transcript completion", offset: 33 },
      },
    });

    const result = await waitForFanIn(ctx, ["alpha", "beta"], {
      mode: "any",
      timeoutMs: 100,
      eventLogDir: tempDir(),
    });

    expect(result.completed).toEqual([
      expect.objectContaining({
        node: "alpha",
        transcriptOffset: 33,
        summary: "alpha transcript completion",
      }),
    ]);
    expect(ctx.registry.nodes.alpha?.pending).toBeUndefined();
    expect(ctx.registry.nodes.beta?.pending).toBeDefined();
  });

  test("collects simultaneous completions once even when a duplicate nonce is appended", async () => {
    const eventLogDir = tempDir();
    const ctx = makeContext(["alpha", "beta"]);
    const duplicate = turnEvent("alpha", "alpha", 20);
    appendTurnEvent(eventLogDir, duplicate);
    appendTurnEvent(eventLogDir, duplicate);
    appendTurnEvent(eventLogDir, turnEvent("beta", "beta", 20));

    const result = await waitForFanIn(ctx, ["alpha", "beta"], {
      mode: "all",
      timeoutMs: 100,
      eventLogDir,
    });

    expect(result.completed.map((item) => item.node)).toEqual(["alpha", "beta"]);
    expect(result.order.map((item) => item.node)).toEqual(["alpha", "beta"]);
    expect(result.pending).toEqual([]);
  });

  test("renders gather as human text or JSON with the fixed result groups", async () => {
    const eventLogDir = tempDir();
    const ctx = makeContext(["alpha", "beta"]);
    appendTurnEvent(eventLogDir, turnEvent("alpha", "alpha", 20));

    const result = await waitForFanIn(ctx, ["alpha", "beta"], {
      mode: "all",
      timeoutMs: 0,
      eventLogDir,
    });

    expect(JSON.parse(renderGatherJson(result))).toMatchObject({
      completed: [{ node: "alpha" }],
      failed: [],
      pending: [{ node: "beta" }],
    });
    expect(renderGatherText(result)).toContain("completed");
    expect(renderGatherText(result)).toContain("pending");
  });
});
