import { getAdapter } from "./adapters/index.js";
import type { GroveConfig, ResolvedNode } from "./config.js";
import { type Context, type NodeCtx, nodeOf } from "./context.js";
import { loadRegistry, type NodeRuntime, type Registry } from "./registry.js";
import { target } from "./tmux.js";
import { validateGroveName } from "./util/names.js";
import { expandHome } from "./util/paths.js";

export interface ProjectNodeAddress {
  node: string;
  project?: string;
}

export interface ProjectNodeTarget {
  callerCtx: Context;
  targetCtx: Context;
  nc: NodeCtx;
  node: string;
  project: string;
  label: string;
  crossProject: boolean;
}

export interface GatherTarget {
  callerCtx: Context;
  targetCtx: Context;
  nodes: string[];
  project: string;
  labels: string[];
  crossProject: boolean;
}

export type GatherTargetGroup = GatherTarget;

export function parseProjectNodeAddress(
  value: string,
  opts: { project?: string } = {},
): ProjectNodeAddress {
  const trimmed = value.trim();
  if (!trimmed) throw new Error("node is required");

  const optionProject = normalizeProjectOption(opts.project);
  const colon = trimmed.indexOf(":");
  if (colon < 0) {
    return {
      node: validateGroveName(trimmed, "node"),
      project: optionProject,
    };
  }

  const rawProject = trimmed.slice(0, colon).trim();
  const rawNode = trimmed.slice(colon + 1).trim();
  if (!rawProject || !rawNode) {
    throw new Error("node address must use [project:]node");
  }
  const addressProject = validateGroveName(rawProject, "project");
  if (optionProject && optionProject !== addressProject) {
    throw new Error(
      `conflicting projects: address targets "${addressProject}" but --project is "${optionProject}"`,
    );
  }
  return {
    node: validateGroveName(rawNode, "node"),
    project: addressProject,
  };
}

export function resolveProjectNodeTarget(
  callerCtx: Context,
  name: string,
  opts: { project?: string } = {},
): ProjectNodeTarget {
  const address = parseProjectNodeAddress(name, opts);
  const targetProject = address.project ?? callerCtx.config.session;
  const targetCtx =
    targetProject === callerCtx.config.session
      ? callerCtx
      : contextFromProjectRegistry(callerCtx, targetProject);
  const nc = nodeOf(targetCtx, address.node);
  const label =
    address.project === undefined || address.project === callerCtx.config.session
      ? address.node
      : `${address.project}:${address.node}`;
  return {
    callerCtx,
    targetCtx,
    nc,
    node: address.node,
    project: targetProject,
    label,
    crossProject: targetCtx !== callerCtx,
  };
}

export function resolveGatherTarget(
  callerCtx: Context,
  names: string[],
  opts: { project?: string } = {},
): GatherTarget {
  const targets = resolveGatherTargets(callerCtx, names, opts);
  if (targets.length !== 1) {
    throw new Error("gather target resolved to multiple projects");
  }
  return targets[0]!;
}

export function resolveGatherTargets(
  callerCtx: Context,
  names: string[],
  opts: { project?: string } = {},
): GatherTargetGroup[] {
  const addresses = names.map((name) => parseProjectNodeAddress(name, opts));
  const byProject = new Map<string, ProjectNodeAddress[]>();
  for (const address of addresses) {
    const project = address.project ?? callerCtx.config.session;
    byProject.set(project, [...(byProject.get(project) ?? []), address]);
  }
  return [...byProject.entries()].map(([targetProject, projectAddresses]) => {
    const targetCtx =
      targetProject === callerCtx.config.session
        ? callerCtx
        : contextFromProjectRegistry(callerCtx, targetProject);
    return {
      callerCtx,
      targetCtx,
      nodes: projectAddresses.map((address) => address.node),
      project: targetProject,
      labels: projectAddresses.map((address) =>
        address.project === undefined || address.project === callerCtx.config.session
          ? address.node
          : `${address.project}:${address.node}`,
      ),
      crossProject: targetCtx !== callerCtx,
    };
  });
}

function normalizeProjectOption(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return validateGroveName(trimmed, "project");
}

function contextFromProjectRegistry(callerCtx: Context, project: string): Context {
  const registry = loadRegistry(project);
  if (registry === null) {
    throw new Error(`project "${project}" not found`);
  }
  const session = registry.session || project;
  const cwd = expandHome(registry.cwd || callerCtx.config.cwd);
  const config: GroveConfig = {
    ...callerCtx.config,
    cwd,
    nodes: {},
    session,
  };
  const nodes = Object.entries(registry.nodes).map(([name, runtime]) =>
    nodeFromRuntime(name, runtime, { config, registry }),
  );
  const byName = new Map<string, NodeCtx>();
  for (const node of nodes) {
    const runtime = registry.nodes[node.name];
    byName.set(node.name, {
      adapter: getAdapter(node.agent),
      addr: runtime?.tmux_pane ?? target(session, node.name),
      node,
    });
  }
  return {
    byName,
    config,
    configPath: callerCtx.configPath,
    nodes,
    registry,
  };
}

function nodeFromRuntime(
  name: string,
  runtime: NodeRuntime,
  ctx: { config: GroveConfig; registry: Registry },
): ResolvedNode {
  const cwd = runtime.cwd || ctx.registry.cwd || ctx.config.cwd;
  return {
    agent: runtime.agent ?? ctx.config.defaults.agent,
    children: [...(runtime.children ?? [])],
    cwd: expandHome(cwd),
    description: runtime.description,
    group: runtime.group,
    name: runtime.name || name,
    parent: runtime.parent,
    role: runtime.role,
    rolePreset: runtime.rolePreset,
    rolePresetVersion: runtime.rolePresetVersion,
  };
}
