import type { AgentType, ResolvedNode } from "../config.js";
import { type Context, loadContext } from "../context.js";
import type { NodeRuntime } from "../registry.js";

export interface OrgNode {
  name: string;
  agent: AgentType;
  role?: string;
  description?: string;
  parent?: string;
  children: string[];
  group?: string;
}

export interface OrgJson {
  session: string;
  roots: string[];
  nodes: OrgNode[];
  groups: Record<string, string[]>;
}

function configuredByName(ctx: Context): Map<string, ResolvedNode> {
  return new Map(ctx.nodes.map((node) => [node.name, node]));
}

function runtimeNames(ctx: Context): string[] {
  const configuredNames = ctx.nodes.map((node) => node.name);
  const registryNames = Object.keys(ctx.registry.nodes);
  return [
    ...configuredNames.filter((name) => registryNames.includes(name)),
    ...registryNames.filter((name) => !configuredNames.includes(name)),
  ];
}

function orgNode(name: string, runtime: NodeRuntime, configured?: ResolvedNode): OrgNode {
  return {
    agent: runtime.agent ?? configured?.agent,
    children: [...(runtime.children ?? configured?.children ?? [])],
    description: runtime.description ?? configured?.description,
    group: runtime.group ?? configured?.group,
    name,
    parent: runtime.parent ?? configured?.parent,
    role: runtime.role ?? configured?.role,
  };
}

function deriveChildren(nodes: OrgNode[]): void {
  const byName = new Map(nodes.map((node) => [node.name, node]));
  const children = new Map(nodes.map((node) => [node.name, new Set(node.children)]));
  for (const node of nodes) {
    if (!node.parent || !byName.has(node.parent)) continue;
    children.get(node.parent)?.add(node.name);
  }
  for (const node of nodes) {
    node.children = [...(children.get(node.name) ?? [])];
  }
}

export function buildOrg(ctx: Context): OrgJson {
  const configured = configuredByName(ctx);
  const nodes = runtimeNames(ctx).map((name) =>
    orgNode(name, ctx.registry.nodes[name]!, configured.get(name)),
  );
  deriveChildren(nodes);

  const byName = new Map(nodes.map((node) => [node.name, node]));
  const roots = nodes
    .filter((node) => !node.parent || !byName.has(node.parent))
    .map((node) => node.name);
  const groups: Record<string, string[]> = {};
  for (const node of nodes) {
    if (!node.group) continue;
    groups[node.group] = [...(groups[node.group] ?? []), node.name];
  }
  return { groups, nodes, roots, session: ctx.config.session };
}

function roleSuffix(role?: string): string {
  const label = role?.replace(/\s+/g, " ").trim();
  return label ? ` ${label}` : "";
}

function descriptionLine(description: string | undefined, depth: number): string | null {
  const label = description?.replace(/\s+/g, " ").trim();
  return label ? `${"  ".repeat(depth + 1)}description: ${label}` : null;
}

export function renderOrgText(org: OrgJson): string {
  const byName = new Map(org.nodes.map((node) => [node.name, node]));
  const lines = [org.session];
  const seen = new Set<string>();
  const render = (name: string, depth: number): void => {
    const node = byName.get(name);
    if (!node || seen.has(name)) return;
    seen.add(name);
    lines.push(`${"  ".repeat(depth)}${node.name} [${node.agent}]${roleSuffix(node.role)}`);
    const description = descriptionLine(node.description, depth);
    if (description) lines.push(description);
    for (const child of node.children) render(child, depth + 1);
  };

  for (const root of org.roots) render(root, 0);
  for (const node of org.nodes) render(node.name, 0);

  const groupEntries = Object.entries(org.groups);
  if (groupEntries.length > 0) {
    lines.push("", "groups");
    for (const [group, nodes] of groupEntries) {
      lines.push(`${group}: ${nodes.join(", ")}`);
    }
  }

  return lines.join("\n");
}

export function renderOrgJson(org: OrgJson): string {
  return JSON.stringify(org, null, 2);
}

export async function cmdOrg(opts: { config?: string; json?: boolean }): Promise<void> {
  const ctx = loadContext(opts.config);
  const org = buildOrg(ctx);
  process.stdout.write(`${opts.json ? renderOrgJson(org) : renderOrgText(org)}\n`);
}
