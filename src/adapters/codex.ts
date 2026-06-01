import path from "node:path";
import { homedir } from "../util/paths.js";
import {
  fileSize,
  jsonLines,
  mtimeMs,
  newestChanged,
  readFrom,
  snapshotMtimes,
  walk,
} from "./jsonl.js";
import type { AgentAdapter, Completion, DetectedSession, LaunchSpec } from "./types.js";

const ROOT = path.join(homedir(), ".codex", "sessions");
const UUID_RE =
  /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

function isJsonl(p: string): boolean {
  return p.endsWith(".jsonl");
}

function payloadOf(obj: Record<string, unknown>): Record<string, unknown> {
  const p = obj["payload"];
  return p && typeof p === "object" ? (p as Record<string, unknown>) : obj;
}

export const codexAdapter: AgentAdapter = {
  name: "codex",
  label: "codex",
  readyPattern: /·\s+(~|\/)|Explain this codebase|Implement \{feature\}|⏎\s*send/i,
  submit: "enter-enter",

  launchCommand(spec: LaunchSpec): string {
    if (spec.resumeId) return `codex resume ${spec.resumeId}`;
    const parts = ["codex"];
    if (spec.model) parts.push("-m", spec.model);
    return parts.join(" ");
  },

  transcriptForSession(_cwd: string, sessionId: string): string {
    const matches = walk(ROOT, (p) => isJsonl(p) && p.includes(sessionId));
    if (matches.length === 0) return "";
    matches.sort((a, b) => mtimeMs(a) - mtimeMs(b));
    return matches[matches.length - 1]!;
  },

  snapshot(_cwd: string): Map<string, number> {
    return snapshotMtimes(ROOT, isJsonl);
  },

  detectNew(cwd: string, before: Map<string, number>): DetectedSession | null {
    const current = snapshotMtimes(ROOT, isJsonl);
    const p = newestChanged(current, before);
    if (!p) return null;
    const id = this.sessionIdFromPath(p);
    if (!id) return null;
    return { sessionId: id, transcript: p };
  },

  sessionIdFromPath(transcript: string): string | null {
    const m = transcript.match(UUID_RE);
    return m ? m[1]! : null;
  },

  size(transcript: string): number {
    return fileSize(transcript);
  },

  readCompletionSince(transcript: string, byteOffset: number): Completion {
    const { text, size } = readFrom(transcript, byteOffset);
    let result: string | undefined;
    for (const obj of jsonLines(text)) {
      const p = payloadOf(obj);
      if (p["type"] === "task_complete") {
        const msg = p["last_agent_message"];
        if (typeof msg === "string") result = msg;
      }
    }
    return { done: result !== undefined, text: result, offset: size };
  },

  readLast(transcript: string): string | null {
    const size = fileSize(transcript);
    if (size === 0) return null;
    const { text } = readFrom(transcript, Math.max(0, size - 65536));
    let last: string | null = null;
    for (const obj of jsonLines(text)) {
      const p = payloadOf(obj);
      const t = p["type"];
      if (t === "task_complete" && typeof p["last_agent_message"] === "string") {
        last = p["last_agent_message"] as string;
      } else if (t === "agent_message" && typeof p["message"] === "string") {
        last = p["message"] as string;
      }
    }
    return last;
  },
};
