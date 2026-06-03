import { afterEach, describe, expect, test, vi } from "vitest";

import type { AgentAdapter } from "../adapters/types.js";
import type { Context, NodeCtx } from "../context.js";
import { resolveTranscript } from "../ops.js";
import { hasSession, paneCommand } from "../tmux.js";
import { renderStatus } from "./status.js";

vi.mock("../ops.js", () => ({
  resolveTranscript: vi.fn(),
}));

vi.mock("../tmux.js", () => ({
  hasSession: vi.fn(),
  paneCommand: vi.fn(),
}));

afterEach(() => {
  vi.restoreAllMocks();
});

function adapter(label: string): AgentAdapter {
  return {
    detectNew: () => null,
    label,
    launchCommand: () => label,
    name: "codex",
    readCompletionSince: () => ({ done: false, offset: 0 }),
    readLast: () => "last\nturn summary",
    readyPattern: /ready/,
    sessionIdFromPath: () => null,
    size: () => 1,
    snapshot: () => new Map<string, number>(),
    submit: "enter",
    transcriptForSession: () => "",
  };
}

function context(): Context {
  const lead = {
    agent: "codex" as const,
    children: ["maker"],
    cwd: "/repo",
    name: "lead",
  };
  const maker = {
    agent: "codex" as const,
    children: [],
    cwd: "/repo",
    name: "maker",
    parent: "lead",
  };
  const byName = new Map<string, NodeCtx>([
    ["lead", { adapter: adapter("lead-adapter"), addr: "dev10:1.%1", node: lead }],
    ["maker", { adapter: adapter("maker-adapter"), addr: "dev10:1.%2", node: maker }],
  ]);
  return {
    byName,
    config: {
      cwd: "/repo",
      defaults: { agent: "codex" },
      nodes: {},
      session: "dev10",
    },
    configPath: "/repo/grove.yaml",
    nodes: [lead, maker],
    registry: {
      cwd: "/repo",
      nodes: {},
      session: "dev10",
      updatedAt: "2026-06-03T00:00:00.000Z",
    },
  };
}

describe("renderStatus", () => {
  test("renders live hierarchy with pane state and last transcript text", async () => {
    vi.mocked(hasSession).mockResolvedValue(true);
    vi.mocked(paneCommand).mockResolvedValueOnce("codex").mockResolvedValueOnce("zsh");
    vi.mocked(resolveTranscript).mockReturnValue("/tmp/transcript.jsonl");
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((line?: string) => {
      lines.push(line ?? "");
    });

    await renderStatus(context());

    expect(lines.join("\n")).toContain("dev10");
    expect(lines.join("\n")).toContain("lead [lead-adapter]");
    expect(lines.join("\n")).toContain("maker [maker-adapter]");
    expect(lines.join("\n")).toContain("last turn summary");
  });

  test("renders down sessions without querying pane commands", async () => {
    vi.mocked(hasSession).mockResolvedValue(false);
    vi.mocked(resolveTranscript).mockReturnValue("");
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    await renderStatus(context());

    expect(paneCommand).not.toHaveBeenCalled();
  });
});
