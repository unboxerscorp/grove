import { afterEach, describe, expect, test, vi } from "vitest";

import { getAdapter } from "./adapters/index.js";
import type { AgentAdapter } from "./adapters/types.js";
import { loadConfig, resolveNodes } from "./config.js";
import { loadContext, nodeOf } from "./context.js";
import { loadOrInit } from "./registry.js";

vi.mock("./adapters/index.js", () => ({
  getAdapter: vi.fn(
    () =>
      ({
        label: "codex",
        name: "codex",
      }) as AgentAdapter,
  ),
}));

vi.mock("./config.js", () => ({
  loadConfig: vi.fn(),
  resolveNodes: vi.fn(),
}));

vi.mock("./registry.js", () => ({
  loadOrInit: vi.fn(),
}));

afterEach(() => {
  vi.clearAllMocks();
});

describe("loadContext", () => {
  test("uses stable registry tmux_pane before config tmux target", () => {
    vi.mocked(loadConfig).mockReturnValue({
      config: {
        cwd: "/tmp/grove",
        defaults: { agent: "codex" },
        nodes: {},
        session: "sample",
      },
      path: "/tmp/grove/grove.yaml",
    });
    vi.mocked(resolveNodes).mockReturnValue([
      {
        agent: "codex",
        children: [],
        cwd: "/tmp/grove",
        name: "viewer",
        tmux: "1.2",
      },
    ]);
    vi.mocked(loadOrInit).mockReturnValue({
      cwd: "/tmp/grove",
      nodes: {
        viewer: {
          agent: "claude",
          name: "viewer",
          tmux_pane: "sample:1.%7",
        },
      },
      session: "sample",
      updatedAt: "2026-06-03T00:00:00.000Z",
    });

    const ctx = loadContext();

    expect(ctx.byName.get("viewer")?.addr).toBe("sample:1.%7");
    expect(ctx.byName.get("viewer")?.node.agent).toBe("codex");
    expect(getAdapter).toHaveBeenCalledWith("codex");
    expect(getAdapter).not.toHaveBeenCalledWith("claude");
  });

  test("resolves registry-only nodes for dispatch without adding them to configured nodes", () => {
    vi.mocked(loadConfig).mockReturnValue({
      config: {
        cwd: "/tmp/grove",
        defaults: { agent: "codex" },
        nodes: {},
        session: "sample",
      },
      path: "/tmp/grove/grove.yaml",
    });
    vi.mocked(resolveNodes).mockReturnValue([
      {
        agent: "codex",
        children: [],
        cwd: "/tmp/grove",
        name: "lead",
      },
    ]);
    vi.mocked(loadOrInit).mockReturnValue({
      cwd: "/tmp/live-registry",
      nodes: {
        lead: {
          agent: "codex",
          name: "lead",
          tmux_pane: "sample:1.0",
        },
        "orch-platform": {
          agent: "claude",
          children: ["grove-auth"],
          group: "platform",
          name: "orch-platform",
          parent: "lead",
          role: "Sub-orchestrator",
          sessionId: "session-orch",
          tmux_pane: "sample:13.2",
          transcript: "/tmp/live-registry/orch.jsonl",
        },
        "grove-auth": {
          agent: "antigravity",
          name: "grove-auth",
          parent: "orch-platform",
          sessionId: "session-auth",
          transcript: "/tmp/live-registry/auth.log",
        },
      },
      session: "sample",
      updatedAt: "2026-06-03T00:00:00.000Z",
    });

    const ctx = loadContext();
    const live = nodeOf(ctx, "orch-platform");
    const fallback = nodeOf(ctx, "grove-auth");

    expect(ctx.nodes.map((node) => node.name)).toEqual(["lead"]);
    expect(ctx.byName.has("lead")).toBe(true);
    expect(live.addr).toBe("sample:13.2");
    expect(live.node).toEqual(
      expect.objectContaining({
        agent: "claude",
        children: ["grove-auth"],
        cwd: "/tmp/live-registry",
        group: "platform",
        name: "orch-platform",
        parent: "lead",
        role: "Sub-orchestrator",
      }),
    );
    expect(fallback.addr).toBe("sample:grove-auth");
    expect(fallback.node).toEqual(
      expect.objectContaining({
        agent: "antigravity",
        cwd: "/tmp/live-registry",
        name: "grove-auth",
        parent: "orch-platform",
      }),
    );
    expect(getAdapter).toHaveBeenCalledWith("codex");
    expect(getAdapter).toHaveBeenCalledWith("claude");
    expect(getAdapter).toHaveBeenCalledWith("antigravity");
  });
});
