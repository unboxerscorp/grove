import { describe, expect, test, vi } from "vitest";

import type { Context } from "../context.js";
import { GroveProjectFileSchema } from "../project-file.js";
import {
  cmdNewProject,
  createNewProject,
  type NewProjectDeps,
  renderNewProjectJson,
  renderNewProjectText,
} from "./new-project.js";
import type { SpawnInput, SpawnResult } from "./spawn.js";

function spawnResult(input: SpawnInput): SpawnResult {
  const paneSession = input.tmuxSession ?? input.session ?? "alpha";
  const paneWindow = input.window ?? input.name ?? "node";
  return {
    agent: input.agent === "claude" || input.agent === "antigravity" ? input.agent : "codex",
    cwd: input.cwd ?? "",
    group: input.group,
    name: input.name ?? "node",
    pane: `${paneSession}:${paneWindow}.0`,
    parent: input.parent,
    role: input.role ?? "",
    session: input.session ?? "alpha",
    tmuxSession: input.tmuxSession,
    transcriptDetected: false,
  };
}

function deps(opts: { ghAuthed?: boolean; sessionExists?: boolean; template?: string } = {}): {
  deps: NewProjectDeps;
  masterWrites: string[];
  ghArgs: string[][];
  mkdirs: string[];
  newSessions: { cwd: string; name: string; windowName: string }[];
  readPaths: string[];
  spawnInputs: SpawnInput[];
  writes: { file: string; text: string }[];
} {
  const ghArgs: string[][] = [];
  const masterWrites: string[] = [];
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
      ensureSharedMasterRegistry: (cwd) => {
        masterWrites.push(cwd);
      },
      saveRegistry: (registry) => {
        writes.push({ file: `registry:${registry.session}`, text: JSON.stringify(registry) });
      },
      spawnNode: async (_ctx: Context, input: SpawnInput) => {
        spawnInputs.push(input);
        _ctx.registry.nodes[input.name ?? "node"] = {
          agent: input.agent === "claude" || input.agent === "antigravity" ? input.agent : "codex",
          children: [],
          cwd: input.cwd,
          description: input.description,
          group: input.group,
          name: input.name ?? "node",
          parent: input.parent,
          role: input.role,
          sessionId: `session-${input.name ?? "node"}`,
        };
        return { ...spawnResult(input), sessionId: `session-${input.name ?? "node"}` };
      },
      writeFile: async (file, text) => {
        writes.push({ file, text });
      },
    },
    ghArgs,
    masterWrites,
    mkdirs,
    newSessions,
    readPaths,
    spawnInputs,
    writes,
  };
}

describe("createNewProject", () => {
  test("creates a detached session, default workspace, board, and project lead", async () => {
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
        parent: "",
        session: "alpha",
      }),
    ]);
    expect(result).toEqual(
      expect.objectContaining({
        board: { slug: "alpha" },
        dashboardCommand: "grove-web --session alpha",
        dir: "/home/tester/grove-projects/alpha",
        session: "alpha",
      }),
    );
    expect(state.masterWrites).toEqual(["/home/tester/grove-projects/alpha"]);
    expect(state.writes.map((write) => write.file)).toEqual([
      "registry:alpha",
      "/home/tester/grove-projects/alpha/grove.project.json",
    ]);
    const savedRegistry = JSON.parse(state.writes[0]!.text) as {
      nodes: Record<string, Record<string, unknown>>;
    };
    expect(savedRegistry.nodes["lead"]).toEqual(
      expect.objectContaining({
        cwd: "/home/tester/grove-projects/alpha",
        name: "lead",
        parent: "",
      }),
    );
    expect(JSON.parse(state.writes[1]!.text)).toEqual({
      created_at: "2026-06-03T00:00:00.000Z",
      name: "alpha",
      board: { slug: "alpha" },
      nodes: [
        {
          agent: "claude",
          group: "core",
          name: "lead",
          role: "Project lead for alpha. Coordinate direct node communication and use human-facing list items only for operator TODO, feedback, and ask-human records.",
          session_id: "session-lead",
        },
      ],
      updated_at: "2026-06-03T00:00:00.000Z",
      workspace: ".",
    });
    expect(savedRegistry.nodes["lead"]?.role).not.toContain("project board");
  });

  test("can keep the project registry while hosting panes in an existing shared tmux session", async () => {
    const state = deps({ sessionExists: true });

    const result = await createNewProject("alpha", { tmuxSession: "dev10" }, state.deps);

    expect(state.newSessions).toEqual([]);
    expect(state.spawnInputs).toEqual([
      expect.objectContaining({
        cwd: "/home/tester/grove-projects/alpha",
        name: "lead",
        session: "alpha",
        tmuxSession: "dev10",
        window: "alpha",
      }),
    ]);
    expect(result).toEqual(
      expect.objectContaining({
        board: { slug: "alpha" },
        dashboardCommand: "grove-web --session alpha",
        dir: "/home/tester/grove-projects/alpha",
        session: "alpha",
        tmuxSession: "dev10",
      }),
    );
    const savedRegistry = JSON.parse(state.writes[0]!.text) as {
      session: string;
      tmuxSession?: string;
      nodes: Record<string, Record<string, unknown>>;
    };
    expect(savedRegistry.session).toBe("alpha");
    expect(savedRegistry.tmuxSession).toBe("dev10");
    expect(savedRegistry.nodes["lead"]).toEqual(
      expect.objectContaining({
        cwd: "/home/tester/grove-projects/alpha",
        name: "lead",
        parent: "",
        tmux_pane: "dev10:alpha.0",
      }),
    );
  });

  test("errors when the project tmux session already exists", async () => {
    const state = deps({ sessionExists: true });

    await expect(createNewProject("alpha", {}, state.deps)).rejects.toThrow(
      "tmux session already exists: alpha",
    );
    expect(state.mkdirs).toEqual([]);
    expect(state.spawnInputs).toEqual([]);
  });

  test("errors when a requested shared tmux session does not exist", async () => {
    const state = deps({ sessionExists: false });

    await expect(createNewProject("alpha", { tmuxSession: "dev10" }, state.deps)).rejects.toThrow(
      "tmux session not found: dev10",
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
        parent: "",
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
    const projectFile = GroveProjectFileSchema.parse(JSON.parse(state.writes[1]!.text));
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
    expect(renderNewProjectText(result)).toContain("board: alpha");
    expect(renderNewProjectText(result)).toContain("grove-web --session alpha");
    expect(JSON.parse(renderNewProjectJson(result))).toEqual(result);
  });
  test("renders text and JSON summaries with clone info", async () => {
    const state = deps({ ghAuthed: true });
    const result = await createNewProject(
      "alpha",
      { clone: "owner/repo", dir: "/workspace/alpha" },
      state.deps,
    );

    expect(renderNewProjectText(result)).toContain("clone: cloned owner/repo");
  });
});

describe("cmdNewProject", () => {
  test("prints text summary to stdout by default", async () => {
    const state = deps();
    const writes: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
    });

    await cmdNewProject("alpha", {}, state.deps);
    expect(writes.join("")).toContain("session: alpha");
  });

  test("prints JSON summary to stdout when requested", async () => {
    const state = deps();
    const writes: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
    });

    await cmdNewProject("alpha", { json: true }, state.deps);
    const parsed = JSON.parse(writes.join("")) as Record<string, unknown>;
    expect(parsed["session"]).toBe("alpha");
  });
});
