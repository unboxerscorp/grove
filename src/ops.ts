import type { Context, NodeCtx } from "./context.js";
import { eventLogSize, readTurnEventsSince } from "./events.js";
import { type NodeRuntime, saveRegistry } from "./registry.js";
import {
  capturePane,
  hasSession,
  hasWindow,
  listWindows,
  newSession,
  newWindow,
  paneCommand,
  sendEnter,
  sendLiteral,
  sendText,
} from "./tmux.js";
import { color, info, step, warn } from "./util/log.js";
import { eventsDir } from "./util/paths.js";
import { poll, sleep, waitForChangeOrTimeout } from "./util/time.js";

const READY_TIMEOUT_MS = 30_000;
const DETECT_TIMEOUT_MS = 20_000;
const SHELLS = new Set(["zsh", "-zsh", "bash", "-bash", "sh", "fish", "tmux"]);
const BP_START = "\x1b[200~";
const BP_END = "\x1b[201~";

/** Best-effort transcript path for a node: registry → known session id. */
export function resolveTranscript(ctx: Context, nc: NodeCtx): string {
  const rt = ctx.registry.nodes[nc.node.name];
  if (rt?.transcript && nc.adapter.size(rt.transcript) > 0) return rt.transcript;
  const sid = nc.node.resume ?? rt?.sessionId;
  if (sid) {
    const p = nc.adapter.transcriptForSession(nc.node.cwd, sid);
    if (p) return p;
  }
  return rt?.transcript ?? "";
}

/** Record the in-flight turn baseline so a later `grove wait` scans from before
 *  the response lands (fixes the send→wait race). */
export function recordPending(
  ctx: Context,
  nc: NodeCtx,
  transcript: string,
  fromOffset: number,
  opts: { eventLogDir?: string; eventLogOffset?: number } = {},
): void {
  const prev = ctx.registry.nodes[nc.node.name] ?? {
    name: nc.node.name,
    agent: nc.node.agent,
  };
  const eventLogDir = opts.eventLogDir ?? eventsDir(ctx.config.session);
  ctx.registry.nodes[nc.node.name] = {
    ...prev,
    pending: {
      transcript,
      fromOffset,
      submittedAt: new Date().toISOString(),
      eventLogOffset: opts.eventLogOffset ?? eventLogSize(eventLogDir),
    },
  };
  saveRegistry(ctx.registry);
}

/** Drop a node's in-flight baseline once its turn has been collected. */
export function clearPending(ctx: Context, nc: NodeCtx): void {
  const rt = ctx.registry.nodes[nc.node.name];
  if (rt?.pending) {
    delete rt.pending;
    saveRegistry(ctx.registry);
  }
}

/**
 * Type a message into a node's pane and submit it. Uses bracketed paste so
 * multi-line content stays intact and does not submit on every newline.
 */
export async function submitMessage(nc: NodeCtx, message: string): Promise<void> {
  await sendLiteral(nc.addr, BP_START + message + BP_END);
  await sleep(220);
  await sendEnter(nc.addr);
  if (nc.adapter.submit === "enter-enter") {
    await sleep(260);
    await sendEnter(nc.addr);
  }
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
    throw new Error(
      `"${nc.node.name}": no session transcript resolved — run \`grove up\` (or \`fleet repair\`) first`,
    );
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
    if (Date.now() >= deadline) return null;
    // Wake on the next transcript append, or after `interval` as a safety net.
    await waitForChangeOrTimeout(transcript, interval);
  }
}

/** Send a message and wait for the resulting turn to complete. */
export async function ask(
  ctx: Context,
  nc: NodeCtx,
  message: string,
  timeoutMs: number,
  opts: { eventLogDir?: string } = {},
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
  await submitMessage(nc, message);
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

function registerExisting(ctx: Context, nc: NodeCtx): void {
  const prev = ctx.registry.nodes[nc.node.name];
  const sid = nc.node.resume ?? prev?.sessionId;
  let transcript = "";
  if (sid) transcript = nc.adapter.transcriptForSession(nc.node.cwd, sid);
  ctx.registry.nodes[nc.node.name] = {
    name: nc.node.name,
    agent: nc.node.agent,
    sessionId: sid,
    transcript: transcript || prev?.transcript,
    ...teamRuntime(nc),
    ...tmuxPaneRuntime(ctx, nc),
  };
}

function tmuxPaneRuntime(ctx: Context, nc: NodeCtx): { tmux_pane?: string } {
  return nc.node.tmux ? { tmux_pane: `${ctx.config.session}:${nc.node.tmux}` } : {};
}

function teamRuntime(
  nc: NodeCtx,
): Pick<NodeRuntime, "children" | "description" | "group" | "parent" | "role"> {
  const runtime: Pick<NodeRuntime, "children" | "description" | "group" | "parent" | "role"> = {
    children: [...nc.node.children],
  };
  if (nc.node.role) runtime.role = nc.node.role;
  if (nc.node.description) runtime.description = nc.node.description;
  if (nc.node.parent) runtime.parent = nc.node.parent;
  if (nc.node.group) runtime.group = nc.node.group;
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
    await submitMessage(nc, node.role);
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

  ctx.registry.nodes[node.name] = {
    name: node.name,
    agent: node.agent,
    sessionId,
    transcript: transcript || undefined,
    ...teamRuntime(nc),
    ...tmuxPaneRuntime(ctx, nc),
  };
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
      const running = await paneCommand(nc.addr);
      if (running && !SHELLS.has(running)) {
        step(`adopt ${color.bold(node.name)} ${color.dim(`(${nc.adapter.label}) @ ${node.tmux}`)}`);
        registerExisting(ctx, nc);
        result.adopted.push(node.name);
        continue;
      }
      await sendText(nc.addr, `cd ${node.cwd}`);
      await sendEnter(nc.addr);
      await sleep(300);
      await launchNode(ctx, nc);
      result.launched.push(node.name);
      continue;
    }

    if (existingWindows.includes(node.name)) {
      step(`adopt ${color.bold(node.name)} ${color.dim(`(${nc.adapter.label})`)}`);
      registerExisting(ctx, nc);
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
