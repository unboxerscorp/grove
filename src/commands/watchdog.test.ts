import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";

import type { AgentAdapter } from "../adapters/types.js";
import type { Context, NodeCtx } from "../context.js";
import { writeFileAtomicSync } from "../util/atomic.js";
import {
  collectWatchdogSnapshot,
  type WatchdogDeps,
  type WatchdogHealth,
  type WatchdogMemory,
} from "./watchdog.js";

interface MockRuntime {
  commands?: Record<string, string>;
  paneTargets?: Record<string, string | Error>;
  paneText?: Record<string, string>;
  transcriptBytes?: Record<string, number>;
  transcriptMtimeMs?: Record<string, number | null>;
  transcriptText?: Record<string, string>;
}

afterEach(() => {
  vi.restoreAllMocks();
});

function adapter(runtime: MockRuntime, transcript: string): AgentAdapter {
  return {
    detectNew: () => null,
    label: "Codex",
    launchCommand: () => "codex",
    name: "codex",
    readCompletionSince: (_path, offset) => ({ done: false, offset }),
    readLast: (path) => runtime.transcriptText?.[path] ?? null,
    readyPattern: /ready/,
    sessionIdFromPath: () => "session-id",
    size: (path) => runtime.transcriptBytes?.[path] ?? 0,
    snapshot: () => new Map<string, number>(),
    submit: "enter",
    transcriptForSession: () => transcript,
  };
}

function context(names: string[], runtime: MockRuntime = {}): Context {
  const nodes = names.map((name) => ({
    agent: "codex" as const,
    children: [],
    cwd: "/repo",
    name,
  }));
  const byName = new Map<string, NodeCtx>();
  const registryNodes: Context["registry"]["nodes"] = {};
  for (const [index, node] of nodes.entries()) {
    const pane = `dev10:${index}.0`;
    const transcript = `/repo/${node.name}.jsonl`;
    byName.set(node.name, {
      adapter: adapter(runtime, transcript),
      addr: pane,
      node,
    });
    registryNodes[node.name] = {
      agent: "codex",
      name: node.name,
      sessionId: `${node.name}-session`,
      tmux_pane: pane,
      transcript,
    };
  }
  return {
    byName,
    config: {
      cwd: "/repo",
      defaults: { agent: "codex" },
      nodes: {},
      session: "dev10",
    },
    configPath: "/repo/grove.yaml",
    nodes,
    registry: {
      cwd: "/repo",
      nodes: registryNodes,
      session: "dev10",
      updatedAt: "2026-06-05T00:00:00.000Z",
    },
  };
}

function deps(ctx: Context, runtime: MockRuntime, now: () => Date): WatchdogDeps {
  return {
    capturePane: async (addr) => runtime.paneText?.[addr] ?? "",
    exists: existsSync,
    loadContext: () => ctx,
    now,
    paneCommand: async (addr) => runtime.commands?.[addr] ?? "codex",
    paneTarget: async (addr) => {
      const target = runtime.paneTargets?.[addr] ?? addr;
      if (target instanceof Error) throw target;
      return target;
    },
    readFileSync: (file) => readFileSync(file, "utf8"),
    transcriptMtimeMs: async (path) => runtime.transcriptMtimeMs?.[path] ?? null,
    writeFileAtomicSync,
  };
}

function healthByNode(snapshot: Awaited<ReturnType<typeof collectWatchdogSnapshot>>) {
  return new Map(snapshot.nodes.map((node) => [node.node, node]));
}

describe("watchdog node health", () => {
  test("detects rate limits, usage limits, and login failures from pane/transcript text", async () => {
    const now = new Date(2026, 0, 1, 10, 0, 0);
    const runtime: MockRuntime = {
      paneText: {
        "dev10:0.0": "temporarily limiting requests; try again later",
        "dev10:1.0": "session limit reached, resets 11:45",
        "dev10:2.0": "Authentication expired. Please sign in.",
      },
      transcriptBytes: {
        "/repo/login.jsonl": 10,
        "/repo/rate.jsonl": 10,
        "/repo/usage.jsonl": 10,
      },
    };
    const ctx = context(["rate", "usage", "login"], runtime);

    const snapshot = await collectWatchdogSnapshot(
      ctx,
      new Map(),
      { hungAfterMs: 60_000 },
      deps(ctx, runtime, () => now),
    );
    const nodes = healthByNode(snapshot);

    expect(snapshot).toMatchObject({ schema: 1, session: "dev10", type: "node_health" });
    expect(nodes.get("rate")?.health).toBe("rate_limited");
    expect(nodes.get("usage")?.health).toBe("cooldown");
    expect(nodes.get("usage")?.reset_at).toBe(new Date(2026, 0, 1, 11, 45, 0, 0).toISOString());
    expect(nodes.get("usage")?.usage_limit_reset_at).toBe(
      new Date(2026, 0, 1, 11, 45, 0, 0).toISOString(),
    );
    expect(nodes.get("login")?.health).toBe("login_required");
  });

  test("detects crashed nodes when the pane or pane process is missing", async () => {
    const now = new Date(2026, 0, 1, 10, 0, 0);
    const runtime: MockRuntime = {
      commands: { "dev10:1.0": "", "dev10:2.0": "zsh" },
      paneTargets: { "dev10:0.0": new Error("pane missing") },
    };
    const ctx = context(["gone", "dead-process", "shell"], runtime);

    const snapshot = await collectWatchdogSnapshot(
      ctx,
      new Map(),
      { hungAfterMs: 60_000 },
      deps(ctx, runtime, () => now),
    );
    const nodes = healthByNode(snapshot);

    expect(nodes.get("gone")).toMatchObject({
      health: "crashed" satisfies WatchdogHealth,
      pane_exists: false,
      reason: "pane-missing",
    });
    expect(nodes.get("dead-process")).toMatchObject({
      health: "crashed" satisfies WatchdogHealth,
      pane_exists: true,
      reason: "process-missing",
    });
    expect(nodes.get("shell")).toMatchObject({
      health: "crashed" satisfies WatchdogHealth,
      pane_exists: true,
      reason: "process-exited",
    });
  });

  test("marks a node hung on first invocation from transcript activity timestamps", async () => {
    const nowMs = new Date(2026, 0, 1, 10, 0, 0).getTime();
    const runtime: MockRuntime = {
      paneText: { "dev10:0.0": "same output" },
      transcriptBytes: { "/repo/worker.jsonl": 42 },
      transcriptMtimeMs: { "/repo/worker.jsonl": nowMs - 301_000 },
    };
    const ctx = context(["worker"], runtime);

    const snapshot = await collectWatchdogSnapshot(
      ctx,
      new Map(),
      { hungAfterMs: 300_000 },
      deps(ctx, runtime, () => new Date(nowMs)),
    );

    expect(healthByNode(snapshot).get("worker")).toMatchObject({
      health: "hung",
      idle_ms: 301_000,
      reason: "no-pane-or-transcript-output",
    });
  });

  test("marks a node hung after repeated ticks with no pane or transcript output", async () => {
    let nowMs = new Date(2026, 0, 1, 10, 0, 0).getTime();
    const runtime: MockRuntime = {
      paneText: { "dev10:0.0": "same output" },
      transcriptBytes: { "/repo/worker.jsonl": 42 },
    };
    const ctx = context(["worker"], runtime);
    const memory = new Map<string, WatchdogMemory>();
    const injected = deps(ctx, runtime, () => new Date(nowMs));

    const first = await collectWatchdogSnapshot(ctx, memory, { hungAfterMs: 300_000 }, injected);
    nowMs += 301_000;
    const second = await collectWatchdogSnapshot(ctx, memory, { hungAfterMs: 300_000 }, injected);

    expect(healthByNode(first).get("worker")?.health).toBe("healthy");
    expect(healthByNode(second).get("worker")).toMatchObject({
      health: "hung",
      reason: "no-pane-or-transcript-output",
    });
  });

  test("ignores spinner and clock-only pane redraws when deciding activity", async () => {
    let nowMs = new Date(2026, 0, 1, 10, 0, 0).getTime();
    const runtime: MockRuntime = {
      paneText: { "dev10:0.0": "Working | elapsed 00:00 1%" },
      transcriptBytes: { "/repo/worker.jsonl": 42 },
    };
    const ctx = context(["worker"], runtime);
    const memory = new Map<string, WatchdogMemory>();
    const injected = deps(ctx, runtime, () => new Date(nowMs));

    const first = await collectWatchdogSnapshot(ctx, memory, { hungAfterMs: 300_000 }, injected);
    nowMs += 301_000;
    runtime.paneText!["dev10:0.0"] = "Working / elapsed 00:05 2%";
    const second = await collectWatchdogSnapshot(ctx, memory, { hungAfterMs: 300_000 }, injected);

    expect(healthByNode(first).get("worker")?.health).toBe("healthy");
    expect(healthByNode(second).get("worker")).toMatchObject({
      health: "hung",
      reason: "no-pane-or-transcript-output",
    });
  });

  test("prunes stale node entries from watchdog memory", async () => {
    const now = new Date(2026, 0, 1, 10, 0, 0);
    const runtime: MockRuntime = {
      paneText: { "dev10:0.0": "ready" },
      transcriptBytes: { "/repo/worker.jsonl": 1 },
    };
    const ctx = context(["worker"], runtime);
    const memory = new Map<string, WatchdogMemory>([
      ["stale", { lastActivityMs: now.getTime() - 60_000 }],
    ]);

    await collectWatchdogSnapshot(
      ctx,
      memory,
      { hungAfterMs: 300_000 },
      deps(ctx, runtime, () => now),
    );

    expect(memory.has("worker")).toBe(true);
    expect(memory.has("stale")).toBe(false);
  });

  test("cmdWatchdog tracks panes independently when one pane in the same window is busy", async () => {
    const previousHome = process.env.GROVE_HOME;
    const root = mkdtempSync(path.join(os.tmpdir(), "grove-watchdog-"));
    process.env.GROVE_HOME = root;
    vi.resetModules();

    let nowMs = new Date(2026, 0, 1, 10, 0, 0).getTime();
    const runtime: MockRuntime = {
      paneText: {
        "dev10:0.0": "busy-1",
        "dev10:0.1": "quiet-output",
      },
      transcriptBytes: {
        "/repo/busy.jsonl": 1,
        "/repo/silent.jsonl": 1,
      },
    };
    const ctx = context(["busy", "silent"], runtime);
    const busy = ctx.byName.get("busy")!;
    const silent = ctx.byName.get("silent")!;
    busy.addr = "dev10:0.0";
    silent.addr = "dev10:0.1";
    ctx.registry.nodes.busy!.tmux_pane = "dev10:0.0";
    ctx.registry.nodes.silent!.tmux_pane = "dev10:0.1";
    const writes: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
    });
    const injected = deps(ctx, runtime, () => new Date(nowMs));

    try {
      const watchdog = await import("./watchdog.js");
      const { sessionDir } = await import("../util/paths.js");
      const statePath = path.join(sessionDir("dev10"), "watchdog-state.json");

      await watchdog.cmdWatchdog({ hungAfter: "5m", json: true }, injected);
      const firstPayload = JSON.parse(writes.join("")) as {
        nodes: Array<{ health: WatchdogHealth; node: string }>;
      };
      expect(firstPayload.nodes).toEqual([
        expect.objectContaining({ health: "healthy", node: "busy" }),
        expect.objectContaining({ health: "healthy", node: "silent" }),
      ]);
      expect(existsSync(statePath)).toBe(true);

      writes.length = 0;
      nowMs += 301_000;
      runtime.paneText!["dev10:0.0"] = "busy-2";
      await watchdog.cmdWatchdog({ hungAfter: "5m", json: true }, injected);

      const secondPayload = JSON.parse(writes.join("")) as {
        nodes: Array<{ health: WatchdogHealth; node: string; reason?: string }>;
      };
      expect(secondPayload.nodes).toEqual([
        expect.objectContaining({ health: "healthy", node: "busy" }),
        expect.objectContaining({
          health: "hung",
          node: "silent",
          reason: "no-pane-or-transcript-output",
        }),
      ]);
      const state = readFileSync(statePath, "utf8");
      expect(state).toContain('"busy"');
      expect(state).toContain('"silent"');
      expect(state).not.toContain("busy-1");
      expect(state).not.toContain("quiet-output");
    } finally {
      if (previousHome === undefined) {
        delete process.env.GROVE_HOME;
      } else {
        process.env.GROVE_HOME = previousHome;
      }
      vi.resetModules();
      rmSync(root, { force: true, recursive: true });
    }
  });
});
