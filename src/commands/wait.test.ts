import { afterEach, describe, expect, test, vi } from "vitest";

import type { Context, NodeCtx } from "../context.js";
import { loadContext, nodeOf } from "../context.js";
import type { FanInResult } from "../fanin.js";
import { renderFanInJson, waitForFanIn } from "../fanin.js";
import { clearPending, resolvePending, waitForCompletion } from "../ops.js";
import { cmdWait, cmdWaitCommand } from "./wait.js";

vi.mock("../context.js", () => ({
  loadContext: vi.fn(),
  nodeOf: vi.fn(),
}));

vi.mock("../fanin.js", () => ({
  renderFanInJson: vi.fn(),
  waitForFanIn: vi.fn(),
}));

vi.mock("../ops.js", () => ({
  clearPending: vi.fn(),
  resolvePending: vi.fn(),
  waitForCompletion: vi.fn(),
}));

afterEach(() => {
  process.exitCode = undefined;
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

function harness(): { ctx: Context; nc: NodeCtx; writes: string[] } {
  const nc = {
    adapter: { label: "codex" },
    addr: "dev10:1.%1",
    node: { agent: "codex", children: [], cwd: "/repo", name: "maker" },
  } as unknown as NodeCtx;
  const ctx = {
    byName: new Map([["maker", nc]]),
    config: { cwd: "/repo", defaults: { agent: "codex" }, nodes: {}, session: "dev10" },
    configPath: "/repo/grove.yaml",
    nodes: [nc.node],
    registry: {
      cwd: "/repo",
      nodes: {
        maker: {
          agent: "codex",
          name: "maker",
          pending: {
            eventLogOffset: 7,
            fromOffset: 42,
            submittedAt: "now",
            transcript: "/repo/maker.jsonl",
          },
        },
      },
      session: "dev10",
      updatedAt: "now",
    },
  } as Context;
  const writes: string[] = [];
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
    writes.push(String(chunk));
    return true;
  });
  vi.mocked(loadContext).mockReturnValue(ctx);
  vi.mocked(nodeOf).mockReturnValue(nc);
  vi.mocked(resolvePending).mockReturnValue(ctx.registry.nodes.maker?.pending);
  return { ctx, nc, writes };
}

function fanIn(deadlineExceeded: boolean): FanInResult {
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

describe("cmdWait", () => {
  test("uses pending baseline, clears it, and writes completion", async () => {
    const { ctx, nc, writes } = harness();
    vi.mocked(waitForCompletion).mockResolvedValue("done");

    await cmdWait("maker", { timeout: "4s" });

    expect(waitForCompletion).toHaveBeenCalledWith(ctx, nc, {
      eventLogOffset: 7,
      fromOffset: 42,
      timeoutMs: 4000,
      transcript: "/repo/maker.jsonl",
    });
    expect(clearPending).toHaveBeenCalledWith(ctx, nc);
    expect(writes).toEqual(["done\n"]);
  });

  test("sets exitCode and keeps pending on timeout", async () => {
    harness();
    vi.mocked(waitForCompletion).mockResolvedValue(null);

    await cmdWait("maker", { timeout: "1ms" });

    expect(clearPending).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });
});

describe("cmdWaitCommand", () => {
  test("requires exactly one node without --any or --all", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    await cmdWaitCommand(["a", "b"], {});

    expect(loadContext).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  test("rejects --any and --all together", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    await cmdWaitCommand(["a"], { all: true, any: true });

    expect(loadContext).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  test("waits for fan-in mode and marks all-deadline failures", async () => {
    const { ctx, writes } = harness();
    vi.mocked(waitForFanIn).mockResolvedValue(fanIn(true));
    vi.mocked(renderFanInJson).mockReturnValue('{"deadlineExceeded":true}');

    await cmdWaitCommand(["a", "b"], { all: true, timeout: "2s" });

    expect(waitForFanIn).toHaveBeenCalledWith(ctx, ["a", "b"], { mode: "all", timeoutMs: 2000 });
    expect(writes).toEqual(['{"deadlineExceeded":true}\n']);
    expect(process.exitCode).toBe(1);
  });
});
