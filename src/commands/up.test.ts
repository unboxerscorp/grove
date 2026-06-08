import { afterEach, describe, expect, test, vi } from "vitest";

import type { Context } from "../context.js";
import { loadContext } from "../context.js";
import { bringUp } from "../ops.js";
import { renderStatus } from "./status.js";
import { cmdUp } from "./up.js";

vi.mock("../context.js", () => ({
  loadContext: vi.fn(),
}));

vi.mock("../ops.js", () => ({
  bringUp: vi.fn(),
}));

vi.mock("./status.js", () => ({
  renderStatus: vi.fn(),
}));

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("cmdUp", () => {
  test("loads context, brings nodes up, then renders status", async () => {
    const ctx = {
      byName: new Map(),
      config: { cwd: "/repo", defaults: { agent: "codex" }, nodes: {}, session: "sample" },
      configPath: "/repo/grove.yaml",
      nodes: [],
      registry: { cwd: "/repo", nodes: {}, session: "sample", updatedAt: "now" },
    } satisfies Context;
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.mocked(loadContext).mockReturnValue(ctx);
    vi.mocked(bringUp).mockResolvedValue({ adopted: ["lead"], created: true, launched: ["maker"] });

    await cmdUp({ config: "grove.yaml" });

    expect(bringUp).toHaveBeenCalledWith(ctx);
    expect(renderStatus).toHaveBeenCalledWith(ctx);
  });

  test("keeps registry-only nodes visible to status without adding them to bring-up nodes", async () => {
    const configured = {
      agent: "codex" as const,
      children: [],
      cwd: "/repo",
      name: "lead",
    };
    const spawned = {
      agent: "claude" as const,
      children: [],
      cwd: "/repo",
      name: "orch-platform",
      parent: "lead",
    };
    const ctx = {
      byName: new Map([
        ["lead", { adapter: {} as never, addr: "sample:0.0", node: configured }],
        ["orch-platform", { adapter: {} as never, addr: "sample:1.1", node: spawned }],
      ]),
      config: { cwd: "/repo", defaults: { agent: "codex" }, nodes: {}, session: "sample" },
      configPath: "/repo/grove.yaml",
      nodes: [configured],
      registry: {
        cwd: "/repo",
        nodes: {
          "orch-platform": {
            agent: "claude",
            name: "orch-platform",
            parent: "lead",
            tmux_pane: "sample:1.1",
          },
        },
        session: "sample",
        updatedAt: "now",
      },
    } satisfies Context;
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.mocked(loadContext).mockReturnValue(ctx);
    vi.mocked(bringUp).mockResolvedValue({ adopted: [], created: false, launched: [] });

    await cmdUp({ config: "grove.yaml" });

    expect(vi.mocked(bringUp).mock.calls[0]?.[0].nodes.map((node) => node.name)).toEqual(["lead"]);
    expect(vi.mocked(renderStatus).mock.calls[0]?.[0].byName.has("orch-platform")).toBe(true);
  });
});
