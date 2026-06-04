import { closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync } from "node:fs";

import type { AgentType } from "./config.js";
import { writeFileAtomicSync } from "./util/atomic.js";
import { registryPath, sessionDir } from "./util/paths.js";

const REGISTRY_LOCK_WAIT_MS = 5_000;
const REGISTRY_LOCK_RETRY_MS = 25;
const heldLocks = new Map<string, number>();
const sleepBuffer = new SharedArrayBuffer(4);
const sleepView = new Int32Array(sleepBuffer);

export interface NodeRuntime {
  name: string;
  agent: AgentType;
  role?: string;
  description?: string;
  parent?: string;
  children?: string[];
  group?: string;
  /** agent-native session id (codex/claude UUID), once detected */
  sessionId?: string;
  /** resolved transcript path, once detected */
  transcript?: string;
  /** full tmux pane target for explicit pane-bound nodes, e.g. "dev10:1.2" */
  tmux_pane?: string;
  /** Baseline for the in-flight turn, recorded at submit time so a later
   *  `wait` scans from before the response (fixes the send→wait race).
   *  Set by send/ask, cleared on completion. */
  pending?: {
    transcript: string;
    fromOffset: number;
    submittedAt: string;
    eventLogOffset?: number;
  };
}

export interface Registry {
  session: string;
  cwd: string;
  nodes: Record<string, NodeRuntime>;
  updatedAt: string;
}

export function emptyRegistry(session: string, cwd: string): Registry {
  return { session, cwd, nodes: {}, updatedAt: new Date().toISOString() };
}

export function loadRegistry(session: string): Registry | null {
  const p = registryPath(session);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8")) as Registry;
  } catch {
    return null;
  }
}

function registryLockPath(session: string): string {
  return `${registryPath(session)}.lock`;
}

function sleepSync(ms: number): void {
  Atomics.wait(sleepView, 0, 0, ms);
}

function withRegistryLock<T>(session: string, fn: () => T): T {
  const lockFile = registryLockPath(session);
  const held = heldLocks.get(lockFile);
  if (held !== undefined) {
    heldLocks.set(lockFile, held + 1);
    try {
      return fn();
    } finally {
      const next = (heldLocks.get(lockFile) ?? 1) - 1;
      if (next > 0) heldLocks.set(lockFile, next);
      else heldLocks.delete(lockFile);
    }
  }

  mkdirSync(sessionDir(session), { recursive: true });
  const deadline = Date.now() + REGISTRY_LOCK_WAIT_MS;
  let fd: number | undefined;
  while (fd === undefined) {
    try {
      fd = openSync(lockFile, "wx", 0o600);
    } catch (error) {
      if (Date.now() >= deadline) {
        const detail = error instanceof Error ? `: ${error.message}` : "";
        throw new Error(`registry lock busy for session ${session}${detail}`);
      }
      sleepSync(REGISTRY_LOCK_RETRY_MS);
    }
  }

  heldLocks.set(lockFile, 1);
  try {
    return fn();
  } finally {
    const next = (heldLocks.get(lockFile) ?? 1) - 1;
    if (next > 0) {
      heldLocks.set(lockFile, next);
    } else {
      heldLocks.delete(lockFile);
      closeSync(fd);
      try {
        unlinkSync(lockFile);
      } catch {
        /* lock already removed */
      }
    }
  }
}

function saveRegistryUnlocked(reg: Registry): void {
  mkdirSync(sessionDir(reg.session), { recursive: true });
  reg.updatedAt = new Date().toISOString();
  writeFileAtomicSync(registryPath(reg.session), JSON.stringify(reg, null, 2) + "\n");
}

export function saveRegistry(reg: Registry): void {
  withRegistryLock(reg.session, () => saveRegistryUnlocked(reg));
}

export function updateRegistryNode(
  reg: Registry,
  nodeName: string,
  update: (current: NodeRuntime | undefined) => NodeRuntime | undefined,
  opts: { allowCreate?: boolean } = {},
): NodeRuntime | undefined {
  return withRegistryLock(reg.session, () => {
    const latest = loadRegistry(reg.session);
    const current = latest?.nodes[nodeName] ?? reg.nodes[nodeName];
    if (latest && !latest.nodes[nodeName] && !opts.allowCreate) {
      delete reg.nodes[nodeName];
      return undefined;
    }

    const updated = update(current);
    const base = loadRegistry(reg.session) ?? latest ?? reg;
    const next: Registry = { ...base, nodes: { ...base.nodes } };
    if (base.nodes[nodeName] === undefined && !opts.allowCreate) {
      delete reg.nodes[nodeName];
      return undefined;
    }
    if (updated) {
      next.nodes[nodeName] = updated;
    } else {
      delete next.nodes[nodeName];
    }
    saveRegistryUnlocked(next);
    reg.cwd = next.cwd;
    reg.updatedAt = next.updatedAt;
    if (updated) reg.nodes[nodeName] = updated;
    else delete reg.nodes[nodeName];
    return reg.nodes[nodeName];
  });
}

export function loadOrInit(session: string, cwd: string): Registry {
  return loadRegistry(session) ?? emptyRegistry(session, cwd);
}
