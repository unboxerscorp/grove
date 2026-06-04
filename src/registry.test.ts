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

  test("scoped node updates do not resurrect stale nodes deleted from latest registry", async () => {
    const root = path.join(os.tmpdir(), `grove-registry-update-${process.pid}-${Date.now()}`);
    process.env.GROVE_HOME = root;
    vi.resetModules();
    const { loadRegistry, saveRegistry, updateRegistryNode } = await import("./registry.js");

    try {
      const stale = {
        cwd: "/repo",
        nodes: {
          deleted: {
            agent: "codex" as const,
            name: "deleted",
            role: "stale-node",
          },
          worker: {
            agent: "codex" as const,
            name: "worker",
            role: "stale-worker",
          },
        },
        session: "dev10",
        updatedAt: "before",
      };
      saveRegistry(stale);
      const latest = loadRegistry("dev10")!;
      delete latest.nodes.deleted;
      latest.nodes.worker = {
        agent: "codex",
        name: "worker",
        role: "live-worker",
      };
      saveRegistry(latest);

      updateRegistryNode(stale, "worker", (current) => ({
        ...current!,
        pending: {
          eventLogOffset: 7,
          fromOffset: 10,
          submittedAt: "now",
          transcript: "/tmp/worker.jsonl",
        },
      }));

      const reloaded = loadRegistry("dev10");
      expect(reloaded?.nodes.deleted).toBeUndefined();
      expect(reloaded?.nodes.worker?.role).toBe("live-worker");
      expect(reloaded?.nodes.worker?.pending?.transcript).toBe("/tmp/worker.jsonl");
      expect(stale.nodes.deleted).toBeDefined();
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  test("scoped node updates preserve interleaved concurrent node writes", async () => {
    const root = path.join(os.tmpdir(), `grove-registry-concurrent-${process.pid}-${Date.now()}`);
    process.env.GROVE_HOME = root;
    vi.resetModules();
    const { loadRegistry, saveRegistry, updateRegistryNode } = await import("./registry.js");
    const { sessionDir } = await import("./util/paths.js");

    try {
      saveRegistry({
        cwd: "/repo",
        nodes: {
          alpha: {
            agent: "codex",
            name: "alpha",
            role: "alpha-live",
          },
          beta: {
            agent: "codex",
            name: "beta",
            role: "beta-live",
          },
        },
        session: "dev10",
        updatedAt: "before",
      });
      const stale = loadRegistry("dev10")!;

      updateRegistryNode(stale, "alpha", (current) => {
        updateRegistryNode(stale, "beta", (innerCurrent) => ({
          ...innerCurrent!,
          pending: {
            eventLogOffset: 8,
            fromOffset: 20,
            submittedAt: "inner",
            transcript: "/tmp/beta.jsonl",
          },
          role: "beta-updated",
        }));
        return {
          ...current!,
          pending: {
            eventLogOffset: 7,
            fromOffset: 10,
            submittedAt: "outer",
            transcript: "/tmp/alpha.jsonl",
          },
        };
      });

      const reloaded = loadRegistry("dev10");
      expect(reloaded?.nodes.alpha?.pending?.transcript).toBe("/tmp/alpha.jsonl");
      expect(reloaded?.nodes.beta?.role).toBe("beta-updated");
      expect(reloaded?.nodes.beta?.pending?.transcript).toBe("/tmp/beta.jsonl");
      expect(readdirSync(sessionDir("dev10")).filter((name) => name.endsWith(".lock"))).toEqual([]);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });
});
