import { describe, expect, test } from "vitest";

import { parseDuration, poll } from "./time.js";

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
