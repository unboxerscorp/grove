import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";

import { cmdInit } from "./init.js";

const cwdStack: string[] = [];
const tempRoots: string[] = [];

afterEach(() => {
  while (cwdStack.length > 0) {
    process.chdir(cwdStack.pop()!);
  }
  while (tempRoots.length > 0) {
    rmSync(tempRoots.pop()!, { force: true, recursive: true });
  }
  vi.restoreAllMocks();
});

function enterTempProject(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "grove-init-"));
  tempRoots.push(root);
  cwdStack.push(process.cwd());
  process.chdir(root);
  return process.cwd();
}

describe("cmdInit", () => {
  test("writes grove.yaml and delegation protocol in the current project", async () => {
    const root = enterTempProject();
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    await cmdInit({ session: "dev10" });

    const config = readFileSync(path.join(root, "grove.yaml"), "utf8");
    expect(config).toContain("session: dev10");
    expect(config).toContain(`cwd: ${root}`);
    expect(config).toContain("nodes:");
    expect(readFileSync(path.join(root, "grove-protocol.md"), "utf8")).toContain("grove wait");
  });

  test("preserves existing files unless force is set", async () => {
    const root = enterTempProject();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const configPath = path.join(root, "grove.yaml");
    const protocolPath = path.join(root, "grove-protocol.md");
    writeFileSync(configPath, "existing config");
    writeFileSync(protocolPath, "existing protocol");

    await cmdInit({});

    expect(readFileSync(configPath, "utf8")).toBe("existing config");
    expect(readFileSync(protocolPath, "utf8")).toBe("existing protocol");

    await cmdInit({ force: true, session: "forced" });

    expect(readFileSync(configPath, "utf8")).toContain("session: forced");
    expect(readFileSync(protocolPath, "utf8")).toContain("grove ask");
  });
});
