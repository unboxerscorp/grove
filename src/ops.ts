import type { Context, NodeCtx } from "./context.js";
import { saveRegistry } from "./registry.js";
import {
  capturePane,
  hasSession,
  hasWindow,
  listWindows,
  newSession,
  newWindow,
  sendEnter,
  sendLiteral,
} from "./tmux.js";
import { color, info, step, warn } from "./util/log.js";
import { poll, sleep } from "./util/time.js";

const READY_TIMEOUT_MS = 30_000;
const DETECT_TIMEOUT_MS = 20_000;
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
  intervalMs?: number;
}

/** Block until the node finishes a turn after the baseline offset. */
export async function waitForCompletion(
  ctx: Context,
  nc: NodeCtx,
  opts: WaitOptions,
): Promise<string | null> {
  const interval = opts.intervalMs ?? 1500;
  const transcript = resolveTranscript(ctx, nc);
  if (!transcript) {
    throw new Error(
      `"${nc.node.name}": no session transcript resolved — run \`grove up\` first`,
    );
  }

  let offset = opts.fromOffset ?? nc.adapter.size(transcript);
  const deadline = Date.now() + opts.timeoutMs;
  for (;;) {
    const comp = nc.adapter.readCompletionSince(transcript, offset);
    if (comp.done) return comp.text ?? "";
    offset = comp.offset;
    if (Date.now() >= deadline) return null;
    await sleep(interval);
  }
}

/** Send a message and wait for the resulting turn to complete. */
export async function ask(
  ctx: Context,
  nc: NodeCtx,
  message: string,
  timeoutMs: number,
): Promise<string | null> {
  const transcript = resolveTranscript(ctx, nc);
  const haveBaseline = Boolean(transcript) && nc.adapter.size(transcript) > 0;
  const fromOffset = haveBaseline ? nc.adapter.size(transcript) : undefined;
  await submitMessage(nc, message);
  return waitForCompletion(ctx, nc, { timeoutMs, fromOffset });
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
  };
}

async function launch(ctx: Context, nc: NodeCtx): Promise<void> {
  const { node, adapter, addr } = nc;
  const resumeId = node.resume ?? ctx.registry.nodes[node.name]?.sessionId;
  const before = adapter.snapshot(node.cwd);
  const cmd = adapter.launchCommand({ cwd: node.cwd, model: node.model, resumeId });
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
    if (existingWindows.includes(node.name)) {
      step(`adopt ${color.bold(node.name)} ${color.dim(`(${nc.adapter.label})`)}`);
      registerExisting(ctx, nc);
      result.adopted.push(node.name);
      continue;
    }
    if (!(await hasWindow(session, node.name))) {
      await newWindow(session, node.name, node.cwd);
    }
    await launch(ctx, nc);
    result.launched.push(node.name);
  }

  saveRegistry(ctx.registry);
  return result;
}
