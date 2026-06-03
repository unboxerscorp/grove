import { beforeEach, describe, expect, test, vi } from "vitest";

import type { AgentAdapter } from "./adapters/types.js";
import type { ResolvedNode } from "./config.js";
import type { Context, NodeCtx } from "./context.js";
import { bringUp } from "./ops.js";
import { saveRegistry } from "./registry.js";
import { paneCommand } from "./tmux.js";

vi.mock("./registry.js", () => {
  return {
    saveRegistry: vi.fn(),
  };
});

vi.mock("./tmux.js", () => ({
  capturePane: vi.fn(async () => "ready"),
  hasSession: vi.fn(async () => true),
  hasWindow: vi.fn(async () => true),
  listWindows: vi.fn(async () => []),
  newSession: vi.fn(async () => undefined),
  newWindow: vi.fn(async () => undefined),
  paneCommand: vi.fn(async () => "zsh"),
  sendEnter: vi.fn(async () => undefined),
  sendLiteral: vi.fn(async () => undefined),
  sendText: vi.fn(async () => undefined),
  target: (session: string, window: string) => `${session}:${window}`,
}));

vi.mock("./util/time.js", () => ({
  poll: vi.fn(async <T>(fn: () => T | Promise<T>) => ({
    timedOut: false,
    value: await fn(),
  })),
  sleep: vi.fn(async () => undefined),
  waitForChangeOrTimeout: vi.fn(async () => undefined),
}));

function makeAdapter(): AgentAdapter {
  return {
    name: "codex",
    label: "codex",
    submit: "enter",
    readyPattern: /ready/,
    launchCommand: () => "codex",
    transcriptForSession: () => "/tmp/grove/session-new.jsonl",
    snapshot: () => new Map<string, number>(),
    detectNew: () => ({
      sessionId: "session-new",
      transcript: "/tmp/grove/session-new.jsonl",
    }),
    sessionIdFromPath: () => "session-new",
    size: () => 0,
    readCompletionSince: () => ({ done: false, offset: 0 }),
    readLast: () => null,
  };
}

function makeContext(nodes: ResolvedNode[]): Context {
  const byName = new Map<string, NodeCtx>();
  for (const node of nodes) {
    byName.set(node.name, {
      node,
      adapter: makeAdapter(),
      addr: `dev10:${node.tmux ?? node.name}`,
    });
  }
  return {
    config: {
      cwd: "/tmp/grove",
      defaults: { agent: "codex" },
      nodes: Object.fromEntries(nodes.map((node) => [node.name, { children: [] }])),
      session: "dev10",
    },
    configPath: "/tmp/grove/grove.yaml",
    byName,
    nodes,
    registry: {
      cwd: "/tmp/grove",
      nodes: {},
      session: "dev10",
      updatedAt: "2026-06-03T00:00:00.000Z",
    },
  };
}

function node(
  name: string,
  opts: Partial<
    Pick<ResolvedNode, "children" | "description" | "group" | "parent" | "role" | "tmux">
  > = {},
): ResolvedNode {
  return {
    agent: "codex",
    children: opts.children ?? [],
    cwd: "/tmp/grove",
    description: opts.description,
    group: opts.group,
    name,
    parent: opts.parent,
    role: opts.role,
    tmux: opts.tmux,
  };
}

describe("bringUp registry tmux pane metadata", () => {
  beforeEach(() => {
    vi.mocked(saveRegistry).mockClear();
    vi.mocked(paneCommand).mockReset();
    vi.mocked(paneCommand).mockResolvedValue("zsh");
  });

  test("records the canonical tmux pane for adopted explicit tmux nodes", async () => {
    vi.mocked(paneCommand).mockResolvedValue("codex");
    const ctx = makeContext([node("viewer", { tmux: "1.2" })]);

    await bringUp(ctx);

    expect(ctx.registry.nodes.viewer).toEqual(
      expect.objectContaining({
        tmux_pane: "dev10:1.2",
      }),
    );
  });

  test("records the canonical tmux pane for launched explicit tmux nodes", async () => {
    vi.mocked(paneCommand).mockResolvedValue("zsh");
    const ctx = makeContext([node("viewer", { tmux: "1.2" })]);

    await bringUp(ctx);

    expect(ctx.registry.nodes.viewer).toEqual(
      expect.objectContaining({
        sessionId: "session-new",
        tmux_pane: "dev10:1.2",
        transcript: "/tmp/grove/session-new.jsonl",
      }),
    );
  });

  test("does not set tmux_pane for automatic window nodes", async () => {
    const ctx = makeContext([node("worker")]);

    await bringUp(ctx);

    expect(ctx.registry.nodes.worker?.tmux_pane).toBeUndefined();
  });

  test("persists team graph fields for adopted and launched nodes", async () => {
    vi.mocked(paneCommand).mockResolvedValue("codex");
    const ctx = makeContext([
      node("lead", {
        children: ["maker"],
        description: "Coordinates handoffs",
        group: "core",
        role: "Lead",
        tmux: "1.1",
      }),
      node("maker", {
        group: "core",
        parent: "lead",
        description: "Builds TypeScript changes",
        role: "Builder",
      }),
    ]);

    await bringUp(ctx);

    expect(ctx.registry.nodes.lead).toEqual(
      expect.objectContaining({
        children: ["maker"],
        description: "Coordinates handoffs",
        group: "core",
        role: "Lead",
        tmux_pane: "dev10:1.1",
      }),
    );
    expect(ctx.registry.nodes.maker).toEqual(
      expect.objectContaining({
        children: [],
        description: "Builds TypeScript changes",
        group: "core",
        parent: "lead",
        role: "Builder",
      }),
    );
  });
});
