import { afterEach, describe, expect, test, vi } from "vitest";

import type { Context, NodeCtx } from "../context.js";
import { loadContext, nodeOf } from "../context.js";
import { resolveTranscript } from "../ops.js";
import { cmdSession } from "./session.js";

vi.mock("../context.js", () => ({
  loadContext: vi.fn(),
  nodeOf: vi.fn(),
}));

vi.mock("../ops.js", () => ({
  resolveTranscript: vi.fn(),
}));

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("cmdSession", () => {
  test("prints node session metadata as JSON", async () => {
    const nc = {
      adapter: { size: () => 123 },
      addr: "sample:1.%1",
      node: { agent: "codex", children: [], cwd: "/repo", name: "maker", resume: "resume-id" },
    } as unknown as NodeCtx;
    const ctx = {
      byName: new Map([["maker", nc]]),
      config: { cwd: "/repo", defaults: { agent: "codex" }, nodes: {}, session: "sample" },
      configPath: "/repo/grove.yaml",
      nodes: [nc.node],
      registry: {
        cwd: "/repo",
        nodes: { maker: { agent: "codex", name: "maker", sessionId: "session-id" } },
        session: "sample",
        updatedAt: "now",
      },
    } as Context;
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((line?: string) => {
      lines.push(line ?? "");
    });
    vi.mocked(loadContext).mockReturnValue(ctx);
    vi.mocked(nodeOf).mockReturnValue(nc);
    vi.mocked(resolveTranscript).mockReturnValue("/repo/maker.jsonl");

    await cmdSession("maker", { config: "grove.yaml" });

    expect(JSON.parse(lines.join("\n"))).toEqual({
      agent: "codex",
      bytes: 123,
      node: "maker",
      sessionId: "session-id",
      transcript: "/repo/maker.jsonl",
    });
  });
});
