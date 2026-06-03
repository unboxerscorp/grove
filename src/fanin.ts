import type { Context, NodeCtx } from "./context.js";
import type { GroveTurnEvent } from "./events.js";
import { eventLogPath, eventLogSize, readTurnEventsSince } from "./events.js";
import { resolveTranscript } from "./ops.js";
import { saveRegistry } from "./registry.js";
import { eventsDir } from "./util/paths.js";
import { waitForChangeOrTimeout } from "./util/time.js";

export type FanInMode = "any" | "all";

export interface FanInTerminalResult {
  node: string;
  status: "done" | "failed";
  turnId: string;
  transcriptId: string;
  transcriptOffset: number;
  marker: string;
  ts: number;
  summary?: string;
  reason?: string;
}

export interface FanInPendingResult {
  node: string;
  turnId: string;
  transcriptId: string;
  transcriptOffset: number;
}

export interface FanInResult {
  mode: FanInMode;
  completed: FanInTerminalResult[];
  failed: FanInTerminalResult[];
  pending: FanInPendingResult[];
  order: FanInTerminalResult[];
  summaries: Record<string, string>;
  deadlineExceeded: boolean;
  nextEventLogOffset: number;
}

export interface FanInWaitOptions {
  mode: FanInMode;
  timeoutMs: number;
  eventLogDir?: string;
  intervalMs?: number;
}

interface NodeWaitState {
  name: string;
  nc: NodeCtx;
  transcript: string;
  transcriptId: string;
  fromOffset: number;
  eventLogOffset: number;
  terminal?: FanInTerminalResult;
}

const FAN_IN_INTERVAL_MS = 1000;

function transcriptIdOf(
  ctx: Context,
  state: Pick<NodeWaitState, "name" | "nc" | "transcript">,
): string {
  return (
    state.nc.adapter.sessionIdFromPath(state.transcript) ??
    ctx.registry.nodes[state.name]?.sessionId ??
    state.name
  );
}

function terminalFromEvent(event: GroveTurnEvent): FanInTerminalResult {
  const status = event.status === "failed" || event.type === "turn.failed" ? "failed" : "done";
  return {
    node: event.node,
    status,
    turnId: event.turnId,
    transcriptId: event.transcriptId,
    transcriptOffset: event.transcriptOffset,
    marker: event.marker,
    ts: event.ts,
    summary: event.summary,
    reason: status === "failed" ? event.summary : undefined,
  };
}

function terminalFromTranscriptCompletion(
  state: NodeWaitState,
  text: string,
  transcriptOffset: number,
): FanInTerminalResult {
  const turnId = `${state.name}:${state.transcriptId}:${transcriptOffset}`;
  return {
    node: state.name,
    status: "done",
    turnId,
    transcriptId: state.transcriptId,
    transcriptOffset,
    marker: `completion@${transcriptOffset}`,
    ts: Date.now(),
    summary: text,
  };
}

function buildStates(ctx: Context, names: string[], eventLogDir: string): NodeWaitState[] {
  return names.map((name) => {
    const nc = ctx.byName.get(name);
    if (!nc) {
      const known = [...ctx.byName.keys()].join(", ") || "(none)";
      throw new Error(`unknown node "${name}". known nodes: ${known}`);
    }
    const runtime = ctx.registry.nodes[name];
    const transcript = runtime?.pending?.transcript ?? resolveTranscript(ctx, nc);
    if (!transcript) {
      throw new Error(
        `"${name}": no session transcript resolved — run \`grove up\` (or \`fleet repair\`) first`,
      );
    }
    const fromOffset = runtime?.pending?.fromOffset ?? nc.adapter.size(transcript);
    const eventLogOffset = runtime?.pending?.eventLogOffset ?? eventLogSize(eventLogDir);
    const partialState = { name, nc, transcript };
    return {
      name,
      nc,
      transcript,
      transcriptId: transcriptIdOf(ctx, partialState),
      fromOffset,
      eventLogOffset,
    };
  });
}

function pendingForState(state: NodeWaitState): FanInPendingResult {
  const transcriptOffset = state.nc.adapter.size(state.transcript) || state.fromOffset;
  return {
    node: state.name,
    turnId: `${state.name}:${state.transcriptId}:${transcriptOffset}`,
    transcriptId: state.transcriptId,
    transcriptOffset,
  };
}

function finalizeResult(
  ctx: Context,
  mode: FanInMode,
  states: NodeWaitState[],
  order: FanInTerminalResult[],
  deadlineExceeded: boolean,
  nextEventLogOffset: number,
): FanInResult {
  let registryChanged = false;
  for (const state of states) {
    if (!state.terminal) continue;
    const runtime = ctx.registry.nodes[state.name];
    if (runtime?.pending) {
      delete runtime.pending;
      registryChanged = true;
    }
  }
  if (registryChanged) saveRegistry(ctx.registry);

  const completed = order.filter((item) => item.status === "done");
  const failed = order.filter((item) => item.status === "failed");
  const pending = states.filter((state) => !state.terminal).map((state) => pendingForState(state));
  const summaries: Record<string, string> = {};
  for (const item of order) {
    if (item.summary) summaries[item.node] = item.summary;
  }

  return {
    mode,
    completed,
    failed,
    pending,
    order,
    summaries,
    deadlineExceeded,
    nextEventLogOffset,
  };
}

function collectTerminalEvents(
  states: NodeWaitState[],
  events: GroveTurnEvent[],
  order: FanInTerminalResult[],
  opts: { stopAfterFirst?: boolean } = {},
): void {
  const byName = new Map(states.map((state) => [state.name, state]));
  for (const event of events) {
    const state = byName.get(event.node);
    if (!state || state.terminal) continue;
    if (event.transcriptId !== state.transcriptId) continue;
    if (event.transcriptOffset <= state.fromOffset) continue;
    const terminal = terminalFromEvent(event);
    state.terminal = terminal;
    order.push(terminal);
    if (opts.stopAfterFirst) return;
  }
}

function collectTranscriptCompletions(
  states: NodeWaitState[],
  order: FanInTerminalResult[],
  opts: { stopAfterFirst?: boolean } = {},
): void {
  for (const state of states) {
    if (state.terminal) continue;
    const completion = state.nc.adapter.readCompletionSince(state.transcript, state.fromOffset);
    state.fromOffset = completion.offset;
    if (!completion.done) continue;
    const terminal = terminalFromTranscriptCompletion(
      state,
      completion.text ?? "",
      completion.offset,
    );
    state.terminal = terminal;
    order.push(terminal);
    if (opts.stopAfterFirst) return;
  }
}

export async function waitForFanIn(
  ctx: Context,
  names: string[],
  opts: FanInWaitOptions,
): Promise<FanInResult> {
  if (names.length === 0) {
    throw new Error("at least one node is required");
  }
  const eventLogDir = opts.eventLogDir ?? eventsDir(ctx.config.session);
  const intervalMs = opts.intervalMs ?? FAN_IN_INTERVAL_MS;
  const states = buildStates(ctx, names, eventLogDir);
  let eventLogOffset = Math.min(...states.map((state) => state.eventLogOffset));
  const deadline = Date.now() + opts.timeoutMs;
  const order: FanInTerminalResult[] = [];

  for (;;) {
    const read = readTurnEventsSince(eventLogDir, eventLogOffset);
    eventLogOffset = read.nextOffset;
    collectTerminalEvents(states, read.events, order, {
      stopAfterFirst: opts.mode === "any",
    });
    if (!(opts.mode === "any" && order.length > 0)) {
      collectTranscriptCompletions(states, order, {
        stopAfterFirst: opts.mode === "any",
      });
    }

    if (opts.mode === "any" && order.length > 0) {
      return finalizeResult(ctx, opts.mode, states, order.slice(0, 1), false, eventLogOffset);
    }

    if (states.every((state) => state.terminal)) {
      return finalizeResult(ctx, opts.mode, states, order, false, eventLogOffset);
    }

    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      return finalizeResult(ctx, opts.mode, states, order, true, eventLogOffset);
    }

    await waitForChangeOrTimeout(eventLogPath(eventLogDir), Math.min(intervalMs, remainingMs));
  }
}

export function renderFanInJson(result: FanInResult): string {
  return JSON.stringify(result, null, 2);
}

export function renderGatherJson(result: FanInResult): string {
  return renderFanInJson(result);
}

export function renderGatherText(result: FanInResult): string {
  const lines: string[] = [];
  lines.push(`completed (${result.completed.length})`);
  for (const item of result.completed) {
    lines.push(`- ${item.node}: ${item.summary ?? item.turnId}`);
  }
  lines.push(`failed (${result.failed.length})`);
  for (const item of result.failed) {
    lines.push(`- ${item.node}: ${item.reason ?? item.summary ?? item.turnId}`);
  }
  lines.push(`pending (${result.pending.length})`);
  for (const item of result.pending) {
    lines.push(`- ${item.node}: ${item.turnId} @ ${item.transcriptOffset}`);
  }
  return `${lines.join("\n")}\n`;
}
