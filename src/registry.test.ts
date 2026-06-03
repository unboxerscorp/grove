import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";

const previousHome = process.env.GROVE_HOME;

afterEach(() => {
  if (previousHome === undefined) {
    delete process.env.GROVE_HOME;
  } else {
    process.env.GROVE_HOME = previousHome;
  }
  vi.resetModules();
});

describe("registry persistence", () => {
  test("saves through atomic replacement and reloads valid JSON", async () => {
    const root = path.join(os.tmpdir(), `grove-registry-${process.pid}-${Date.now()}`);
    process.env.GROVE_HOME = root;
    vi.resetModules();
    const { emptyRegistry, loadRegistry, saveRegistry } = await import("./registry.js");
    const { registryPath, sessionDir } = await import("./util/paths.js");

    try {
      const reg = emptyRegistry("dev10", "/repo");
      reg.nodes.maker = { agent: "codex", name: "maker" };

      saveRegistry(reg);

      expect(loadRegistry("dev10")?.nodes.maker?.agent).toBe("codex");
      expect(existsSync(registryPath("dev10"))).toBe(true);
      expect(readFileSync(registryPath("dev10"), "utf8")).toContain('"maker"');
      expect(readdirSync(sessionDir("dev10")).filter((name) => name.includes(".tmp"))).toEqual([]);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  test("returns null for missing or invalid registry JSON", async () => {
    const root = path.join(os.tmpdir(), `grove-registry-invalid-${process.pid}-${Date.now()}`);
    process.env.GROVE_HOME = root;
    vi.resetModules();
    const { mkdirSync, writeFileSync } = await import("node:fs");
    const { loadRegistry } = await import("./registry.js");
    const { registryPath, sessionDir } = await import("./util/paths.js");

    try {
      expect(loadRegistry("dev10")).toBeNull();
      mkdirSync(sessionDir("dev10"), { recursive: true });
      writeFileSync(registryPath("dev10"), "{broken");
      expect(loadRegistry("dev10")).toBeNull();
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });
});
