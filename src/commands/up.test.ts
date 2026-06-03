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
      config: { cwd: "/repo", defaults: { agent: "codex" }, nodes: {}, session: "dev10" },
      configPath: "/repo/grove.yaml",
      nodes: [],
      registry: { cwd: "/repo", nodes: {}, session: "dev10", updatedAt: "now" },
    } satisfies Context;
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.mocked(loadContext).mockReturnValue(ctx);
    vi.mocked(bringUp).mockResolvedValue({ adopted: ["lead"], created: true, launched: ["maker"] });

    await cmdUp({ config: "grove.yaml" });

    expect(bringUp).toHaveBeenCalledWith(ctx);
    expect(renderStatus).toHaveBeenCalledWith(ctx);
  });
});
