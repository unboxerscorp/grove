import { describe, expect, test } from "vitest";

import { GROVE_NAME_RE, GroveNameSchema, validateGroveName } from "./names.js";

describe("grove name validation", () => {
  test("accepts bridge-compatible project/session names", () => {
    for (const name of ["a", "A1", "0root", "dev10", "maker-1", "maker_1"]) {
      expect(GROVE_NAME_RE.test(name)).toBe(true);
      expect(GroveNameSchema.parse(name)).toBe(name);
      expect(validateGroveName(name, "name")).toBe(name);
    }
  });

  test("rejects empty, path-like, dotted, spaced, and non-ascii names", () => {
    for (const name of ["", "_hidden", "-dash", "../escape", "/abs", "a.b", "a b", "한글"]) {
      expect(GroveNameSchema.safeParse(name).success).toBe(false);
      expect(() => validateGroveName(name, "session")).toThrow("session must match");
    }
  });
});
