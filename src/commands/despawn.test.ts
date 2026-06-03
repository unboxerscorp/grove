import { afterEach, describe, expect, test, vi } from "vitest";

import type { Context } from "../context.js";
import type { Registry } from "../registry.js";
import { type DespawnDeps, despawnNodes, renderDespawnJson, renderDespawnText } from "./despawn.js";

afterEach(() => {
  vi.restoreAllMocks();
});

function registry(): Registry {
  return {
    cwd: "/repo",
    nodes: {
      lead: {
        agent: "claude",
        children: ["maker", "viewer"],
        name: "lead",
        role: "Lead",
        tmux_pane: "dev10:1.%1",
      },
      maker: {
        agent: "codex",
        children: [],
        group: "core",
        name: "maker",
        parent: "lead",
        role: "Maker",
        tmux_pane: "dev10:2.%5",
      },
      viewer: {
        agent: "antigravity",
        children: [],
        group: "core",
        name: "viewer",
        parent: "lead",
        role: "Viewer",
        tmux_pane: "dev10:2.%6",
      },
    },
    session: "dev10",
    updatedAt: "2026-06-03T00:00:00.000Z",
  };
}

function context(reg = registry()): Context {
  return {
    byName: new Map(),
    config: {
      cwd: "/repo",
      defaults: { agent: "codex" },
      nodes: {},
      session: reg.session,
    },
    configPath: "/repo/grove.yaml",
    nodes: [],
    registry: reg,
  };
}

function deps(killResult = true): {
  deps: DespawnDeps;
  guardSessions: string[];
  killed: string[];
  saves: number;
} {
  const guardSessions: string[] = [];
  const killed: string[] = [];
  let saves = 0;
  return {
    deps: {
      hasSession: async () => true,
      killPane: async (addr) => {
        killed.push(addr);
        return killResult;
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
    killed,
  };
}

describe("despawnNodes", () => {
  test("kills exactly the node pane, removes registry entry, and updates parent children", async () => {
    const ctx = context();
    const state = deps();

    const result = await despawnNodes(ctx, { node: "maker" }, state.deps);

    expect(state.guardSessions).toEqual(["dev10"]);
    expect(state.killed).toEqual(["dev10:2.%5"]);
    expect(ctx.registry.nodes.maker).toBeUndefined();
    expect(ctx.registry.nodes.lead?.children).toEqual(["viewer"]);
    expect(state.saves).toBe(1);
    expect(result.removed).toEqual([
      {
        name: "maker",
        pane: "dev10:2.%5",
        paneKilled: true,
        paneMissing: false,
      },
    ]);
  });

  test("cleans the registry even when the pane is already gone", async () => {
    const ctx = context();
    const state = deps(false);

    const result = await despawnNodes(ctx, { node: "maker" }, state.deps);

    expect(state.killed).toEqual(["dev10:2.%5"]);
    expect(ctx.registry.nodes.maker).toBeUndefined();
    expect(result.removed[0]).toEqual(
      expect.objectContaining({
        name: "maker",
        paneKilled: false,
        paneMissing: true,
      }),
    );
  });

  test("skips killing ambiguous pane targets and cleans only the registry", async () => {
    const reg = registry();
    reg.nodes.maker!.tmux_pane = "dev10:2";
    const ctx = context(reg);
    const state = deps();

    const result = await despawnNodes(ctx, { node: "maker" }, state.deps);

    expect(state.killed).toEqual([]);
    expect(ctx.registry.nodes.maker).toBeUndefined();
    expect(result.removed[0]).toEqual(
      expect.objectContaining({
        name: "maker",
        pane: "dev10:2",
        paneKilled: false,
        paneMissing: true,
      }),
    );
  });

  test("requires confirmation for group teardown", async () => {
    const ctx = context();
    const state = deps();

    await expect(despawnNodes(ctx, { group: "core" }, state.deps)).rejects.toThrow(
      "bulk despawn requires --yes",
    );

    expect(state.killed).toEqual([]);
  });

  test("tears down a group and removes parent links", async () => {
    const ctx = context();
    const state = deps();

    const result = await despawnNodes(ctx, { group: "core", yes: true }, state.deps);

    expect(state.killed).toEqual(["dev10:2.%5", "dev10:2.%6"]);
    expect(Object.keys(ctx.registry.nodes)).toEqual(["lead"]);
    expect(ctx.registry.nodes.lead?.children).toEqual([]);
    expect(result.removed.map((item) => item.name)).toEqual(["maker", "viewer"]);
  });

  test("tears down all registry nodes after confirmation without a live session", async () => {
    const ctx = context();
    const state = deps();
    state.deps.hasSession = async () => false;

    const result = await despawnNodes(ctx, { all: true, yes: true }, state.deps);

    expect(state.guardSessions).toEqual([]);
    expect(state.killed).toEqual([]);
    expect(ctx.registry.nodes).toEqual({});
    expect(result.removed).toHaveLength(3);
  });

  test("renders text and JSON summaries", () => {
    const result = {
      removed: [
        {
          name: "maker",
          pane: "dev10:2.%5",
          paneKilled: true,
          paneMissing: false,
        },
      ],
      session: "dev10",
    };

    expect(renderDespawnText(result)).toContain("maker: killed pane=dev10:2.%5");
    expect(JSON.parse(renderDespawnJson(result))).toEqual(result);
  });
});
