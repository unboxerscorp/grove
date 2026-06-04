import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import type { AgentAdapter } from "./adapters/types.js";
import type { Context, NodeCtx } from "./context.js";
import { appendTurnEvent, type GroveTurnEvent } from "./events.js";
import { renderGatherJson, renderGatherText, waitForFanIn } from "./fanin.js";
import { loadRegistry, saveRegistry } from "./registry.js";
import { sessionDir } from "./util/paths.js";

let tempDirs: string[] = [];
let registrySessions: string[] = [];
let contextCounter = 0;

afterEach(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs = [];
  for (const session of registrySessions) {
    rmSync(sessionDir(session), { recursive: true, force: true });
  }
  registrySessions = [];
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
  const session = `fanin-${process.pid}-${Date.now()}-${contextCounter++}`;
  registrySessions.push(session);
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
      sessionIdFromPath: (path: string) => path.match(/\/([^/]+)-session\.jsonl$/)?.[1] ?? null,
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
      session,
      cwd: "/tmp/grove-test",
      defaults: { agent: "codex" },
      nodes: Object.fromEntries(nodeNames.map((name) => [name, { agent: "codex", children: [] }])),
    },
    nodes,
    byName,
    registry: {
      session,
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
  test("accepts registry-only nodes resolved into context byName", async () => {
    const eventLogDir = tempDir();
    const ctx = makeContext(["configured"]);
    const transcript = "/tmp/orch-platform-session.jsonl";
    const liveNode = {
      agent: "codex" as const,
      children: [],
      cwd: "/tmp/grove-test",
      name: "orch-platform",
    };
    const liveAdapter = {
      name: "codex",
      label: "Codex",
      submit: "enter",
      readyPattern: /ready/,
      launchCommand: () => "codex",
      transcriptForSession: () => transcript,
      snapshot: () => new Map<string, number>(),
      detectNew: () => null,
      sessionIdFromPath: () => "orch-platform",
      size: () => 10,
      readCompletionSince: (_path: string, offset: number) => ({
        done: false,
        offset,
      }),
      readLast: () => null,
    } satisfies AgentAdapter;
    ctx.byName.set("orch-platform", {
      adapter: liveAdapter,
      addr: "dev10:13.2",
      node: liveNode,
    });
    ctx.registry.nodes["orch-platform"] = {
      agent: "codex",
      name: "orch-platform",
      pending: {
        eventLogOffset: 0,
        fromOffset: 10,
        submittedAt: "2026-06-03T00:00:00.000Z",
        transcript,
      },
      sessionId: "orch-platform",
      tmux_pane: "dev10:13.2",
      transcript,
    };
    appendTurnEvent(eventLogDir, turnEvent("orch-platform", "orch-platform", 20));

    const result = await waitForFanIn(ctx, ["orch-platform"], {
      mode: "all",
      timeoutMs: 100,
      eventLogDir,
    });

    expect(ctx.nodes.map((node) => node.name)).toEqual(["configured"]);
    expect(result.completed).toEqual([expect.objectContaining({ node: "orch-platform" })]);
    expect(result.deadlineExceeded).toBe(false);
  });

  test("resolves provisional pending snapshots for wait --all and gather fan-in paths", async () => {
    const eventLogDir = tempDir();
    const ctx = makeContext(["alpha", "beta"]);
    const beta = ctx.byName.get("beta")!;
    beta.adapter = {
      ...beta.adapter,
      detectNew: () => ({
        sessionId: "beta-new",
        transcript: "/tmp/beta-new-session.jsonl",
      }),
    };
    ctx.registry.nodes.beta = {
      agent: "codex",
      name: "beta",
      pending: {
        eventLogOffset: 0,
        fromOffset: 0,
        provisional: true,
        snapshot: { "/tmp/beta-old-session.jsonl": 1 },
        submittedAt: "2026-06-03T00:00:00.000Z",
      },
    };
    appendTurnEvent(eventLogDir, turnEvent("alpha", "alpha", 20));
    appendTurnEvent(eventLogDir, turnEvent("beta", "beta-new", 20));

    const result = await waitForFanIn(ctx, ["alpha", "beta"], {
      mode: "all",
      timeoutMs: 100,
      eventLogDir,
    });

    expect(result.completed.map((item) => item.node)).toEqual(["alpha", "beta"]);
    expect(result.deadlineExceeded).toBe(false);
    expect(ctx.registry.nodes.beta?.sessionId).toBe("beta-new");
    expect(ctx.registry.nodes.beta?.transcript).toBe("/tmp/beta-new-session.jsonl");
    expect(ctx.registry.nodes.beta?.pending).toBeUndefined();
  });

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

  test("keeps unsaved non-terminal pending when a latest registry snapshot exists", async () => {
    const eventLogDir = tempDir();
    const ctx = makeContext(["alpha", "beta"]);
    saveRegistry({
      ...ctx.registry,
      nodes: {
        alpha: {
          agent: "codex",
          name: "alpha",
        },
      },
    });
    appendTurnEvent(eventLogDir, turnEvent("alpha", "alpha", 20));

    const result = await waitForFanIn(ctx, ["alpha", "beta"], {
      mode: "any",
      timeoutMs: 100,
      eventLogDir,
    });

    expect(result.completed.map((item) => item.node)).toEqual(["alpha"]);
    expect(ctx.registry.nodes.alpha?.pending).toBeUndefined();
    expect(ctx.registry.nodes.beta?.pending).toBeDefined();
    expect(loadRegistry(ctx.config.session)?.nodes.beta).toBeUndefined();
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

  test("finalizeResult clears pending without clobbering concurrent registry writes", async () => {
    const session = `faninreg-${process.pid}-${Date.now()}`;
    const eventLogDir = tempDir();
    const ctx = makeContext(["alpha", "beta"]);
    const concurrentCtx = makeContext(["alpha", "beta"]);
    ctx.config.session = session;
    ctx.registry.session = session;
    concurrentCtx.config.session = session;
    concurrentCtx.registry.session = session;

    saveRegistry(ctx.registry);
    const latest = loadRegistry(session)!;
    latest.nodes.browser = {
      agent: "codex",
      name: "browser",
      role: "live-browser-role",
    };
    saveRegistry(latest);
    appendTurnEvent(eventLogDir, turnEvent("alpha", "alpha", 20));
    appendTurnEvent(eventLogDir, turnEvent("beta", "beta", 20));

    try {
      await waitForFanIn(ctx, ["alpha"], { mode: "all", timeoutMs: 0, eventLogDir });
      await waitForFanIn(concurrentCtx, ["beta"], { mode: "all", timeoutMs: 0, eventLogDir });

      const reloaded = loadRegistry(session);
      expect(reloaded?.nodes.alpha?.pending).toBeUndefined();
      expect(reloaded?.nodes.beta?.pending).toBeUndefined();
      expect(reloaded?.nodes.browser?.role).toBe("live-browser-role");
    } finally {
      rmSync(sessionDir(session), { force: true, recursive: true });
    }
  });

  test("finalizeResult does not resurrect a deleted registry-only target node", async () => {
    const eventLogDir = tempDir();
    const ctx = makeContext(["configured"]);
    const transcript = "/tmp/registry-only-session.jsonl";
    const registryOnlyNode = {
      agent: "codex" as const,
      children: [],
      cwd: "/tmp/grove-test",
      name: "registry-only",
    };
    const registryOnlyAdapter = {
      name: "codex",
      label: "Codex",
      submit: "enter",
      readyPattern: /ready/,
      launchCommand: () => "codex",
      transcriptForSession: () => transcript,
      snapshot: () => new Map<string, number>(),
      detectNew: () => null,
      sessionIdFromPath: () => "registry-only",
      size: () => 10,
      readCompletionSince: (_path: string, offset: number) => ({
        done: false,
        offset,
      }),
      readLast: () => null,
    } satisfies AgentAdapter;
    ctx.byName.set("registry-only", {
      adapter: registryOnlyAdapter,
      addr: "dev10:13.4",
      node: registryOnlyNode,
    });
    ctx.registry.nodes["registry-only"] = {
      agent: "codex",
      name: "registry-only",
      pending: {
        eventLogOffset: 0,
        fromOffset: 10,
        submittedAt: "2026-06-03T00:00:00.000Z",
        transcript,
      },
      sessionId: "registry-only",
      transcript,
    };
    saveRegistry(ctx.registry);
    const latest = loadRegistry(ctx.config.session)!;
    delete latest.nodes["registry-only"];
    saveRegistry(latest);
    appendTurnEvent(eventLogDir, turnEvent("registry-only", "registry-only", 20));

    const result = await waitForFanIn(ctx, ["registry-only"], {
      mode: "all",
      timeoutMs: 100,
      eventLogDir,
    });

    expect(result.completed).toEqual([expect.objectContaining({ node: "registry-only" })]);
    expect(loadRegistry(ctx.config.session)?.nodes["registry-only"]).toBeUndefined();
    expect(ctx.registry.nodes["registry-only"]).toBeUndefined();
  });
});
