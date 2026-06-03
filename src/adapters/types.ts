import type { AgentType } from "../config.js";

export interface LaunchSpec {
  cwd: string;
  initialPrompt?: string;
  model?: string;
  resumeId?: string;
}

export interface Completion {
  /** a finished turn appeared after the requested offset */
  done: boolean;
  /** the agent's message text for that turn */
  text?: string;
  /** byte offset consumed up to (feed back on next poll) */
  offset: number;
}

export interface DetectedSession {
  sessionId: string;
  transcript: string;
}

/**
 * Teaches grove how to drive one kind of agent. Implement these and grove can
 * launch it, know when it finished a turn, and read what it said.
 */
export interface AgentAdapter {
  readonly name: AgentType;
  /** short label for status output */
  readonly label: string;

  /** shell command to run inside the node's tmux pane */
  launchCommand(spec: LaunchSpec): string;

  /** pane text that indicates the TUI has booted and is ready for input */
  readonly readyPattern: RegExp;

  /** how to submit a message after typing it: single Enter, or Enter twice */
  readonly submit: "enter" | "enter-enter";

  /** deterministic transcript path for a known session id (file may not exist yet) */
  transcriptForSession(cwd: string, sessionId: string): string;

  /** snapshot of candidate transcripts (path → mtimeMs) for new-session detection */
  snapshot(cwd: string): Map<string, number>;

  /** detect the transcript/session created or touched since `before` */
  detectNew(cwd: string, before: Map<string, number>): DetectedSession | null;

  /** extract the agent-native session id from a transcript path */
  sessionIdFromPath(transcript: string): string | null;

  /** current transcript size in bytes (offset baseline); 0 if missing */
  size(transcript: string): number;

  /** scan transcript from byteOffset; report a finished turn if one appeared */
  readCompletionSince(transcript: string, byteOffset: number): Completion;

  /** the last finished message text in the transcript (status / readback) */
  readLast(transcript: string): string | null;
}
