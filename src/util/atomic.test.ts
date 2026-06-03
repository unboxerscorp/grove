import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, test } from "vitest";

import { writeFileAtomic, writeFileAtomicSync } from "./atomic.js";

function tempRoot(): string {
  return mkdtempSync(path.join(os.tmpdir(), "grove-atomic-"));
}

function tempFiles(dir: string): string[] {
  return readdirSync(dir).filter((name) => name.includes(".tmp"));
}

describe("atomic file writes", () => {
  test("sync write creates parents, writes 0600, and leaves no temp file", () => {
    const root = tempRoot();
    try {
      const file = path.join(root, "nested", "registry.json");

      writeFileAtomicSync(file, "registry");

      expect(readFileSync(file, "utf8")).toBe("registry");
      expect(statSync(file).mode & 0o777).toBe(0o600);
      expect(tempFiles(path.dirname(file))).toEqual([]);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  test("async write replaces content and leaves no temp file", async () => {
    const root = tempRoot();
    try {
      const file = path.join(root, "grove.project.json");
      writeFileSync(file, "old");

      await writeFileAtomic(file, "new");

      expect(readFileSync(file, "utf8")).toBe("new");
      expect(tempFiles(root)).toEqual([]);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  test("throws before replacement when parent creation is invalid", async () => {
    const root = tempRoot();
    try {
      const blocked = path.join(root, "blocked");
      writeFileSync(blocked, "not a directory");
      const file = path.join(blocked, "registry.json");

      expect(() => writeFileAtomicSync(file, "x")).toThrow();
      await expect(writeFileAtomic(file, "x")).rejects.toThrow();
      expect(readFileSync(blocked, "utf8")).toBe("not a directory");
      expect(tempFiles(root)).toEqual([]);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });
});
