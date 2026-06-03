import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, test } from "vitest";
import {
  appendTurnEvent,
  eventLogPath,
  readTurnEventsSince,
  type GroveTurnEvent,
} from "./events.js";

let tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs = [];
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "grove-events-test-"));
  tempDirs.push(dir);
  return dir;
}

function turnEvent(overrides: Partial<GroveTurnEvent> = {}): GroveTurnEvent {
  return {
    schema: 1,
    type: "turn.done",
    node: "worker",
    turnId: "worker:session-1:42",
    transcriptId: "session-1",
    transcriptOffset: 42,
    marker: "completion@42",
    ts: 1_781_000_000_000,
    nonce: "nonce-1",
    status: "done",
    summary: "finished",
    ...overrides,
  };
}

describe("durable turn events", () => {
  test("appends and parses complete JSONL events while ignoring an incomplete final line", () => {
    const dir = tempDir();
    const event = turnEvent();

    appendTurnEvent(dir, event);
    appendFileSync(eventLogPath(dir), '{"schema":1,"type":"turn.done"');

    const result = readTurnEventsSince(dir, 0);

    expect(result.events).toEqual([event]);
    expect(result.nextOffset).toBeGreaterThan(0);
  });

  test("deduplicates repeated completion events by nonce", () => {
    const dir = tempDir();
    const event = turnEvent();

    expect(appendTurnEvent(dir, event)).toBe(true);
    expect(appendTurnEvent(dir, event)).toBe(false);

    expect(readTurnEventsSince(dir, 0).events).toEqual([event]);
  });
});
