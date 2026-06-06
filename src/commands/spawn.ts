import path from "node:path";

import { getAdapter } from "../adapters/index.js";
import type { AgentAdapter } from "../adapters/types.js";
import { type AgentType, AgentTypeSchema, type ResolvedNode } from "../config.js";
import { type Context, loadContext, type NodeCtx } from "../context.js";
import { launchNode } from "../ops.js";
import { loadOrInit, type NodeRuntime, saveRegistry } from "../registry.js";
import { expandRolePreset } from "../role-presets.js";
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
  rolePreset?: string;
  description?: string;
  workInstructions?: string;
  kind?: string;
  parent?: string;
  group?: string;
  session?: string;
  tmuxSession?: string;
  window?: string;
  cwd?: string;
  resume?: string;
  operatorManaged?: boolean;
}

interface SpawnRequest {
  name: string;
  agent: AgentType;
  role: string;
  rolePreset?: string;
  rolePresetVersion?: string;
  description?: string;
  workInstructions?: string;
  kind?: string;
  parent?: string;
  group?: string;
  session: string;
  tmuxSession: string;
  window?: string;
  cwd: string;
  resume?: string;
}

export interface SpawnResult {
  name: string;
  agent: AgentType;
  role: string;
  rolePreset?: string;
  rolePresetVersion?: string;
  description?: string;
  workInstructions?: string;
  kind?: string;
  session: string;
  tmuxSession?: string;
  pane: string;
  parent?: string;
  group?: string;
  cwd: string;
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

function normalizeCwd(cwd: string): string {
  return path.resolve(expandHome(cwd));
}

function explicitCwd(input?: string): string | undefined {
  const cwd = trimmed(input);
  return cwd ? normalizeCwd(cwd) : undefined;
}

function defaultSpawnCwd(ctx: Context, input?: string): string {
  return explicitCwd(input) ?? normalizeCwd(ctx.registry.cwd || ctx.config.cwd || process.cwd());
}

function configFreeContext(input: SpawnInput): Context {
  const session = trimmed(input.session) ?? DEFAULT_SPAWN_SESSION;
  const cwd = explicitCwd(input.cwd) ?? normalizeCwd(process.cwd());
  const registry = loadOrInit(session, cwd);
  const configCwd = normalizeCwd(registry.cwd || cwd);
  return {
    byName: new Map(),
    config: {
      cwd: configCwd,
      defaults: { agent: "codex" },
      nodes: {},
      session,
    },
    configPath: "",
    nodes: [],
    registry,
  };
}

function sessionContext(ctx: Context, session: string): Context {
  if (session === ctx.registry.session) {
    const cwd = normalizeCwd(ctx.registry.cwd || ctx.config.cwd || process.cwd());
    return {
      ...ctx,
      config: { ...ctx.config, cwd },
    };
  }
  const registry = loadOrInit(session, ctx.registry.cwd || ctx.config.cwd || process.cwd());
  const cwd = normalizeCwd(registry.cwd || ctx.registry.cwd || ctx.config.cwd || process.cwd());
  return {
    ...ctx,
    config: { ...ctx.config, cwd, session },
    registry,
  };
}

function parseSpawnRequest(ctx: Context, input: SpawnInput): SpawnRequest {
  const name = validateGroveName(required(input.name, "--name"), "--name");
  const agent = parseAgent(required(input.agent, "--agent"));
  const group = trimmed(input.group);
  const parent = trimmed(input.parent);
  const rolePresetKey = trimmed(input.rolePreset);
  const rolePreset = rolePresetKey ? expandRolePreset(rolePresetKey) : undefined;
  const session = validateGroveName(trimmed(input.session) ?? ctx.config.session, "--session");
  const tmuxSession = validateGroveName(
    trimmed(input.tmuxSession) ?? ctx.registry.tmuxSession ?? session,
    "--tmux-session",
  );
  const sharedTmuxSession = tmuxSession !== session;
  const window = trimmed(input.window) ?? (sharedTmuxSession ? session : undefined);
  return {
    agent,
    cwd: defaultSpawnCwd(ctx, input.cwd),
    description: trimmed(input.description),
    workInstructions: trimmed(input.workInstructions),
    kind: trimmed(input.kind),
    group: group ? validateGroveName(group, "--group") : undefined,
    name,
    parent: parent ? validateGroveName(parent, "--parent") : undefined,
    resume: trimmed(input.resume),
    role: trimmed(input.role) ?? rolePreset?.body ?? "",
    rolePreset: rolePreset?.id,
    rolePresetVersion: rolePreset?.version,
    session,
    tmuxSession,
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
    cwd: node.cwd,
    description: node.description,
    work_instructions: node.work_instructions,
    kind: node.kind,
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

function assertOperatorManaged(input: SpawnInput): void {
  if (!input.operatorManaged) {
    throw new Error(
      "spawn changes the org chart; use the dashboard or pass --operator for explicit human instruction",
    );
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
  assertOperatorManaged(input);
  const session = validateGroveName(trimmed(input.session) ?? baseCtx.config.session, "--session");
  const ctx = sessionContext(baseCtx, session);
  const parsed = parseSpawnRequest(ctx, { ...input, session });
  ensureSpawnable(ctx, parsed);

  return deps.preserveActiveWindow(parsed.tmuxSession, async () => {
    const pane = await deps.createPane({
      cwd: parsed.cwd,
      name: parsed.name,
      session: parsed.tmuxSession,
      window: parsed.window,
    });
    const node: ResolvedNode = {
      agent: parsed.agent,
      children: [],
      cwd: parsed.cwd,
      description: parsed.description,
      work_instructions: parsed.workInstructions,
      kind: parsed.kind,
      group: parsed.group,
      name: parsed.name,
      parent: parsed.parent,
      resume: parsed.resume,
      role: parsed.role,
      rolePreset: parsed.rolePreset,
      rolePresetVersion: parsed.rolePresetVersion,
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
      cwd: parsed.cwd,
      description: parsed.description,
      work_instructions: parsed.workInstructions,
      kind: parsed.kind,
      group: parsed.group,
      name: parsed.name,
      parent: parsed.parent,
      role: parsed.role,
      rolePreset: parsed.rolePreset,
      rolePresetVersion: parsed.rolePresetVersion,
      tmux_pane: pane,
    };
    addParentChild(ctx, parsed.parent, parsed.name);
    deps.saveRegistry(ctx.registry);

    const saved = ctx.registry.nodes[parsed.name]!;
    const transcriptDetected = Boolean(saved.sessionId && saved.transcript);
    return {
      agent: parsed.agent,
      cwd: parsed.cwd,
      description: parsed.description,
      workInstructions: parsed.workInstructions,
      kind: parsed.kind,
      group: parsed.group,
      name: parsed.name,
      pane,
      parent: parsed.parent,
      rebindHint: transcriptDetected ? undefined : rebindHint(parsed),
      role: parsed.role,
      rolePreset: parsed.rolePreset,
      rolePresetVersion: parsed.rolePresetVersion,
      session: parsed.session,
      tmuxSession: parsed.tmuxSession !== parsed.session ? parsed.tmuxSession : undefined,
      sessionId: saved.sessionId,
      transcript: saved.transcript,
      transcriptDetected,
    };
  });
}

export function renderSpawnText(result: SpawnResult): string {
  const lines = [`${result.name} [${result.agent}]`, `role: ${result.role}`];
  if (result.rolePreset) lines.push(`rolePreset: ${result.rolePreset}`);
  if (result.description) lines.push(`description: ${result.description}`);
  if (result.workInstructions) lines.push(`work_instructions: ${result.workInstructions}`);
  if (result.kind) lines.push(`kind: ${result.kind}`);
  lines.push(`cwd: ${result.cwd}`);
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
  opts: SpawnInput & { config?: string; json?: boolean; operator?: boolean },
  deps: SpawnDeps = defaultDeps,
): Promise<void> {
  const ctx = opts.config ? loadContext(opts.config) : configFreeContext(opts);
  const result = await spawnNode(ctx, { ...opts, operatorManaged: Boolean(opts.operator) }, deps);
  process.stdout.write(`${opts.json ? renderSpawnJson(result) : renderSpawnText(result)}\n`);
}
