import { access, readFile, realpath } from "node:fs/promises";
import path from "node:path";

import { getAdapter } from "../adapters/index.js";
import type { AgentType } from "../config.js";
import type { Context } from "../context.js";
import {
  GroveProjectFileSchema,
  PROJECT_FILE_NAME,
  type ProjectNodeFile,
} from "../project-file.js";
import { emptyRegistry } from "../registry.js";
import { hasSession, newSession } from "../tmux.js";
import { expandHome } from "../util/paths.js";
import { type SpawnInput, spawnNode, type SpawnResult } from "./spawn.js";

export interface LoadProjectOptions {
  json?: boolean;
}

export interface LoadNodeResult {
  name: string;
  agent: AgentType;
  status: "fresh" | "restored";
  sessionId?: string;
  pane: string;
}

export interface LoadProjectResult {
  projectFile: string;
  session: string;
  workspace: {
    path: string;
    exists: boolean;
  };
  nodes: LoadNodeResult[];
  board?: {
    slug: string;
    status: "linked";
  };
}

export interface LoadProjectDeps {
  exists(file: string): Promise<boolean>;
  readFile(file: string): Promise<string>;
  realpath(file: string): Promise<string>;
  hasSession(session: string): Promise<boolean>;
  newSession(name: string, opts: { cwd?: string; windowName?: string }): Promise<void>;
  sessionFileExists(agent: AgentType, cwd: string, sessionId: string): Promise<boolean>;
  spawnNode(ctx: Context, input: SpawnInput): Promise<SpawnResult>;
}

const defaultDeps: LoadProjectDeps = {
  exists: async (file) => {
    try {
      await access(file);
      return true;
    } catch {
      return false;
    }
  },
  hasSession,
  newSession,
  realpath: async (file) => realpath(file),
  readFile: async (file) => readFile(file, "utf8"),
  sessionFileExists: async (agent, cwd, sessionId) => {
    const adapter = getAdapter(agent);
    const transcript = adapter.transcriptForSession(cwd, sessionId);
    return Boolean(transcript) && adapter.size(transcript) > 0;
  },
  spawnNode,
};

function resolveProjectFile(input: string): { projectFile: string; root: string } {
  const resolved = path.resolve(expandHome(input));
  if (path.basename(resolved) === PROJECT_FILE_NAME) {
    return { projectFile: resolved, root: path.dirname(resolved) };
  }
  return { projectFile: path.join(resolved, PROJECT_FILE_NAME), root: resolved };
}

function ensureContained(root: string, resolved: string, label: string, value: string): void {
  const rel = path.relative(root, resolved);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`${label} must stay inside the project root: ${value}`);
  }
}

function resolveProjectRelativePath(root: string, value: string, label: string): string {
  if (path.isAbsolute(value)) {
    throw new Error(`${label} must stay inside the project root and be relative: ${value}`);
  }
  const resolved = path.resolve(root, value);
  ensureContained(root, resolved, label, value);
  return resolved;
}

async function assertRealContained(
  deps: LoadProjectDeps,
  root: string,
  resolved: string,
  label: string,
  value: string,
): Promise<void> {
  const realRoot = await deps.realpath(root);
  const realResolved = await deps.realpath(resolved);
  ensureContained(realRoot, realResolved, label, value);
}

function parseProjectFile(
  raw: string,
  projectFile: string,
): ReturnType<typeof GroveProjectFileSchema.parse> {
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw) as unknown;
  } catch {
    throw new Error(`invalid grove project file JSON: ${projectFile}`);
  }
  const parsed = GroveProjectFileSchema.safeParse(parsedJson);
  if (!parsed.success) {
    throw new Error(`invalid grove project file: ${projectFile}`);
  }
  return parsed.data;
}

function contextForLoad(session: string, workspace: string): Context {
  return {
    byName: new Map(),
    config: {
      cwd: workspace,
      defaults: { agent: "codex" },
      nodes: {},
      session,
    },
    configPath: "",
    nodes: [],
    registry: emptyRegistry(session, workspace),
  };
}

function orderNodes(nodes: ProjectNodeFile[]): ProjectNodeFile[] {
  const remaining = [...nodes];
  const emitted = new Set<string>();
  const ordered: ProjectNodeFile[] = [];
  while (remaining.length > 0) {
    const index = remaining.findIndex((node) => !node.parent || emitted.has(node.parent));
    if (index === -1) {
      throw new Error(
        `project file has unresolved parent links: ${remaining.map((node) => node.name).join(", ")}`,
      );
    }
    const [node] = remaining.splice(index, 1);
    ordered.push(node!);
    emitted.add(node!.name);
  }
  return ordered;
}

export async function loadProject(
  input: string,
  _opts: LoadProjectOptions = {},
  deps: LoadProjectDeps = defaultDeps,
): Promise<LoadProjectResult> {
  const { projectFile, root } = resolveProjectFile(input);
  if (!(await deps.exists(projectFile))) throw new Error(`project file not found: ${projectFile}`);

  const project = parseProjectFile(await deps.readFile(projectFile), projectFile);
  const workspace = resolveProjectRelativePath(root, project.workspace, "project workspace");
  const workspaceExists = await deps.exists(workspace);
  if (!workspaceExists) throw new Error(`workspace folder missing: ${workspace}`);
  await assertRealContained(deps, root, workspace, "project workspace", project.workspace);
  if (await deps.hasSession(project.name)) {
    throw new Error(`tmux session already exists: ${project.name}`);
  }

  await deps.newSession(project.name, { cwd: workspace, windowName: "main" });
  const ctx = contextForLoad(project.name, workspace);
  const nodes: LoadNodeResult[] = [];
  for (const node of orderNodes(project.nodes)) {
    const restored = node.session_id
      ? await deps.sessionFileExists(node.agent, workspace, node.session_id)
      : false;
    const spawned = await deps.spawnNode(ctx, {
      agent: node.agent,
      cwd: workspace,
      description: node.description,
      group: node.group,
      name: node.name,
      operatorManaged: true,
      parent: node.parent,
      resume: restored ? node.session_id : undefined,
      role: node.role,
      session: project.name,
    });
    nodes.push({
      agent: node.agent,
      name: node.name,
      pane: spawned.pane,
      sessionId: restored ? node.session_id : undefined,
      status: restored ? "restored" : "fresh",
    });
  }

  return {
    board: project.board ? { slug: project.board.slug, status: "linked" } : undefined,
    nodes,
    projectFile,
    session: project.name,
    workspace: { exists: true, path: workspace },
  };
}

export function renderLoadProjectJson(result: LoadProjectResult): string {
  return JSON.stringify(result, null, 2);
}

export function renderLoadProjectText(result: LoadProjectResult): string {
  const lines = [
    `session: ${result.session}`,
    `workspace: ${result.workspace.path}`,
    `project: ${result.projectFile}`,
  ];
  if (result.board) lines.push(`board: ${result.board.slug} ${result.board.status}`);
  lines.push("nodes:");
  for (const node of result.nodes) {
    lines.push(`- ${node.name} [${node.agent}] ${node.status} ${node.pane}`);
  }
  return lines.join("\n");
}

export async function cmdLoadProject(
  input: string,
  opts: LoadProjectOptions = {},
  deps: LoadProjectDeps = defaultDeps,
): Promise<void> {
  const result = await loadProject(input, opts, deps);
  process.stdout.write(
    `${opts.json ? renderLoadProjectJson(result) : renderLoadProjectText(result)}\n`,
  );
}
