import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";

import type * as registryTypes from "../registry.js";
import type * as initTypes from "./init.js";

const cwdStack: string[] = [];
const tempRoots: string[] = [];
const previousGroveHome = process.env.GROVE_HOME;

afterEach(() => {
  while (cwdStack.length > 0) {
    process.chdir(cwdStack.pop()!);
  }
  while (tempRoots.length > 0) {
    rmSync(tempRoots.pop()!, { force: true, recursive: true });
  }
  if (previousGroveHome === undefined) {
    delete process.env.GROVE_HOME;
  } else {
    process.env.GROVE_HOME = previousGroveHome;
  }
  vi.resetModules();
  vi.restoreAllMocks();
});

function enterTempProject(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "grove-init-"));
  tempRoots.push(root);
  cwdStack.push(process.cwd());
  process.chdir(root);
  return process.cwd();
}

async function initModules(groveHome: string): Promise<{
  cmdInit: typeof initTypes.cmdInit;
  loadRegistry: typeof registryTypes.loadRegistry;
}> {
  process.env.GROVE_HOME = groveHome;
  vi.resetModules();
  const init = await import("./init.js");
  const registry = await import("../registry.js");
  return { cmdInit: init.cmdInit, loadRegistry: registry.loadRegistry };
}

describe("cmdInit", () => {
  test("writes grove.yaml and delegation protocol in the current project", async () => {
    const root = enterTempProject();
    const groveHome = path.join(root, ".test-grove-home");
    const { cmdInit, loadRegistry } = await initModules(groveHome);
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    await cmdInit({ session: "dev10" });

    const config = readFileSync(path.join(root, "grove.yaml"), "utf8");
    expect(config).toContain("session: dev10");
    expect(config).toContain(`cwd: ${root}`);
    expect(config).toContain("nodes:");
    expect(readFileSync(path.join(root, "grove-protocol.md"), "utf8")).toContain("grove wait");
    expect(loadRegistry("dev10")?.nodes.lead).toEqual(
      expect.objectContaining({
        cwd: root,
        name: "lead",
        parent: "",
      }),
    );
    expect(loadRegistry(".master")?.nodes["grove-master"]).toEqual(
      expect.objectContaining({
        name: "grove-master",
        parent: "",
      }),
    );
  });

  test("preserves existing files unless force is set", async () => {
    const root = enterTempProject();
    const { cmdInit } = await initModules(path.join(root, ".test-grove-home"));
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
