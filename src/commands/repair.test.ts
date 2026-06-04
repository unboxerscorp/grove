import { describe, expect, test, vi } from "vitest";

import type { AgentAdapter } from "../adapters/types.js";
import type { Context } from "../context.js";
import type { Registry } from "../registry.js";
import {
  cmdRepair,
  renderRepairJson,
  renderRepairText,
  type RepairDeps,
  repairNodes,
} from "./repair.js";

function adapter(
  sizes: Record<string, number> = {},
  transcripts: Record<string, string> = {},
): AgentAdapter {
  return {
    detectNew: () => null,
    label: "codex",
    launchCommand: () => "codex",
    name: "codex",
    readCompletionSince: () => ({ done: false, offset: 0 }),
    readLast: () => null,
    readyPattern: /ready/,
    sessionIdFromPath: (transcript) => transcript.match(/session-[^.]+/)?.[0] ?? null,
    size: (file) => sizes[file] ?? 0,
    snapshot: () => new Map<string, number>(),
    submit: "enter",
    transcriptForSession: (_cwd, sessionId) => transcripts[sessionId] ?? "",
  };
}

function registry(): Registry {
  return {
    cwd: "/repo",
    nodes: {
      dead: {
        agent: "codex",
        name: "dead",
        role: "Dead",
        tmux_pane: "dev10:old.%5",
      },
      empty: {
        agent: "codex",
        name: "empty",
        role: "Empty",
        sessionId: "session-empty",
        transcript: "/repo/empty.jsonl",
      },
      gone: {
        agent: "codex",
        name: "gone",
        role: "Gone",
        tmux_pane: "dev10:gone.%8",
      },
      ok: {
        agent: "codex",
        name: "ok",
        role: "Ok",
        sessionId: "session-ok",
        tmux_pane: "dev10:ok.%9",
        transcript: "/repo/ok.jsonl",
      },
    },
    session: "dev10",
    updatedAt: "2026-06-04T00:00:00.000Z",
  };
}

function context(reg = registry(), agent = adapter({ "/repo/ok.jsonl": 10 })): Context {
  return {
    byName: new Map([
      [
        "dead",
        {
          adapter: agent,
          addr: "dev10:1.2",
          node: {
            agent: "codex",
            children: [],
            cwd: "/repo",
            name: "dead",
            role: "Dead",
            tmux: "1.2",
          },
        },
      ],
    ]),
    config: {
      cwd: "/repo",
      defaults: { agent: "codex" },
      nodes: {
        dead: { agent: "codex", children: [], role: "Dead", tmux: "1.2" },
      },
      session: "dev10",
    },
    configPath: "/repo/grove.yaml",
    nodes: [
      {
        agent: "codex",
        children: [],
        cwd: "/repo",
        name: "dead",
        role: "Dead",
        tmux: "1.2",
      },
    ],
    registry: reg,
  };
}

function deps(agent = adapter({ "/repo/ok.jsonl": 10 })): {
  deps: RepairDeps;
  guardSessions: string[];
  paneTargets: string[];
  saves: number;
} {
  const guardSessions: string[] = [];
  const paneTargets: string[] = [];
  let saves = 0;
  return {
    deps: {
      exists: (file) => file !== "/repo/missing.jsonl",
      getAdapter: () => agent,
      hasSession: async () => true,
      loadContext: () => context(registry(), agent),
      paneTarget: async (addr) => {
        paneTargets.push(addr);
        if (addr === "dev10:old.%5") throw new Error("pane not found");
        if (addr === "dev10:1.2") return "dev10:1.7";
        if (addr === "dev10:gone.%8") throw new Error("pane not found");
        return addr;
      },
      preserveActiveWindow: async (session, fn) => {
        guardSessions.push(session);
        return fn();
      },
      saveRegistry: () => {
        saves += 1;
      },
    },
    get saves() {
      return saves;
    },
    guardSessions,
    paneTargets,
  };
}

describe("repairNodes", () => {
  test("recovers a dead configured pane by rebinding to its explicit tmux target", async () => {
    const state = deps();
    const ctx = context();

    const result = await repairNodes(ctx, { node: "dead" }, state.deps);

    expect(state.guardSessions).toEqual(["dev10"]);
    expect(state.paneTargets).toEqual(["dev10:old.%5", "dev10:1.2"]);
    expect(ctx.registry.nodes.dead?.tmux_pane).toBe("dev10:1.7");
    expect(result.recovered).toEqual([
      expect.objectContaining({
        after: "dev10:1.7",
        before: "dev10:old.%5",
        kind: "pane",
        node: "dead",
        reason: "pane-rebound",
      }),
    ]);
    expect(state.saves).toBe(1);
  });

  test("classifies an empty bound transcript as stale when no replacement is resolved", async () => {
    const agent = adapter({ "/repo/empty.jsonl": 0 });
    const state = deps(agent);
    const ctx = context(registry(), agent);

    const result = await repairNodes(ctx, { node: "empty" }, state.deps);

    expect(result.stale).toEqual([
      expect.objectContaining({
        before: "/repo/empty.jsonl",
        kind: "transcript",
        node: "empty",
        reason: "transcript-empty:no-match",
      }),
    ]);
    expect(state.saves).toBe(0);
  });

  test("reports an unrecoverable missing spawned pane without destructive cleanup", async () => {
    const state = deps();
    const ctx = context();

    const result = await repairNodes(ctx, { node: "gone" }, state.deps);

    expect(result.unrecoverable).toEqual([
      expect.objectContaining({
        before: "dev10:gone.%8",
        kind: "pane",
        node: "gone",
        reason: "pane-missing",
      }),
    ]);
    expect(ctx.registry.nodes.gone).toBeDefined();
    expect(state.saves).toBe(0);
  });

  test("leaves healthy nodes unchanged", async () => {
    const state = deps();
    const ctx = context();

    const result = await repairNodes(ctx, { node: "ok" }, state.deps);

    expect(result).toEqual({
      recovered: [],
      session: "dev10",
      stale: [],
      unrecoverable: [],
    });
    expect(state.saves).toBe(0);
  });

  test("renders text and JSON summaries", async () => {
    const state = deps();
    const result = await repairNodes(context(), { node: "gone" }, state.deps);

    expect(renderRepairText(result)).toContain("gone: pane pane-missing");
    expect(JSON.parse(renderRepairJson(result))).toEqual(result);
  });
});

describe("cmdRepair", () => {
  test("prints JSON repair results", async () => {
    const state = deps();
    const writes: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
    });
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    await cmdRepair({ json: true, node: "dead" }, state.deps);

    const parsed = JSON.parse(writes.join("")) as { recovered: unknown[] };
    expect(parsed.recovered).toHaveLength(1);
  });
});
