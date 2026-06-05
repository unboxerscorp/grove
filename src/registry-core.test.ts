import { existsSync, mkdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import type * as registryTypes from "./registry.js";

async function registryModules(): Promise<typeof registryTypes> {
  return import("./registry.js");
}

describe("Registry Load/Save", () => {
  const session = `test-registry-core-${Date.now()}`;
  const envGroveHome = process.env.GROVE_HOME;
  let testHome: string;

  beforeEach(() => {
    testHome = join(tmpdir(), session);
    mkdirSync(testHome, { recursive: true });
    process.env.GROVE_HOME = testHome;
    vi.resetModules();
  });

  afterEach(() => {
    if (envGroveHome === undefined) {
      delete process.env.GROVE_HOME;
    } else {
      process.env.GROVE_HOME = envGroveHome;
    }
    vi.resetModules();
    if (existsSync(testHome)) {
      rmSync(testHome, { recursive: true, force: true });
    }
  });

  test("returns null if registry does not exist", async () => {
    const { loadRegistry } = await registryModules();

    const reg = loadRegistry(session);
    expect(reg).toBeNull();
  });

  test("roundtrip empty registry", async () => {
    const { emptyRegistry, loadRegistry, saveRegistry } = await registryModules();

    const empty = emptyRegistry(session, "/test/cwd");
    saveRegistry(empty);

    const loaded = loadRegistry(session);
    expect(loaded).toBeDefined();
    expect(loaded?.session).toBe(session);
    expect(loaded?.cwd).toBe("/test/cwd");
    expect(loaded?.nodes).toEqual({});
  });

  test("updateRegistryNode adds nodes and preserves parent-child links and state", async () => {
    const { emptyRegistry, loadRegistry, saveRegistry, updateRegistryNode } =
      await registryModules();

    const initial = emptyRegistry(session, "/test/cwd");
    saveRegistry(initial);

    updateRegistryNode(
      initial,
      "parent-node",
      () => ({ name: "parent-node", agent: "codex", children: ["child-node"] }),
      { allowCreate: true },
    );
    updateRegistryNode(
      initial,
      "child-node",
      () => ({
        name: "child-node",
        agent: "claude",
        parent: "parent-node",
        group: "reviewers",
        cwd: "/test/child-cwd",
        tmux_pane: "session:1.0",
        pending: {
          fromOffset: 0,
          submittedAt: "2026-06-05T00:00:00Z",
        },
      }),
      { allowCreate: true },
    );
    const loaded = loadRegistry(session);
    expect(loaded).toBeDefined();
    expect(loaded?.nodes["parent-node"]!.children).toEqual(["child-node"]);
    expect(loaded?.nodes["child-node"]!.parent).toBe("parent-node");
    expect(loaded?.nodes["child-node"]!.group).toBe("reviewers");
    expect(loaded?.nodes["child-node"]!.cwd).toBe("/test/child-cwd");
    expect(loaded?.nodes["child-node"]!.pending?.submittedAt).toBe("2026-06-05T00:00:00Z");
  });
});
