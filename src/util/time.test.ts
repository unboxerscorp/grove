import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { parseDuration, poll, waitForChangeOrTimeout } from "./time.js";

const tempRoots: string[] = [];

afterEach(() => {
  while (tempRoots.length > 0) {
    rmSync(tempRoots.pop()!, { force: true, recursive: true });
  }
});

function tempRoot(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "grove-time-"));
  tempRoots.push(root);
  return root;
}

describe("parseDuration", () => {
  test("parses supported units and keeps defaults for invalid input", () => {
    expect(parseDuration(undefined, 123)).toBe(123);
    expect(parseDuration("500ms", 0)).toBe(500);
    expect(parseDuration("1.5s", 0)).toBe(1500);
    expect(parseDuration("2m", 0)).toBe(120_000);
    expect(parseDuration("1h", 0)).toBe(3_600_000);
    expect(parseDuration("45", 0)).toBe(45_000);
    expect(parseDuration("not-duration", 321)).toBe(321);
  });
});

describe("poll", () => {
  test("returns the first value that satisfies the predicate", async () => {
    let calls = 0;

    await expect(
      poll(
        () => {
          calls += 1;
          return calls;
        },
        { intervalMs: 0, timeoutMs: 100, until: (value) => value === 3 },
      ),
    ).resolves.toEqual({ timedOut: false, value: 3 });
  });

  test("reports timeout with the last observed value", async () => {
    await expect(
      poll(() => "still waiting", {
        intervalMs: 0,
        timeoutMs: 0,
        until: () => false,
      }),
    ).resolves.toEqual({ timedOut: true, value: "still waiting" });
  });
});

describe("waitForChangeOrTimeout", () => {
  test("resolves on file changes and falls back to timeout for missing paths", async () => {
    const root = tempRoot();
    const file = path.join(root, "transcript.jsonl");
    writeFileSync(file, "");

    const changed = waitForChangeOrTimeout(file, 100);
    setTimeout(() => {
      writeFileSync(file, "{}\n");
    }, 0);
    await expect(changed).resolves.toBeUndefined();

    await expect(
      waitForChangeOrTimeout(path.join(root, "missing.jsonl"), 0),
    ).resolves.toBeUndefined();
  });
});
