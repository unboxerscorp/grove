import { readFileSync, statSync } from "node:fs";

import { type AgentAdapter, getAdapter } from "./adapters/index.js";
import type { ResolvedNode } from "./config.js";
import type { Context, NodeCtx } from "./context.js";
import { target } from "./tmux.js";

const MAX_EARLY_LINES = 120;

export interface TranscriptRebindUpdate {
  node: string;
  beforeSessionId?: string;
  afterSessionId: string;
  beforeTranscript?: string;
  afterTranscript: string;
  pendingCleared: boolean;
}

export interface TranscriptRebindSkip {
  node: string;
  reason: "no-marker" | "no-match" | "ambiguous" | "conflict";
  detail?: string;
}

export interface TranscriptRebindPlan {
  updates: TranscriptRebindUpdate[];
  skipped: TranscriptRebindSkip[];
}

interface Candidate {
  sessionId: string;
  transcript: string;
  mtimeMs: number;
}

export interface RebindOptions {
  getAdapter?: (agent: ResolvedNode["agent"]) => AgentAdapter;
}

function normalizeText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function earlyJsonLines(transcript: string): unknown[] {
  const out: unknown[] = [];
  let lines: string[];
  try {
    lines = readFileSync(transcript, "utf8").split("\n");
  } catch {
    return out;
  }
  for (const line of lines) {
    if (out.length >= MAX_EARLY_LINES) break;
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed) as unknown);
    } catch {
      /* partial transcript line */
    }
  }
  return out;
}

function findStringProperty(value: unknown, key: string): string | null {
  if (!value || typeof value !== "object") return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findStringProperty(item, key);
      if (found) return found;
    }
    return null;
  }
  const record = value as Record<string, unknown>;
  if (typeof record[key] === "string") return record[key];
  for (const child of Object.values(record)) {
    const found = findStringProperty(child, key);
    if (found) return found;
  }
  return null;
}

function transcriptCwd(transcript: string): string | null {
  for (const line of earlyJsonLines(transcript)) {
    const found = findStringProperty(line, "cwd");
    if (found) return found;
  }
  return null;
}

function messageContentText(content: unknown): string[] {
  if (typeof content === "string") return [content];
  if (!Array.isArray(content)) return [];
  const parts: string[] = [];
  for (const item of content) {
    if (typeof item === "string") {
      parts.push(item);
      continue;
    }
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    if (typeof record.text === "string") parts.push(record.text);
  }
  return parts;
}

function earlyUserText(transcript: string): string {
  const parts: string[] = [];
  for (const line of earlyJsonLines(transcript)) {
    if (!line || typeof line !== "object") continue;
    const record = line as Record<string, unknown>;

    if (record.type === "user") {
      const message = record.message;
      if (message && typeof message === "object") {
        parts.push(...messageContentText((message as Record<string, unknown>).content));
      }
      continue;
    }

    if (record.type !== "response_item") continue;
    const payload = record.payload;
    if (!payload || typeof payload !== "object") continue;
    const payloadRecord = payload as Record<string, unknown>;
    if (payloadRecord.type !== "message" || payloadRecord.role !== "user") {
      continue;
    }
    parts.push(...messageContentText(payloadRecord.content));
  }
  return parts.join("\n");
}

function hasNodeMarker(node: ResolvedNode, transcript: string): boolean {
  const text = normalizeText(earlyUserText(transcript));
  if (!text) return false;
  if (node.role && text.includes(normalizeText(node.role))) return true;
  return text.includes(normalizeText(`너는 "${node.name}" 노드`));
}

function findCandidates(nc: NodeCtx): Candidate[] {
  const candidates: Candidate[] = [];
  for (const transcript of nc.adapter.snapshot(nc.node.cwd).keys()) {
    const sessionId = nc.adapter.sessionIdFromPath(transcript);
    if (!sessionId) continue;
    const cwd = transcriptCwd(transcript);
    if (cwd !== nc.node.cwd) continue;
    if (!hasNodeMarker(nc.node, transcript)) continue;
    try {
      candidates.push({
        sessionId,
        transcript,
        mtimeMs: statSync(transcript).mtimeMs,
      });
    } catch {
      /* transcript disappeared while planning */
    }
  }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return candidates;
}

function registryNodeCtxs(
  ctx: Context,
  adapterFor: (agent: ResolvedNode["agent"]) => AgentAdapter,
): NodeCtx[] {
  const out = [...ctx.byName.values()];
  const known = new Set(out.map((nc) => nc.node.name));
  for (const runtime of Object.values(ctx.registry.nodes)) {
    if (known.has(runtime.name)) continue;
    const node: ResolvedNode = {
      agent: runtime.agent,
      children: runtime.children ?? [],
      cwd: ctx.registry.cwd || ctx.config.cwd,
      group: runtime.group,
      name: runtime.name,
      parent: runtime.parent,
      role: runtime.role,
    };
    out.push({
      addr: runtime.tmux_pane ?? target(ctx.registry.session, runtime.name),
      adapter: adapterFor(runtime.agent),
      node,
    });
  }
  return out;
}

function rebindNodeCtxByName(
  ctx: Context,
  adapterFor: (agent: ResolvedNode["agent"]) => AgentAdapter,
): Map<string, NodeCtx> {
  return new Map(registryNodeCtxs(ctx, adapterFor).map((nc) => [nc.node.name, nc]));
}

export function planTranscriptRebinds(
  ctx: Context,
  opts: RebindOptions = {},
): TranscriptRebindPlan {
  const skipped: TranscriptRebindSkip[] = [];
  const selected = new Map<string, Candidate>();
  const nodeCtxs = registryNodeCtxs(ctx, opts.getAdapter ?? getAdapter);

  for (const nc of nodeCtxs) {
    const node = nc.node;
    if (!node.role) {
      skipped.push({ node: node.name, reason: "no-marker" });
      continue;
    }

    const candidates = findCandidates(nc);
    if (candidates.length === 0) {
      skipped.push({ node: node.name, reason: "no-match" });
      continue;
    }
    if (candidates.length > 1) {
      skipped.push({
        node: node.name,
        reason: "ambiguous",
        detail: candidates.map((candidate) => candidate.transcript).join(", "),
      });
      continue;
    }
    selected.set(node.name, candidates[0]!);
  }

  const byTranscript = new Map<string, string[]>();
  for (const [node, candidate] of selected) {
    const nodes = byTranscript.get(candidate.transcript) ?? [];
    nodes.push(node);
    byTranscript.set(candidate.transcript, nodes);
  }
  for (const [transcript, nodes] of byTranscript) {
    if (nodes.length <= 1) continue;
    for (const node of nodes) {
      selected.delete(node);
      skipped.push({ node, reason: "conflict", detail: transcript });
    }
  }

  const updates: TranscriptRebindUpdate[] = [];
  for (const [nodeName, candidate] of selected) {
    const current = ctx.registry.nodes[nodeName];
    const pendingCleared = Boolean(
      current?.pending && current.pending.transcript !== candidate.transcript,
    );
    if (
      current?.sessionId === candidate.sessionId &&
      current?.transcript === candidate.transcript &&
      !pendingCleared
    ) {
      continue;
    }
    updates.push({
      node: nodeName,
      beforeSessionId: current?.sessionId,
      afterSessionId: candidate.sessionId,
      beforeTranscript: current?.transcript,
      afterTranscript: candidate.transcript,
      pendingCleared,
    });
  }

  return { updates, skipped };
}

export function applyTranscriptRebinds(
  ctx: Context,
  plan: TranscriptRebindPlan,
  opts: RebindOptions = {},
): void {
  const byName = rebindNodeCtxByName(ctx, opts.getAdapter ?? getAdapter);
  for (const update of plan.updates) {
    const nc = byName.get(update.node);
    if (!nc) continue;
    const current = ctx.registry.nodes[update.node] ?? {
      name: update.node,
      agent: nc.node.agent,
    };
    ctx.registry.nodes[update.node] = {
      ...current,
      sessionId: update.afterSessionId,
      transcript: update.afterTranscript,
    };
    if (update.pendingCleared) {
      delete ctx.registry.nodes[update.node]!.pending;
    }
  }
}
