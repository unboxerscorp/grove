import { describe, expect, test } from "vitest";

import type { Context } from "../context.js";
import { GroveProjectFileSchema } from "../project-file.js";
import {
  createNewProject,
  type NewProjectDeps,
  renderNewProjectJson,
  renderNewProjectText,
} from "./new-project.js";
import type { SpawnInput, SpawnResult } from "./spawn.js";

function spawnResult(input: SpawnInput): SpawnResult {
  return {
    agent: input.agent === "claude" || input.agent === "antigravity" ? input.agent : "codex",
    group: input.group,
    name: input.name ?? "node",
    pane: `${input.session ?? "alpha"}:${input.name ?? "node"}.0`,
    parent: input.parent,
    role: input.role ?? "",
    session: input.session ?? "alpha",
    transcriptDetected: false,
  };
}

function deps(opts: { ghAuthed?: boolean; sessionExists?: boolean; template?: string } = {}): {
  deps: NewProjectDeps;
  ghArgs: string[][];
  mkdirs: string[];
  newSessions: { cwd: string; name: string; windowName: string }[];
  readPaths: string[];
  spawnInputs: SpawnInput[];
  writes: { file: string; text: string }[];
} {
  const ghArgs: string[][] = [];
  const mkdirs: string[] = [];
  const newSessions: { cwd: string; name: string; windowName: string }[] = [];
  const readPaths: string[] = [];
  const spawnInputs: SpawnInput[] = [];
  const writes: { file: string; text: string }[] = [];
  return {
    deps: {
      ensureDir: async (dir) => {
        mkdirs.push(dir);
      },
      hasSession: async () => opts.sessionExists ?? false,
      homeDir: () => "/home/tester",
      newSession: async (name, sessionOpts) => {
        newSessions.push({
          cwd: sessionOpts.cwd ?? "",
          name,
          windowName: sessionOpts.windowName ?? "",
        });
      },
      now: () => "2026-06-03T00:00:00.000Z",
      readFile: async (file) => {
        readPaths.push(file);
        return opts.template ?? "";
      },
      runGh: async (args) => {
        ghArgs.push(args);
        if (args.join(" ") === "auth status") return { ok: opts.ghAuthed ?? false };
        return { ok: true };
      },
      spawnNode: async (_ctx: Context, input: SpawnInput) => {
        spawnInputs.push(input);
        return { ...spawnResult(input), sessionId: `session-${input.name ?? "node"}` };
      },
      writeFile: async (file, text) => {
        writes.push({ file, text });
      },
    },
    ghArgs,
    mkdirs,
    newSessions,
    readPaths,
    spawnInputs,
    writes,
  };
}

describe("createNewProject", () => {
  test("creates a detached session, default workspace, and default lead node", async () => {
    const state = deps();

    const result = await createNewProject("alpha", {}, state.deps);

    expect(state.mkdirs).toEqual(["/home/tester/grove-projects/alpha"]);
    expect(state.newSessions).toEqual([
      {
        cwd: "/home/tester/grove-projects/alpha",
        name: "alpha",
        windowName: "main",
      },
    ]);
    expect(state.spawnInputs).toEqual([
      expect.objectContaining({
        agent: "claude",
        cwd: "/home/tester/grove-projects/alpha",
        group: "core",
        name: "lead",
        session: "alpha",
      }),
    ]);
    expect(result).toEqual(
      expect.objectContaining({
        dashboardCommand: "grove-web --session alpha",
        dir: "/home/tester/grove-projects/alpha",
        session: "alpha",
      }),
    );
    expect(state.writes.map((write) => write.file)).toEqual([
      "/home/tester/grove-projects/alpha/grove.project.json",
    ]);
    expect(JSON.parse(state.writes[0]!.text)).toEqual({
      created_at: "2026-06-03T00:00:00.000Z",
      name: "alpha",
      nodes: [
        {
          agent: "claude",
          group: "core",
          name: "lead",
          role: "Lead the alpha project. Coordinate work and keep the team moving.",
          session_id: "session-lead",
        },
      ],
      updated_at: "2026-06-03T00:00:00.000Z",
      workspace: ".",
    });
  });

  test("errors when the project tmux session already exists", async () => {
    const state = deps({ sessionExists: true });

    await expect(createNewProject("alpha", {}, state.deps)).rejects.toThrow(
      "tmux session already exists: alpha",
    );
    expect(state.mkdirs).toEqual([]);
    expect(state.spawnInputs).toEqual([]);
  });

  test("loads a template from grove templates and spawns nodes in parent order", async () => {
    const state = deps({
      template: [
        "nodes:",
        "  maker:",
        "    agent: codex",
        "    role: Maker",
        "    description: Implements TypeScript tasks",
        "    parent: lead",
        "    group: core",
        "  lead:",
        "    agent: claude",
        "    role: Lead",
        "    description: Coordinates handoffs",
        "    group: core",
      ].join("\n"),
    });

    await createNewProject("alpha", { template: "team" }, state.deps);

    expect(state.readPaths).toEqual(["/home/tester/.grove/templates/team.yaml"]);
    expect(state.spawnInputs.map((input) => input.name)).toEqual(["lead", "maker"]);
    expect(state.spawnInputs).toEqual([
      expect.objectContaining({
        agent: "claude",
        description: "Coordinates handoffs",
        name: "lead",
        role: "Lead",
      }),
      expect.objectContaining({
        agent: "codex",
        description: "Implements TypeScript tasks",
        name: "maker",
        parent: "lead",
        role: "Maker",
      }),
    ]);
    const projectFile = GroveProjectFileSchema.parse(JSON.parse(state.writes[0]!.text));
    expect(projectFile.nodes).toEqual([
      expect.objectContaining({
        description: "Coordinates handoffs",
        name: "lead",
        session_id: "session-lead",
      }),
      expect.objectContaining({
        description: "Implements TypeScript tasks",
        name: "maker",
        session_id: "session-maker",
      }),
    ]);
  });

  test("runs gh auth status and gh repo clone with argv arrays when authenticated", async () => {
    const state = deps({ ghAuthed: true });

    const result = await createNewProject(
      "alpha",
      { clone: "owner/repo", dir: "/workspace/alpha" },
      state.deps,
    );

    expect(state.mkdirs).toEqual(["/workspace/alpha"]);
    expect(state.ghArgs).toEqual([
      ["auth", "status"],
      ["repo", "clone", "owner/repo", "/workspace/alpha"],
    ]);
    expect(result.clone).toEqual({ repo: "owner/repo", status: "cloned" });
  });

  test("skips clone with guidance when gh is not authenticated", async () => {
    const state = deps({ ghAuthed: false });

    const result = await createNewProject(
      "alpha",
      { clone: "owner/repo", dir: "/workspace/alpha" },
      state.deps,
    );

    expect(state.ghArgs).toEqual([["auth", "status"]]);
    expect(result.clone).toEqual({
      reason: "gh auth status failed; run `gh auth login` and retry clone if needed",
      repo: "owner/repo",
      status: "skipped",
    });
  });

  test("renders text and JSON summaries", async () => {
    const state = deps();
    const result = await createNewProject("alpha", {}, state.deps);

    expect(renderNewProjectText(result)).toContain("session: alpha");
    expect(renderNewProjectText(result)).toContain("grove-web --session alpha");
    expect(JSON.parse(renderNewProjectJson(result))).toEqual(result);
  });
});
