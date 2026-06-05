import { afterEach, describe, expect, test, vi } from "vitest";

import type * as configModType from "./config.js";
import * as configMod from "./config.js";
import { type GroveConfig, type ResolvedNode } from "./config.js";
import { loadContext, nodeOf } from "./context.js";
import type * as registryModType from "./registry.js";
import * as registryMod from "./registry.js";
import type * as pathsModType from "./util/paths.js";

vi.mock("./config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof configModType>();
  return { ...actual, loadConfig: vi.fn(), resolveNodes: vi.fn() };
});

vi.mock("./registry.js", async (importOriginal) => {
  const actual = await importOriginal<typeof registryModType>();
  return { ...actual, loadOrInit: vi.fn() };
});

vi.mock("./util/paths.js", async (importOriginal) => {
  const actual = await importOriginal<typeof pathsModType>();
  return { ...actual, expandHome: vi.fn((p: string) => p) };
});

describe("Context Resolution", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  const baseConfig: GroveConfig = {
    session: "test-session",
    cwd: "/test/cwd",
    defaults: { agent: "codex" },
    nodes: {},
  };
  const registryMock = {
    session: "test-session",
    cwd: "/test/registry/cwd",
    nodes: {},
    updatedAt: "2026-06-05T00:00:00Z",
  };

  test("nodeOf throws if node not found", () => {
    vi.mocked(configMod.loadConfig).mockReturnValue({ path: "/grove.yaml", config: baseConfig });
    vi.mocked(configMod.resolveNodes).mockReturnValue([]);
    vi.mocked(registryMod.loadOrInit).mockReturnValue(registryMock);

    const ctx = loadContext();
    expect(() => nodeOf(ctx, "unknown")).toThrowError(/unknown node "unknown"/);
  });

  test("byName contains both configured and registry-only nodes", () => {
    const configuredNode: ResolvedNode = {
      name: "conf-node",
      agent: "codex",
      cwd: "/test/cwd",
      tmux: "conf-node-pane",
      children: [],
    };
    vi.mocked(configMod.loadConfig).mockReturnValue({ path: "/grove.yaml", config: baseConfig });
    vi.mocked(configMod.resolveNodes).mockReturnValue([configuredNode]);

    const reg = {
      ...registryMock,
      nodes: {
        "reg-only": {
          name: "reg-only",
          agent: "claude",
          role: "reviewer",
          parent: "conf-node",
          tmux_pane: "test-session:custom.pane",
          children: [],
        },
      },
    };
    vi.mocked(registryMod.loadOrInit).mockReturnValue(reg as unknown as registryModType.Registry);

    const ctx = loadContext();

    const confCtx = nodeOf(ctx, "conf-node");
    expect(confCtx.node.name).toBe("conf-node");
    expect(confCtx.addr).toBe("test-session:conf-node-pane"); // tmux from config

    const regCtx = nodeOf(ctx, "reg-only");
    expect(regCtx.node.name).toBe("reg-only");
    expect(regCtx.addr).toBe("test-session:custom.pane"); // tmux_pane from registry
    expect(regCtx.node.parent).toBe("conf-node");
    expect(regCtx.node.cwd).toBe("/test/registry/cwd"); // Uses registry.cwd if registry node
  });

  test("registry node properties override or supplement config default tmux_pane", () => {
    const configuredNode: ResolvedNode = {
      name: "conf-node",
      agent: "codex",
      cwd: "/test/cwd",
      children: [],
    };
    vi.mocked(configMod.loadConfig).mockReturnValue({ path: "/grove.yaml", config: baseConfig });
    vi.mocked(configMod.resolveNodes).mockReturnValue([configuredNode]);

    const reg = {
      ...registryMock,
      nodes: {
        "conf-node": {
          name: "conf-node",
          agent: "codex",
          tmux_pane: "test-session:overridden.pane", // should override target(config.session, node.tmux ?? node.name)
          children: [],
        },
      },
    };
    vi.mocked(registryMod.loadOrInit).mockReturnValue(reg as unknown as registryModType.Registry);

    const ctx = loadContext();
    const confCtx = nodeOf(ctx, "conf-node");
    expect(confCtx.addr).toBe("test-session:overridden.pane");
  });
});
