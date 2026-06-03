import { afterEach, describe, expect, test, vi } from "vitest";

import type { Context, NodeCtx } from "../context.js";
import { loadContext, nodeOf } from "../context.js";
import { resolveTranscript } from "../ops.js";
import { waitForChangeOrTimeout } from "../util/watch.js";
import { cmdTail } from "./tail.js";

vi.mock("../context.js", () => ({
  loadContext: vi.fn(),
  nodeOf: vi.fn(),
}));

vi.mock("../ops.js", () => ({
  resolveTranscript: vi.fn(),
}));

vi.mock("../util/watch.js", () => ({
  waitForChangeOrTimeout: vi.fn(),
}));

afterEach(() => {
  process.exitCode = undefined;
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

function harness(): {
  ctx: Context;
  lines: string[];
  nc: NodeCtx;
  readCompletionSince: ReturnType<typeof vi.fn>;
} {
  const readCompletionSince = vi.fn(() => ({ done: true, offset: 20, text: "tail result" }));
  const nc = {
    adapter: {
      label: "codex",
      readCompletionSince,
      size: vi.fn(() => 10),
    },
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
  const lines: string[] = [];
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(console, "log").mockImplementation((line?: string) => {
    lines.push(line ?? "");
  });
  vi.mocked(loadContext).mockReturnValue(ctx);
  vi.mocked(nodeOf).mockReturnValue(nc);
  return { ctx, lines, nc, readCompletionSince };
}

describe("cmdTail", () => {
  test("fails fast when no transcript is available", async () => {
    harness();
    vi.mocked(resolveTranscript).mockReturnValue("");

    await cmdTail("maker", {});

    expect(process.exitCode).toBe(1);
    expect(waitForChangeOrTimeout).not.toHaveBeenCalled();
  });

  test("prints completed turns and waits for the next change", async () => {
    const { lines, readCompletionSince } = harness();
    vi.mocked(resolveTranscript).mockReturnValue("/repo/maker.jsonl");
    vi.mocked(waitForChangeOrTimeout).mockRejectedValue(new Error("stop tail"));

    await expect(cmdTail("maker", {})).rejects.toThrow("stop tail");

    expect(readCompletionSince).toHaveBeenCalledWith("/repo/maker.jsonl", 10);
    expect(lines.join("\n")).toContain("tail result");
  });
});
