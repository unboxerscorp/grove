import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { waitForChangeOrTimeout } from "./watch.js";

const tempRoots: string[] = [];

afterEach(() => {
  while (tempRoots.length > 0) {
    rmSync(tempRoots.pop()!, { force: true, recursive: true });
  }
});

function tempRoot(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "grove-watch-"));
  tempRoots.push(root);
  return root;
}

describe("waitForChangeOrTimeout", () => {
  test("resolves on the next append before the safety timeout", async () => {
    const root = tempRoot();
    const file = path.join(root, "transcript.jsonl");
    writeFileSync(file, "");
    const started = Date.now();

    const changed = waitForChangeOrTimeout(file, 2000);
    setTimeout(() => {
      writeFileSync(file, "{}\n");
    }, 10);
    await changed;

    expect(Date.now() - started).toBeLessThan(1000);
  });

  test("watches the parent directory when the file does not exist yet", async () => {
    const root = tempRoot();
    const file = path.join(root, "new-transcript.jsonl");

    const changed = waitForChangeOrTimeout(file, 2000);
    const written = new Promise<void>((resolve) => {
      setTimeout(() => {
        writeFileSync(file, "{}\n");
        resolve();
      }, 10);
    });

    await expect(Promise.all([changed, written])).resolves.toBeDefined();
  });

  test("falls back to timeout when no file or parent watcher can be opened", async () => {
    const root = tempRoot();
    const missingParent = path.join(root, "missing", "transcript.jsonl");
    const started = Date.now();

    await waitForChangeOrTimeout(missingParent, 5);

    expect(Date.now() - started).toBeGreaterThanOrEqual(0);
  });

  test("does not require the target file to be present when parent exists", async () => {
    const root = tempRoot();
    const dir = path.join(root, "logs");
    mkdirSync(dir);

    await expect(
      waitForChangeOrTimeout(path.join(dir, "missing.jsonl"), 0),
    ).resolves.toBeUndefined();
  });
});
