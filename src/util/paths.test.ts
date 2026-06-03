import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, test, vi } from "vitest";

import { registryPath, sessionDir } from "./paths.js";

describe("grove runtime paths", () => {
  test("rejects unsafe session names before joining under GROVE_HOME", () => {
    expect(() => sessionDir("../escape")).toThrow("session must match");
    expect(() => registryPath("/absolute")).toThrow("session must match");
  });

  test("rejects session directories that escape GROVE_HOME through symlinks", async () => {
    const previous = process.env.GROVE_HOME;
    const tempRoot = mkdtempSync(path.join(os.tmpdir(), "grove-paths-"));
    const groveHome = path.join(tempRoot, "home");
    const outside = path.join(tempRoot, "outside");
    mkdirSync(groveHome);
    mkdirSync(outside);
    symlinkSync(outside, path.join(groveHome, "dev10"), "dir");

    try {
      process.env.GROVE_HOME = groveHome;
      vi.resetModules();
      const paths = await import("./paths.js");

      expect(() => paths.sessionDir("dev10")).toThrow("session path escaped GROVE_HOME");
    } finally {
      if (previous === undefined) {
        delete process.env.GROVE_HOME;
      } else {
        process.env.GROVE_HOME = previous;
      }
      vi.resetModules();
      rmSync(tempRoot, { force: true, recursive: true });
    }
  });
});
