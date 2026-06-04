import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync as readFileSyncNode,
  unlinkSync,
} from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";

import type { Context, NodeCtx } from "../context.js";
import { loadContext } from "../context.js";
import { resolveTranscript } from "../ops.js";
import { capturePane, paneCommand, paneTarget, sendEnter } from "../tmux.js";
import { writeFileAtomicSync } from "../util/atomic.js";
import { color, warn } from "../util/log.js";
import { sessionDir } from "../util/paths.js";
import { parseDuration, sleep } from "../util/time.js";

export type WatchdogHealth =
  | "healthy"
  | "rate_limited"
  | "login_required"
  | "crashed"
  | "cooldown"
  | "hung"
  | "unknown";

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
  recovery: WatchdogRecoveryPlan;
}

export interface WatchdogOptions {
  config?: string;
  execute?: boolean;
  hungAfter?: string;
  json?: boolean;
}

export type WatchdogRecoveryActionType = "none" | "notify" | "nudge" | "restart" | "ready";
export type WatchdogRecoveryStatus =
  | "not_needed"
  | "blocked"
  | "scheduled"
  | "waiting"
  | "deferred"
  | "dry_run"
  | "executed"
  | "failed"
  | "ready"
  | "circuit_open";

export interface WatchdogRecoveryAction {
  node: string;
  health: WatchdogHealth;
  action: WatchdogRecoveryActionType;
  status: WatchdogRecoveryStatus;
  reason: string;
  dry_run: boolean;
  pane?: string;
  due_at?: string;
  cooldown_until?: string;
  lease_until?: string;
  executed_at?: string;
  error?: string;
}

export interface WatchdogRecoveryPlan {
  mode: "dry-run" | "execute";
  min_wake_interval_ms: number;
  actions: WatchdogRecoveryAction[];
  next_wake_at?: string;
}

export interface WatchdogMemory {
  lastPaneHash?: string;
  lastTranscriptBytes?: number;
  lastTranscriptMtimeMs?: number;
  lastActivityMs: number;
  recovery?: WatchdogNodeRecoveryMemory;
}

export interface WatchdogNodeRecoveryMemory {
  cooldownUntilMs?: number;
  lastHealth?: WatchdogHealth;
  lastRestartFailureAtMs?: number;
  lastNudgeAtMs?: number;
  lastRestartAtMs?: number;
  nudgeLeaseUntilMs?: number;
  notifiedLoginAtMs?: number;
  restartAttempts?: number;
}

export interface WatchdogGlobalRecoveryMemory {
  lastWakeAtMs?: number;
}

export interface WatchdogDeps {
  capturePane(addr: string, lines?: number): Promise<string>;
  exists(file: string): boolean;
  loadContext(config?: string): Context;
  now(): Date;
  paneCommand(addr: string): Promise<string>;
  paneTarget(addr: string): Promise<string>;
  performRecoveryAction(action: WatchdogRecoveryAction): Promise<void>;
  readFileSync(file: string): string;
  transcriptMtimeMs(path: string): Promise<number | null>;
  writeFileAtomicSync(file: string, data: string): void;
}

interface LimitMatch {
  reason: string;
  resetAt?: string;
}

const DEFAULT_HUNG_AFTER_MS = 10 * 60_000;
const DEFAULT_RATE_LIMIT_BACKOFF_MS = 15 * 60_000;
const DEFAULT_NUDGE_LEASE_MS = 5 * 60_000;
const GLOBAL_WAKE_INTERVAL_MS = 90_000;
const MAX_RESTART_ATTEMPTS = 3;
const STATE_LOCK_WAIT_MS = 5_000;
const STATE_LOCK_RETRY_MS = 25;
const CAPTURE_LINES = 240;
const WATCHDOG_STATE_FILE = "watchdog-state.json";
const RATE_LIMIT_RE = /temporarily limiting requests/i;
const USAGE_LIMIT_RE = /session limit[\s\S]{0,160}?resets?(?:\s+at)?\s+(\d{1,2}):(\d{2})/i;
const LOGIN_REQUIRED_RE =
  /\b(?:login required|not logged in|please log in|please sign in|authentication required|authentication expired|auth expired|token expired|credentials expired)\b/i;
const ACTIVE_PANE_RE =
  /\b(?:working|thinking|processing|running|streaming|esc\s+to\s+interrupt|press\s+esc\s+to\s+interrupt)\b/i;
const CODEX_IDLE_RE = /(?:^|\n)\s*[›❯]\s+\S|\bgpt[-\w.]*\s+(?:xhigh|high|medium|low)\b/i;
const CLAUDE_IDLE_RE = /(?:^|\n)\s*❯\s*(?:$|\S)|bypass permissions/i;
const ANTIGRAVITY_IDLE_RE = /\?\s*for\s+shortcuts|\bgemini\b|esc\s+to\s+cancel/i;
const SINGLE_PANE_TARGET_RE = /^(?:%\d+|[^:\s]+:[^:\s]+\.(?:%\d+|\d+))$/;
const SHELL_COMMANDS = new Set(["zsh", "-zsh", "bash", "-bash", "sh", "fish", "tmux"]);
const ANSI_ESCAPE_RE = new RegExp(`${String.fromCharCode(0x1b)}\\[[0-?]*[ -/]*[@-~]`, "g");

async function defaultTranscriptMtimeMs(path: string): Promise<number | null> {
  try {
    return (await stat(path)).mtimeMs;
  } catch {
    return null;
  }
}

async function defaultPerformRecoveryAction(action: WatchdogRecoveryAction): Promise<void> {
  if (action.action === "notify") {
    warn(`${action.node}: ${action.reason}`);
    return;
  }
  if ((action.action === "nudge" || action.action === "restart") && action.pane) {
    await sendEnter(action.pane);
  }
}

const defaultDeps: WatchdogDeps = {
  capturePane,
  exists: existsSync,
  loadContext,
  now: () => new Date(),
  paneCommand,
  paneTarget,
  performRecoveryAction: defaultPerformRecoveryAction,
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
  recovery?: WatchdogGlobalRecoveryMemory;
}

interface WatchdogRuntimeState {
  nodes: Map<string, WatchdogMemory>;
  recovery: WatchdogGlobalRecoveryMemory;
}

function emptyCounts(): Record<WatchdogHealth, number> {
  return {
    crashed: 0,
    cooldown: 0,
    healthy: 0,
    hung: 0,
    login_required: 0,
    rate_limited: 0,
    unknown: 0,
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

function watchdogStateLockPath(session: string): string {
  return `${watchdogStatePath(session)}.lock`;
}

async function withWatchdogStateLock<T>(session: string, fn: () => Promise<T>): Promise<T> {
  const lockFile = watchdogStateLockPath(session);
  mkdirSync(path.dirname(lockFile), { recursive: true });
  const deadline = Date.now() + STATE_LOCK_WAIT_MS;
  let fd: number | undefined;
  while (fd === undefined) {
    try {
      fd = openSync(lockFile, "wx", 0o600);
    } catch (error) {
      if (Date.now() >= deadline) {
        const detail = error instanceof Error ? `: ${error.message}` : "";
        throw new Error(`watchdog state lock busy for session ${session}${detail}`);
      }
      await sleep(STATE_LOCK_RETRY_MS);
    }
  }
  try {
    return await fn();
  } finally {
    closeSync(fd);
    try {
      unlinkSync(lockFile);
    } catch {
      /* lock already removed */
    }
  }
}

function loadWatchdogState(session: string, deps: WatchdogDeps): WatchdogRuntimeState {
  const file = watchdogStatePath(session);
  if (!deps.exists(file)) return { nodes: new Map(), recovery: {} };
  try {
    const parsed = JSON.parse(deps.readFileSync(file)) as Partial<WatchdogStateFile>;
    if (parsed.schema !== 1 || parsed.type !== "watchdog_state" || parsed.session !== session) {
      return { nodes: new Map(), recovery: {} };
    }
    return { nodes: new Map(Object.entries(parsed.nodes ?? {})), recovery: parsed.recovery ?? {} };
  } catch {
    return { nodes: new Map(), recovery: {} };
  }
}

function saveWatchdogState(
  session: string,
  state: WatchdogRuntimeState,
  now: Date,
  deps: WatchdogDeps,
): void {
  const payload: WatchdogStateFile = {
    nodes: Object.fromEntries(state.nodes),
    recovery: state.recovery,
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

function paneLineContent(line: string): string {
  return line
    .replace(/[│┃┆┊╎╏]/g, "")
    .replace(/[╭╮╰╯─═━┄┅┈┉]+/g, "")
    .trim();
}

function hasIdlePrompt(text: string, agent: string): boolean {
  const normalized = normalizePaneText(text);
  const hasPromptGlyph = normalized
    .split("\n")
    .some((line) => /^(?:[❯›>]\s*){1,3}$/.test(paneLineContent(line)));
  if (hasPromptGlyph) return true;
  if (agent === "codex") return CODEX_IDLE_RE.test(normalized);
  if (agent === "claude") return CLAUDE_IDLE_RE.test(normalized);
  if (agent === "antigravity") return ANTIGRAVITY_IDLE_RE.test(normalized);
  return CODEX_IDLE_RE.test(normalized) || CLAUDE_IDLE_RE.test(normalized);
}

function hasActiveIndicator(text: string): boolean {
  return ACTIVE_PANE_RE.test(text);
}

function isSinglePaneTarget(target: string): boolean {
  return SINGLE_PANE_TARGET_RE.test(target);
}

function cloneWatchdogMemory(memory: Map<string, WatchdogMemory>): Map<string, WatchdogMemory> {
  return new Map(
    [...memory.entries()].map(([node, entry]) => [
      node,
      {
        ...entry,
        recovery: entry.recovery ? { ...entry.recovery } : undefined,
      },
    ]),
  );
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function recoveryAction(
  node: WatchdogNodeState,
  action: WatchdogRecoveryActionType,
  status: WatchdogRecoveryStatus,
  reason: string,
  dryRun: boolean,
  details: Omit<
    WatchdogRecoveryAction,
    "action" | "dry_run" | "health" | "node" | "reason" | "status"
  > = {},
): WatchdogRecoveryAction {
  return {
    action,
    dry_run: dryRun,
    health: node.health,
    node: node.node,
    reason,
    status,
    ...details,
  };
}

function scheduledRestartMs(
  node: WatchdogNodeState,
  memory: WatchdogMemory,
  nowMs: number,
): number {
  const recovery = (memory.recovery ??= {});
  if (node.health === "cooldown" && node.usage_limit_reset_at) {
    const reset = Date.parse(node.usage_limit_reset_at);
    if (Number.isFinite(reset)) {
      recovery.cooldownUntilMs = reset;
      return reset;
    }
  }
  if (recovery.lastHealth !== node.health || !recovery.cooldownUntilMs) {
    recovery.cooldownUntilMs = nowMs + DEFAULT_RATE_LIMIT_BACKOFF_MS;
  }
  return recovery.cooldownUntilMs;
}

interface RecoveryCandidate {
  action: WatchdogRecoveryAction;
  dueMs: number;
  memory: WatchdogMemory;
}

function plannedRecoveryActions(
  snapshotNodes: WatchdogNodeState[],
  memory: Map<string, WatchdogMemory>,
  nowMs: number,
  dryRun: boolean,
): { actions: WatchdogRecoveryAction[]; candidates: RecoveryCandidate[] } {
  const actions: WatchdogRecoveryAction[] = [];
  const candidates: RecoveryCandidate[] = [];

  for (const node of snapshotNodes) {
    const nodeMemory = memory.get(node.node);
    if (!nodeMemory) continue;
    const recovery = (nodeMemory.recovery ??= {});

    if (node.health === "healthy" || node.health === "unknown") {
      delete nodeMemory.recovery;
      actions.push(recoveryAction(node, "none", "not_needed", node.health, dryRun));
      continue;
    }

    if (node.health === "login_required") {
      if (!recovery.notifiedLoginAtMs) recovery.notifiedLoginAtMs = nowMs;
      actions.push(
        recoveryAction(node, "notify", "blocked", "login-required-manual-recovery", dryRun, {
          executed_at: iso(recovery.notifiedLoginAtMs),
          pane: node.pane,
        }),
      );
      recovery.lastHealth = node.health;
      continue;
    }

    if (node.health === "rate_limited" || node.health === "cooldown") {
      if ((recovery.restartAttempts ?? 0) >= MAX_RESTART_ATTEMPTS) {
        actions.push(
          recoveryAction(node, "notify", "circuit_open", "circuit-open:max-retries", dryRun, {
            pane: node.pane,
          }),
        );
        recovery.lastHealth = node.health;
        continue;
      }
      const dueMs = scheduledRestartMs(node, nodeMemory, nowMs);
      const action = recoveryAction(
        node,
        "restart",
        dueMs <= nowMs ? "deferred" : "scheduled",
        node.health === "cooldown" ? "usage-limit-reset-wake" : "rate-limit-backoff",
        dryRun,
        {
          cooldown_until: iso(dueMs),
          due_at: iso(dueMs),
          pane: node.pane,
        },
      );
      actions.push(action);
      if (dueMs <= nowMs) candidates.push({ action, dueMs, memory: nodeMemory });
      recovery.lastHealth = node.health;
      continue;
    }

    if (node.health === "crashed" || node.health === "hung") {
      if (!recovery.lastNudgeAtMs) {
        recovery.lastNudgeAtMs = nowMs;
        recovery.nudgeLeaseUntilMs = nowMs + DEFAULT_NUDGE_LEASE_MS;
        const action = recoveryAction(node, "nudge", "deferred", `${node.health}-nudge`, dryRun, {
          due_at: iso(nowMs),
          lease_until: iso(recovery.nudgeLeaseUntilMs),
          pane: node.pane,
        });
        actions.push(action);
        candidates.push({ action, dueMs: nowMs, memory: nodeMemory });
      } else if ((recovery.nudgeLeaseUntilMs ?? nowMs) > nowMs) {
        actions.push(
          recoveryAction(node, "nudge", "waiting", `${node.health}-nudge-lease`, dryRun, {
            lease_until: iso(recovery.nudgeLeaseUntilMs ?? nowMs),
            pane: node.pane,
          }),
        );
      } else {
        actions.push(
          recoveryAction(node, "ready", "ready", `${node.health}-nudge-lease-expired`, dryRun, {
            lease_until: iso(recovery.nudgeLeaseUntilMs ?? nowMs),
            pane: node.pane,
          }),
        );
      }
      recovery.lastHealth = node.health;
    }
  }

  return { actions, candidates };
}

async function applyRecoveryQueue(
  candidates: RecoveryCandidate[],
  global: WatchdogGlobalRecoveryMemory,
  nowMs: number,
  execute: boolean,
  deps: WatchdogDeps,
): Promise<string | undefined> {
  const nextAllowedMs = (global.lastWakeAtMs ?? 0) + GLOBAL_WAKE_INTERVAL_MS;
  if (candidates.length === 0) return undefined;
  candidates.sort((a, b) => a.dueMs - b.dueMs || a.action.node.localeCompare(b.action.node));

  if (nextAllowedMs > nowMs) {
    for (const candidate of candidates) {
      candidate.action.status = "deferred";
      candidate.action.due_at = iso(nextAllowedMs);
      candidate.action.reason = `${candidate.action.reason}:global-wake-interval`;
    }
    return iso(nextAllowedMs);
  }

  const selected = candidates[0]!;
  const deferred = candidates.slice(1);
  for (const candidate of deferred) {
    candidate.action.status = "deferred";
    candidate.action.due_at = iso(nowMs + GLOBAL_WAKE_INTERVAL_MS);
    candidate.action.reason = `${candidate.action.reason}:global-queue`;
  }

  selected.action.status = execute ? "executed" : "dry_run";
  selected.action.executed_at = iso(nowMs);
  if (execute) {
    try {
      await deps.performRecoveryAction(selected.action);
      global.lastWakeAtMs = nowMs;
      if (selected.action.action === "restart") {
        selected.memory.recovery ??= {};
        selected.memory.recovery.restartAttempts =
          (selected.memory.recovery.restartAttempts ?? 0) + 1;
        selected.memory.recovery.lastRestartAtMs = nowMs;
        selected.memory.recovery.cooldownUntilMs = nowMs + DEFAULT_RATE_LIMIT_BACKOFF_MS;
        selected.action.cooldown_until = iso(selected.memory.recovery.cooldownUntilMs);
      }
    } catch (error) {
      selected.action.status = "failed";
      selected.action.error = error instanceof Error ? error.message : String(error);
      global.lastWakeAtMs = nowMs;
      if (selected.action.action === "restart") {
        selected.memory.recovery ??= {};
        selected.memory.recovery.restartAttempts =
          (selected.memory.recovery.restartAttempts ?? 0) + 1;
        selected.memory.recovery.lastRestartFailureAtMs = nowMs;
        selected.memory.recovery.cooldownUntilMs = nowMs + DEFAULT_RATE_LIMIT_BACKOFF_MS;
        selected.action.cooldown_until = iso(selected.memory.recovery.cooldownUntilMs);
        if (selected.memory.recovery.restartAttempts >= MAX_RESTART_ATTEMPTS) {
          selected.action.action = "notify";
          selected.action.status = "circuit_open";
          selected.action.reason = "circuit-open:max-retries";
        }
      }
    }
  }

  return deferred.length > 0 || execute ? iso(nowMs + GLOBAL_WAKE_INTERVAL_MS) : undefined;
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
  if (!isSinglePaneTarget(pane)) {
    const transcript = resolveTranscript(ctx, nc) || runtime?.transcript || "";
    memory.set(nc.node.name, previous);
    return {
      agent: nc.node.agent,
      health: "unknown",
      idle_ms: Math.max(0, nowMs - previous.lastActivityMs),
      last_activity_at: new Date(previous.lastActivityMs).toISOString(),
      node: nc.node.name,
      observed_at: now.toISOString(),
      pane,
      pane_exists: false,
      reason: "ambiguous-pane-target",
      transcript: transcript || runtime?.transcript,
      transcript_bytes: transcript ? nc.adapter.size(transcript) : 0,
    };
  }

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
    recovery: previous.recovery,
  });

  const limit = classifyText(combinedText, now);
  const idlePrompt = hasIdlePrompt(paneText, nc.node.agent);
  const activeIndicator = hasActiveIndicator(paneText);
  const idleMs = Math.max(0, nowMs - lastActivityMs);
  let health: WatchdogHealth = "healthy";
  let reason = idlePrompt ? "idle" : "active";
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
  } else if (!idlePrompt && !activeIndicator && idleMs >= opts.hungAfterMs) {
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
  opts: {
    execute?: boolean;
    globalRecovery?: WatchdogGlobalRecoveryMemory;
    hungAfterMs: number;
  },
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
  const now = deps.now();
  const execute = opts.execute ?? false;
  const planningMemory = execute ? memory : cloneWatchdogMemory(memory);
  const { actions, candidates } = plannedRecoveryActions(
    nodes,
    planningMemory,
    now.getTime(),
    !execute,
  );
  const nextWakeAt = await applyRecoveryQueue(
    candidates,
    opts.globalRecovery ?? {},
    now.getTime(),
    execute,
    deps,
  );
  return {
    counts,
    generated_at: now.toISOString(),
    hung_after_ms: opts.hungAfterMs,
    nodes,
    recovery: {
      actions,
      min_wake_interval_ms: GLOBAL_WAKE_INTERVAL_MS,
      mode: execute ? "execute" : "dry-run",
      next_wake_at: nextWakeAt,
    },
    schema: 1,
    session: ctx.config.session,
    type: "node_health",
  };
}

export function renderWatchdogText(snapshot: WatchdogSnapshot): string {
  const lines = [
    `${color.bold(snapshot.session)} watchdog ${color.dim(snapshot.generated_at)} healthy=${snapshot.counts.healthy} degraded=${
      snapshot.nodes.length - snapshot.counts.healthy
    } recovery=${snapshot.recovery.mode}`,
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
  for (const action of snapshot.recovery.actions) {
    if (action.status === "not_needed") continue;
    const due = action.due_at ? ` due=${action.due_at}` : "";
    const lease = action.lease_until ? ` lease=${action.lease_until}` : "";
    lines.push(
      `${action.node}: recovery ${action.action} ${action.status} ${action.reason}${due}${lease}`,
    );
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
  const snapshot = await withWatchdogStateLock(ctx.config.session, async () => {
    const state = loadWatchdogState(ctx.config.session, deps);
    const current = await collectWatchdogSnapshot(
      ctx,
      state.nodes,
      { execute: opts.execute, globalRecovery: state.recovery, hungAfterMs },
      deps,
    );
    saveWatchdogState(ctx.config.session, state, deps.now(), deps);
    return current;
  });
  process.stdout.write(
    `${opts.json ? renderWatchdogJson(snapshot) : renderWatchdogText(snapshot)}\n`,
  );
}
