import { type AgentAdapter, getAdapter } from "./adapters/index.js";
import { type GroveConfig, loadConfig, type ResolvedNode, resolveNodes } from "./config.js";
import { loadOrInit, type Registry } from "./registry.js";
import { target } from "./tmux.js";

export interface NodeCtx {
  node: ResolvedNode;
  adapter: AgentAdapter;
  /** tmux target, preferably the stable "session:window.%pane_id" form. */
  addr: string;
}

export interface Context {
  configPath: string;
  config: GroveConfig;
  nodes: ResolvedNode[];
  byName: Map<string, NodeCtx>;
  registry: Registry;
}

export function loadContext(configOpt?: string): Context {
  const { path: configPath, config } = loadConfig(configOpt);
  const nodes = resolveNodes(config);
  const registry = loadOrInit(config.session, config.cwd);
  const byName = new Map<string, NodeCtx>();
  for (const node of nodes) {
    const runtime = registry.nodes[node.name];
    byName.set(node.name, {
      node,
      adapter: getAdapter(node.agent),
      addr: runtime?.tmux_pane ?? target(config.session, node.tmux ?? node.name),
    });
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
