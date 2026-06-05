import { execFile } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { parse as parseYaml } from "yaml";
import { z } from "zod";

import { type AgentType, AgentTypeSchema } from "../config.js";
import type { Context } from "../context.js";
import { type GroveProjectFile, PROJECT_FILE_NAME } from "../project-file.js";
import {
  emptyRegistry,
  ensureSharedMasterRegistry,
  type Registry,
  saveRegistry,
} from "../registry.js";
import { hasSession, newSession } from "../tmux.js";
import { writeFileAtomic } from "../util/atomic.js";
import { validateGroveName } from "../util/names.js";
import { expandHome } from "../util/paths.js";
import { type SpawnInput, spawnNode, type SpawnResult } from "./spawn.js";

const pexec = promisify(execFile);

export interface NewProjectOptions {
  template?: string;
  dir?: string;
  clone?: string;
  tmuxSession?: string;
  json?: boolean;
}

interface ProjectNodeSpec {
  name: string;
  agent: AgentType;
  role?: string;
  description?: string;
  parent?: string;
  group?: string;
}

export interface CloneResult {
  repo: string;
  status: "cloned" | "skipped";
  reason?: string;
}

export interface NewProjectResult {
  session: string;
  tmuxSession?: string;
  dir: string;
  board: { slug: string };
  template?: string;
  clone?: CloneResult;
  nodes: SpawnResult[];
  dashboardCommand: string;
  nextSteps: string[];
}

export interface GhResult {
  ok: boolean;
  stderr?: string;
}

export interface NewProjectDeps {
  hasSession(session: string): Promise<boolean>;
  newSession(name: string, opts: { cwd?: string; windowName?: string }): Promise<void>;
  ensureDir(dir: string): Promise<void>;
  homeDir(): string;
  now(): string;
  readFile(file: string): Promise<string>;
  runGh(args: string[]): Promise<GhResult>;
  ensureSharedMasterRegistry(cwd: string): void;
  saveRegistry(registry: Registry): void;
  spawnNode(ctx: Context, input: SpawnInput): Promise<SpawnResult>;
  writeFile(file: string, text: string): Promise<void>;
}

const defaultDeps: NewProjectDeps = {
  ensureDir: async (dir) => {
    await mkdir(dir, { recursive: true });
  },
  hasSession,
  homeDir: () => os.homedir(),
  newSession,
  now: () => new Date().toISOString(),
  readFile: async (file) => readFile(file, "utf8"),
  runGh: async (args) => {
    try {
      await pexec("gh", args);
      return { ok: true };
    } catch (error) {
      return {
        ok: false,
        stderr: error instanceof Error ? error.message : String(error),
      };
    }
  },
  ensureSharedMasterRegistry: (cwd) => {
    ensureSharedMasterRegistry(cwd);
  },
  saveRegistry,
  spawnNode,
  writeFile: async (file, text) => writeFileAtomic(file, text),
};

const NodeBodySchema = z
  .object({
    agent: AgentTypeSchema.default("codex"),
    role: z.string().optional(),
    description: z.string().optional(),
    parent: z.string().optional(),
    group: z.string().optional(),
  })
  .strict();

const TemplateSchema = z
  .object({
    nodes: z.union([
      z.record(z.string(), NodeBodySchema),
      z.array(NodeBodySchema.extend({ name: z.string().min(1) })),
    ]),
  })
  .strict();

const PROJECT_LEAD_NODE_NAME = "lead";

function required(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`${label} is required`);
  return trimmed;
}

function workspaceDir(name: string, opts: NewProjectOptions, deps: NewProjectDeps): string {
  if (opts.dir?.trim()) return path.resolve(expandHome(opts.dir.trim()));
  return path.join(deps.homeDir(), "grove-projects", name);
}

function templatePath(template: string, deps: NewProjectDeps): string {
  return path.join(deps.homeDir(), ".grove", "templates", `${template}.yaml`);
}

function defaultNodes(project: string): ProjectNodeSpec[] {
  return [
    {
      agent: "claude",
      group: "core",
      name: PROJECT_LEAD_NODE_NAME,
      parent: "",
      role: `Project lead for ${project}. Coordinate the project board and team.`,
    },
  ];
}

function ensureProjectLead(project: string, nodes: ProjectNodeSpec[]): ProjectNodeSpec[] {
  if (nodes.some((node) => node.name === PROJECT_LEAD_NODE_NAME)) {
    return nodes.map((node) =>
      node.name === PROJECT_LEAD_NODE_NAME ? { ...node, parent: "" } : node,
    );
  }
  return [...defaultNodes(project), ...nodes];
}

function normalizeTemplate(raw: unknown): ProjectNodeSpec[] {
  const parsed = TemplateSchema.parse(raw);
  if (Array.isArray(parsed.nodes)) {
    return parsed.nodes.map((node) => ({
      agent: node.agent,
      description: node.description,
      group: node.group,
      name: node.name,
      parent: node.parent,
      role: node.role,
    }));
  }
  return Object.entries(parsed.nodes).map(([name, node]) => ({
    agent: node.agent,
    description: node.description,
    group: node.group,
    name,
    parent: node.parent,
    role: node.role,
  }));
}

async function loadTemplate(
  template: string | undefined,
  deps: NewProjectDeps,
): Promise<ProjectNodeSpec[]> {
  if (!template) return [];
  const raw = await deps.readFile(templatePath(template, deps));
  return normalizeTemplate(parseYaml(raw));
}

function orderNodes(nodes: ProjectNodeSpec[]): ProjectNodeSpec[] {
  const remaining = [...nodes];
  const emitted = new Set<string>();
  const ordered: ProjectNodeSpec[] = [];
  while (remaining.length > 0) {
    const index = remaining.findIndex((node) => !node.parent || emitted.has(node.parent));
    if (index === -1) {
      const unresolved = remaining.map((node) => node.name).join(", ");
      throw new Error(`template has unresolved parent links: ${unresolved}`);
    }
    const [node] = remaining.splice(index, 1);
    ordered.push(node!);
    emitted.add(node!.name);
  }
  return ordered;
}

async function maybeClone(
  repo: string | undefined,
  dir: string,
  deps: NewProjectDeps,
): Promise<CloneResult | undefined> {
  if (!repo) return undefined;
  const auth = await deps.runGh(["auth", "status"]);
  if (!auth.ok) {
    return {
      reason: "gh auth status failed; run `gh auth login` and retry clone if needed",
      repo,
      status: "skipped",
    };
  }
  const clone = await deps.runGh(["repo", "clone", repo, dir]);
  if (!clone.ok) {
    return {
      reason: clone.stderr ?? "gh repo clone failed",
      repo,
      status: "skipped",
    };
  }
  return { repo, status: "cloned" };
}

function contextForProject(session: string, dir: string, tmuxSession?: string): Context {
  const registry = emptyRegistry(session, dir);
  if (tmuxSession && tmuxSession !== session) registry.tmuxSession = tmuxSession;
  return {
    byName: new Map(),
    config: {
      cwd: dir,
      defaults: { agent: "codex" },
      nodes: {},
      session,
    },
    configPath: "",
    nodes: [],
    registry,
  };
}

function projectFileFromNodes(
  name: string,
  specs: ProjectNodeSpec[],
  nodes: SpawnResult[],
  now: string,
): GroveProjectFile {
  return {
    board: { slug: name },
    created_at: now,
    name,
    nodes: specs.map((spec, index) => ({
      agent: spec.agent,
      description: spec.description,
      group: spec.group,
      name: spec.name,
      parent: spec.parent || undefined,
      role: spec.role,
      session_id: nodes[index]?.sessionId,
    })),
    updated_at: now,
    workspace: ".",
  };
}

function childNamesFor(specs: ProjectNodeSpec[], parent: string): string[] {
  return specs.filter((spec) => spec.parent === parent).map((spec) => spec.name);
}

function persistProjectLead(
  ctx: Context,
  dir: string,
  specs: ProjectNodeSpec[],
  results: SpawnResult[],
): void {
  const leadIndex = specs.findIndex((spec) => spec.name === PROJECT_LEAD_NODE_NAME);
  if (leadIndex < 0) return;
  const leadSpec = specs[leadIndex]!;
  const spawned = results[leadIndex];
  const previous = ctx.registry.nodes[PROJECT_LEAD_NODE_NAME];
  ctx.registry.nodes[PROJECT_LEAD_NODE_NAME] = {
    ...previous,
    agent: leadSpec.agent,
    children: childNamesFor(specs, PROJECT_LEAD_NODE_NAME),
    cwd: dir,
    description: leadSpec.description,
    group: leadSpec.group,
    name: PROJECT_LEAD_NODE_NAME,
    parent: "",
    role: leadSpec.role,
    sessionId: previous?.sessionId ?? spawned?.sessionId,
    transcript: previous?.transcript ?? spawned?.transcript,
    tmux_pane: previous?.tmux_pane ?? spawned?.pane,
  };
}

export async function createNewProject(
  rawName: string,
  opts: NewProjectOptions = {},
  deps: NewProjectDeps = defaultDeps,
): Promise<NewProjectResult> {
  const name = validateGroveName(required(rawName, "project name"), "project name");
  const tmuxSession = opts.tmuxSession?.trim()
    ? validateGroveName(opts.tmuxSession.trim(), "--tmux-session")
    : name;
  const sharedTmuxSession = tmuxSession !== name;
  if (sharedTmuxSession) {
    if (!(await deps.hasSession(tmuxSession)))
      throw new Error(`tmux session not found: ${tmuxSession}`);
  } else if (await deps.hasSession(name)) {
    throw new Error(`tmux session already exists: ${name}`);
  }

  const dir = workspaceDir(name, opts, deps);
  await deps.ensureDir(dir);
  const clone = await maybeClone(opts.clone?.trim() || undefined, dir, deps);
  if (!sharedTmuxSession) await deps.newSession(name, { cwd: dir, windowName: "main" });

  const templateNodes = await loadTemplate(opts.template?.trim() || undefined, deps);
  const specs = orderNodes(
    templateNodes.length > 0 ? ensureProjectLead(name, templateNodes) : defaultNodes(name),
  );
  const ctx = contextForProject(name, dir, sharedTmuxSession ? tmuxSession : undefined);
  const nodes: SpawnResult[] = [];
  for (const spec of specs) {
    nodes.push(
      await deps.spawnNode(ctx, {
        agent: spec.agent,
        cwd: dir,
        description: spec.description,
        group: spec.group,
        name: spec.name,
        operatorManaged: true,
        parent: spec.parent,
        role: spec.role,
        session: name,
        tmuxSession: sharedTmuxSession ? tmuxSession : undefined,
        window: sharedTmuxSession ? name : undefined,
      }),
    );
  }
  persistProjectLead(ctx, dir, specs, nodes);
  deps.saveRegistry(ctx.registry);
  deps.ensureSharedMasterRegistry(dir);
  const now = deps.now();
  await deps.writeFile(
    path.join(dir, PROJECT_FILE_NAME),
    JSON.stringify(projectFileFromNodes(name, specs, nodes, now), null, 2) + "\n",
  );

  const dashboardCommand = `grove-web --session ${name}`;
  return {
    board: { slug: name },
    clone,
    dashboardCommand,
    dir,
    nextSteps: [
      dashboardCommand,
      `cd ${dir}`,
      ...(sharedTmuxSession ? [`tmux attach -t ${tmuxSession}`] : []),
    ],
    nodes,
    session: name,
    tmuxSession: sharedTmuxSession ? tmuxSession : undefined,
    template: opts.template?.trim() || undefined,
  };
}

export function renderNewProjectJson(result: NewProjectResult): string {
  return JSON.stringify(result, null, 2);
}

export function renderNewProjectText(result: NewProjectResult): string {
  const lines = [
    `session: ${result.session}`,
    ...(result.tmuxSession ? [`tmux session: ${result.tmuxSession}`] : []),
    `board: ${result.board.slug}`,
    `dir: ${result.dir}`,
    `dashboard: ${result.dashboardCommand}`,
  ];
  if (result.template) lines.push(`template: ${result.template}`);
  if (result.clone) {
    lines.push(
      `clone: ${result.clone.status} ${result.clone.repo}${
        result.clone.reason ? ` (${result.clone.reason})` : ""
      }`,
    );
  }
  lines.push("nodes:");
  for (const node of result.nodes) {
    lines.push(`- ${node.name} [${node.agent}] ${node.pane}`);
  }
  lines.push("next:");
  for (const step of result.nextSteps) lines.push(`- ${step}`);
  return lines.join("\n");
}

export async function cmdNewProject(
  name: string,
  opts: NewProjectOptions = {},
  deps: NewProjectDeps = defaultDeps,
): Promise<void> {
  const result = await createNewProject(name, opts, deps);
  process.stdout.write(
    `${opts.json ? renderNewProjectJson(result) : renderNewProjectText(result)}\n`,
  );
}
