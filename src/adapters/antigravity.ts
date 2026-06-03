import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";

import { cwdSlug } from "../util/paths.js";
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

function logRoot(cwd: string): string {
  return path.join(cwd, ".grove", "antigravity", cwdSlug(cwd));
}

function isLog(p: string): boolean {
  return p.endsWith(".log") || p.endsWith(".jsonl");
}

function safeLogName(sessionId: string): string {
  return encodeURIComponent(sessionId).replaceAll("%", "_");
}

function newLogPath(cwd: string): string {
  mkdirSync(logRoot(cwd), { recursive: true });
  return path.join(logRoot(cwd), `${randomUUID()}.log`);
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function conversationIdFromRecord(record: Record<string, unknown>): string | null {
  for (const key of ["conversation_id", "conversationId", "conversationID"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  const conversation = record["conversation"];
  if (typeof conversation === "string" && conversation.trim()) return conversation.trim();
  if (conversation && typeof conversation === "object") {
    const id = (conversation as Record<string, unknown>)["id"];
    if (typeof id === "string" && id.trim()) return id.trim();
  }
  return null;
}

function conversationIdFromText(text: string): string | null {
  for (const record of jsonLines(text)) {
    const id = conversationIdFromRecord(record);
    if (id) return id;
  }
  const match = text.match(/\bconversation(?:[_ -]?id)?\s*[:=]\s*([A-Za-z0-9._:-]+)/i);
  return match?.[1] ?? null;
}

function textFromContent(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return null;
  const parts: string[] = [];
  for (const item of value) {
    if (typeof item === "string") {
      parts.push(item);
      continue;
    }
    if (!item || typeof item !== "object") continue;
    const text = (item as Record<string, unknown>)["text"];
    if (typeof text === "string") parts.push(text);
  }
  return parts.length ? parts.join("\n") : null;
}

function completionText(record: Record<string, unknown>): string {
  for (const key of ["last_agent_message", "message", "summary", "text"]) {
    const value = record[key];
    if (typeof value === "string") return value;
  }
  return textFromContent(record["content"]) ?? "";
}

function isCompletionRecord(record: Record<string, unknown>): boolean {
  const typeValue = record["type"] ?? record["event"];
  const statusValue = record["status"];
  const type = typeof typeValue === "string" ? typeValue.toLowerCase() : "";
  const status = typeof statusValue === "string" ? statusValue.toLowerCase() : "";
  return (
    /(?:turn|task|response)[_.-]?(?:complete|done|finished)/.test(type) ||
    ["complete", "completed", "done", "finished"].includes(status)
  );
}

function completionFromText(text: string): string | undefined {
  let result: string | undefined;
  for (const record of jsonLines(text)) {
    if (isCompletionRecord(record)) result = completionText(record);
  }
  if (result !== undefined) return result;

  // Antigravity's log schema is not public yet. If logs only show the TUI
  // returning to an idle prompt, report a completed turn with no extracted text.
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (/^(?:>|❯)$/.test(trimmed) || /^status:\s*idle$/i.test(trimmed)) return "";
    const marker = trimmed.match(/\b(?:turn|task|response)[_. -]?(?:complete|done)\b:?\s*(.*)$/i);
    if (marker) return marker[1] ?? "";
  }
  return undefined;
}

function latestMatchingTranscript(cwd: string, sessionId: string): string {
  const exact = path.join(logRoot(cwd), `${safeLogName(sessionId)}.log`);
  if (existsSync(exact)) return exact;
  const matches = walk(logRoot(cwd), (p) => isLog(p) && p.includes(sessionId));
  matches.sort((a, b) => mtimeMs(a) - mtimeMs(b));
  return matches.at(-1) ?? exact;
}

export const antigravityAdapter: AgentAdapter = {
  name: "antigravity",
  label: "agy",
  readyPattern: /(^|\n)\s*[>❯]\s*$|status:?\s*idle/i,
  submit: "enter",

  launchCommand(spec: LaunchSpec): string {
    if (spec.resumeId) {
      return [
        "agy",
        "--conversation",
        shellQuote(spec.resumeId),
        "--dangerously-skip-permissions",
        "--log-file",
        shellQuote(this.transcriptForSession(spec.cwd, spec.resumeId)),
      ].join(" ");
    }
    return [
      "agy",
      "-i",
      shellQuote(spec.initialPrompt ?? ""),
      "--dangerously-skip-permissions",
      "--log-file",
      shellQuote(newLogPath(spec.cwd)),
    ].join(" ");
  },

  transcriptForSession(cwd: string, sessionId: string): string {
    return latestMatchingTranscript(cwd, sessionId);
  },

  snapshot(cwd: string): Map<string, number> {
    return snapshotMtimes(logRoot(cwd), isLog);
  },

  detectNew(cwd: string, before: Map<string, number>): DetectedSession | null {
    const current = snapshotMtimes(logRoot(cwd), isLog);
    const transcript = newestChanged(current, before);
    if (!transcript) return null;
    const { text } = readFrom(transcript, 0);
    const sessionId = conversationIdFromText(text) ?? this.sessionIdFromPath(transcript);
    return sessionId ? { sessionId, transcript } : null;
  },

  sessionIdFromPath(transcript: string): string | null {
    const base = path.basename(transcript).replace(/\.(?:log|jsonl)$/i, "");
    return base || null;
  },

  size(transcript: string): number {
    return fileSize(transcript);
  },

  readCompletionSince(transcript: string, byteOffset: number): Completion {
    const { text, size } = readFrom(transcript, byteOffset);
    const result = completionFromText(text);
    return { done: result !== undefined, text: result, offset: size };
  },

  readLast(transcript: string): string | null {
    const size = fileSize(transcript);
    if (size === 0) return null;
    const { text } = readFrom(transcript, Math.max(0, size - 131072));
    return completionFromText(text) ?? null;
  },
};
