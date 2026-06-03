import { afterEach, describe, expect, test, vi } from "vitest";

import { loadContext } from "../context.js";
import type { FanInResult } from "../fanin.js";
import { renderGatherJson, renderGatherText, waitForFanIn } from "../fanin.js";
import { cmdGather } from "./gather.js";

vi.mock("../context.js", () => ({
  loadContext: vi.fn(),
}));

vi.mock("../fanin.js", () => ({
  renderGatherJson: vi.fn(),
  renderGatherText: vi.fn(),
  waitForFanIn: vi.fn(),
}));

afterEach(() => {
  process.exitCode = undefined;
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

function fanIn(deadlineExceeded = false): FanInResult {
  return {
    completed: [],
    deadlineExceeded,
    failed: [],
    mode: "all",
    nextEventLogOffset: 0,
    order: [],
    pending: [],
    summaries: {},
  };
}

describe("cmdGather", () => {
  test("rejects an empty node list", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    await cmdGather([], {});

    expect(loadContext).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  test("waits for all nodes and writes JSON output", async () => {
    const ctx = { config: { session: "dev10" } };
    const result = fanIn(false);
    const writes: string[] = [];
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
    });
    vi.mocked(loadContext).mockReturnValue(ctx as never);
    vi.mocked(waitForFanIn).mockResolvedValue(result);
    vi.mocked(renderGatherJson).mockReturnValue('{"ok":true}');

    await cmdGather(["a", "b"], { json: true, timeout: "3s" });

    expect(waitForFanIn).toHaveBeenCalledWith(ctx, ["a", "b"], { mode: "all", timeoutMs: 3000 });
    expect(writes).toEqual(['{"ok":true}\n']);
    expect(process.exitCode).toBeUndefined();
  });

  test("sets exitCode when the fan-in deadline is exceeded", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    vi.mocked(loadContext).mockReturnValue({} as never);
    vi.mocked(waitForFanIn).mockResolvedValue(fanIn(true));
    vi.mocked(renderGatherText).mockReturnValue("partial");

    await cmdGather(["a"], {});

    expect(process.exitCode).toBe(1);
  });
});
