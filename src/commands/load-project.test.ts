import { describe, expect, test, vi } from "vitest";

import type { Context } from "../context.js";
import {
  cmdLoadProject,
  loadProject,
  type LoadProjectDeps,
  renderLoadProjectJson,
  renderLoadProjectText,
} from "./load-project.js";
import type { SpawnInput, SpawnResult } from "./spawn.js";

function spawnResult(input: SpawnInput): SpawnResult {
  return {
    agent: input.agent === "claude" || input.agent === "antigravity" ? input.agent : "codex",
    name: input.name ?? "node",
    pane: `${input.session ?? "alpha"}:${input.name ?? "node"}.0`,
    parent: input.parent,
    role: input.role ?? "",
    session: input.session ?? "alpha",
    sessionId: input.resume,
    transcriptDetected: Boolean(input.resume),
  };
}

function projectFile(workspace = "."): string {
  return JSON.stringify({
    board: { slug: "roadmap" },
    created_at: "2026-06-03T00:00:00.000Z",
    name: "alpha",
    nodes: [
      {
        agent: "claude",
        description: "Coordinates handoffs",
        group: "core",
        name: "lead",
        role: "Lead",
        session_id: "claude-session",
      },
      {
        agent: "codex",
        description: "Implements TypeScript tasks",
        group: "core",
        name: "maker",
        parent: "lead",
        role: "Maker",
        session_id: "missing-session",
      },
    ],
    updated_at: "2026-06-03T00:00:00.000Z",
    workspace,
  });
}

function deps(
  opts: { existingPaths?: string[]; workspace?: string; sessionExists?: boolean } = {},
): {
  deps: LoadProjectDeps;
  newSessions: { cwd: string; name: string; windowName: string }[];
  sessionChecks: { agent: string; cwd: string; sessionId: string }[];
  spawnInputs: SpawnInput[];
} {
  const newSessions: { cwd: string; name: string; windowName: string }[] = [];
  const sessionChecks: { agent: string; cwd: string; sessionId: string }[] = [];
  const spawnInputs: SpawnInput[] = [];
  const existingPaths = new Set([
    "/projects/alpha",
    "/projects/alpha/grove.project.json",
    ...(opts.existingPaths ?? []),
  ]);
  return {
    deps: {
      exists: async (file) => existingPaths.has(file),
      hasSession: async () => opts.sessionExists ?? false,
      newSession: async (name, sessionOpts) => {
        newSessions.push({
          cwd: sessionOpts.cwd ?? "",
          name,
          windowName: sessionOpts.windowName ?? "",
        });
      },
      realpath: async (file) => file,
      readFile: async () => projectFile(opts.workspace),
      sessionFileExists: async (agent, cwd, sessionId) => {
        sessionChecks.push({ agent, cwd, sessionId });
        return sessionId === "claude-session";
      },
      spawnNode: async (_ctx: Context, input: SpawnInput) => {
        spawnInputs.push(input);
        return spawnResult(input);
      },
    },
    newSessions,
    sessionChecks,
    spawnInputs,
  };
}

describe("loadProject", () => {
  test("parses a project file, verifies sessions, and restores org fields", async () => {
    const state = deps();

    const result = await loadProject("/projects/alpha", {}, state.deps);

    expect(state.newSessions).toEqual([
      {
        cwd: "/projects/alpha",
        name: "alpha",
        windowName: "main",
      },
    ]);
    expect(state.sessionChecks).toEqual([
      { agent: "claude", cwd: "/projects/alpha", sessionId: "claude-session" },
      { agent: "codex", cwd: "/projects/alpha", sessionId: "missing-session" },
    ]);
    expect(state.spawnInputs).toEqual([
      expect.objectContaining({
        agent: "claude",
        cwd: "/projects/alpha",
        description: "Coordinates handoffs",
        name: "lead",
        resume: "claude-session",
        role: "Lead",
        session: "alpha",
      }),
      expect.objectContaining({
        agent: "codex",
        cwd: "/projects/alpha",
        description: "Implements TypeScript tasks",
        name: "maker",
        parent: "lead",
        resume: undefined,
        role: "Maker",
        session: "alpha",
      }),
    ]);
    expect(result.nodes).toEqual([
      expect.objectContaining({ name: "lead", status: "restored" }),
      expect.objectContaining({ name: "maker", status: "fresh" }),
    ]);
    expect(result.board).toEqual({ slug: "roadmap", status: "linked" });
  });

  test("allows project workspaces inside the project root", async () => {
    const state = deps({
      existingPaths: ["/projects/alpha/sub/dir"],
      workspace: "sub/dir",
    });

    const result = await loadProject("/projects/alpha", {}, state.deps);

    expect(result.workspace.path).toBe("/projects/alpha/sub/dir");
    expect(state.newSessions).toEqual([
      {
        cwd: "/projects/alpha/sub/dir",
        name: "alpha",
        windowName: "main",
      },
    ]);
  });

  test.each([
    { existing: "/etc", workspace: "../../etc" },
    { existing: "/projects", workspace: ".." },
  ])(
    "rejects project workspace outside the project root: $workspace",
    async ({ existing, workspace }) => {
      const state = deps({
        existingPaths: [existing],
        workspace,
      });

      await expect(loadProject("/projects/alpha", {}, state.deps)).rejects.toThrow(
        "project workspace must stay inside the project root",
      );
      expect(state.newSessions).toEqual([]);
      expect(state.spawnInputs).toEqual([]);
    },
  );

  test("rejects absolute project workspace paths", async () => {
    const state = deps({
      existingPaths: ["/tmp/outside"],
      workspace: "/tmp/outside",
    });

    await expect(loadProject("/projects/alpha", {}, state.deps)).rejects.toThrow(
      "invalid grove project file",
    );
    expect(state.newSessions).toEqual([]);
    expect(state.spawnInputs).toEqual([]);
  });

  test("rejects real workspace paths that escape through symlinks", async () => {
    const state = deps({
      existingPaths: ["/projects/alpha/link"],
      workspace: "link",
    });
    state.deps.realpath = async (file) =>
      file === "/projects/alpha/link" ? "/private/outside" : file;

    await expect(loadProject("/projects/alpha", {}, state.deps)).rejects.toThrow(
      "project workspace must stay inside the project root",
    );
    expect(state.newSessions).toEqual([]);
  });

  test("reports malformed project JSON with a friendly error", async () => {
    const state = deps();
    state.deps.readFile = async () => "{";

    await expect(loadProject("/projects/alpha", {}, state.deps)).rejects.toThrow(
      "invalid grove project file JSON",
    );
  });

  test("rejects when tmux session already exists", async () => {
    const state = deps({ sessionExists: true });
    await expect(loadProject("/projects/alpha", {}, state.deps)).rejects.toThrow(
      "tmux session already exists: alpha",
    );
  });

  test("renders text and JSON summaries", async () => {
    const state = deps();

    const result = await loadProject("/projects/alpha/grove.project.json", {}, state.deps);

    expect(renderLoadProjectText(result)).toContain("session: alpha");
    expect(renderLoadProjectText(result)).toContain("maker [codex] fresh");
    expect(JSON.parse(renderLoadProjectJson(result))).toEqual(result);
  });
});

describe("cmdLoadProject", () => {
  test("prints text summary to stdout by default", async () => {
    const state = deps();
    const writes: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
    });

    await cmdLoadProject("/projects/alpha", {}, state.deps);
    expect(writes.join("")).toContain("session: alpha");
  });

  test("prints JSON summary to stdout when requested", async () => {
    const state = deps();
    const writes: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
    });

    await cmdLoadProject("/projects/alpha", { json: true }, state.deps);
    const parsed = JSON.parse(writes.join("")) as Record<string, unknown>;
    expect(parsed["session"]).toBe("alpha");
  });
});
