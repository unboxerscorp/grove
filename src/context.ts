import { type AgentAdapter, getAdapter } from "./adapters/index.js";
import { type GroveConfig, loadConfig, type ResolvedNode, resolveNodes } from "./config.js";
import { loadOrInit, type NodeRuntime, type Registry } from "./registry.js";
import { target } from "./tmux.js";
import { expandHome } from "./util/paths.js";

export interface NodeCtx {
  node: ResolvedNode;
  adapter: AgentAdapter;
  /** tmux target, preferably the canonical "session:window.pane" form. */
  addr: string;
}

export interface Context {
  configPath: string;
  config: GroveConfig;
  nodes: ResolvedNode[];
  byName: Map<string, NodeCtx>;
  registry: Registry;
}

function nodeFromRuntime(
  name: string,
  runtime: NodeRuntime,
  ctx: { config: GroveConfig; registry: Registry },
): ResolvedNode {
  const cwd = runtime.cwd || ctx.registry.cwd || ctx.config.cwd;
  return {
    agent: runtime.agent,
    children: [...(runtime.children ?? [])],
    cwd: expandHome(cwd),
    description: runtime.description,
    group: runtime.group,
    name,
    parent: runtime.parent,
    role: runtime.role,
  };
}

function addNodeContext(byName: Map<string, NodeCtx>, node: ResolvedNode, addr: string): void {
  byName.set(node.name, {
    adapter: getAdapter(node.agent),
    addr,
    node,
  });
}

export function loadContext(configOpt?: string): Context {
  const { path: configPath, config } = loadConfig(configOpt);
  const nodes = resolveNodes(config);
  const registry = loadOrInit(config.session, config.cwd);
  const byName = new Map<string, NodeCtx>();
  for (const node of nodes) {
    const runtime = registry.nodes[node.name];
    addNodeContext(
      byName,
      node,
      runtime?.tmux_pane ?? target(config.session, node.tmux ?? node.name),
    );
  }
  for (const [name, runtime] of Object.entries(registry.nodes)) {
    if (byName.has(name)) continue;
    const node = nodeFromRuntime(name, runtime, { config, registry });
    addNodeContext(
      byName,
      node,
      runtime.tmux_pane ?? target(registry.tmuxSession ?? registry.session, node.name),
    );
  }
  return { configPath, config, nodes, byName, registry };
}

export function nodeOf(ctx: Context, name: string): NodeCtx {
  const nc = ctx.byName.get(name);
  if (!nc) {
    const known = [...ctx.byName.keys()].join(", ") || "(none)";
    throw new Error(`unknown node "${name}". known nodes: ${known}`);
  }
  return nc;
}
