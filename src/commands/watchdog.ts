import { createHash } from "node:crypto";
import { existsSync, readFileSync as readFileSyncNode } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";

import type { Context, NodeCtx } from "../context.js";
import { loadContext } from "../context.js";
import { resolveTranscript } from "../ops.js";
import { capturePane, paneCommand, paneTarget } from "../tmux.js";
import { writeFileAtomicSync } from "../util/atomic.js";
import { color } from "../util/log.js";
import { sessionDir } from "../util/paths.js";
import { parseDuration } from "../util/time.js";

export type WatchdogHealth =
  | "healthy"
  | "rate_limited"
  | "login_required"
  | "crashed"
  | "cooldown"
  | "hung";

export interface WatchdogNodeState {
  node: string;
  agent: string;
  health: WatchdogHealth;
  reason?: string;
  pane: string;
  pane_exists: boolean;
  transcript?: string;
  transcript_bytes: number;
  last_activity_at: string;
  observed_at: string;
  idle_ms: number;
  reset_at?: string;
  usage_limit_reset_at?: string;
}

export interface WatchdogSnapshot {
  schema: 1;
  type: "node_health";
  session: string;
  generated_at: string;
  hung_after_ms: number;
  nodes: WatchdogNodeState[];
  counts: Record<WatchdogHealth, number>;
}

export interface WatchdogOptions {
  config?: string;
  hungAfter?: string;
  json?: boolean;
}

export interface WatchdogMemory {
  lastPaneHash?: string;
  lastTranscriptBytes?: number;
  lastTranscriptMtimeMs?: number;
  lastActivityMs: number;
}

export interface WatchdogDeps {
  capturePane(addr: string, lines?: number): Promise<string>;
  exists(file: string): boolean;
  loadContext(config?: string): Context;
  now(): Date;
  paneCommand(addr: string): Promise<string>;
  paneTarget(addr: string): Promise<string>;
  readFileSync(file: string): string;
  transcriptMtimeMs(path: string): Promise<number | null>;
  writeFileAtomicSync(file: string, data: string): void;
}

interface LimitMatch {
  reason: string;
  resetAt?: string;
}

const DEFAULT_HUNG_AFTER_MS = 10 * 60_000;
const CAPTURE_LINES = 240;
const WATCHDOG_STATE_FILE = "watchdog-state.json";
const RATE_LIMIT_RE = /temporarily limiting requests/i;
const USAGE_LIMIT_RE = /session limit[\s\S]{0,160}?resets?(?:\s+at)?\s+(\d{1,2}):(\d{2})/i;
const LOGIN_REQUIRED_RE =
  /\b(?:login required|not logged in|please log in|please sign in|authentication required|authentication expired|auth expired|token expired|credentials expired)\b/i;
const SHELL_COMMANDS = new Set(["zsh", "-zsh", "bash", "-bash", "sh", "fish", "tmux"]);
const ANSI_ESCAPE_RE = new RegExp(`${String.fromCharCode(0x1b)}\\[[0-?]*[ -/]*[@-~]`, "g");

async function defaultTranscriptMtimeMs(path: string): Promise<number | null> {
  try {
    return (await stat(path)).mtimeMs;
  } catch {
    return null;
  }
}

const defaultDeps: WatchdogDeps = {
  capturePane,
  exists: existsSync,
  loadContext,
  now: () => new Date(),
  paneCommand,
  paneTarget,
  readFileSync: (file) => readFileSyncNode(file, "utf8"),
  transcriptMtimeMs: defaultTranscriptMtimeMs,
  writeFileAtomicSync,
};

interface WatchdogStateFile {
  schema: 1;
  type: "watchdog_state";
  session: string;
  updated_at: string;
  nodes: Record<string, WatchdogMemory>;
}

function emptyCounts(): Record<WatchdogHealth, number> {
  return {
    crashed: 0,
    cooldown: 0,
    healthy: 0,
    hung: 0,
    login_required: 0,
    rate_limited: 0,
  };
}

function resetTimeFromMatch(hour: string, minute: string, now: Date): string {
  const reset = new Date(now);
  reset.setHours(Number.parseInt(hour, 10), Number.parseInt(minute, 10), 0, 0);
  if (reset.getTime() <= now.getTime()) reset.setDate(reset.getDate() + 1);
  return reset.toISOString();
}

function usageLimit(text: string, now: Date): LimitMatch | null {
  const match = text.match(USAGE_LIMIT_RE);
  if (!match) return null;
  return {
    reason: "usage-limit",
    resetAt: resetTimeFromMatch(match[1]!, match[2]!, now),
  };
}

function classifyText(text: string, now: Date): LimitMatch | null {
  if (LOGIN_REQUIRED_RE.test(text)) return { reason: "login-required" };
  const usage = usageLimit(text, now);
  if (usage) return usage;
  if (RATE_LIMIT_RE.test(text)) return { reason: "rate-limit" };
  return null;
}

function watchdogStatePath(session: string): string {
  return path.join(sessionDir(session), WATCHDOG_STATE_FILE);
}

function loadWatchdogMemory(session: string, deps: WatchdogDeps): Map<string, WatchdogMemory> {
  const file = watchdogStatePath(session);
  if (!deps.exists(file)) return new Map();
  try {
    const parsed = JSON.parse(deps.readFileSync(file)) as Partial<WatchdogStateFile>;
    if (parsed.schema !== 1 || parsed.type !== "watchdog_state" || parsed.session !== session) {
      return new Map();
    }
    return new Map(Object.entries(parsed.nodes ?? {}));
  } catch {
    return new Map();
  }
}

function saveWatchdogMemory(
  session: string,
  memory: Map<string, WatchdogMemory>,
  now: Date,
  deps: WatchdogDeps,
): void {
  const payload: WatchdogStateFile = {
    nodes: Object.fromEntries(memory),
    schema: 1,
    session,
    type: "watchdog_state",
    updated_at: now.toISOString(),
  };
  deps.writeFileAtomicSync(watchdogStatePath(session), `${JSON.stringify(payload, null, 2)}\n`);
}

function normalizePaneText(text: string): string {
  return text
    .replace(ANSI_ESCAPE_RE, "")
    .split(/\r?\n/)
    .map((line) =>
      line
        .replace(/[⠁-⣿]/g, "")
        .replace(/(^|\s)[|/\\-](?=\s|$)/g, "$1<spin>")
        .replace(/\b\d{1,2}:\d{2}(?::\d{2})?\b/g, "<time>")
        .replace(/\b\d+(?:\.\d+)?%/g, "<n>")
        .replace(/\b\d+(?:\.\d+)?\s*(?:ms|s|sec|secs|seconds|m|min|mins|%)\b/gi, "<n>")
        .replace(/[▏▎▍▌▋▊▉█]+/g, "<bar>")
        .replace(/\s+/g, " ")
        .trim(),
    )
    .filter(Boolean)
    .join("\n");
}

function paneHash(text: string): string {
  return createHash("sha256").update(normalizePaneText(text)).digest("hex");
}

function transcriptText(nc: NodeCtx, transcript: string): string {
  try {
    return nc.adapter.readLast(transcript) ?? "";
  } catch {
    return "";
  }
}

async function paneExists(addr: string, deps: WatchdogDeps): Promise<boolean> {
  try {
    await deps.paneTarget(addr);
    return true;
  } catch {
    return false;
  }
}

async function safeTranscriptMtimeMs(path: string, deps: WatchdogDeps): Promise<number | null> {
  try {
    return await deps.transcriptMtimeMs(path);
  } catch {
    return null;
  }
}

async function nodeState(
  ctx: Context,
  nc: NodeCtx,
  memory: Map<string, WatchdogMemory>,
  opts: { hungAfterMs: number },
  deps: WatchdogDeps,
): Promise<WatchdogNodeState> {
  const now = deps.now();
  const nowMs = now.getTime();
  const runtime = ctx.registry.nodes[nc.node.name];
  const pane = runtime?.tmux_pane ?? nc.addr;
  const previousMemory = memory.get(nc.node.name);
  const previous = previousMemory ?? { lastActivityMs: nowMs };

  if (!(await paneExists(pane, deps))) {
    memory.set(nc.node.name, previous);
    return {
      agent: nc.node.agent,
      health: "crashed",
      idle_ms: Math.max(0, nowMs - previous.lastActivityMs),
      last_activity_at: new Date(previous.lastActivityMs).toISOString(),
      node: nc.node.name,
      observed_at: now.toISOString(),
      pane,
      pane_exists: false,
      reason: "pane-missing",
      transcript: runtime?.transcript,
      transcript_bytes: 0,
    };
  }

  const command = await deps.paneCommand(pane);
  const normalizedCommand = command.trim().toLowerCase();
  if (!command || SHELL_COMMANDS.has(normalizedCommand)) {
    memory.set(nc.node.name, previous);
    return {
      agent: nc.node.agent,
      health: "crashed",
      idle_ms: Math.max(0, nowMs - previous.lastActivityMs),
      last_activity_at: new Date(previous.lastActivityMs).toISOString(),
      node: nc.node.name,
      observed_at: now.toISOString(),
      pane,
      pane_exists: true,
      reason: command ? "process-exited" : "process-missing",
      transcript: runtime?.transcript,
      transcript_bytes: 0,
    };
  }

  const paneText = await deps.capturePane(pane, CAPTURE_LINES);
  const paneTextHash = paneHash(paneText);
  const transcript = resolveTranscript(ctx, nc) || runtime?.transcript || "";
  const transcriptBytes = transcript ? nc.adapter.size(transcript) : 0;
  const transcriptMtimeMs = transcript ? await safeTranscriptMtimeMs(transcript, deps) : null;
  const combinedText = `${paneText}\n${transcript ? transcriptText(nc, transcript) : ""}`;
  const changed =
    previousMemory !== undefined &&
    (previous.lastPaneHash !== paneTextHash ||
      previous.lastTranscriptBytes !== transcriptBytes ||
      (transcriptMtimeMs !== null && previous.lastTranscriptMtimeMs !== transcriptMtimeMs));
  const lastActivityMs = changed
    ? nowMs
    : previousMemory === undefined && transcriptMtimeMs !== null
      ? Math.min(nowMs, transcriptMtimeMs)
      : previous.lastActivityMs;
  memory.set(nc.node.name, {
    lastActivityMs,
    lastPaneHash: paneTextHash,
    lastTranscriptBytes: transcriptBytes,
    lastTranscriptMtimeMs: transcriptMtimeMs ?? previous.lastTranscriptMtimeMs,
  });

  const limit = classifyText(combinedText, now);
  const idleMs = Math.max(0, nowMs - lastActivityMs);
  let health: WatchdogHealth = "healthy";
  let reason = "active";
  let usageLimitResetAt: string | undefined;
  if (limit?.reason === "login-required") {
    health = "login_required";
    reason = limit.reason;
  } else if (limit?.reason === "usage-limit") {
    health = "cooldown";
    reason = limit.reason;
    usageLimitResetAt = limit.resetAt;
  } else if (limit?.reason === "rate-limit") {
    health = "rate_limited";
    reason = limit.reason;
  } else if (idleMs >= opts.hungAfterMs) {
    health = "hung";
    reason = "no-pane-or-transcript-output";
  }

  return {
    agent: nc.node.agent,
    health,
    idle_ms: idleMs,
    last_activity_at: new Date(lastActivityMs).toISOString(),
    node: nc.node.name,
    observed_at: now.toISOString(),
    pane,
    pane_exists: true,
    reason,
    reset_at: usageLimitResetAt,
    transcript: transcript || runtime?.transcript,
    transcript_bytes: transcriptBytes,
    usage_limit_reset_at: usageLimitResetAt,
  };
}

export async function collectWatchdogSnapshot(
  ctx: Context,
  memory: Map<string, WatchdogMemory>,
  opts: { hungAfterMs: number },
  deps: WatchdogDeps = defaultDeps,
): Promise<WatchdogSnapshot> {
  const nodes: WatchdogNodeState[] = [];
  const activeNodes = new Set<string>();
  for (const nc of ctx.byName.values()) {
    activeNodes.add(nc.node.name);
    nodes.push(await nodeState(ctx, nc, memory, opts, deps));
  }
  for (const node of memory.keys()) {
    if (!activeNodes.has(node)) memory.delete(node);
  }
  nodes.sort((a, b) => a.node.localeCompare(b.node));
  const counts = emptyCounts();
  for (const node of nodes) counts[node.health] += 1;
  return {
    counts,
    generated_at: deps.now().toISOString(),
    hung_after_ms: opts.hungAfterMs,
    nodes,
    schema: 1,
    session: ctx.config.session,
    type: "node_health",
  };
}

export function renderWatchdogText(snapshot: WatchdogSnapshot): string {
  const lines = [
    `${color.bold(snapshot.session)} watchdog ${color.dim(snapshot.generated_at)} healthy=${snapshot.counts.healthy} degraded=${
      snapshot.nodes.length - snapshot.counts.healthy
    }`,
  ];
  for (const node of snapshot.nodes) {
    const marker =
      node.health === "healthy"
        ? color.green("healthy")
        : node.health === "crashed" || node.health === "login_required"
          ? color.red(node.health)
          : color.yellow(node.health);
    const detail = node.usage_limit_reset_at
      ? ` reset=${node.usage_limit_reset_at}`
      : ` idle=${Math.round(node.idle_ms / 1000)}s`;
    lines.push(`${node.node} [${node.agent}] ${marker} ${node.reason ?? ""}${detail}`);
  }
  return lines.join("\n");
}

export function renderWatchdogJson(snapshot: WatchdogSnapshot): string {
  return JSON.stringify(snapshot, null, 2);
}

export async function cmdWatchdog(
  opts: WatchdogOptions,
  deps: WatchdogDeps = defaultDeps,
): Promise<void> {
  const hungAfterMs = parseDuration(opts.hungAfter, DEFAULT_HUNG_AFTER_MS);
  const ctx = deps.loadContext(opts.config);
  const memory = loadWatchdogMemory(ctx.config.session, deps);
  const snapshot = await collectWatchdogSnapshot(ctx, memory, { hungAfterMs }, deps);
  saveWatchdogMemory(ctx.config.session, memory, deps.now(), deps);
  process.stdout.write(
    `${opts.json ? renderWatchdogJson(snapshot) : renderWatchdogText(snapshot)}\n`,
  );
}
