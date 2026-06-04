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
    performRecoveryAction: async () => undefined,
    readFileSync: (file) => readFileSync(file, "utf8"),
    transcriptMtimeMs: async (path) => runtime.transcriptMtimeMs?.[path] ?? null,
    writeFileAtomicSync,
  };
}

function healthByNode(snapshot: Awaited<ReturnType<typeof collectWatchdogSnapshot>>) {
  return new Map(snapshot.nodes.map((node) => [node.node, node]));
}

function recoveryByNode(snapshot: Awaited<ReturnType<typeof collectWatchdogSnapshot>>) {
  return new Map(snapshot.recovery.actions.map((action) => [action.node, action]));
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

  test("plans dry-run staggered recovery for limits without performing actions", async () => {
    const now = new Date(2026, 0, 1, 10, 0, 0);
    const performed = vi.fn<WatchdogDeps["performRecoveryAction"]>(async () => undefined);
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
    const injected = {
      ...deps(ctx, runtime, () => now),
      performRecoveryAction: performed,
    };

    const snapshot = await collectWatchdogSnapshot(
      ctx,
      new Map(),
      { hungAfterMs: 60_000 },
      injected,
    );
    const recovery = recoveryByNode(snapshot);

    expect(snapshot.recovery.mode).toBe("dry-run");
    expect(recovery.get("rate")).toMatchObject({
      action: "restart",
      cooldown_until: new Date(2026, 0, 1, 10, 15, 0, 0).toISOString(),
      status: "scheduled",
    });
    expect(recovery.get("usage")).toMatchObject({
      action: "restart",
      cooldown_until: new Date(2026, 0, 1, 11, 45, 0, 0).toISOString(),
      reason: "usage-limit-reset-wake",
      status: "scheduled",
    });
    expect(recovery.get("login")).toMatchObject({
      action: "notify",
      reason: "login-required-manual-recovery",
      status: "blocked",
    });
    expect(performed).not.toHaveBeenCalled();
  });

  test("executes at most one due recovery action and enforces the global wake interval", async () => {
    const nowMs = new Date(2026, 0, 1, 10, 0, 0).getTime();
    const performed = vi.fn<WatchdogDeps["performRecoveryAction"]>(async () => undefined);
    const runtime: MockRuntime = {
      paneText: {
        "dev10:0.0": "temporarily limiting requests",
        "dev10:1.0": "temporarily limiting requests",
      },
      transcriptBytes: {
        "/repo/alpha.jsonl": 10,
        "/repo/beta.jsonl": 10,
      },
    };
    const ctx = context(["alpha", "beta"], runtime);
    const memory = new Map<string, WatchdogMemory>([
      [
        "alpha",
        {
          lastActivityMs: nowMs,
          recovery: { cooldownUntilMs: nowMs - 1, lastHealth: "rate_limited" },
        },
      ],
      [
        "beta",
        {
          lastActivityMs: nowMs,
          recovery: { cooldownUntilMs: nowMs - 1, lastHealth: "rate_limited" },
        },
      ],
    ]);
    const globalRecovery = {};
    const injected = {
      ...deps(ctx, runtime, () => new Date(nowMs)),
      performRecoveryAction: performed,
    };

    const first = await collectWatchdogSnapshot(
      ctx,
      memory,
      { execute: true, globalRecovery, hungAfterMs: 60_000 },
      injected,
    );
    const firstRecovery = recoveryByNode(first);

    expect(performed).toHaveBeenCalledTimes(1);
    expect(performed.mock.calls[0]?.[0]).toMatchObject({ action: "restart", node: "alpha" });
    expect(firstRecovery.get("alpha")?.status).toBe("executed");
    expect(firstRecovery.get("beta")).toMatchObject({
      reason: "rate-limit-backoff:global-queue",
      status: "deferred",
    });

    performed.mockClear();
    const second = await collectWatchdogSnapshot(
      ctx,
      memory,
      { execute: true, globalRecovery, hungAfterMs: 60_000 },
      injected,
    );

    expect(performed).not.toHaveBeenCalled();
    expect(recoveryByNode(second).get("beta")).toMatchObject({
      reason: "rate-limit-backoff:global-wake-interval",
      status: "deferred",
    });
  });

  test("opens a circuit after max restart attempts for persistent rate limits", async () => {
    const nowMs = new Date(2026, 0, 1, 10, 0, 0).getTime();
    const performed = vi.fn<WatchdogDeps["performRecoveryAction"]>(async () => undefined);
    const runtime: MockRuntime = {
      paneText: { "dev10:0.0": "temporarily limiting requests" },
      transcriptBytes: { "/repo/worker.jsonl": 10 },
    };
    const ctx = context(["worker"], runtime);
    const memory = new Map<string, WatchdogMemory>([
      [
        "worker",
        {
          lastActivityMs: nowMs,
          recovery: {
            cooldownUntilMs: nowMs - 1,
            lastHealth: "rate_limited",
            restartAttempts: 3,
          },
        },
      ],
    ]);

    const snapshot = await collectWatchdogSnapshot(
      ctx,
      memory,
      { execute: true, globalRecovery: {}, hungAfterMs: 60_000 },
      {
        ...deps(ctx, runtime, () => new Date(nowMs)),
        performRecoveryAction: performed,
      },
    );

    expect(performed).not.toHaveBeenCalled();
    expect(recoveryByNode(snapshot).get("worker")).toMatchObject({
      action: "notify",
      reason: "circuit-open:max-retries",
      status: "circuit_open",
    });
  });

  test("counts failed restart actions toward the circuit breaker", async () => {
    let nowMs = new Date(2026, 0, 1, 10, 0, 0).getTime();
    const performed = vi.fn<WatchdogDeps["performRecoveryAction"]>(async () => {
      throw new Error("tmux send failed");
    });
    const runtime: MockRuntime = {
      paneText: { "dev10:0.0": "temporarily limiting requests" },
      transcriptBytes: { "/repo/worker.jsonl": 10 },
    };
    const ctx = context(["worker"], runtime);
    const memory = new Map<string, WatchdogMemory>([
      [
        "worker",
        {
          lastActivityMs: nowMs,
          recovery: { cooldownUntilMs: nowMs - 1, lastHealth: "rate_limited" },
        },
      ],
    ]);
    const globalRecovery = {};
    const injected = {
      ...deps(ctx, runtime, () => new Date(nowMs)),
      performRecoveryAction: performed,
    };

    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const snapshot = await collectWatchdogSnapshot(
        ctx,
        memory,
        { execute: true, globalRecovery, hungAfterMs: 60_000 },
        injected,
      );
      expect(recoveryByNode(snapshot).get("worker")).toMatchObject({
        action: "restart",
        status: "failed",
      });
      nowMs += 15 * 60_000 + 1;
    }

    const final = await collectWatchdogSnapshot(
      ctx,
      memory,
      { execute: true, globalRecovery, hungAfterMs: 60_000 },
      injected,
    );

    expect(performed).toHaveBeenCalledTimes(3);
    expect(memory.get("worker")?.recovery?.restartAttempts).toBe(3);
    expect(recoveryByNode(final).get("worker")).toMatchObject({
      action: "notify",
      reason: "circuit-open:max-retries",
      status: "circuit_open",
    });

    nowMs += 15 * 60_000 + 1;
    const afterCircuit = await collectWatchdogSnapshot(
      ctx,
      memory,
      { execute: true, globalRecovery, hungAfterMs: 60_000 },
      injected,
    );
    expect(performed).toHaveBeenCalledTimes(3);
    expect(recoveryByNode(afterCircuit).get("worker")).toMatchObject({
      action: "notify",
      reason: "circuit-open:max-retries",
      status: "circuit_open",
    });
  });

  test("schedules usage-limit resets across midnight using local time", async () => {
    const now = new Date(2026, 0, 1, 23, 50, 0, 0);
    const runtime: MockRuntime = {
      paneText: { "dev10:0.0": "session limit reached, resets 00:10" },
      transcriptBytes: { "/repo/worker.jsonl": 10 },
    };
    const ctx = context(["worker"], runtime);

    const snapshot = await collectWatchdogSnapshot(
      ctx,
      new Map(),
      { hungAfterMs: 60_000 },
      deps(ctx, runtime, () => now),
    );

    expect(healthByNode(snapshot).get("worker")?.usage_limit_reset_at).toBe(
      new Date(2026, 0, 2, 0, 10, 0, 0).toISOString(),
    );
    expect(recoveryByNode(snapshot).get("worker")).toMatchObject({
      cooldown_until: new Date(2026, 0, 2, 0, 10, 0, 0).toISOString(),
      reason: "usage-limit-reset-wake",
      status: "scheduled",
    });
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

  test("nudges crashed nodes once and marks them ready after the nudge lease expires", async () => {
    let nowMs = new Date(2026, 0, 1, 10, 0, 0).getTime();
    const performed = vi.fn<WatchdogDeps["performRecoveryAction"]>(async () => undefined);
    const runtime: MockRuntime = {
      paneTargets: { "dev10:0.0": new Error("pane missing") },
    };
    const ctx = context(["gone"], runtime);
    const memory = new Map<string, WatchdogMemory>();
    const injected = {
      ...deps(ctx, runtime, () => new Date(nowMs)),
      performRecoveryAction: performed,
    };

    const first = await collectWatchdogSnapshot(
      ctx,
      memory,
      { execute: true, globalRecovery: {}, hungAfterMs: 60_000 },
      injected,
    );
    expect(recoveryByNode(first).get("gone")).toMatchObject({
      action: "nudge",
      reason: "crashed-nudge",
      status: "executed",
    });
    expect(performed).toHaveBeenCalledTimes(1);

    nowMs += 301_000;
    const second = await collectWatchdogSnapshot(
      ctx,
      memory,
      { execute: true, globalRecovery: {}, hungAfterMs: 60_000 },
      injected,
    );
    expect(recoveryByNode(second).get("gone")).toMatchObject({
      action: "ready",
      reason: "crashed-nudge-lease-expired",
      status: "ready",
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

  test("does not mark idle prompt panes as hung without transcript output", async () => {
    let nowMs = new Date(2026, 0, 1, 10, 0, 0).getTime();
    const runtime: MockRuntime = {
      paneText: { "dev10:0.0": "╭── ready ──╮\n│ ❯ > │\n╰──────────╯" },
      transcriptBytes: { "/repo/worker.jsonl": 42 },
      transcriptMtimeMs: { "/repo/worker.jsonl": nowMs - 301_000 },
    };
    const ctx = context(["worker"], runtime);
    const memory = new Map<string, WatchdogMemory>();
    const injected = deps(ctx, runtime, () => new Date(nowMs));

    const first = await collectWatchdogSnapshot(ctx, memory, { hungAfterMs: 300_000 }, injected);
    nowMs += 301_000;
    const second = await collectWatchdogSnapshot(ctx, memory, { hungAfterMs: 300_000 }, injected);

    expect(healthByNode(first).get("worker")).toMatchObject({
      health: "healthy",
      reason: "idle",
    });
    expect(healthByNode(second).get("worker")).toMatchObject({
      health: "healthy",
      reason: "idle",
    });
  });

  test("does not mark codex idle suggestion and model status screens as hung", async () => {
    let nowMs = new Date(2026, 0, 1, 10, 0, 0).getTime();
    const runtime: MockRuntime = {
      paneText: {
        "dev10:0.0": "› Summarize recent commits\n\n  gpt-5.5 xhigh · /repo",
      },
      transcriptBytes: { "/repo/worker.jsonl": 42 },
      transcriptMtimeMs: { "/repo/worker.jsonl": nowMs - 301_000 },
    };
    const ctx = context(["worker"], runtime);
    const memory = new Map<string, WatchdogMemory>();
    const injected = deps(ctx, runtime, () => new Date(nowMs));

    const first = await collectWatchdogSnapshot(ctx, memory, { hungAfterMs: 300_000 }, injected);
    nowMs += 301_000;
    const second = await collectWatchdogSnapshot(ctx, memory, { hungAfterMs: 300_000 }, injected);

    expect(healthByNode(first).get("worker")).toMatchObject({
      health: "healthy",
      reason: "idle",
    });
    expect(healthByNode(second).get("worker")).toMatchObject({
      health: "healthy",
      reason: "idle",
    });
  });

  test("does not mark antigravity idle shortcut screens as hung", async () => {
    let nowMs = new Date(2026, 0, 1, 10, 0, 0).getTime();
    const runtime: MockRuntime = {
      paneText: {
        "dev10:0.0": "Gemini\n? for shortcuts\nesc to cancel",
      },
      transcriptBytes: { "/repo/worker.jsonl": 42 },
      transcriptMtimeMs: { "/repo/worker.jsonl": nowMs - 301_000 },
    };
    const ctx = context(["worker"], runtime);
    const worker = ctx.byName.get("worker")!;
    worker.node.agent = "antigravity";
    ctx.registry.nodes.worker!.agent = "antigravity";
    const memory = new Map<string, WatchdogMemory>();
    const injected = deps(ctx, runtime, () => new Date(nowMs));

    const first = await collectWatchdogSnapshot(ctx, memory, { hungAfterMs: 300_000 }, injected);
    nowMs += 301_000;
    const second = await collectWatchdogSnapshot(ctx, memory, { hungAfterMs: 300_000 }, injected);

    expect(healthByNode(first).get("worker")).toMatchObject({
      health: "healthy",
      reason: "idle",
    });
    expect(healthByNode(second).get("worker")).toMatchObject({
      health: "healthy",
      reason: "idle",
    });
  });

  test("does not mark active panes as hung without transcript output", async () => {
    let nowMs = new Date(2026, 0, 1, 10, 0, 0).getTime();
    const runtime: MockRuntime = {
      paneText: { "dev10:0.0": "Working | esc to interrupt | elapsed 00:00 1%" },
      transcriptBytes: { "/repo/worker.jsonl": 42 },
    };
    const ctx = context(["worker"], runtime);
    const memory = new Map<string, WatchdogMemory>();
    const injected = deps(ctx, runtime, () => new Date(nowMs));

    const first = await collectWatchdogSnapshot(ctx, memory, { hungAfterMs: 300_000 }, injected);
    nowMs += 301_000;
    runtime.paneText!["dev10:0.0"] = "Working / esc to interrupt / elapsed 00:05 2%";
    const second = await collectWatchdogSnapshot(ctx, memory, { hungAfterMs: 300_000 }, injected);

    expect(healthByNode(first).get("worker")?.health).toBe("healthy");
    expect(healthByNode(second).get("worker")).toMatchObject({
      health: "healthy",
      reason: "active",
    });
  });

  test("marks ambiguous non-pane tmux targets unknown instead of hung", async () => {
    const nowMs = new Date(2026, 0, 1, 10, 0, 0).getTime();
    const runtime: MockRuntime = {
      paneText: { "dev10:grove-dev": "same output" },
      transcriptBytes: { "/repo/grove-dev.jsonl": 42 },
      transcriptMtimeMs: { "/repo/grove-dev.jsonl": nowMs - 301_000 },
    };
    const ctx = context(["grove-dev"], runtime);
    ctx.registry.nodes["grove-dev"]!.tmux_pane = "dev10:grove-dev";

    const snapshot = await collectWatchdogSnapshot(
      ctx,
      new Map(),
      { hungAfterMs: 300_000 },
      deps(ctx, runtime, () => new Date(nowMs)),
    );

    expect(healthByNode(snapshot).get("grove-dev")).toMatchObject({
      health: "unknown",
      pane_exists: false,
      reason: "ambiguous-pane-target",
    });
    expect(snapshot.counts.unknown).toBe(1);
    expect(recoveryByNode(snapshot).get("grove-dev")).toMatchObject({
      action: "none",
      status: "not_needed",
    });
  });

  test("ignores spinner and clock-only pane redraws without active or idle markers", async () => {
    let nowMs = new Date(2026, 0, 1, 10, 0, 0).getTime();
    const runtime: MockRuntime = {
      paneText: { "dev10:0.0": "| elapsed 00:00 1%" },
      transcriptBytes: { "/repo/worker.jsonl": 42 },
    };
    const ctx = context(["worker"], runtime);
    const memory = new Map<string, WatchdogMemory>();
    const injected = deps(ctx, runtime, () => new Date(nowMs));

    const first = await collectWatchdogSnapshot(ctx, memory, { hungAfterMs: 300_000 }, injected);
    nowMs += 301_000;
    runtime.paneText!["dev10:0.0"] = "/ elapsed 00:05 2%";
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

  test("cmdWatchdog dry-run does not persist recovery attempts before execute nudges", async () => {
    const previousHome = process.env.GROVE_HOME;
    const root = mkdtempSync(path.join(os.tmpdir(), "grove-watchdog-dry-run-"));
    process.env.GROVE_HOME = root;
    vi.resetModules();

    const nowMs = new Date(2026, 0, 1, 10, 0, 0).getTime();
    const performed = vi.fn<WatchdogDeps["performRecoveryAction"]>(async () => undefined);
    const runtime: MockRuntime = {
      paneTargets: { "dev10:0.0": new Error("pane missing") },
    };
    const ctx = context(["gone"], runtime);
    const writes: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
    });
    const injected = {
      ...deps(ctx, runtime, () => new Date(nowMs)),
      performRecoveryAction: performed,
    };

    try {
      const watchdog = await import("./watchdog.js");
      const { sessionDir } = await import("../util/paths.js");
      const statePath = path.join(sessionDir("dev10"), "watchdog-state.json");

      await watchdog.cmdWatchdog({ hungAfter: "1m", json: true }, injected);
      expect(performed).not.toHaveBeenCalled();
      expect(readFileSync(statePath, "utf8")).not.toContain("lastNudgeAtMs");

      writes.length = 0;
      await watchdog.cmdWatchdog({ execute: true, hungAfter: "1m", json: true }, injected);
      const payload = JSON.parse(writes.join("")) as Awaited<
        ReturnType<typeof collectWatchdogSnapshot>
      >;

      expect(performed).toHaveBeenCalledTimes(1);
      expect(recoveryByNode(payload).get("gone")).toMatchObject({
        action: "nudge",
        status: "executed",
      });
      expect(readFileSync(statePath, "utf8")).toContain("lastNudgeAtMs");
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

  test("cmdWatchdog serializes concurrent execute wake attempts through the state lock", async () => {
    const previousHome = process.env.GROVE_HOME;
    const root = mkdtempSync(path.join(os.tmpdir(), "grove-watchdog-lock-"));
    process.env.GROVE_HOME = root;
    vi.resetModules();

    const nowMs = new Date(2026, 0, 1, 10, 0, 0).getTime();
    const performed = vi.fn<WatchdogDeps["performRecoveryAction"]>(async () => {
      await new Promise((resolve) => setTimeout(resolve, 40));
    });
    const runtime: MockRuntime = {
      paneText: { "dev10:0.0": "temporarily limiting requests" },
      transcriptBytes: { "/repo/worker.jsonl": 10 },
    };
    const ctx = context(["worker"], runtime);
    const writes: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
    });
    const injected = {
      ...deps(ctx, runtime, () => new Date(nowMs)),
      performRecoveryAction: performed,
    };

    try {
      const watchdog = await import("./watchdog.js");
      const { sessionDir } = await import("../util/paths.js");
      const statePath = path.join(sessionDir("dev10"), "watchdog-state.json");
      writeFileAtomicSync(
        statePath,
        `${JSON.stringify(
          {
            nodes: {
              worker: {
                lastActivityMs: nowMs,
                recovery: { cooldownUntilMs: nowMs - 1, lastHealth: "rate_limited" },
              },
            },
            recovery: {},
            schema: 1,
            session: "dev10",
            type: "watchdog_state",
            updated_at: new Date(nowMs).toISOString(),
          },
          null,
          2,
        )}\n`,
      );

      await Promise.all([
        watchdog.cmdWatchdog({ execute: true, hungAfter: "1m", json: true }, injected),
        watchdog.cmdWatchdog({ execute: true, hungAfter: "1m", json: true }, injected),
      ]);

      expect(performed).toHaveBeenCalledTimes(1);
      const state = JSON.parse(readFileSync(statePath, "utf8")) as {
        nodes: Record<string, { recovery?: { restartAttempts?: number } }>;
        recovery?: { lastWakeAtMs?: number };
      };
      expect(state.recovery?.lastWakeAtMs).toBe(nowMs);
      expect(state.nodes.worker?.recovery?.restartAttempts).toBe(1);
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
