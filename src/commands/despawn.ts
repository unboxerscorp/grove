import { type Context, loadContext } from "../context.js";
import { loadOrInit, type NodeRuntime, saveRegistry } from "../registry.js";
import { hasSession, isSinglePaneTarget, killPane, preserveActiveWindow } from "../tmux.js";
import { validateGroveName } from "../util/names.js";

const DEFAULT_DESPAWN_SESSION = "dev10";

export interface DespawnInput {
  node?: string;
  group?: string;
  all?: boolean;
  caller?: string;
  operatorOverride?: boolean;
  yes?: boolean;
  session?: string;
}

export interface DespawnNodeResult {
  name: string;
  pane?: string;
  paneKilled: boolean;
  paneMissing: boolean;
}

export interface DespawnResult {
  session: string;
  removed: DespawnNodeResult[];
}

export interface DespawnDeps {
  hasSession(session: string): Promise<boolean>;
  killPane(addr: string): Promise<boolean>;
  preserveActiveWindow<T>(session: string, fn: () => Promise<T>): Promise<T>;
  saveRegistry(ctx: Context["registry"]): void;
}

const defaultDeps: DespawnDeps = {
  hasSession,
  killPane,
  preserveActiveWindow,
  saveRegistry,
};

function trimmed(value: string | undefined): string | undefined {
  return value?.trim() || undefined;
}

function configFreeContext(input: DespawnInput): Context {
  const session = validateGroveName(trimmed(input.session) ?? DEFAULT_DESPAWN_SESSION, "--session");
  const cwd = process.cwd();
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

function singleTarget(input: DespawnInput): string | undefined {
  const name = trimmed(input.node);
  return name ? validateGroveName(name, "node") : undefined;
}

function groupTarget(input: DespawnInput): string | undefined {
  const group = trimmed(input.group);
  return group ? validateGroveName(group, "--group") : undefined;
}

function callerName(input: DespawnInput): string | undefined {
  const caller = trimmed(input.caller);
  return caller ? validateGroveName(caller, "--caller") : undefined;
}

function targetNodes(ctx: Context, input: DespawnInput): string[] {
  const node = singleTarget(input);
  const group = groupTarget(input);
  const modes = [Boolean(node), Boolean(group), Boolean(input.all)].filter(Boolean).length;
  if (modes !== 1) throw new Error("choose exactly one of <node>, --group, or --all");
  if ((group || input.all) && !input.yes) {
    throw new Error("bulk despawn requires --yes");
  }

  if (node) {
    if (!ctx.registry.nodes[node]) throw new Error(`node not found in registry: ${node}`);
    return [node];
  }
  if (group) {
    const names = Object.values(ctx.registry.nodes)
      .filter((runtime) => runtime.group === group)
      .map((runtime) => runtime.name);
    if (names.length === 0) throw new Error(`no nodes found for group: ${group}`);
    return names;
  }
  return Object.keys(ctx.registry.nodes);
}

function assertTerminationAllowed(ctx: Context, input: DespawnInput, names: string[]): void {
  if (input.operatorOverride) return;
  const caller = callerName(input);
  if (!caller) throw new Error("despawn requires --caller <node> or --operator-override");
  if (!ctx.registry.nodes[caller]) throw new Error(`caller not found in registry: ${caller}`);

  for (const name of names) {
    if (name === caller) throw new Error(`${caller} cannot despawn itself`);
    const runtime: NodeRuntime | undefined = ctx.registry.nodes[name];
    if (!runtime) throw new Error(`node not found in registry: ${name}`);
    if (runtime.parent !== caller) {
      throw new Error(`${caller} cannot despawn ${name}: node is not a direct child`);
    }
  }
}

function removeParentLinks(runtime: NodeRuntime, removed: Set<string>): NodeRuntime {
  const next: NodeRuntime = { ...runtime };
  if (next.children) {
    next.children = next.children.filter((child) => !removed.has(child));
  }
  if (next.parent && removed.has(next.parent)) {
    delete next.parent;
  }
  return next;
}

function removeFromRegistry(ctx: Context, names: string[]): void {
  const removed = new Set(names);
  for (const name of names) {
    delete ctx.registry.nodes[name];
  }
  for (const [name, runtime] of Object.entries(ctx.registry.nodes)) {
    ctx.registry.nodes[name] = removeParentLinks(runtime, removed);
  }
}

async function killTargetPanes(
  session: string,
  runtimes: NodeRuntime[],
  deps: DespawnDeps,
): Promise<DespawnNodeResult[]> {
  const alive = await deps.hasSession(session);
  const kill = async (): Promise<DespawnNodeResult[]> => {
    const out: DespawnNodeResult[] = [];
    for (const runtime of runtimes) {
      const pane = runtime.tmux_pane;
      const paneKilled =
        alive && pane && isSinglePaneTarget(pane) ? await deps.killPane(pane) : false;
      out.push({
        name: runtime.name,
        pane,
        paneKilled,
        paneMissing: Boolean(pane) && !paneKilled,
      });
    }
    return out;
  };
  return alive ? deps.preserveActiveWindow(session, kill) : kill();
}

export async function despawnNodes(
  baseCtx: Context,
  input: DespawnInput,
  deps: DespawnDeps = defaultDeps,
): Promise<DespawnResult> {
  const session = validateGroveName(trimmed(input.session) ?? baseCtx.config.session, "--session");
  const ctx = sessionContext(baseCtx, session);
  const names = targetNodes(ctx, input);
  assertTerminationAllowed(ctx, input, names);
  const runtimes = names.map((name) => ctx.registry.nodes[name]!);
  const removed = await killTargetPanes(session, runtimes, deps);
  removeFromRegistry(ctx, names);
  deps.saveRegistry(ctx.registry);
  return { removed, session };
}

export function renderDespawnText(result: DespawnResult): string {
  const lines = [`session: ${result.session}`];
  for (const item of result.removed) {
    const pane = item.pane ? ` pane=${item.pane}` : "";
    const status = item.paneKilled ? "killed" : item.paneMissing ? "pane-missing" : "registry-only";
    lines.push(`${item.name}: ${status}${pane}`);
  }
  return lines.join("\n");
}

export function renderDespawnJson(result: DespawnResult): string {
  return JSON.stringify(result, null, 2);
}

export async function cmdDespawn(
  node: string | undefined,
  opts: DespawnInput & { config?: string; json?: boolean },
  deps: DespawnDeps = defaultDeps,
): Promise<void> {
  const ctx = opts.config ? loadContext(opts.config) : configFreeContext(opts);
  const result = await despawnNodes(ctx, { ...opts, node }, deps);
  process.stdout.write(`${opts.json ? renderDespawnJson(result) : renderDespawnText(result)}\n`);
}
