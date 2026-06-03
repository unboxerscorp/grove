import { afterEach, describe, expect, test, vi } from "vitest";

import { loadContext } from "../context.js";
import { startTurnEventWatcher } from "../watch.js";
import { cmdWatch } from "./watch.js";

vi.mock("../context.js", () => ({
  loadContext: vi.fn(),
}));

vi.mock("../watch.js", () => ({
  startTurnEventWatcher: vi.fn(),
}));

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("cmdWatch", () => {
  test("starts a watcher and stops it on SIGINT", async () => {
    const ctx = { config: { session: "dev10" } };
    const stop = vi.fn();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.mocked(loadContext).mockReturnValue(ctx as never);
    vi.mocked(startTurnEventWatcher).mockReturnValue({ stop, watched: ["maker"] });

    const running = cmdWatch({ config: "grove.yaml" });
    process.emit("SIGINT");
    await running;

    const call = vi.mocked(startTurnEventWatcher).mock.calls[0]!;
    expect(call[0]).toBe(ctx);
    const options = call[1];
    expect(options).toBeDefined();
    if (!options) throw new Error("missing watcher options");
    expect(typeof options.reloadContext).toBe("function");
    expect(stop).toHaveBeenCalled();
  });

  test("warns when no transcripts are watched and stops on SIGTERM", async () => {
    const stop = vi.fn();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.mocked(loadContext).mockReturnValue({} as never);
    vi.mocked(startTurnEventWatcher).mockReturnValue({ stop, watched: [] });

    const running = cmdWatch({});
    process.emit("SIGTERM");
    await running;

    expect(stop).toHaveBeenCalled();
  });
});
