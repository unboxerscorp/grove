import { describe, expect, test } from "vitest";

import { shellQuote } from "./shell.js";

describe("shellQuote", () => {
  test("single-quotes shell metacharacters and whitespace", () => {
    expect(shellQuote("plain")).toBe("'plain'");
    expect(shellQuote("dir with spaces")).toBe("'dir with spaces'");
    expect(shellQuote("repo; rm -rf nope")).toBe("'repo; rm -rf nope'");
    expect(shellQuote("$(touch nope)")).toBe("'$(touch nope)'");
  });

  test("escapes embedded single quotes and preserves newlines", () => {
    expect(shellQuote("it's fine")).toBe("'it'\\''s fine'");
    expect(shellQuote("line one\nline two")).toBe("'line one\nline two'");
  });
});
