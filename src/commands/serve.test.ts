import { afterEach, describe, expect, test, vi } from "vitest";

import type { Context } from "../context.js";
import { loadContext } from "../context.js";
import { createDefaultGroveFacadeRuntime, createGroveChatServer } from "../serve.js";
import { cmdServe, resolveServeHost } from "./serve.js";

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
  test("defaults to loopback for the unauthenticated chat-completions facade", () => {
    expect(resolveServeHost({})).toBe("127.0.0.1");
    expect(resolveServeHost({ host: "localhost" })).toBe("localhost");
    expect(resolveServeHost({ host: "::1" })).toBe("::1");
  });

  test("refuses non-loopback bind targets before listening", async () => {
    vi.mocked(loadContext).mockReturnValue(ctx());

    await expect(cmdServe(["lead"], { host: "0.0.0.0" })).rejects.toThrow(
      "refusing to bind unauthenticated chat-completions facade to non-loopback host",
    );

    expect(createGroveChatServer).not.toHaveBeenCalled();
  });

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
    expect(listen).toHaveBeenCalledWith(9000, "127.0.0.1", expect.any(Function));
    expect(close).toHaveBeenCalled();
  });

  test("prints only the local facade URL", async () => {
    const writes: string[] = [];
    const listen = vi.fn((_port: number, _host: string, cb: () => void) => cb());
    const close = vi.fn((cb: () => void) => cb());
    const runtime = { kind: "runtime" };
    vi.spyOn(console, "error").mockImplementation((line?: string) => {
      writes.push(line ?? "");
    });
    vi.mocked(loadContext).mockReturnValue(ctx());
    vi.mocked(createDefaultGroveFacadeRuntime).mockReturnValue(runtime as never);
    vi.mocked(createGroveChatServer).mockReturnValue({ close, listen } as never);

    const running = cmdServe(["maker"], {
      host: "localhost",
      port: "9000",
    });
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    process.emit("SIGTERM");
    await running;

    const output = writes.join("\n");
    expect(listen).toHaveBeenCalledWith(9000, "localhost", expect.any(Function));
    expect(output).toContain("http://localhost:9000/v1/chat/completions");
    expect(output).not.toMatch(/share .*teammates/i);
    expect(output).not.toContain("shared access");
  });
});
