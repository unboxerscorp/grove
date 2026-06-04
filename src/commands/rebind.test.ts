import { afterEach, describe, expect, test, vi } from "vitest";

import type { Context } from "../context.js";
import { loadContext } from "../context.js";
import { applyTranscriptRebinds, planTranscriptRebinds } from "../rebind.js";
import { loadOrInit, saveRegistry } from "../registry.js";
import { paneTarget } from "../tmux.js";
import { cmdRebind } from "./rebind.js";

vi.mock("../context.js", () => ({
  loadContext: vi.fn(),
}));

vi.mock("../rebind.js", () => ({
  applyTranscriptRebinds: vi.fn(),
  planTranscriptRebinds: vi.fn(),
}));

vi.mock("../registry.js", () => ({
  loadOrInit: vi.fn(),
  saveRegistry: vi.fn(),
}));

vi.mock("../tmux.js", () => ({
  paneTarget: vi.fn(),
  target: (session: string, window: string) => `${session}:${window}`,
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
    nodes: [],
    registry: { cwd: "/repo", nodes: {}, session: "dev10", updatedAt: "now" },
  };
}

describe("cmdRebind", () => {
  test("prints planned updates and skips writes in dry-run mode", async () => {
    const loaded = ctx();
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((line?: string) => {
      lines.push(line ?? "");
    });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.mocked(loadContext).mockReturnValue(loaded);
    vi.mocked(planTranscriptRebinds).mockReturnValue({
      skipped: [{ detail: "ambiguous transcript", node: "reviewer", reason: "ambiguous" }],
      updates: [
        {
          afterSessionId: "new",
          afterTranscript: "/new.jsonl",
          beforeSessionId: undefined,
          beforeTranscript: undefined,
          node: "maker",
          pendingCleared: true,
        },
      ],
    });

    await cmdRebind({ dryRun: true });

    expect(lines[0]).toContain("maker\t(none) -> new\t(none) -> /new.jsonl\tpending cleared");
    expect(applyTranscriptRebinds).not.toHaveBeenCalled();
    expect(saveRegistry).not.toHaveBeenCalled();
  });

  test("loads an alternate session and saves planned updates", async () => {
    const loaded = ctx();
    const registry = { cwd: "/repo", nodes: {}, session: "other", updatedAt: "now" };
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.mocked(loadContext).mockReturnValue(loaded);
    vi.mocked(loadOrInit).mockReturnValue(registry);
    vi.mocked(planTranscriptRebinds).mockReturnValue({
      skipped: [],
      updates: [
        {
          afterSessionId: "new",
          afterTranscript: "/new.jsonl",
          node: "maker",
          pendingCleared: false,
        },
      ],
    });

    await cmdRebind({ session: " other " });

    expect(loadOrInit).toHaveBeenCalledWith("other", "/repo");
    expect(applyTranscriptRebinds).toHaveBeenCalled();
    expect(saveRegistry).toHaveBeenCalledWith(registry);
  });

  test("repairs stale explicit tmux pane bindings", async () => {
    const loaded: Context = {
      ...ctx(),
      byName: new Map([
        [
          "viewer",
          {
            adapter: {} as never,
            addr: "dev10:1.2",
            node: {
              agent: "codex",
              children: [],
              cwd: "/repo",
              name: "viewer",
              tmux: "1.2",
            },
          },
        ],
      ]),
      nodes: [
        {
          agent: "codex",
          children: [],
          cwd: "/repo",
          name: "viewer",
          tmux: "1.2",
        },
      ],
      registry: {
        cwd: "/repo",
        nodes: {
          viewer: {
            agent: "codex",
            name: "viewer",
            tmux_pane: "dev10:1.2",
          },
        },
        session: "dev10",
        updatedAt: "now",
      },
    };
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.mocked(loadContext).mockReturnValue(loaded);
    vi.mocked(planTranscriptRebinds).mockReturnValue({ skipped: [], updates: [] });
    vi.mocked(paneTarget).mockResolvedValue("dev10:1.7");

    await cmdRebind({});

    expect(paneTarget).toHaveBeenCalledWith("dev10:1.2");
    expect(loaded.registry.nodes.viewer?.tmux_pane).toBe("dev10:1.7");
    expect(saveRegistry).toHaveBeenCalledWith(loaded.registry);
  });
});
