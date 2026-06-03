import { describe, expect, test } from "vitest";

import {
  PROJECT_BUNDLE_SCAFFOLD,
  PROJECT_BUNDLE_SCHEMA,
  PROJECT_BUNDLE_TYPE,
} from "../project-bundle.js";
import { PROJECT_FILE_NAME } from "../project-file.js";
import {
  importProject,
  type ImportProjectDeps,
  renderImportProjectJson,
  renderImportProjectText,
} from "./import-project.js";

function manifest(name = "alpha"): string {
  return JSON.stringify({
    exported_at: "2026-06-04T00:00:00.000Z",
    files: {
      project: PROJECT_FILE_NAME,
      scaffold: PROJECT_BUNDLE_SCAFFOLD,
    },
    name,
    schema: PROJECT_BUNDLE_SCHEMA,
    type: PROJECT_BUNDLE_TYPE,
  });
}

function projectJson(opts: { name?: string; workspace?: string } = {}): string {
  return JSON.stringify({
    board: { slug: "roadmap" },
    created_at: "2026-06-03T00:00:00.000Z",
    name: opts.name ?? "alpha",
    nodes: [
      {
        agent: "claude",
        description: "Coordinates work",
        group: "core",
        name: "lead",
        role: "Lead",
        session_id: "local-session",
      },
      {
        agent: "codex",
        name: "maker",
        parent: "lead",
        role: "Maker",
        session_id: "other-local-session",
      },
    ],
    updated_at: "2026-06-03T00:00:00.000Z",
    workspace: opts.workspace ?? ".",
  });
}

function deps(files = new Map<string, string>()): {
  deps: ImportProjectDeps;
  dirs: string[];
  files: Map<string, string>;
} {
  const dirs: string[] = [];
  return {
    deps: {
      ensureDir: async (dir) => {
        dirs.push(dir);
      },
      exists: async (file) => files.has(file),
      homeDir: () => "/home/tester",
      readFile: async (file) => {
        const text = files.get(file);
        if (text === undefined) throw new Error(`missing file ${file}`);
        return text;
      },
      writeFile: async (file, text) => {
        files.set(file, text);
      },
    },
    dirs,
    files,
  };
}

function bundleFiles(project = projectJson()): Map<string, string> {
  return new Map([
    ["/bundles/alpha/bundle.json", manifest()],
    ["/bundles/alpha/grove.project.json", project],
  ]);
}

describe("importProject", () => {
  test("creates a local project folder from a portable bundle with fresh nodes", async () => {
    const state = deps(bundleFiles());

    const result = await importProject("/bundles/alpha", { dir: "/imports/alpha" }, state.deps);

    expect(state.dirs).toEqual(["/imports/alpha", "/imports/alpha"]);
    expect(result.projectFile).toBe("/imports/alpha/grove.project.json");
    const imported = JSON.parse(state.files.get("/imports/alpha/grove.project.json") ?? "{}") as {
      nodes: Array<Record<string, unknown>>;
    };
    expect(imported.nodes.every((node) => !("session_id" in node))).toBe(true);
    expect(JSON.stringify(imported)).not.toContain("local-session");
  });

  test("preserves relative workspace structure", async () => {
    const state = deps(bundleFiles(projectJson({ workspace: "workspace" })));

    const result = await importProject("/bundles/alpha", { dir: "/imports/alpha" }, state.deps);

    expect(state.dirs).toEqual(["/imports/alpha", "/imports/alpha/workspace"]);
    expect(result.workspace).toBe("/imports/alpha/workspace");
  });

  test("round-trips project structure without machine-local session ids", async () => {
    const state = deps(bundleFiles());

    await importProject("/bundles/alpha", { dir: "/imports/alpha" }, state.deps);

    const imported = JSON.parse(state.files.get("/imports/alpha/grove.project.json") ?? "{}") as {
      board: { slug: string };
      nodes: Array<Record<string, unknown>>;
      workspace: string;
    };
    expect(imported.board.slug).toBe("roadmap");
    expect(imported.workspace).toBe(".");
    expect(imported.nodes.map((node) => [node.name, node.agent, node.parent])).toEqual([
      ["lead", "claude", undefined],
      ["maker", "codex", "lead"],
    ]);
  });

  test("reports malformed bundles clearly", async () => {
    const state = deps(new Map([["/bundles/alpha/bundle.json", "{"]]));

    await expect(
      importProject("/bundles/alpha", { dir: "/imports/alpha" }, state.deps),
    ).rejects.toThrow("invalid grove project bundle JSON");
  });

  test("validates imported project names and workspace containment", async () => {
    const badName = deps(
      new Map([
        ["/bundles/alpha/bundle.json", manifest("../bad")],
        ["/bundles/alpha/grove.project.json", projectJson({ name: "../bad" })],
      ]),
    );
    await expect(
      importProject("/bundles/alpha", { dir: "/imports/alpha" }, badName.deps),
    ).rejects.toThrow("invalid grove project file");

    const traversal = deps(bundleFiles(projectJson({ workspace: "../../outside" })));
    await expect(
      importProject("/bundles/alpha", { dir: "/imports/alpha" }, traversal.deps),
    ).rejects.toThrow("project workspace must stay inside the project root");
  });

  test("renders text and JSON summaries", async () => {
    const state = deps(bundleFiles());
    const result = await importProject("/bundles/alpha", { dir: "/imports/alpha" }, state.deps);

    expect(renderImportProjectText(result)).toContain("grove load-project /imports/alpha");
    expect(JSON.parse(renderImportProjectJson(result))).toEqual(result);
  });
});
