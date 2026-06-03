import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { getAdapter } from "../adapters/index.js";
import type { AgentAdapter } from "../adapters/types.js";
import { type AgentType, AgentTypeSchema, type ResolvedNode } from "../config.js";
import { type Context, loadContext, type NodeCtx } from "../context.js";
import { launchNode } from "../ops.js";
import { loadOrInit, type NodeRuntime, saveRegistry } from "../registry.js";
import {
  createDetachedPane,
  type CreateDetachedPaneRequest,
  preserveActiveWindow,
} from "../tmux.js";
import { validateGroveName } from "../util/names.js";
import { expandHome } from "../util/paths.js";

export interface SpawnInput {
  name?: string;
  agent?: string;
  role?: string;
  description?: string;
  parent?: string;
  group?: string;
  session?: string;
  window?: string;
  cwd?: string;
  resume?: string;
}

interface SpawnRequest {
  name: string;
  agent: AgentType;
  role: string;
  description?: string;
  parent?: string;
  group?: string;
  session: string;
  window?: string;
  cwd: string;
  resume?: string;
}

export interface SpawnResult {
  name: string;
  agent: AgentType;
  role: string;
  description?: string;
  session: string;
  pane: string;
  parent?: string;
  group?: string;
  sessionId?: string;
  transcript?: string;
  transcriptDetected: boolean;
  rebindHint?: string;
}

export interface SpawnDeps {
  createPane(req: CreateDetachedPaneRequest): Promise<string>;
  getAdapter(agent: AgentType): AgentAdapter;
  launchNode(ctx: Context, nc: NodeCtx): Promise<void>;
  preserveActiveWindow<T>(session: string, fn: () => Promise<T>): Promise<T>;
  saveRegistry(registry: Context["registry"]): void;
}

const defaultDeps: SpawnDeps = {
  createPane: createDetachedPane,
  getAdapter,
  launchNode,
  preserveActiveWindow,
  saveRegistry,
};

const DEFAULT_SPAWN_SESSION = "dev10";

function required(value: string | undefined, flag: string): string {
  const trimmed = value?.trim();
  if (!trimmed) throw new Error(`${flag} is required`);
  return trimmed;
}

function trimmed(value: string | undefined): string | undefined {
  return value?.trim() || undefined;
}

function parseAgent(value: string): AgentType {
  const parsed = AgentTypeSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(`unsupported agent "${value}" (expected codex, claude, or antigravity)`);
  }
  return parsed.data;
}

function packageName(dir: string): string | null {
  const packagePath = path.join(dir, "package.json");
  if (!existsSync(packagePath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(packagePath, "utf8")) as { name?: unknown };
    return typeof parsed.name === "string" ? parsed.name : null;
  } catch {
    return null;
  }
}

function findGroveRoot(start: string): string | null {
  let dir = path.resolve(start);
  for (;;) {
    if (packageName(dir) === "grove") return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function defaultSpawnCwd(input?: string): string {
  if (input?.trim()) return path.resolve(expandHome(input.trim()));
  return findGroveRoot(process.cwd()) ?? process.cwd();
}

function configFreeContext(input: SpawnInput): Context {
  const session = trimmed(input.session) ?? DEFAULT_SPAWN_SESSION;
  const cwd = defaultSpawnCwd(input.cwd);
  return {
    byName: new Map(),
    config: {
      cwd,
      defaults: { agent: "codex" },
      nodes: {},
      session,
    },
    configPath: "",
    nodes: [],
    registry: loadOrInit(session, cwd),
  };
}

function sessionContext(ctx: Context, session: string): Context {
  if (session === ctx.registry.session) return ctx;
  return {
    ...ctx,
    config: { ...ctx.config, session },
    registry: loadOrInit(session, ctx.config.cwd),
  };
}

function parseSpawnRequest(ctx: Context, input: SpawnInput): SpawnRequest {
  const name = validateGroveName(required(input.name, "--name"), "--name");
  const agent = parseAgent(required(input.agent, "--agent"));
  const group = trimmed(input.group);
  const parent = trimmed(input.parent);
  const session = trimmed(input.session) ?? ctx.config.session;
  const window = trimmed(input.window);
  return {
    agent,
    cwd: defaultSpawnCwd(input.cwd ?? ctx.config.cwd),
    description: trimmed(input.description),
    group: group ? validateGroveName(group, "--group") : undefined,
    name,
    parent: parent ? validateGroveName(parent, "--parent") : undefined,
    resume: trimmed(input.resume),
    role: trimmed(input.role) ?? "",
    session: validateGroveName(session, "--session"),
    window: window ? validateGroveName(window, "--window") : undefined,
  };
}

function configuredNode(ctx: Context, name: string): ResolvedNode | undefined {
  return ctx.byName.get(name)?.node;
}

function runtimeFromConfigured(node: ResolvedNode): NodeRuntime {
  return {
    agent: node.agent,
    children: [...node.children],
    description: node.description,
    group: node.group,
    name: node.name,
    parent: node.parent,
    role: node.role,
  };
}

function ensureSpawnable(ctx: Context, req: SpawnRequest): void {
  if (ctx.registry.nodes[req.name] || configuredNode(ctx, req.name)) {
    throw new Error(`node already exists: ${req.name}`);
  }
  if (!req.parent) return;
  if (req.parent === req.name) throw new Error("spawn parent cannot be the new node");
  if (!ctx.registry.nodes[req.parent] && !configuredNode(ctx, req.parent)) {
    throw new Error(`parent node not found: ${req.parent}`);
  }
}

function addParentChild(ctx: Context, parent: string | undefined, child: string): void {
  if (!parent) return;
  const configured = configuredNode(ctx, parent);
  const runtime =
    ctx.registry.nodes[parent] ?? (configured ? runtimeFromConfigured(configured) : null);
  if (!runtime) return;
  const children = runtime.children ?? [];
  ctx.registry.nodes[parent] = {
    ...runtime,
    children: children.includes(child) ? children : [...children, child],
  };
}

function rebindHint(req: SpawnRequest): string {
  return [
    "transcript not detected yet; keep the pane running and retry binding with",
    `grove rebind${req.session ? ` --session ${req.session}` : ""}`,
    "after the agent finishes startup",
  ].join(" ");
}

export async function spawnNode(
  baseCtx: Context,
  input: SpawnInput,
  deps: SpawnDeps = defaultDeps,
): Promise<SpawnResult> {
  const parsed = parseSpawnRequest(baseCtx, input);
  const ctx = sessionContext(baseCtx, parsed.session);
  ensureSpawnable(ctx, parsed);

  return deps.preserveActiveWindow(parsed.session, async () => {
    const pane = await deps.createPane({
      cwd: parsed.cwd,
      name: parsed.name,
      session: parsed.session,
      window: parsed.window,
    });
    const node: ResolvedNode = {
      agent: parsed.agent,
      children: [],
      cwd: parsed.cwd,
      description: parsed.description,
      group: parsed.group,
      name: parsed.name,
      parent: parsed.parent,
      resume: parsed.resume,
      role: parsed.role,
    };
    const nc: NodeCtx = {
      addr: pane,
      adapter: deps.getAdapter(parsed.agent),
      node,
    };
    ctx.nodes.push(node);
    ctx.byName.set(node.name, nc);

    await deps.launchNode(ctx, nc);
    const runtime = ctx.registry.nodes[parsed.name] ?? {
      agent: parsed.agent,
      name: parsed.name,
    };
    ctx.registry.nodes[parsed.name] = {
      ...runtime,
      agent: parsed.agent,
      children: runtime.children ?? [],
      description: parsed.description,
      group: parsed.group,
      name: parsed.name,
      parent: parsed.parent,
      role: parsed.role,
      tmux_pane: pane,
    };
    addParentChild(ctx, parsed.parent, parsed.name);
    deps.saveRegistry(ctx.registry);

    const saved = ctx.registry.nodes[parsed.name]!;
    const transcriptDetected = Boolean(saved.sessionId && saved.transcript);
    return {
      agent: parsed.agent,
      description: parsed.description,
      group: parsed.group,
      name: parsed.name,
      pane,
      parent: parsed.parent,
      rebindHint: transcriptDetected ? undefined : rebindHint(parsed),
      role: parsed.role,
      session: parsed.session,
      sessionId: saved.sessionId,
      transcript: saved.transcript,
      transcriptDetected,
    };
  });
}

export function renderSpawnText(result: SpawnResult): string {
  const lines = [`${result.name} [${result.agent}]`, `role: ${result.role}`];
  if (result.description) lines.push(`description: ${result.description}`);
  lines.push(`pane: ${result.pane}`);
  if (result.parent) lines.push(`parent: ${result.parent}`);
  if (result.group) lines.push(`group: ${result.group}`);
  if (result.sessionId) lines.push(`sessionId: ${result.sessionId}`);
  if (result.transcript) lines.push(`transcript: ${result.transcript}`);
  if (result.rebindHint) lines.push(`warning: ${result.rebindHint}`);
  return lines.join("\n");
}

export function renderSpawnJson(result: SpawnResult): string {
  return JSON.stringify(result, null, 2);
}

export async function cmdSpawn(
  opts: SpawnInput & { config?: string; json?: boolean },
  deps: SpawnDeps = defaultDeps,
): Promise<void> {
  const ctx = opts.config ? loadContext(opts.config) : configFreeContext(opts);
  const result = await spawnNode(ctx, opts, deps);
  process.stdout.write(`${opts.json ? renderSpawnJson(result) : renderSpawnText(result)}\n`);
}
