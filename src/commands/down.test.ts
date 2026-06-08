import { afterEach, describe, expect, test, vi } from "vitest";

import type { Context } from "../context.js";
import { loadContext } from "../context.js";
import { hasSession, killSession } from "../tmux.js";
import { cmdDown } from "./down.js";

vi.mock("../context.js", () => ({
  loadContext: vi.fn(),
}));

vi.mock("../tmux.js", () => ({
  hasSession: vi.fn(),
  killSession: vi.fn(),
}));

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

function ctx(): Context {
  return {
    byName: new Map(),
    config: { cwd: "/repo", defaults: { agent: "codex" }, nodes: {}, session: "sample" },
    configPath: "/repo/grove.yaml",
    nodes: [],
    registry: { cwd: "/repo", nodes: {}, session: "sample", updatedAt: "now" },
  };
}

describe("cmdDown", () => {
  test("kills an existing tmux session", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.mocked(loadContext).mockReturnValue(ctx());
    vi.mocked(hasSession).mockResolvedValue(true);

    await cmdDown({ config: "grove.yaml" });

    expect(hasSession).toHaveBeenCalledWith("sample");
    expect(killSession).toHaveBeenCalledWith("sample");
  });

  test("does not kill when the session is already down", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.mocked(loadContext).mockReturnValue(ctx());
    vi.mocked(hasSession).mockResolvedValue(false);

    await cmdDown({});

    expect(killSession).not.toHaveBeenCalled();
  });
});
