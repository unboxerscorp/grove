import { describe, expect, test, vi } from "vitest";

import type { AgentAdapter } from "./adapters/types.js";
import { loadConfig, resolveNodes } from "./config.js";
import { loadContext } from "./context.js";
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

describe("loadContext", () => {
  test("uses stable registry tmux_pane before config tmux target", () => {
    vi.mocked(loadConfig).mockReturnValue({
      config: {
        cwd: "/tmp/grove",
        defaults: { agent: "codex" },
        nodes: {},
        session: "dev10",
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
          agent: "codex",
          name: "viewer",
          tmux_pane: "dev10:1.%7",
        },
      },
      session: "dev10",
      updatedAt: "2026-06-03T00:00:00.000Z",
    });

    const ctx = loadContext();

    expect(ctx.byName.get("viewer")?.addr).toBe("dev10:1.%7");
  });
});
