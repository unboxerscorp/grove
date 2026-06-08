import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { ensureCodexTrustedProject } from "./codex-config.js";

const dirs: string[] = [];

afterEach(() => {
  while (dirs.length > 0) {
    rmSync(dirs.pop()!, { force: true, recursive: true });
  }
});

function tempConfig(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "grove-codex-config-"));
  dirs.push(dir);
  return path.join(dir, "config.toml");
}

describe("ensureCodexTrustedProject", () => {
  test("creates a trusted project section when config is missing", () => {
    const config = tempConfig();

    expect(ensureCodexTrustedProject("/repo", config)).toBe(true);

    expect(readFileSync(config, "utf8")).toBe('[projects."/repo"]\ntrust_level = "trusted"\n');
  });

  test("leaves an existing trusted project section unchanged", () => {
    const config = tempConfig();
    const text = '[projects."/repo"]\ntrust_level = "trusted"\n';
    writeFileSync(config, text);

    expect(ensureCodexTrustedProject("/repo", config)).toBe(false);

    expect(readFileSync(config, "utf8")).toBe(text);
  });

  test("upgrades an existing project section to trusted", () => {
    const config = tempConfig();
    writeFileSync(config, '[projects."/repo"]\ntrust_level = "untrusted"\n');

    expect(ensureCodexTrustedProject("/repo", config)).toBe(true);

    expect(readFileSync(config, "utf8")).toBe('[projects."/repo"]\ntrust_level = "trusted"\n');
  });
});
