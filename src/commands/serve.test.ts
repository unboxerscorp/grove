import { afterEach, describe, expect, test, vi } from "vitest";

import type { Context } from "../context.js";
import { loadContext } from "../context.js";
import { createDefaultGroveFacadeRuntime, createGroveChatServer } from "../serve.js";
import { cmdServe } from "./serve.js";

vi.mock("../context.js", () => ({
  loadContext: vi.fn(),
}));

vi.mock("../serve.js", () => ({
  createDefaultGroveFacadeRuntime: vi.fn(),
  createGroveChatServer: vi.fn(),
}));

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

function ctx(): Context {
  return {
    byName: new Map(),
    config: { cwd: "/repo", defaults: { agent: "codex" }, nodes: {}, session: "dev10" },
    configPath: "/repo/grove.yaml",
    nodes: [
      { agent: "codex", children: [], cwd: "/repo", name: "lead" },
      { agent: "claude", children: [], cwd: "/repo", name: "maker" },
    ],
    registry: { cwd: "/repo", nodes: {}, session: "dev10", updatedAt: "now" },
  };
}

describe("cmdServe", () => {
  test("rejects unknown nodes before listening", async () => {
    vi.mocked(loadContext).mockReturnValue(ctx());

    await expect(cmdServe(["missing"], {})).rejects.toThrow('unknown node "missing"');

    expect(createGroveChatServer).not.toHaveBeenCalled();
  });

  test("validates port range", async () => {
    vi.mocked(loadContext).mockReturnValue(ctx());

    await expect(cmdServe(["lead"], { port: "70000" })).rejects.toThrow("invalid port");
  });

  test("starts the chat server with selected nodes and closes on SIGTERM", async () => {
    const listen = vi.fn((_port: number, _host: string, cb: () => void) => cb());
    const close = vi.fn((cb: () => void) => cb());
    const runtime = { kind: "runtime" };
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.mocked(loadContext).mockReturnValue(ctx());
    vi.mocked(createDefaultGroveFacadeRuntime).mockReturnValue(runtime as never);
    vi.mocked(createGroveChatServer).mockReturnValue({ close, listen } as never);

    const running = cmdServe(["maker"], {
      config: "grove.yaml",
      host: "0.0.0.0",
      port: "9000",
      timeout: "5s",
    });
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    process.emit("SIGTERM");
    await running;

    expect(createGroveChatServer).toHaveBeenCalledWith({
      nodeNames: ["maker"],
      runtime,
      timeoutMs: 5000,
    });
    expect(listen).toHaveBeenCalledWith(9000, "0.0.0.0", expect.any(Function));
    expect(close).toHaveBeenCalled();
  });
});
