import { existsSync } from "node:fs";

import { getAdapter } from "../adapters/index.js";
import type { AgentAdapter } from "../adapters/types.js";
import type { AgentType, ResolvedNode } from "../config.js";
import { type Context, loadContext, type NodeCtx } from "../context.js";
import {
  applyTranscriptRebinds,
  planTranscriptRebinds,
  type TranscriptRebindPlan,
} from "../rebind.js";
import type { NodeRuntime } from "../registry.js";
import { loadOrInit, saveRegistry } from "../registry.js";
import { hasSession, paneTarget, preserveActiveWindow, target } from "../tmux.js";
import { color, info, warn } from "../util/log.js";
import { validateGroveName } from "../util/names.js";

export type RepairStatus = "recovered" | "stale" | "unrecoverable";
export type RepairKind = "pane" | "transcript";

export interface RepairItem {
  node: string;
  kind: RepairKind;
  status: RepairStatus;
  reason: string;
  before?: string;
  after?: string;
  detail?: string;
}

export interface RepairResult {
  session: string;
  recovered: RepairItem[];
  stale: RepairItem[];
  unrecoverable: RepairItem[];
}

export interface RepairInput {
  all?: boolean;
  node?: string;
  session?: string;
}

export interface RepairDeps {
  exists(file: string): boolean;
  getAdapter(agent: AgentType): AgentAdapter;
  hasSession(session: string): Promise<boolean>;
  loadContext(config?: string): Context;
  paneTarget(addr: string): Promise<string>;
  preserveActiveWindow<T>(session: string, fn: () => Promise<T>): Promise<T>;
  saveRegistry(ctx: Context["registry"]): void;
}

const defaultDeps: RepairDeps = {
  exists: existsSync,
  getAdapter,
  hasSession,
  loadContext,
  paneTarget,
  preserveActiveWindow,
  saveRegistry,
};

function trimmed(value: string | undefined): string | undefined {
  return value?.trim() || undefined;
}

function selectedNames(ctx: Context, input: RepairInput): string[] {
  const node = trimmed(input.node);
  if (input.all && node) throw new Error("choose only one of --all or --node");
  if (node) {
    const name = validateGroveName(node, "--node");
    if (!ctx.registry.nodes[name]) throw new Error(`node not found in registry: ${name}`);
    return [name];
  }
  return Object.keys(ctx.registry.nodes);
}

function contextForSession(ctx: Context, session: string | undefined): Context {
  const targetSession = trimmed(session);
  if (!targetSession || targetSession === ctx.registry.session) return ctx;
  const safeSession = validateGroveName(targetSession, "--session");
  return {
    ...ctx,
    config: { ...ctx.config, session: safeSession },
    registry: loadOrInit(safeSession, ctx.config.cwd),
  };
}

function configuredNode(ctx: Context, name: string): ResolvedNode | undefined {
  return ctx.byName.get(name)?.node;
}

function runtimeNode(ctx: Context, runtime: NodeRuntime): ResolvedNode {
  const configured = configuredNode(ctx, runtime.name);
  return {
    agent: runtime.agent,
    children: runtime.children ?? configured?.children ?? [],
    cwd: ctx.registry.cwd || ctx.config.cwd,
    description: runtime.description ?? configured?.description,
    group: runtime.group ?? configured?.group,
    name: runtime.name,
    parent: runtime.parent ?? configured?.parent,
    role: runtime.role ?? configured?.role,
    tmux: configured?.tmux,
  };
}

function nodeCtx(ctx: Context, runtime: NodeRuntime, deps: RepairDeps): NodeCtx {
  const existing = ctx.byName.get(runtime.name);
  if (existing) {
    return {
      ...existing,
      addr: runtime.tmux_pane ?? existing.addr,
    };
  }
  const node = runtimeNode(ctx, runtime);
  return {
    addr: runtime.tmux_pane ?? target(ctx.registry.session, runtime.name),
    adapter: deps.getAdapter(node.agent),
    node,
  };
}

function item(
  status: RepairStatus,
  node: string,
  kind: RepairKind,
  reason: string,
  details: Omit<RepairItem, "kind" | "node" | "reason" | "status"> = {},
): RepairItem {
  return { kind, node, reason, status, ...details };
}

function pushItem(result: RepairResult, entry: RepairItem): void {
  if (entry.status === "recovered") result.recovered.push(entry);
  else if (entry.status === "stale") result.stale.push(entry);
  else result.unrecoverable.push(entry);
}

async function repairPane(
  ctx: Context,
  nc: NodeCtx,
  runtime: NodeRuntime,
  deps: RepairDeps,
): Promise<RepairItem | null> {
  const current = runtime.tmux_pane;
  const explicit = nc.node.tmux ? target(ctx.registry.session, nc.node.tmux) : undefined;
  if (!current && !explicit) return null;

  try {
    const resolved = await deps.paneTarget(current ?? explicit!);
    if (current !== resolved) {
      runtime.tmux_pane = resolved;
      nc.addr = resolved;
      return item("recovered", runtime.name, "pane", "pane-rebound", {
        after: resolved,
        before: current,
      });
    }
    return null;
  } catch (error) {
    if (!explicit || explicit === current) {
      return item("unrecoverable", runtime.name, "pane", "pane-missing", {
        before: current,
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }

  try {
    const resolved = await deps.paneTarget(explicit);
    runtime.tmux_pane = resolved;
    nc.addr = resolved;
    return item("recovered", runtime.name, "pane", "pane-rebound", {
      after: resolved,
      before: current,
    });
  } catch (error) {
    return item("unrecoverable", runtime.name, "pane", "pane-missing", {
      before: current,
      detail: error instanceof Error ? error.message : String(error),
    });
  }
}

function transcriptState(
  nc: NodeCtx,
  runtime: NodeRuntime,
  deps: RepairDeps,
): "ok" | "missing" | "empty" | null {
  if (!runtime.sessionId) return null;
  if (!runtime.transcript) return "missing";
  if (!deps.exists(runtime.transcript)) return "missing";
  return nc.adapter.size(runtime.transcript) > 0 ? "ok" : "empty";
}

function repairDeterministicTranscript(
  nc: NodeCtx,
  runtime: NodeRuntime,
  deps: RepairDeps,
): RepairItem | null {
  const state = transcriptState(nc, runtime, deps);
  if (!state || state === "ok" || !runtime.sessionId) return null;

  const candidate = nc.adapter.transcriptForSession(nc.node.cwd, runtime.sessionId);
  if (candidate && deps.exists(candidate) && nc.adapter.size(candidate) > 0) {
    const before = runtime.transcript;
    runtime.transcript = candidate;
    if (runtime.pending && runtime.pending.transcript !== candidate) {
      delete runtime.pending;
    }
    return item("recovered", runtime.name, "transcript", `transcript-${state}`, {
      after: candidate,
      before,
    });
  }

  return item("stale", runtime.name, "transcript", `transcript-${state}`, {
    before: runtime.transcript,
    detail: "no non-empty transcript resolved for bound sessionId",
  });
}

function filterTranscriptPlan(
  plan: TranscriptRebindPlan,
  names: Set<string>,
): TranscriptRebindPlan {
  return {
    skipped: plan.skipped.filter((entry) => names.has(entry.node)),
    updates: plan.updates.filter((entry) => names.has(entry.node)),
  };
}

function applyTranscriptPlan(
  ctx: Context,
  plan: TranscriptRebindPlan,
  result: RepairResult,
  seenTranscriptNodes: Set<string>,
  deps: RepairDeps,
): boolean {
  if (plan.updates.length === 0) return false;
  applyTranscriptRebinds(ctx, plan, { getAdapter: (agent) => deps.getAdapter(agent) });
  for (const update of plan.updates) {
    seenTranscriptNodes.add(update.node);
    pushItem(
      result,
      item("recovered", update.node, "transcript", "transcript-rebound", {
        after: update.afterTranscript,
        before: update.beforeTranscript,
      }),
    );
  }
  return true;
}

function reportTranscriptSkips(
  plan: TranscriptRebindPlan,
  result: RepairResult,
  staleNodes: Map<string, RepairItem>,
  recoveredTranscriptNodes: Set<string>,
): void {
  for (const node of recoveredTranscriptNodes) {
    staleNodes.delete(node);
  }
  for (const skipped of plan.skipped) {
    if (recoveredTranscriptNodes.has(skipped.node)) continue;
    const stale = staleNodes.get(skipped.node);
    if (!stale) continue;
    pushItem(result, {
      ...stale,
      detail: skipped.detail ?? stale.detail,
      reason: `${stale.reason}:${skipped.reason}`,
    });
    staleNodes.delete(skipped.node);
  }
  for (const stale of staleNodes.values()) pushItem(result, stale);
}

export async function repairNodes(
  baseCtx: Context,
  input: RepairInput = {},
  deps: RepairDeps = defaultDeps,
): Promise<RepairResult> {
  const ctx = contextForSession(baseCtx, input.session);
  const names = selectedNames(ctx, input);
  const selected = new Set(names);
  const result: RepairResult = {
    recovered: [],
    session: ctx.registry.session,
    stale: [],
    unrecoverable: [],
  };
  const hadSession = await deps.hasSession(ctx.registry.session);
  let changed = false;

  const repairPanes = async (): Promise<void> => {
    for (const name of names) {
      const runtime = ctx.registry.nodes[name]!;
      const nc = nodeCtx(ctx, runtime, deps);
      const paneResult = hadSession
        ? await repairPane(ctx, nc, runtime, deps)
        : runtime.tmux_pane
          ? item("unrecoverable", name, "pane", "tmux-session-missing", {
              before: runtime.tmux_pane,
            })
          : null;
      if (paneResult) {
        if (paneResult.status === "recovered") changed = true;
        pushItem(result, paneResult);
      }
    }
  };
  if (hadSession) await deps.preserveActiveWindow(ctx.registry.session, repairPanes);
  else await repairPanes();

  const staleTranscripts = new Map<string, RepairItem>();
  for (const name of names) {
    const runtime = ctx.registry.nodes[name]!;
    const nc = nodeCtx(ctx, runtime, deps);
    const transcriptResult = repairDeterministicTranscript(nc, runtime, deps);
    if (!transcriptResult) continue;
    if (transcriptResult.status === "recovered") {
      changed = true;
      pushItem(result, transcriptResult);
    } else {
      staleTranscripts.set(name, transcriptResult);
    }
  }

  const transcriptPlan = filterTranscriptPlan(
    planTranscriptRebinds(ctx, { getAdapter: (agent) => deps.getAdapter(agent) }),
    selected,
  );
  const recoveredTranscriptNodes = new Set<string>();
  changed =
    applyTranscriptPlan(ctx, transcriptPlan, result, recoveredTranscriptNodes, deps) || changed;
  reportTranscriptSkips(transcriptPlan, result, staleTranscripts, recoveredTranscriptNodes);

  if (changed) deps.saveRegistry(ctx.registry);
  return result;
}

export function renderRepairText(result: RepairResult): string {
  const lines = [`session: ${result.session}`];
  for (const section of ["recovered", "stale", "unrecoverable"] as const) {
    const items = result[section];
    if (items.length === 0) continue;
    lines.push(section);
    for (const entry of items) {
      const movement = entry.after ? ` ${entry.before ?? "(none)"} -> ${entry.after}` : "";
      const detail = entry.detail ? ` ${color.dim(entry.detail)}` : "";
      lines.push(`${entry.node}: ${entry.kind} ${entry.reason}${movement}${detail}`);
    }
  }
  if (lines.length === 1) lines.push("no repairs needed");
  return lines.join("\n");
}

export function renderRepairJson(result: RepairResult): string {
  return JSON.stringify(result, null, 2);
}

export async function cmdRepair(
  opts: RepairInput & { config?: string; json?: boolean },
  deps: RepairDeps = defaultDeps,
): Promise<void> {
  const loaded = deps.loadContext(opts.config);
  const result = await repairNodes(loaded, opts, deps);
  process.stdout.write(`${opts.json ? renderRepairJson(result) : renderRepairText(result)}\n`);
  if (result.stale.length > 0 || result.unrecoverable.length > 0) {
    warn("repair completed with stale or unrecoverable nodes");
  } else if (result.recovered.length > 0) {
    info(`repair recovered ${result.recovered.length} binding(s)`);
  }
}
