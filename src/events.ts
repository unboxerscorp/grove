import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import path from "node:path";

export type GroveTurnEventType = "turn.done" | "turn.failed";
export type GroveTurnStatus = "done" | "failed";

export interface GroveTurnEvent {
  schema: 1;
  type: GroveTurnEventType;
  node: string;
  turnId: string;
  transcriptId: string;
  transcriptOffset: number;
  marker: string;
  ts: number;
  nonce: string;
  status: GroveTurnStatus;
  summary?: string;
}

export interface TurnEventReadResult {
  events: GroveTurnEvent[];
  nextOffset: number;
}

const EVENT_LOG_FILE = "events.jsonl";
const NONCE_DIR = "nonces";

export function eventLogPath(eventLogDir: string): string {
  return path.join(eventLogDir, EVENT_LOG_FILE);
}

export function eventLogSize(eventLogDir: string): number {
  try {
    return statSync(eventLogPath(eventLogDir)).size;
  } catch {
    return 0;
  }
}

function isTurnEvent(value: unknown): value is GroveTurnEvent {
  if (!value || typeof value !== "object") return false;
  const event = value as Record<string, unknown>;
  return (
    event["schema"] === 1 &&
    (event["type"] === "turn.done" || event["type"] === "turn.failed") &&
    typeof event["node"] === "string" &&
    typeof event["turnId"] === "string" &&
    typeof event["transcriptId"] === "string" &&
    Number.isInteger(event["transcriptOffset"]) &&
    typeof event["marker"] === "string" &&
    typeof event["ts"] === "number" &&
    typeof event["nonce"] === "string" &&
    (event["status"] === "done" || event["status"] === "failed") &&
    (event["summary"] === undefined || typeof event["summary"] === "string")
  );
}

export function readTurnEventsSince(eventLogDir: string, fromOffset: number): TurnEventReadResult {
  const logPath = eventLogPath(eventLogDir);
  let buffer: Buffer;
  try {
    buffer = readFileSync(logPath);
  } catch {
    return { events: [], nextOffset: 0 };
  }

  const start = Math.min(Math.max(0, fromOffset), buffer.length);
  const slice = buffer.subarray(start);
  const lastNewline = slice.lastIndexOf(0x0a);
  if (lastNewline < 0) {
    return { events: [], nextOffset: start };
  }

  const completeLength = lastNewline + 1;
  const text = slice.subarray(0, completeLength).toString("utf8");
  const events: GroveTurnEvent[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (isTurnEvent(parsed)) events.push(parsed);
    } catch {
      /* Ignore torn or invalid records; the next read starts after complete lines. */
    }
  }

  return { events, nextOffset: start + completeLength };
}

function noncePath(eventLogDir: string, nonce: string): string {
  return path.join(eventLogDir, NONCE_DIR, encodeURIComponent(nonce));
}

function hasNonceInLog(eventLogDir: string, nonce: string): boolean {
  for (const event of readTurnEventsSince(eventLogDir, 0).events) {
    if (event.nonce === nonce) return true;
  }
  return false;
}

function claimNonce(eventLogDir: string, nonce: string): boolean {
  mkdirSync(path.join(eventLogDir, NONCE_DIR), { recursive: true });
  if (existsSync(noncePath(eventLogDir, nonce)) || hasNonceInLog(eventLogDir, nonce)) {
    return false;
  }

  let fd: number;
  try {
    fd = openSync(noncePath(eventLogDir, nonce), "wx");
  } catch {
    return false;
  }
  closeSync(fd);
  return true;
}

export function appendTurnEvent(eventLogDir: string, event: GroveTurnEvent): boolean {
  mkdirSync(eventLogDir, { recursive: true });
  if (!claimNonce(eventLogDir, event.nonce)) return false;

  const line = `${JSON.stringify(event)}\n`;
  let fd: number | null = null;
  try {
    fd = openSync(eventLogPath(eventLogDir), "a");
    writeSync(fd, line);
    return true;
  } catch (error) {
    try {
      unlinkSync(noncePath(eventLogDir, event.nonce));
    } catch {
      /* best effort rollback */
    }
    throw error;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}
