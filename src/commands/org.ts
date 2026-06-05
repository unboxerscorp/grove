import type { AgentType, ResolvedNode } from "../config.js";
import { type Context, loadContext } from "../context.js";
import {
  GROVE_MASTER_NODE_NAME,
  loadRegistry,
  type NodeRuntime,
  type Registry,
  sharedMasterRuntime,
} from "../registry.js";
import { paneExists, target } from "../tmux.js";
import { MASTER_REGISTRY_SESSION } from "../util/paths.js";

export interface OrgNode {
  name: string;
  agent: AgentType;
  role?: string;
  description?: string;
  parent?: string;
  children: string[];
  group?: string;
  cwd: string;
  tmux_pane: string;
  session_id: string;
  status: string;
  pane_exists?: boolean;
  unavailable_reason?: string;
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

function orgNode(
  name: string,
  runtime: NodeRuntime,
  configured: ResolvedNode | undefined,
  session: string,
): OrgNode {
  return {
    agent: runtime.agent ?? configured?.agent,
    children: [...(runtime.children ?? configured?.children ?? [])],
    cwd: runtime.cwd ?? configured?.cwd ?? "",
    description: runtime.description ?? configured?.description,
    group: runtime.group ?? configured?.group,
    name,
    parent: runtime.parent ?? configured?.parent,
    role: runtime.role ?? configured?.role,
    session_id: runtime.sessionId ?? "",
    status: runtime.status ?? (runtime.pending ? "running" : ""),
    tmux_pane: runtime.tmux_pane ?? (configured?.tmux ? target(session, configured.tmux) : ""),
  };
}

function masterOrgNode(masterRegistry: Registry | null, session: string): OrgNode {
  return orgNode(
    GROVE_MASTER_NODE_NAME,
    masterRegistry?.nodes[GROVE_MASTER_NODE_NAME] ?? sharedMasterRuntime(),
    undefined,
    session,
  );
}

function projectLeadName(nodes: OrgNode[]): string | undefined {
  if (nodes.some((node) => node.name === "lead")) return "lead";
  return nodes.find((node) => node.name !== GROVE_MASTER_NODE_NAME && node.parent === "")?.name;
}

function applyMasterHierarchy(nodes: OrgNode[]): void {
  const byName = new Map(nodes.map((node) => [node.name, node]));
  const leadName = projectLeadName(nodes);
  for (const node of nodes) {
    if (node.name === GROVE_MASTER_NODE_NAME) {
      node.parent = "";
      continue;
    }
    if (leadName && node.name === leadName) {
      node.parent = GROVE_MASTER_NODE_NAME;
      continue;
    }
    if (!node.parent || !byName.has(node.parent)) {
      node.parent = leadName ?? GROVE_MASTER_NODE_NAME;
    }
  }
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

export function buildOrg(
  ctx: Context,
  masterRegistry: Registry | null = loadRegistry(MASTER_REGISTRY_SESSION),
): OrgJson {
  const configured = configuredByName(ctx);
  const nodes = runtimeNames(ctx).map((name) =>
    orgNode(name, ctx.registry.nodes[name]!, configured.get(name), ctx.config.session),
  );
  if (!nodes.some((node) => node.name === GROVE_MASTER_NODE_NAME)) {
    nodes.unshift(masterOrgNode(masterRegistry, ctx.config.session));
  }
  applyMasterHierarchy(nodes);
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

export async function annotateOrgPaneStatus(
  org: OrgJson,
  paneExistsFn: (pane: string) => Promise<boolean> = paneExists,
): Promise<OrgJson> {
  const nodes = await Promise.all(
    org.nodes.map(async (node) => {
      if (!node.tmux_pane) return node;
      const exists = await paneExistsFn(node.tmux_pane);
      if (exists) {
        return {
          ...node,
          pane_exists: true,
          unavailable_reason: node.unavailable_reason ?? "",
        };
      }
      return {
        ...node,
        pane_exists: false,
        status: "pane-missing",
        unavailable_reason: "tmux pane missing",
      };
    }),
  );
  return { ...org, nodes };
}

function roleSuffix(role?: string): string {
  const label = role?.replace(/\s+/g, " ").trim();
  return label ? ` ${label}` : "";
}

function descriptionLine(description: string | undefined, depth: number): string | null {
  const label = description?.replace(/\s+/g, " ").trim();
  return label ? `${"  ".repeat(depth + 1)}description: ${label}` : null;
}

function metadataLines(node: OrgNode, depth: number): string[] {
  const indent = "  ".repeat(depth + 1);
  const lines: string[] = [];
  if (node.tmux_pane) lines.push(`${indent}pane: ${node.tmux_pane}`);
  if (typeof node.pane_exists === "boolean") {
    lines.push(`${indent}pane_exists: ${String(node.pane_exists)}`);
  }
  if (node.cwd) lines.push(`${indent}cwd: ${node.cwd}`);
  if (node.session_id) lines.push(`${indent}session_id: ${node.session_id}`);
  if (node.status) lines.push(`${indent}status: ${node.status}`);
  if (node.unavailable_reason)
    lines.push(`${indent}unavailable_reason: ${node.unavailable_reason}`);
  return lines;
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
    lines.push(...metadataLines(node, depth));
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
  const org = await annotateOrgPaneStatus(buildOrg(ctx));
  process.stdout.write(`${opts.json ? renderOrgJson(org) : renderOrgText(org)}\n`);
}
