import { existsSync } from "node:fs";
import path from "node:path";

import type { Context, NodeCtx } from "./context.js";
import { type ContextMode, prependNodeContextPack } from "./context-pack.js";
import { eventLogSize, readTurnEventsSince } from "./events.js";
import { type NodeRuntime, saveRegistry, updateRegistryNode } from "./registry.js";
import {
  capturePane,
  currentPaneTarget,
  hasSession,
  hasWindow,
  listWindows,
  newSession,
  newWindow,
  paneCommand,
  paneCurrentPath,
  paneTarget,
  sendEnter,
  sendLiteral,
  sendText,
} from "./tmux.js";
import { color, info, step, warn } from "./util/log.js";
import { eventsDir } from "./util/paths.js";
import { shellQuote } from "./util/shell.js";
import { poll, sleep } from "./util/time.js";
import { waitForChangeOrTimeout } from "./util/watch.js";

const READY_TIMEOUT_MS = 30_000;
const DETECT_TIMEOUT_MS = 20_000;
const SHELLS = new Set(["zsh", "-zsh", "bash", "-bash", "sh", "fish", "tmux"]);
const BP_START = "\x1b[200~";
const BP_END = "\x1b[201~";
const AGENT_INPUT_PROMPT_RE = /^\s*[›❯](?:\s+(.*))?$/u;
const DIM_ANSI_RE = new RegExp(`${String.fromCharCode(27)}\\[(?:0;)?2m`);
const ANSI_ESCAPE_RE = new RegExp(`${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`, "g");

export interface PendingBinding {
  sessionId: string;
  transcript: string;
  previous?: {
    sessionId?: string;
    transcript?: string;
  };
}

function snapshotRecord(snapshot: Map<string, number>): Record<string, number> {
  const record: Record<string, number> = {};
  for (const [transcript, marker] of snapshot) {
    if (Number.isFinite(marker)) record[transcript] = marker;
  }
  return record;
}

function transcriptHasContent(nc: NodeCtx, transcript: string): boolean {
  return nc.adapter.size(transcript) > 0;
}

function shouldApplyDetectedBinding(
  latest: NodeRuntime | undefined,
  previous: PendingBinding["previous"],
): boolean {
  if (!latest) return true;
  if (latest.sessionId && latest.sessionId !== (previous?.sessionId ?? "")) return false;
  if (latest.transcript && latest.transcript !== (previous?.transcript ?? "")) return false;
  return true;
}

function isConfiguredNode(ctx: Context, nodeName: string): boolean {
  return ctx.nodes.some((node) => node.name === nodeName);
}

/** Best-effort transcript path for a node: registry → known session id. */
export function resolveTranscript(ctx: Context, nc: NodeCtx): string {
  const rt = ctx.registry.nodes[nc.node.name];
  const hasBoundSession = Boolean(nc.node.resume ?? rt?.sessionId);
  if (rt?.transcript && transcriptHasContent(nc, rt.transcript)) return rt.transcript;
  if (rt?.transcript && !hasBoundSession && existsSync(rt.transcript)) return rt.transcript;
  const sid = nc.node.resume ?? rt?.sessionId;
  if (sid) {
    const p = nc.adapter.transcriptForSession(nc.node.cwd, sid);
    if (p && transcriptHasContent(nc, p)) return p;
  }
  return "";
}

/** Record the in-flight turn baseline so a later `grove wait` scans from before
 *  the response lands (fixes the send→wait race). */
export function recordPending(
  ctx: Context,
  nc: NodeCtx,
  transcript: string,
  fromOffset: number,
  opts: {
    eventLogDir?: string;
    eventLogOffset?: number;
    binding?: PendingBinding;
  } = {},
): void {
  const inMemory = ctx.registry.nodes[nc.node.name];
  const fallback = {
    name: nc.node.name,
    agent: nc.node.agent,
  };
  const eventLogDir = opts.eventLogDir ?? eventsDir(ctx.config.session);
  const pending = {
    transcript,
    fromOffset,
    submittedAt: new Date().toISOString(),
    eventLogOffset: opts.eventLogOffset ?? eventLogSize(eventLogDir),
  };
  updateRegistryNode(
    ctx.registry,
    nc.node.name,
    (latest) => {
      const merged: NodeRuntime = { ...(latest ?? inMemory ?? fallback) };
      merged.name = latest?.name ?? inMemory?.name ?? nc.node.name;
      merged.agent = latest?.agent ?? inMemory?.agent ?? nc.node.agent;
      if (opts.binding && shouldApplyDetectedBinding(latest, opts.binding.previous)) {
        merged.sessionId = opts.binding.sessionId;
        merged.transcript = opts.binding.transcript;
      } else if (!latest && inMemory?.transcript === transcript) {
        merged.transcript = inMemory.transcript;
        if (inMemory.sessionId) merged.sessionId = inMemory.sessionId;
      }
      return { ...merged, pending };
    },
    { allowCreate: isConfiguredNode(ctx, nc.node.name) },
  );
}

/** Record a submit baseline before the agent has exposed a transcript path.
 *  Later wait/send probing can resolve the detected transcript from snapshot. */
export function recordProvisionalPending(
  ctx: Context,
  nc: NodeCtx,
  fromOffset: number,
  opts: {
    eventLogDir?: string;
    eventLogOffset?: number;
    snapshot: Map<string, number>;
  },
): void {
  const inMemory = ctx.registry.nodes[nc.node.name];
  const fallback = {
    name: nc.node.name,
    agent: nc.node.agent,
  };
  const eventLogDir = opts.eventLogDir ?? eventsDir(ctx.config.session);
  const pending = {
    fromOffset,
    submittedAt: new Date().toISOString(),
    eventLogOffset: opts.eventLogOffset ?? eventLogSize(eventLogDir),
    provisional: true,
    snapshot: snapshotRecord(opts.snapshot),
  };
  updateRegistryNode(
    ctx.registry,
    nc.node.name,
    (latest) => {
      const merged: NodeRuntime = { ...(latest ?? inMemory ?? fallback) };
      merged.name = latest?.name ?? inMemory?.name ?? nc.node.name;
      merged.agent = latest?.agent ?? inMemory?.agent ?? nc.node.agent;
      return { ...merged, pending };
    },
    { allowCreate: isConfiguredNode(ctx, nc.node.name) },
  );
}

function snapshotMap(pending: NodeRuntime["pending"]): Map<string, number> | undefined {
  if (!pending?.snapshot) return undefined;
  return new Map(Object.entries(pending.snapshot));
}

export function resolvePending(ctx: Context, nc: NodeCtx): NodeRuntime["pending"] {
  const runtime = ctx.registry.nodes[nc.node.name];
  const pending = runtime?.pending;
  if (!pending || pending.transcript) return pending;
  const snapshot = snapshotMap(pending);
  if (!snapshot) return pending;
  const detected = nc.adapter.detectNew(nc.node.cwd, snapshot);
  if (!detected) return pending;
  const previous: PendingBinding["previous"] = {};
  if (runtime?.sessionId) previous.sessionId = runtime.sessionId;
  if (runtime?.transcript) previous.transcript = runtime.transcript;
  recordPending(ctx, nc, detected.transcript, 0, {
    binding: {
      ...detected,
      previous,
    },
    ...(pending.eventLogOffset === undefined ? {} : { eventLogOffset: pending.eventLogOffset }),
  });
  return ctx.registry.nodes[nc.node.name]?.pending ?? pending;
}

/** Drop a node's in-flight baseline once its turn has been collected. */
export function clearPending(ctx: Context, nc: NodeCtx): void {
  const rt = ctx.registry.nodes[nc.node.name];
  if (rt?.pending) {
    updateRegistryNode(
      ctx.registry,
      nc.node.name,
      (latest) => {
        const current = latest ?? rt;
        const next = { ...current };
        delete next.pending;
        return next;
      },
      { allowCreate: isConfiguredNode(ctx, nc.node.name) },
    );
  }
}

/** Resolve the calling node's name from the current tmux pane ($TMUX_PANE →
 *  registry tmux_pane match), so live `grove send`/`ask` surface the sender as
 *  `node@project` in the context pack. Returns null outside tmux / when no node
 *  owns the pane (the caller then renders as the raw CLI sentinel). */
export async function resolveSelfNodeName(ctx: Context): Promise<string | null> {
  const pane = await currentPaneTarget();
  if (!pane) return null;
  for (const [name, runtime] of Object.entries(ctx.registry.nodes)) {
    if (runtime.tmux_pane && runtime.tmux_pane === pane) return runtime.name || name;
  }
  return null;
}

/**
 * Type a message into a node's pane and submit it. Uses bracketed paste so
 * multi-line content stays intact and does not submit on every newline.
 */
export async function submitMessage(
  nc: NodeCtx,
  message: string,
  opts: {
    callerNode?: string;
    context?: Context;
    contextMode?: ContextMode;
    includeContextPack?: boolean;
    project?: string;
  } = {},
): Promise<void> {
  await assertPaneInputClear(nc);
  // Live node-to-node callers (send/ask) pass "compact"; bootstrap/fan-out
  // leave it unset → "full". includeContextPack:false stays "none" (no pack).
  const contextMode: ContextMode =
    opts.includeContextPack === false ? "none" : (opts.contextMode ?? "full");
  const submittedMessage = prependNodeContextPack(nc, message, { ...opts, contextMode });
  await sendLiteral(nc.addr, BP_START + submittedMessage + BP_END);
  await sleep(220);
  await sendEnter(nc.addr);
  if (nc.adapter.submit === "enter-enter") {
    await sleep(260);
    await sendEnter(nc.addr);
  }
}

export async function assertPaneInputClear(nc: NodeCtx): Promise<void> {
  const text = await capturePane(nc.addr, 30, { preserveEscapes: true });
  const pending = nonEmptyAgentInput(text);
  if (!pending) return;
  throw new Error(
    `${nc.node.name}: target pane has unsent prompt input; refusing to inject a node message`,
  );
}

export function nonEmptyAgentInput(paneText: string): string | null {
  for (const rawLine of paneText.split(/\r?\n/).reverse()) {
    const line = stripAnsi(rawLine);
    const match = AGENT_INPUT_PROMPT_RE.exec(line);
    if (!match) continue;
    const input = (match[1] ?? "").trim();
    if (!input) return null;
    if (agentPromptTextLooksGhost(rawLine)) return null;
    return input;
  }
  return null;
}

function agentPromptTextLooksGhost(rawLine: string): boolean {
  const promptIndex = Math.max(rawLine.lastIndexOf("›"), rawLine.lastIndexOf("❯"));
  if (promptIndex < 0) return false;
  return DIM_ANSI_RE.test(rawLine.slice(promptIndex));
}

function stripAnsi(value: string): string {
  return value.replace(ANSI_ESCAPE_RE, "");
}

export interface WaitOptions {
  timeoutMs: number;
  /** byte offset to start scanning from (defaults to current transcript size) */
  fromOffset?: number;
  /** transcript captured when the turn was submitted */
  transcript?: string;
  /** byte offset in grove's durable event log captured at submit time */
  eventLogOffset?: number;
  /** test seam; production defaults to util/paths eventsDir(session) */
  eventLogDir?: string;
  intervalMs?: number;
}

function transcriptIdOf(ctx: Context, nc: NodeCtx, transcript: string): string {
  return (
    nc.adapter.sessionIdFromPath(transcript) ?? ctx.registry.nodes[nc.node.name]?.sessionId ?? ""
  );
}

function hasSessionBinding(ctx: Context, nc: NodeCtx): boolean {
  const rt = ctx.registry.nodes[nc.node.name];
  return Boolean(nc.node.resume ?? rt?.sessionId);
}

function transcriptRepairError(name: string): Error {
  return new Error(
    `"${name}": session transcript missing — run \`grove rebind\` (or \`fleet repair\`) first`,
  );
}

function completionFromEvents(
  ctx: Context,
  nc: NodeCtx,
  opts: {
    eventLogDir: string;
    eventLogOffset: number;
    transcriptId: string;
    fromOffset: number;
  },
): { text: string | null; nextOffset: number } {
  const read = readTurnEventsSince(opts.eventLogDir, opts.eventLogOffset);
  for (const event of read.events) {
    if (event.node !== nc.node.name) continue;
    if (event.transcriptId !== opts.transcriptId) continue;
    if (event.transcriptOffset <= opts.fromOffset) continue;
    if (event.type !== "turn.done" && event.type !== "turn.failed") continue;
    return { text: event.summary ?? "", nextOffset: read.nextOffset };
  }
  return { text: null, nextOffset: read.nextOffset };
}

/** Block until the node finishes a turn after the baseline offset. */
export async function waitForCompletion(
  ctx: Context,
  nc: NodeCtx,
  opts: WaitOptions,
): Promise<string | null> {
  // fs.watch wakes us on append; this is just the safety-net re-check period.
  const interval = opts.intervalMs ?? 2500;
  const resolvedTranscript = resolveTranscript(ctx, nc);
  if (opts.transcript && resolvedTranscript !== opts.transcript) {
    throw new Error(`${nc.node.name}: transcript stale — run fleet repair`);
  }
  const transcript = opts.transcript ?? resolvedTranscript;
  if (!transcript) {
    if (hasSessionBinding(ctx, nc)) throw transcriptRepairError(nc.node.name);
    throw new Error(
      `"${nc.node.name}": no session transcript resolved — run \`grove up\` (or \`fleet repair\`) first`,
    );
  }
  if (!transcriptHasContent(nc, transcript) && hasSessionBinding(ctx, nc)) {
    throw transcriptRepairError(nc.node.name);
  }

  let offset = opts.fromOffset ?? nc.adapter.size(transcript);
  const transcriptId = transcriptIdOf(ctx, nc, transcript);
  const eventLogDir = opts.eventLogDir ?? eventsDir(ctx.config.session);
  let eventLogOffset = opts.eventLogOffset ?? eventLogSize(eventLogDir);
  const deadline = Date.now() + opts.timeoutMs;
  for (;;) {
    if (transcriptId) {
      const eventCompletion = completionFromEvents(ctx, nc, {
        eventLogDir,
        eventLogOffset,
        transcriptId,
        fromOffset: offset,
      });
      eventLogOffset = eventCompletion.nextOffset;
      if (eventCompletion.text !== null) return eventCompletion.text;
    }

    const comp = nc.adapter.readCompletionSince(transcript, offset);
    if (comp.done) return comp.text ?? "";
    offset = comp.offset;
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) return null;
    // Wake on the next transcript append, or after `interval` as a safety net.
    await waitForChangeOrTimeout(transcript, Math.min(interval, remainingMs));
  }
}

/** Send a message and wait for the resulting turn to complete. */
export async function ask(
  ctx: Context,
  nc: NodeCtx,
  message: string,
  timeoutMs: number,
  opts: {
    callerNode?: string;
    contextMode?: ContextMode;
    eventLogDir?: string;
    submissionContext?: Context;
    submissionProject?: string;
  } = {},
): Promise<string | null> {
  const transcript = resolveTranscript(ctx, nc);
  const haveBaseline = Boolean(transcript) && nc.adapter.size(transcript) > 0;
  const fromOffset = haveBaseline ? nc.adapter.size(transcript) : undefined;
  const eventLogDir = opts.eventLogDir ?? eventsDir(ctx.config.session);
  const eventLogOffset = eventLogSize(eventLogDir);
  if (transcript) {
    recordPending(ctx, nc, transcript, fromOffset ?? 0, {
      eventLogDir,
      eventLogOffset,
    });
  }
  await submitMessage(nc, message, {
    callerNode: opts.callerNode ?? "grove ask CLI",
    context: opts.submissionContext ?? ctx,
    contextMode: opts.contextMode,
    project: opts.submissionProject,
  });
  const res = await waitForCompletion(ctx, nc, {
    timeoutMs,
    fromOffset,
    transcript: transcript || undefined,
    eventLogDir,
    eventLogOffset,
  });
  if (res !== null) clearPending(ctx, nc);
  return res;
}

async function registerExisting(ctx: Context, nc: NodeCtx): Promise<void> {
  const prev = ctx.registry.nodes[nc.node.name];
  const sid = nc.node.resume ?? prev?.sessionId;
  let transcript = "";
  if (sid) transcript = nc.adapter.transcriptForSession(nc.node.cwd, sid);
  const tmuxRuntime = await tmuxPaneRuntime(nc);
  ctx.registry.nodes[nc.node.name] = {
    ...prev,
    name: nc.node.name,
    agent: nc.node.agent,
    sessionId: sid,
    transcript: transcript || prev?.transcript,
    ...teamRuntime(nc),
    ...tmuxRuntime,
  };
}

async function tmuxPaneRuntime(nc: NodeCtx): Promise<{ tmux_pane?: string }> {
  if (!nc.node.tmux) return {};
  const tmux_pane = await paneTarget(nc.addr);
  nc.addr = tmux_pane;
  return { tmux_pane };
}

function teamRuntime(
  nc: NodeCtx,
): Pick<NodeRuntime, "children" | "cwd" | "description" | "group" | "kind" | "parent" | "role"> {
  const runtime: Pick<
    NodeRuntime,
    "children" | "cwd" | "description" | "group" | "kind" | "parent" | "role"
  > = {
    children: [...nc.node.children],
    cwd: nc.node.cwd,
  };
  if (nc.node.role) runtime.role = nc.node.role;
  if (nc.node.description) runtime.description = nc.node.description;
  if (nc.node.parent) runtime.parent = nc.node.parent;
  if (nc.node.group) runtime.group = nc.node.group;
  if (nc.node.kind) runtime.kind = nc.node.kind;
  return runtime;
}

export async function launchNode(ctx: Context, nc: NodeCtx): Promise<void> {
  const { node, adapter, addr } = nc;
  const resumeId = node.resume ?? ctx.registry.nodes[node.name]?.sessionId;
  const before = adapter.snapshot(node.cwd);
  const cmd = adapter.launchCommand({
    cwd: node.cwd,
    initialPrompt: node.role,
    model: node.model,
    resumeId,
  });
  step(`launch ${color.bold(node.name)} ${color.dim(`(${adapter.label})`)} → ${color.dim(cmd)}`);
  await sendLiteral(addr, cmd);
  await sendEnter(addr);

  const ready = await poll(() => capturePane(addr, 80), {
    timeoutMs: READY_TIMEOUT_MS,
    intervalMs: 1000,
    until: (txt) => adapter.readyPattern.test(txt),
  });
  if (ready.timedOut) {
    warn(`${node.name}: TUI ready marker not seen in ${READY_TIMEOUT_MS / 1000}s — proceeding`);
  }

  let sessionId = resumeId;
  let transcript = "";
  if (resumeId) {
    transcript = adapter.transcriptForSession(node.cwd, resumeId);
  }

  // Fresh node: establish its role before detecting the transcript (the file
  // is created once the first turn runs).
  if (!resumeId && node.role) {
    await submitMessage(nc, node.role, { callerNode: "grove launch bootstrap", context: ctx });
  }

  if (!resumeId) {
    const det = await poll(() => adapter.detectNew(node.cwd, before), {
      timeoutMs: DETECT_TIMEOUT_MS,
      intervalMs: 1000,
      until: (d) => Boolean(d),
    });
    if (det.value) {
      sessionId = det.value.sessionId;
      transcript = det.value.transcript;
    } else {
      warn(`${node.name}: could not detect a new session transcript`);
    }
  }

  const tmuxRuntime = await tmuxPaneRuntime(nc);
  ctx.registry.nodes[node.name] = {
    ...ctx.registry.nodes[node.name],
    name: node.name,
    agent: node.agent,
    cwd: node.cwd,
    sessionId,
    transcript: transcript || undefined,
    ...teamRuntime(nc),
    ...tmuxRuntime,
  };
}

async function validateAdoptCwd(nc: NodeCtx): Promise<void> {
  if (!nc.node.cwd) {
    warn(`${nc.node.name}: expected cwd missing; skipping adoption cwd verification`);
    return;
  }
  const actual = await paneCurrentPath(nc.addr);
  if (!actual) {
    warn(`${nc.node.name}: could not verify pane cwd for adoption`);
    return;
  }
  if (path.resolve(actual) !== path.resolve(nc.node.cwd)) {
    throw new Error(
      `${nc.node.name}: pane cwd mismatch for adoption (expected ${nc.node.cwd}, got ${actual})`,
    );
  }
}

export interface BringUpResult {
  created: boolean;
  adopted: string[];
  launched: string[];
}

/** Create the tmux session (if needed) and bring up every node. Idempotent. */
export async function bringUp(ctx: Context): Promise<BringUpResult> {
  const { session } = ctx.config;
  const sessionExisted = await hasSession(session);
  const existingWindows = sessionExisted ? await listWindows(session) : [];
  const result: BringUpResult = { created: !sessionExisted, adopted: [], launched: [] };

  const first = ctx.nodes[0];
  if (!first) throw new Error("config has no nodes");

  if (!sessionExisted) {
    await newSession(session, { cwd: first.cwd, windowName: first.name });
    info(`created tmux session ${color.bold(session)}`);
  }

  for (const node of ctx.nodes) {
    const nc = ctx.byName.get(node.name)!;

    // Explicit tmux target (e.g. an existing pane "0.1"): launch in place,
    // no window creation. Adopt if a non-shell agent already runs there.
    if (node.tmux) {
      await tmuxPaneRuntime(nc);
      const running = await paneCommand(nc.addr);
      if (running && !SHELLS.has(running)) {
        step(`adopt ${color.bold(node.name)} ${color.dim(`(${nc.adapter.label}) @ ${node.tmux}`)}`);
        await validateAdoptCwd(nc);
        await registerExisting(ctx, nc);
        result.adopted.push(node.name);
        continue;
      }
      await sendText(nc.addr, `cd ${shellQuote(node.cwd)}`);
      await sendEnter(nc.addr);
      await sleep(300);
      await launchNode(ctx, nc);
      result.launched.push(node.name);
      continue;
    }

    if (existingWindows.includes(node.name)) {
      step(`adopt ${color.bold(node.name)} ${color.dim(`(${nc.adapter.label})`)}`);
      await validateAdoptCwd(nc);
      await registerExisting(ctx, nc);
      result.adopted.push(node.name);
      continue;
    }
    if (!(await hasWindow(session, node.name))) {
      await newWindow(session, node.name, node.cwd);
    }
    await launchNode(ctx, nc);
    result.launched.push(node.name);
  }

  saveRegistry(ctx.registry);
  return result;
}
