import type { Context, NodeCtx } from "./context.js";
import type { Registry } from "./registry.js";

export const GROVE_CONTEXT_PACK_HEADER = "GROVE CONTEXT PACK";
const DEFAULT_MAX_BYTES = 8_000;
const MAX_NODE_LINES = 40;

export interface ContextPackNode {
  name: string;
  agent?: string;
  cwd?: string;
  parent?: string;
  group?: string;
  role?: string;
  tmuxPane?: string;
}

export interface GroveContextPackInput {
  callerNode?: string;
  communicationProtocol?: string;
  maxBytes?: number;
  nodes?: readonly ContextPackNode[];
  project: string;
  projectLead?: string;
  targetNode?: string;
  targetRole?: string;
}

function clean(value: string | undefined, fallback = "(unknown)"): string {
  const stripped = value?.replace(/\s+/g, " ").trim();
  return stripped || fallback;
}

function firstLine(value: string | undefined): string {
  return clean(value, "").split("\n")[0]?.trim() ?? "";
}

export function redactGroveContextText(value: string): string {
  return value
    .replace(/\bxox[a-z]?-[^\s,)]+/gi, "[redacted]")
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, "[redacted]")
    .replace(
      /\b(token|secret|password|api[_-]?key)\s*[:=]\s*[^\s,)]+/gi,
      (_match, key: string) => `${key}=[redacted]`,
    );
}

function truncateUtf8(value: string, maxBytes: number): string {
  const cap = Math.max(256, maxBytes);
  if (Buffer.byteLength(value, "utf8") <= cap) return value;
  const suffix = "\n[context pack truncated]";
  let out = value;
  while (out.length > 0 && Buffer.byteLength(out + suffix, "utf8") > cap) {
    out = out.slice(0, -1);
  }
  return out + suffix;
}

function projectLead(nodes: readonly ContextPackNode[], explicit: string | undefined): string {
  if (explicit?.trim()) return explicit.trim();
  const namedLead = nodes.find((node) => node.name === "lead");
  if (namedLead) return namedLead.name;
  const rootLead = nodes.find((node) => !node.parent && node.name.includes("lead"));
  return rootLead?.name ?? "lead";
}

function nodeLine(node: ContextPackNode): string {
  const parent = clean(node.parent, "root");
  const parts = [clean(node.agent, "unknown")];
  if (node.group?.trim()) parts.push(`group=${clean(node.group)}`);
  if (node.tmuxPane?.trim()) parts.push(`pane=${clean(node.tmuxPane)}`);
  if (node.cwd?.trim()) parts.push(`cwd=${clean(node.cwd)}`);
  const role = firstLine(node.role);
  if (role) parts.push(`role=${role}`);
  return `- ${parent} -> ${clean(node.name)} (${parts.join("; ")})`;
}

export function contextPackNodesFromRegistry(registry: Registry): ContextPackNode[] {
  return Object.entries(registry.nodes)
    .map(([key, node]) => ({
      agent: node.agent,
      cwd: node.cwd,
      group: node.group,
      name: node.name || key,
      parent: node.parent,
      role: node.role,
      tmuxPane: node.tmux_pane,
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

export function contextPackNodesFromContext(ctx: Context): ContextPackNode[] {
  const byName = new Map<string, ContextPackNode>();
  for (const node of ctx.nodes) {
    const runtime = ctx.registry.nodes[node.name];
    byName.set(node.name, {
      agent: node.agent,
      cwd: runtime?.cwd ?? node.cwd,
      group: runtime?.group ?? node.group,
      name: node.name,
      parent: runtime?.parent ?? node.parent,
      role: runtime?.role ?? node.role,
      tmuxPane: runtime?.tmux_pane,
    });
  }
  for (const node of contextPackNodesFromRegistry(ctx.registry)) {
    if (!byName.has(node.name)) byName.set(node.name, node);
  }
  return [...byName.values()].sort((left, right) => left.name.localeCompare(right.name));
}

export function buildGroveContextPack(input: GroveContextPackInput): string {
  const nodes = [...(input.nodes ?? [])].slice(0, MAX_NODE_LINES);
  const lead = projectLead(nodes, input.projectLead);
  const targetNode = input.targetNode?.trim();
  const targetRole = firstLine(input.targetRole);
  const communicationProtocol =
    input.communicationProtocol ??
    "Nodes may communicate directly across projects and hierarchy. Board tasks are for human TODO, feedback, and ask-human records, not a required node-to-node protocol.";
  const orgLines = nodes.length
    ? nodes.map(nodeLine)
    : ["- (visible org summary unavailable in this dispatch context)"];
  const lines = [
    GROVE_CONTEXT_PACK_HEADER,
    `Caller node: ${clean(input.callerNode, "operator/CLI")}`,
    `Project: ${clean(input.project)}`,
    `Project lead: ${clean(lead)}`,
    targetNode ? `Target node: ${targetNode}` : "Target node: (none)",
    targetRole ? `Target role: ${targetRole}` : "Target role: (not recorded)",
    `Communication protocol: ${communicationProtocol}`,
    "Visible org summary:",
    ...orgLines,
  ];
  return truncateUtf8(
    redactGroveContextText(lines.join("\n")),
    input.maxBytes ?? DEFAULT_MAX_BYTES,
  );
}

export function prependGroveContextPack(message: string, input: GroveContextPackInput): string {
  if (message.trimStart().startsWith(GROVE_CONTEXT_PACK_HEADER)) return message;
  const pack = buildGroveContextPack(input);
  return `${pack}\n\nOriginal message:\n${message}`;
}

export function buildNodeContextPack(
  nc: NodeCtx,
  opts: {
    callerNode?: string;
    context?: Context;
    maxBytes?: number;
    project?: string;
  } = {},
): string {
  const project = opts.project ?? opts.context?.config.session ?? "unknown";
  return buildGroveContextPack({
    callerNode: opts.callerNode,
    maxBytes: opts.maxBytes,
    nodes: opts.context ? contextPackNodesFromContext(opts.context) : [{ ...nc.node }],
    project,
    targetNode: nc.node.name,
    targetRole: nc.node.role,
  });
}

export function prependNodeContextPack(
  nc: NodeCtx,
  message: string,
  opts: {
    callerNode?: string;
    context?: Context;
    maxBytes?: number;
    project?: string;
  } = {},
): string {
  if (message.trimStart().startsWith(GROVE_CONTEXT_PACK_HEADER)) return message;
  return `${buildNodeContextPack(nc, opts)}\n\nOriginal message:\n${message}`;
}
