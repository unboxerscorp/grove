import type { Context, NodeCtx } from "./context.js";
import type { Registry } from "./registry.js";

export const GROVE_CONTEXT_PACK_HEADER = "GROVE CONTEXT PACK";
const DEFAULT_MAX_BYTES = 8_000;
const MAX_NODE_LINES = 40;
// Caps for the advisory work-instructions field so a pathologically long value
// cannot bloat every dispatch. The full top-level line gets a generous cap; the
// per-node org-summary entry stays compact. Mirror these in the Python renderer.
const WORK_INSTRUCTIONS_FULL_MAX_CHARS = 500;
const WORK_INSTRUCTIONS_SUMMARY_MAX_CHARS = 120;

export interface ContextPackNode {
  name: string;
  agent?: string;
  cwd?: string;
  parent?: string;
  group?: string;
  role?: string;
  workInstructions?: string;
  tmuxPane?: string;
  // Owning project (registry session). Used ONLY by collapseForeignProjects to
  // decide visibility — never rendered, so it does not affect pack bytes. Unset
  // means "treat as home project" (legacy single-project packs).
  project?: string;
}

export interface GroveContextPackInput {
  callerNode?: string;
  communicationProtocol?: string;
  maxBytes?: number;
  nodes?: readonly ContextPackNode[];
  project: string;
  // Registry/session backing the project. Rendered as a separate line ONLY when
  // it differs from `project` (v1 keeps them 1:1, so the line never appears and
  // the pack stays byte-identical). Disentangles project identity from storage.
  registrySession?: string;
  projectLead?: string;
  targetNode?: string;
  targetRole?: string;
  targetWorkInstructions?: string;
}

function clean(value: string | undefined, fallback = "(unknown)"): string {
  const stripped = value?.replace(/\s+/g, " ").trim();
  return stripped || fallback;
}

function firstLine(value: string | undefined): string {
  return clean(value, "").split("\n")[0]?.trim() ?? "";
}

/** Cap by Unicode code points (matching Python str slicing) so the TS and
 *  Python context-pack renderers stay byte-for-byte identical. */
function capCodePoints(value: string, maxChars: number): string {
  const chars = [...value];
  if (chars.length <= maxChars) return value;
  return `${chars.slice(0, maxChars).join("")}…`;
}

/** Full advisory work-instructions text: whitespace collapsed to one line, then
 *  capped. Empty when unset, so dispatches without it are byte-identical. */
function workInstructionsFull(value: string | undefined): string {
  return capCodePoints(clean(value, ""), WORK_INSTRUCTIONS_FULL_MAX_CHARS);
}

/** Compact work-instructions summary for an org-summary node line: first raw
 *  line only, whitespace collapsed, then capped short. */
function workInstructionsSummary(value: string | undefined): string {
  const firstRawLine = (value ?? "").split(/\r?\n/)[0] ?? "";
  return capCodePoints(clean(firstRawLine, ""), WORK_INSTRUCTIONS_SUMMARY_MAX_CHARS);
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
  const workInstructions = workInstructionsSummary(node.workInstructions);
  if (workInstructions) parts.push(`work_instructions=${workInstructions}`);
  return `- ${parent} -> ${clean(node.name)} (${parts.join("; ")})`;
}

const INFRA_GROUPS = new Set(["master", "services"]);

/** Shared control-plane nodes — master/services groups, plus the advisor — are
 *  always shown regardless of project; they are not part of any one project's
 *  worker tree. */
function isInfraNode(node: ContextPackNode): boolean {
  const group = node.group?.trim() ?? "";
  return (group !== "" && INFRA_GROUPS.has(group)) || node.name === "advisor";
}

/** Lead of a foreign project, found among its own nodes — mirrors projectLead's
 *  heuristic (a node named "lead", else a root node whose name contains
 *  "lead"). Returns undefined when neither matches. */
function foreignProjectLeadName(nodes: readonly ContextPackNode[]): string | undefined {
  const named = nodes.find((node) => node.name === "lead");
  if (named) return named.name;
  const rootLead = nodes.find((node) => !node.parent && node.name.includes("lead"));
  return rootLead?.name;
}

/**
 * Collapse the visible org so OTHER projects surface only their lead node
 * (task_dd4). Home-project nodes — and nodes with no project, i.e. legacy
 * single-project packs — are kept in full; shared control-plane nodes are
 * exempt; each foreign project keeps only its lead (dropped entirely if it has
 * none). Node SELECTION only: input order is preserved and the renderer is
 * untouched, so the byte-parity fixtures are unaffected. A single-project pack
 * is an inert no-op. Mirror of context_pack.py:collapse_foreign_projects.
 */
export function collapseForeignProjects(
  nodes: readonly ContextPackNode[],
  homeProject: string,
): ContextPackNode[] {
  const home = homeProject.trim();
  const foreignByProject = new Map<string, ContextPackNode[]>();
  for (const node of nodes) {
    const project = node.project?.trim() ?? "";
    if (project !== "" && project !== home && !isInfraNode(node)) {
      const group = foreignByProject.get(project) ?? [];
      group.push(node);
      foreignByProject.set(project, group);
    }
  }
  const keptForeignLeads = new Set<string>();
  for (const [project, group] of foreignByProject) {
    const leadName = foreignProjectLeadName(group);
    if (leadName !== undefined) keptForeignLeads.add(`${project} ${leadName}`);
  }
  return nodes.filter((node) => {
    const project = node.project?.trim() ?? "";
    if (project === "" || project === home) return true;
    if (isInfraNode(node)) return true;
    return keptForeignLeads.has(`${project} ${node.name}`);
  });
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
      workInstructions: node.work_instructions,
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
      workInstructions: runtime?.work_instructions ?? node.work_instructions,
      tmuxPane: runtime?.tmux_pane,
    });
  }
  for (const node of contextPackNodesFromRegistry(ctx.registry)) {
    if (!byName.has(node.name)) byName.set(node.name, node);
  }
  return [...byName.values()].sort((left, right) => left.name.localeCompare(right.name));
}

/** The `Registry/session:` line, rendered only when the registry/session differs
 *  from the logical project (v1 keeps them 1:1, so this is empty and the pack is
 *  byte-identical). Mirror of context_pack.py:_registry_session_lines. */
function registrySessionLines(input: GroveContextPackInput): string[] {
  const session = input.registrySession?.trim() ?? "";
  if (session === "" || session === input.project.trim()) return [];
  return [`Registry/session: ${clean(session)}`];
}

export function buildGroveContextPack(input: GroveContextPackInput): string {
  const nodes = collapseForeignProjects(input.nodes ?? [], input.project).slice(0, MAX_NODE_LINES);
  const lead = projectLead(nodes, input.projectLead);
  const targetNode = input.targetNode?.trim();
  const targetRole = firstLine(input.targetRole);
  const targetWorkInstructions = workInstructionsFull(input.targetWorkInstructions);
  const communicationProtocol =
    input.communicationProtocol ??
    "Nodes may communicate directly across projects and hierarchy. Human-facing list items are for human TODO, feedback, and ask-human records, not a required node-to-node protocol.";
  const orgLines = nodes.length
    ? nodes.map(nodeLine)
    : ["- (visible org summary unavailable in this dispatch context)"];
  const lines = [
    GROVE_CONTEXT_PACK_HEADER,
    `Caller node: ${clean(input.callerNode, "operator/CLI")}`,
    `Project: ${clean(input.project)}`,
    ...registrySessionLines(input),
    `Project lead: ${clean(lead)}`,
    targetNode ? `Target node: ${targetNode}` : "Target node: (none)",
    targetRole ? `Target role: ${targetRole}` : "Target role: (not recorded)",
    ...(targetWorkInstructions
      ? [`Target work instructions (advisory): ${targetWorkInstructions}`]
      : []),
    `Communication protocol: ${communicationProtocol}`,
    "Visible org summary:",
    ...orgLines,
  ];
  return truncateUtf8(
    redactGroveContextText(lines.join("\n")),
    input.maxBytes ?? DEFAULT_MAX_BYTES,
  );
}

/**
 * Compact node-to-node pack: the token-saving default for live `grove send` /
 * `grove ask` between running nodes. Carries identity (caller/project/target),
 * the target's role + work-instructions summary, and an org digest (node count)
 * with a one-line reminder pointing at `grove org --all --json` / `grove task mine`
 * for a full refresh — so the org/rules are still reachable, just not inlined.
 * Keeps the `GROVE CONTEXT PACK` header prefix so the no-duplicate-prepend guard
 * still fires. Mirror of context_pack.py:build_compact_grove_context_pack.
 */
export function buildCompactGroveContextPack(input: GroveContextPackInput): string {
  const targetNode = input.targetNode?.trim();
  const targetRole = firstLine(input.targetRole);
  const workInstructions = workInstructionsSummary(input.targetWorkInstructions);
  const nodeCount = (input.nodes ?? []).length;
  const lines = [
    `${GROVE_CONTEXT_PACK_HEADER} (compact)`,
    `Caller node: ${clean(input.callerNode, "operator/CLI")}`,
    `Project: ${clean(input.project)}`,
    ...registrySessionLines(input),
    targetNode ? `Target node: ${targetNode}` : "Target node: (none)",
    ...(targetRole ? [`Target role: ${targetRole}`] : []),
    ...(workInstructions ? [`Target work instructions (advisory): ${workInstructions}`] : []),
    `Visible org: ${nodeCount} ${nodeCount === 1 ? "node" : "nodes"} — run \`grove org --all --json\` for the full multi-project tree; \`grove task mine\` for your tasks.`,
  ];
  return truncateUtf8(
    redactGroveContextText(lines.join("\n")),
    input.maxBytes ?? DEFAULT_MAX_BYTES,
  );
}

export type ContextMode = "full" | "compact" | "none";

function asContextMode(value: string | undefined): ContextMode | undefined {
  const mode = value?.trim().toLowerCase();
  return mode === "full" || mode === "compact" || mode === "none" ? mode : undefined;
}

/** Resolve the context-pack mode by precedence: an explicit value (e.g. the
 *  `--context` flag) wins, then the `GROVE_CONTEXT_MODE` env override, then the
 *  caller's fallback (compact for live node-to-node, full for bootstrap). */
export function resolveContextMode(
  explicit: string | undefined,
  fallback: ContextMode,
): ContextMode {
  return asContextMode(explicit) ?? asContextMode(process.env.GROVE_CONTEXT_MODE) ?? fallback;
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
    contextMode?: ContextMode;
    maxBytes?: number;
    project?: string;
  } = {},
): string {
  const project = opts.project ?? opts.context?.config.session ?? "unknown";
  const input: GroveContextPackInput = {
    callerNode: opts.callerNode,
    maxBytes: opts.maxBytes,
    nodes: opts.context ? contextPackNodesFromContext(opts.context) : [{ ...nc.node }],
    project,
    targetNode: nc.node.name,
    targetRole: nc.node.role,
    targetWorkInstructions: nc.node.work_instructions,
  };
  return opts.contextMode === "compact"
    ? buildCompactGroveContextPack(input)
    : buildGroveContextPack(input);
}

export function prependNodeContextPack(
  nc: NodeCtx,
  message: string,
  opts: {
    callerNode?: string;
    context?: Context;
    contextMode?: ContextMode;
    maxBytes?: number;
    project?: string;
  } = {},
): string {
  if (opts.contextMode === "none") return message;
  if (message.trimStart().startsWith(GROVE_CONTEXT_PACK_HEADER)) return message;
  return `${buildNodeContextPack(nc, opts)}\n\nOriginal message:\n${message}`;
}
