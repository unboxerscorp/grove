import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

import type { AgentType } from "./config.js";
import { registryPath, sessionDir } from "./util/paths.js";

export interface NodeRuntime {
  name: string;
  agent: AgentType;
  role?: string;
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

export function saveRegistry(reg: Registry): void {
  mkdirSync(sessionDir(reg.session), { recursive: true });
  reg.updatedAt = new Date().toISOString();
  writeFileSync(registryPath(reg.session), JSON.stringify(reg, null, 2) + "\n");
}

export function loadOrInit(session: string, cwd: string): Registry {
  return loadRegistry(session) ?? emptyRegistry(session, cwd);
}
