import { afterEach, describe, expect, test, vi } from "vitest";

import { logRawError, safeError } from "./errors.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("safe errors", () => {
  test("returns only stable public code and message", () => {
    expect(safeError("grove_internal_error", "grove internal error")).toEqual({
      code: "grove_internal_error",
      message: "grove internal error",
    });
  });

  test("logs raw details locally without changing the public error shape", () => {
    const raw = new Error("/private/path leaked");
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    logRawError("serve request failed", raw);

    expect(spy).toHaveBeenCalledWith("grove serve request failed:", raw);
    expect(safeError("grove_internal_error", "grove internal error")).not.toHaveProperty("stack");
  });
});
