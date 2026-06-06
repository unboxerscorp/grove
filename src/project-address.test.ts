import { afterEach, describe, expect, test, vi } from "vitest";

import type { Context, NodeCtx } from "./context.js";
import {
  formatNodeAddress,
  parseProjectNodeAddress,
  resolveGatherTarget,
  resolveGatherTargets,
  resolveProjectNodeTarget,
} from "./project-address.js";
import { loadRegistry, type Registry } from "./registry.js";

vi.mock("./adapters/index.js", () => ({
  getAdapter: vi.fn(() => ({ label: "codex" })),
}));

vi.mock("./registry.js", () => ({
  loadRegistry: vi.fn(),
}));

afterEach(() => {
  vi.clearAllMocks();
});

function callerContext(): Context {
  const nc = {
    adapter: { label: "codex" },
    addr: "dev10:1.0",
    node: { agent: "codex", children: [], cwd: "/repo/dev10", name: "local" },
  } as unknown as NodeCtx;
  return {
    byName: new Map([["local", nc]]),
    config: { cwd: "/repo/dev10", defaults: { agent: "codex" }, nodes: {}, session: "dev10" },
    configPath: "/repo/dev10/grove.yaml",
    nodes: [nc.node],
    registry: { cwd: "/repo/dev10", nodes: {}, session: "dev10", updatedAt: "now" },
  };
}

describe("project node addresses", () => {
  test("parses [project:]node addresses and rejects conflicting --project values", () => {
    expect(parseProjectNodeAddress("worker")).toEqual({ node: "worker", project: undefined });
    expect(parseProjectNodeAddress("dev11:worker")).toEqual({
      node: "worker",
      project: "dev11",
    });
    expect(parseProjectNodeAddress("worker", { project: "dev11" })).toEqual({
      node: "worker",
      project: "dev11",
    });

    expect(() => parseProjectNodeAddress("dev11:worker", { project: "dev12" })).toThrow(
      /conflicting projects/,
    );
  });

  test("loads an external project registry for a qualified node target", () => {
    vi.mocked(loadRegistry).mockReturnValue({
      cwd: "/repo/dev11",
      nodes: {
        worker: {
          agent: "claude",
          children: ["reviewer"],
          cwd: "/repo/dev11/worker",
          name: "worker",
          role: "Remote maker",
          tmux_pane: "dev11:2.0",
        },
      },
      session: "dev11",
      updatedAt: "now",
    });

    const callerCtx = callerContext();
    const target = resolveProjectNodeTarget(callerCtx, "dev11:worker");

    expect(loadRegistry).toHaveBeenCalledWith("dev11");
    expect(target.callerCtx).toBe(callerCtx);
    expect(target.targetCtx.config.session).toBe("dev11");
    expect(target.nc.addr).toBe("dev11:2.0");
    expect(target.nc.node.role).toBe("Remote maker");
    expect(target.label).toBe("worker@dev11");
  });

  test("strips external project prefixes for gather target groups", () => {
    const dev11Registry: Registry = {
      cwd: "/repo/dev11",
      nodes: {
        alpha: { agent: "codex", children: [], name: "alpha", tmux_pane: "dev11:1.0" },
        beta: { agent: "codex", children: [], name: "beta", tmux_pane: "dev11:1.1" },
      },
      session: "dev11",
      updatedAt: "now",
    };
    const dev12Registry: Registry = {
      cwd: "/repo/dev12",
      nodes: {
        gamma: { agent: "codex", children: [], name: "gamma", tmux_pane: "dev12:1.0" },
      },
      session: "dev12",
      updatedAt: "now",
    };
    vi.mocked(loadRegistry).mockImplementation((project) =>
      project === "dev11" ? dev11Registry : dev12Registry,
    );

    const target = resolveGatherTarget(callerContext(), ["dev11:alpha", "dev11:beta"]);
    const mixed = resolveGatherTargets(callerContext(), ["dev11:alpha", "dev12:gamma"]);

    expect(target.nodes).toEqual(["alpha", "beta"]);
    expect(target.labels).toEqual(["alpha@dev11", "beta@dev11"]);
    expect(target.project).toBe("dev11");
    expect(mixed.map((group) => group.project)).toEqual(["dev11", "dev12"]);
    expect(mixed.map((group) => group.nodes)).toEqual([["alpha"], ["gamma"]]);
  });

  test("parses canonical node@project addresses (matches org display)", () => {
    expect(parseProjectNodeAddress("worker@dev11")).toEqual({ node: "worker", project: "dev11" });
    expect(parseProjectNodeAddress("lead@base-web-admin")).toEqual({
      node: "lead",
      project: "base-web-admin",
    });
    expect(parseProjectNodeAddress("worker@dev11", { project: "dev11" })).toEqual({
      node: "worker",
      project: "dev11",
    });
    expect(() => parseProjectNodeAddress("worker@dev11", { project: "dev12" })).toThrow(
      /conflicting projects/,
    );
  });

  test("still parses legacy project:node addresses (backcompat)", () => {
    expect(parseProjectNodeAddress("dev11:worker")).toEqual({ node: "worker", project: "dev11" });
  });

  test("formatNodeAddress emits the canonical form and round-trips with the parser", () => {
    expect(formatNodeAddress("worker", "dev11", { homeProject: "dev10" })).toBe("worker@dev11");
    expect(formatNodeAddress("worker", "dev10", { homeProject: "dev10" })).toBe("worker");
    for (const [node, project] of [
      ["worker", "dev11"],
      ["lead", "base-web-admin"],
    ] as const) {
      expect(
        parseProjectNodeAddress(formatNodeAddress(node, project, { homeProject: "dev10" })),
      ).toEqual({
        node,
        project,
      });
    }
  });
});
