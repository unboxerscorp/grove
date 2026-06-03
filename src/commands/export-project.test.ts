import { describe, expect, test } from "vitest";
import { parse as parseYaml } from "yaml";

import { PROJECT_FILE_NAME } from "../project-file.js";
import {
  exportProject,
  type ExportProjectDeps,
  renderExportProjectJson,
  renderExportProjectText,
} from "./export-project.js";

const PROJECT_JSON = JSON.stringify({
  board: { slug: "roadmap" },
  created_at: "2026-06-03T00:00:00.000Z",
  name: "alpha",
  nodes: [
    {
      agent: "claude",
      description: "Coordinates work",
      group: "core",
      name: "lead",
      role: "Lead",
      session_id: "claude-local-session",
    },
    {
      agent: "codex",
      description: "Implements",
      group: "core",
      name: "maker",
      parent: "lead",
      role: "Maker",
      session_id: "codex-local-session",
    },
  ],
  updated_at: "2026-06-03T00:00:00.000Z",
  workspace: ".",
});

function deps(files = new Map<string, string>()): {
  deps: ExportProjectDeps;
  dirs: string[];
  files: Map<string, string>;
} {
  const dirs: string[] = [];
  return {
    deps: {
      cwd: () => "/projects/alpha",
      ensureDir: async (dir) => {
        dirs.push(dir);
      },
      exists: async (file) => files.has(file) || dirs.includes(file),
      homeDir: () => "/home/tester",
      now: () => "2026-06-04T00:00:00.000Z",
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

describe("exportProject", () => {
  test("writes a portable directory bundle without machine-local session ids", async () => {
    const state = deps(new Map([["/projects/alpha/grove.project.json", PROJECT_JSON]]));

    const result = await exportProject(undefined, { out: "/bundles/alpha" }, state.deps);

    expect(state.dirs).toEqual(["/bundles/alpha"]);
    expect(result.files.project).toBe("/bundles/alpha/grove.project.json");
    const portable = JSON.parse(state.files.get("/bundles/alpha/grove.project.json") ?? "{}") as {
      nodes: Array<Record<string, unknown>>;
    };
    expect(portable.nodes.every((node) => !("session_id" in node))).toBe(true);
    expect(JSON.stringify(portable)).not.toContain("local-session");

    const scaffold = parseYaml(state.files.get("/bundles/alpha/scaffold.yaml") ?? "") as {
      nodes: Record<string, Record<string, unknown>>;
    };
    expect(scaffold.nodes.maker).toEqual(
      expect.objectContaining({
        agent: "codex",
        parent: "lead",
        role: "Maker",
      }),
    );
  });

  test("finds a named project in the default grove-projects folder", async () => {
    const state = deps(
      new Map([["/home/tester/grove-projects/alpha/grove.project.json", PROJECT_JSON]]),
    );

    const result = await exportProject("alpha", { out: "/bundles/alpha" }, state.deps);

    expect(result.projectFile).toBe("/home/tester/grove-projects/alpha/grove.project.json");
  });

  test("rejects an existing bundle path", async () => {
    const state = deps(
      new Map([
        ["/projects/alpha/grove.project.json", PROJECT_JSON],
        ["/bundles/alpha", ""],
      ]),
    );

    await expect(exportProject(undefined, { out: "/bundles/alpha" }, state.deps)).rejects.toThrow(
      "bundle path already exists",
    );
  });

  test("renders text and JSON summaries", async () => {
    const state = deps(new Map([["/projects/alpha/grove.project.json", PROJECT_JSON]]));
    const result = await exportProject(undefined, { out: "/bundles/alpha" }, state.deps);

    expect(renderExportProjectText(result)).toContain(
      `project-file: /bundles/alpha/${PROJECT_FILE_NAME}`,
    );
    expect(JSON.parse(renderExportProjectJson(result))).toEqual(result);
  });
});
