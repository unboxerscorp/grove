import { getAdapter, type AgentAdapter } from "./adapters/index.js";
import {
  loadConfig,
  resolveNodes,
  type GroveConfig,
  type ResolvedNode,
} from "./config.js";
import { loadOrInit, type Registry } from "./registry.js";
import { target } from "./tmux.js";

export interface NodeCtx {
  node: ResolvedNode;
  adapter: AgentAdapter;
  /** tmux address "session:window" */
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
  const byName = new Map<string, NodeCtx>();
  for (const node of nodes) {
    byName.set(node.name, {
      node,
      adapter: getAdapter(node.agent),
      addr: target(config.session, node.name),
    });
  }
  const registry = loadOrInit(config.session, config.cwd);
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
