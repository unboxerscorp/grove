import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, test } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));

describe("CLI help text", () => {
  test("--any documents first terminal event among listed nodes", () => {
    const source = readFileSync(join(here, "cli.ts"), "utf8");

    expect(source).toContain("first terminal event among listed nodes");
  });
});
