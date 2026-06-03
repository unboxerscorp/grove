import { describe, expect, test } from "vitest";

import { rawVariadicMessage } from "./argv.js";

describe("rawVariadicMessage", () => {
  test("extracts the raw message args after the addressed node", () => {
    expect(
      rawVariadicMessage(
        "send",
        "maker",
        ["line  one", "two"],
        ["node", "grove", "send", "-c", "grove.yaml", "maker", "line  one", "two"],
      ),
    ).toBe("line  one two");
  });
});
