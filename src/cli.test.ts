import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));

describe("CLI help text", () => {
  test("root command version matches package version", () => {
    const source = readFileSync(join(here, "cli.ts"), "utf8");
    const packageJson = JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8")) as {
      version: string;
    };

    expect(source).toContain(`.version("${packageJson.version}")`);
    expect(source).not.toContain('.version("0.1.0")');
  });

  test("--any documents first terminal event among listed nodes", () => {
    const source = readFileSync(join(here, "cli.ts"), "utf8");

    expect(source).toContain("first terminal event among listed nodes");
  });

  test("delegate command creates human-facing items", () => {
    const source = readFileSync(join(here, "cli.ts"), "utf8");

    expect(source).toContain("delegate <node> <title...>");
    expect(source).toContain(
      "create a human-facing TODO/feedback item associated with a grove node",
    );
  });

  test("compatibility board flag is described as a list slug", () => {
    const source = readFileSync(join(here, "cli.ts"), "utf8");

    expect(source).toContain('option("--board <board>", "target human-facing list slug"');
    expect(source).not.toContain("target board slug");
  });

  test("task compatibility command describes human-facing items", () => {
    const source = readFileSync(join(here, "cli.ts"), "utf8");

    expect(source).toContain(
      'description("transition a human-facing grove TODO/feedback/ask-human item")',
    );
    expect(source).toContain(
      'taskTransitionCommand("start", "mark a human-facing item as running")',
    );
    expect(source).not.toContain("human-facing task");
  });

  test("init command describes direct-org scaffolding", () => {
    const source = readFileSync(join(here, "cli.ts"), "utf8");

    expect(source).toContain("scaffold grove.yaml and grove-context.md");
    expect(source).not.toContain("delegation-protocol doc");
  });

  test("project import/export commands are registered", () => {
    const source = readFileSync(join(here, "cli.ts"), "utf8");

    expect(source).toContain("export-project [name]");
    expect(source).toContain("import-project <bundle>");
  });
});
