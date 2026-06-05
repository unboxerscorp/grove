import { afterEach, describe, expect, test, vi } from "vitest";

import type { Context, NodeCtx } from "../context.js";
import { loadContext, nodeOf } from "../context.js";
import { ask } from "../ops.js";
import { resolveProjectNodeTarget } from "../project-address.js";
import { cmdAsk } from "./ask.js";

vi.mock("../context.js", () => ({
  loadContext: vi.fn(),
  nodeOf: vi.fn(),
}));

vi.mock("../ops.js", () => ({
  ask: vi.fn(),
}));

vi.mock("../project-address.js", () => ({
  resolveProjectNodeTarget: vi.fn(),
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
    registry: { cwd: "/repo", nodes: {}, session: "dev10", updatedAt: "now" },
  } as Context;
  const writes: string[] = [];
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
    writes.push(String(chunk));
    return true;
  });
  vi.mocked(loadContext).mockReturnValue(ctx);
  vi.mocked(nodeOf).mockReturnValue(nc);
  return { ctx, nc, writes };
}

describe("cmdAsk", () => {
  test("asks a node, waits, and writes the answer", async () => {
    const { ctx, nc, writes } = harness();
    vi.mocked(ask).mockResolvedValue("answer");

    await cmdAsk("maker", "hello", { config: "grove.yaml", timeout: "2s" });

    expect(loadContext).toHaveBeenCalledWith("grove.yaml");
    expect(ask).toHaveBeenCalledWith(ctx, nc, "hello", 2000);
    expect(writes).toEqual(["answer\n"]);
    expect(process.exitCode).toBeUndefined();
  });

  test("sets exitCode when the ask times out", async () => {
    const { writes } = harness();
    vi.mocked(ask).mockResolvedValue(null);

    await cmdAsk("maker", "hello", { timeout: "1ms" });

    expect(writes).toEqual([]);
    expect(process.exitCode).toBe(1);
  });

  test("asks a node in another project with caller context preserved for dispatch", async () => {
    const { ctx, nc, writes } = harness();
    const targetCtx: Context = {
      ...ctx,
      config: { ...ctx.config, session: "dev11" },
    };
    const targetNc: NodeCtx = {
      ...nc,
      addr: "dev11:1.0",
    };
    vi.mocked(resolveProjectNodeTarget).mockReturnValue({
      callerCtx: ctx,
      crossProject: true,
      label: "dev11:maker",
      nc: targetNc,
      node: "maker",
      project: "dev11",
      targetCtx,
    });
    vi.mocked(ask).mockResolvedValue("remote answer");

    await cmdAsk("maker", "hello", { project: "dev11", timeout: "2s" });

    expect(resolveProjectNodeTarget).toHaveBeenCalledWith(
      ctx,
      "maker",
      expect.objectContaining({ project: "dev11" }),
    );
    expect(ask).toHaveBeenCalledWith(targetCtx, targetNc, "hello", 2000, {
      submissionContext: ctx,
      submissionProject: "dev10",
    });
    expect(writes).toEqual(["remote answer\n"]);
  });
});
