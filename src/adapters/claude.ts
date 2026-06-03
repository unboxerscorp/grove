import path from "node:path";

import { cwdSlug, homedir } from "../util/paths.js";
import { shellQuote } from "../util/shell.js";
import { fileSize, jsonLines, newestChanged, readFrom, snapshotMtimes } from "./jsonl.js";
import type { AgentAdapter, Completion, DetectedSession, LaunchSpec } from "./types.js";

function projectDir(cwd: string): string {
  return path.join(homedir(), ".claude", "projects", cwdSlug(cwd));
}

function isJsonl(p: string): boolean {
  return p.endsWith(".jsonl");
}

/** Pull text blocks out of a Claude assistant message's content array. */
function textOfAssistant(obj: Record<string, unknown>): string | null {
  const message = obj["message"];
  if (!message || typeof message !== "object") return null;
  const m = message as Record<string, unknown>;
  if (m["stop_reason"] !== "end_turn") return null;
  const content = m["content"];
  if (!Array.isArray(content)) return null;
  const parts: string[] = [];
  for (const block of content) {
    if (
      block &&
      typeof block === "object" &&
      (block as Record<string, unknown>)["type"] === "text"
    ) {
      const t = (block as Record<string, unknown>)["text"];
      if (typeof t === "string") parts.push(t);
    }
  }
  return parts.length ? parts.join("\n").trim() : null;
}

export const claudeAdapter: AgentAdapter = {
  name: "claude",
  label: "claude",
  readyPattern: /Claude Code v|auto mode|\? for shortcuts|esc to interrupt|❯/i,
  // Claude's TUI absorbs the first Enter after a bracketed paste as the paste's
  // trailing newline; a second Enter actually submits.
  submit: "enter-enter",

  launchCommand(spec: LaunchSpec): string {
    const parts = ["claude"];
    if (spec.resumeId) parts.push("--resume", shellQuote(spec.resumeId));
    if (spec.model) parts.push("--model", shellQuote(spec.model));
    return parts.join(" ");
  },

  transcriptForSession(cwd: string, sessionId: string): string {
    return path.join(projectDir(cwd), `${sessionId}.jsonl`);
  },

  snapshot(cwd: string): Map<string, number> {
    return snapshotMtimes(projectDir(cwd), isJsonl);
  },

  detectNew(cwd: string, before: Map<string, number>): DetectedSession | null {
    const current = snapshotMtimes(projectDir(cwd), isJsonl);
    const p = newestChanged(current, before);
    if (!p) return null;
    const id = this.sessionIdFromPath(p);
    if (!id) return null;
    return { sessionId: id, transcript: p };
  },

  sessionIdFromPath(transcript: string): string | null {
    const base = path.basename(transcript, ".jsonl");
    return base.length ? base : null;
  },

  size(transcript: string): number {
    return fileSize(transcript);
  },

  readCompletionSince(transcript: string, byteOffset: number): Completion {
    const { text, size } = readFrom(transcript, byteOffset);
    let result: string | undefined;
    for (const obj of jsonLines(text)) {
      if (obj["type"] !== "assistant") continue;
      const t = textOfAssistant(obj);
      if (t !== null) result = t;
    }
    return { done: result !== undefined, text: result, offset: size };
  },

  readLast(transcript: string): string | null {
    const size = fileSize(transcript);
    if (size === 0) return null;
    const { text } = readFrom(transcript, Math.max(0, size - 131072));
    let last: string | null = null;
    for (const obj of jsonLines(text)) {
      if (obj["type"] !== "assistant") continue;
      const t = textOfAssistant(obj);
      if (t !== null) last = t;
    }
    return last;
  },
};
