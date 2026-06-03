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

  test("falls back to parsed parts when command or fixed arg cannot be matched", () => {
    expect(rawVariadicMessage("send", "maker", ["line", "two"], ["node", "grove"])).toBe(
      "line two",
    );
    expect(
      rawVariadicMessage(
        "send",
        "maker",
        ["line", "two"],
        ["node", "grove", "send", "other", "line", "two"],
      ),
    ).toBe("line two");
  });

  test("does not treat partial argv matches as raw input", () => {
    expect(
      rawVariadicMessage(
        "ask",
        "maker",
        ["line", "two"],
        ["node", "grove", "ask", "maker", "line"],
      ),
    ).toBe("line two");
  });
});
