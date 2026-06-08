import { afterEach, describe, expect, test, vi } from "vitest";

import { loadContext } from "../context.js";
import type { FanInResult } from "../fanin.js";
import { renderGatherJson, renderGatherText, waitForFanIn } from "../fanin.js";
import { resolveGatherTargets } from "../project-address.js";
import { cmdGather } from "./gather.js";

vi.mock("../context.js", () => ({
  loadContext: vi.fn(),
}));

vi.mock("../fanin.js", () => ({
  renderGatherJson: vi.fn(),
  renderGatherText: vi.fn(),
  waitForFanIn: vi.fn(),
}));

vi.mock("../project-address.js", () => ({
  resolveGatherTargets: vi.fn(),
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
    const ctx = { config: { session: "sample" } };
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
    vi.mocked(loadContext).mockReturnValue({ config: { session: "sample" } } as never);
    vi.mocked(waitForFanIn).mockResolvedValue(fanIn(true));
    vi.mocked(renderGatherText).mockReturnValue("partial");

    await cmdGather(["a"], {});

    expect(process.exitCode).toBe(1);
  });

  test("waits on target project nodes resolved from qualified gather addresses", async () => {
    const callerCtx = { config: { session: "sample" } };
    const targetCtx = { config: { session: "dev11" } };
    const result = fanIn(false);
    const writes: string[] = [];
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
    });
    vi.mocked(loadContext).mockReturnValue(callerCtx as never);
    vi.mocked(resolveGatherTargets).mockReturnValue([
      {
        callerCtx: callerCtx as never,
        crossProject: true,
        labels: ["dev11:a", "dev11:b"],
        nodes: ["a", "b"],
        project: "dev11",
        targetCtx: targetCtx as never,
      },
    ]);
    vi.mocked(waitForFanIn).mockResolvedValue(result);
    vi.mocked(renderGatherJson).mockReturnValue('{"ok":true}');

    await cmdGather(["dev11:a", "dev11:b"], { json: true, timeout: "3s" });

    expect(resolveGatherTargets).toHaveBeenCalledWith(callerCtx, ["dev11:a", "dev11:b"], {
      json: true,
      timeout: "3s",
    });
    expect(waitForFanIn).toHaveBeenCalledWith(targetCtx, ["a", "b"], {
      mode: "all",
      timeoutMs: 3000,
    });
    expect(writes).toEqual(['{"ok":true}\n']);
  });

  test("merges fan-in results from multiple project groups", async () => {
    const callerCtx = { config: { session: "sample" } };
    const dev11Ctx = { config: { session: "dev11" } };
    const dev12Ctx = { config: { session: "dev12" } };
    const writes: string[] = [];
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
    });
    vi.mocked(loadContext).mockReturnValue(callerCtx as never);
    vi.mocked(resolveGatherTargets).mockReturnValue([
      {
        callerCtx: callerCtx as never,
        crossProject: true,
        labels: ["dev11:a"],
        nodes: ["a"],
        project: "dev11",
        targetCtx: dev11Ctx as never,
      },
      {
        callerCtx: callerCtx as never,
        crossProject: true,
        labels: ["dev12:b"],
        nodes: ["b"],
        project: "dev12",
        targetCtx: dev12Ctx as never,
      },
    ]);
    vi.mocked(waitForFanIn)
      .mockResolvedValueOnce({
        ...fanIn(false),
        completed: [
          {
            marker: "a",
            node: "a",
            status: "done",
            transcriptId: "ta",
            transcriptOffset: 1,
            ts: 2,
            turnId: "turn-a",
          },
        ],
        order: [
          {
            marker: "a",
            node: "a",
            status: "done",
            transcriptId: "ta",
            transcriptOffset: 1,
            ts: 2,
            turnId: "turn-a",
          },
        ],
        summaries: { a: "done a" },
      })
      .mockResolvedValueOnce({
        ...fanIn(false),
        completed: [
          {
            marker: "b",
            node: "b",
            status: "done",
            transcriptId: "tb",
            transcriptOffset: 1,
            ts: 1,
            turnId: "turn-b",
          },
        ],
        order: [
          {
            marker: "b",
            node: "b",
            status: "done",
            transcriptId: "tb",
            transcriptOffset: 1,
            ts: 1,
            turnId: "turn-b",
          },
        ],
        summaries: { b: "done b" },
      });
    vi.mocked(renderGatherJson).mockImplementation((result) => JSON.stringify(result));

    await cmdGather(["dev11:a", "dev12:b"], { json: true, timeout: "3s" });

    expect(waitForFanIn).toHaveBeenCalledWith(dev11Ctx, ["a"], {
      mode: "all",
      timeoutMs: 3000,
    });
    expect(waitForFanIn).toHaveBeenCalledWith(dev12Ctx, ["b"], {
      mode: "all",
      timeoutMs: 3000,
    });
    const payload = JSON.parse(writes[0]!) as FanInResult;
    expect(payload.completed.map((item) => item.node)).toEqual(["dev11:a", "dev12:b"]);
    expect(payload.order.map((item) => item.node)).toEqual(["dev12:b", "dev11:a"]);
    expect(payload.summaries).toEqual({ "dev11:a": "done a", "dev12:b": "done b" });
  });
});
