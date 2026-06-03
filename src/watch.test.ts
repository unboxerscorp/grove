import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";

import type { AgentAdapter } from "./adapters/types.js";
import type { Context, NodeCtx } from "./context.js";
import { readTurnEventsSince } from "./events.js";
import { scanNodeForTurnEvent, startTurnEventWatcher } from "./watch.js";

let tempDirs: string[] = [];

afterEach(() => {
  vi.useRealTimers();
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs = [];
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "grove-watch-test-"));
  tempDirs.push(dir);
  return dir;
}

function makeNodeCtx(transcript: string): { ctx: Context; nc: NodeCtx } {
  const adapter = {
    name: "codex",
    label: "Codex",
    submit: "enter",
    readyPattern: /ready/,
    launchCommand: () => "codex",
    transcriptForSession: () => transcript,
    snapshot: () => new Map<string, number>(),
    detectNew: () => null,
    sessionIdFromPath: () => "session-current",
    size: () => 42,
    readCompletionSince: (_path: string, _offset: number) => ({
      done: true,
      text: "done from transcript",
      offset: 42,
    }),
    readLast: () => null,
  } satisfies AgentAdapter;

  const nc: NodeCtx = {
    node: {
      name: "worker",
      agent: "codex",
      cwd: "/tmp/grove-test",
      children: [],
    },
    adapter,
    addr: "grove:worker",
  };

  const ctx: Context = {
    configPath: "/tmp/grove.yaml",
    config: {
      session: "grove-test",
      cwd: "/tmp/grove-test",
      defaults: { agent: "codex" },
      nodes: {
        worker: {
          agent: "codex",
          children: [],
        },
      },
    },
    nodes: [nc.node],
    byName: new Map([["worker", nc]]),
    registry: {
      session: "grove-test",
      cwd: "/tmp/grove-test",
      updatedAt: "2026-06-03T00:00:00.000Z",
      nodes: {
        worker: {
          name: "worker",
          agent: "codex",
          sessionId: "session-current",
          transcript,
        },
      },
    },
  };

  return { ctx, nc };
}

describe("watch scan", () => {
  test("appends completion events idempotently for the same transcript marker", () => {
    const eventLogDir = tempDir();
    const { ctx, nc } = makeNodeCtx("/tmp/grove-test/current.jsonl");

    expect(
      scanNodeForTurnEvent(ctx, nc, {
        eventLogDir,
        transcript: "/tmp/grove-test/current.jsonl",
        fromOffset: 0,
      }),
    ).toEqual({ appended: true, nextOffset: 42 });
    expect(
      scanNodeForTurnEvent(ctx, nc, {
        eventLogDir,
        transcript: "/tmp/grove-test/current.jsonl",
        fromOffset: 0,
      }),
    ).toEqual({ appended: false, nextOffset: 42 });

    const events = readTurnEventsSince(eventLogDir, 0).events;
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "turn.done",
      node: "worker",
      transcriptId: "session-current",
      transcriptOffset: 42,
      summary: "done from transcript",
    });
  });

  test("poll reloads context and discovers transcripts created after daemon start", () => {
    vi.useFakeTimers();
    const eventLogDir = tempDir();
    const transcript = join(tempDir(), "current.jsonl");
    writeFileSync(transcript, "{}\n");
    const { ctx: initialCtx } = makeNodeCtx(transcript);
    initialCtx.registry.nodes.worker = {
      name: "worker",
      agent: "codex",
    };
    const { ctx: refreshedCtx } = makeNodeCtx(transcript);

    const watcher = startTurnEventWatcher(initialCtx, {
      eventLogDir,
      pollIntervalMs: 10,
      reloadContext: () => refreshedCtx,
    });

    vi.advanceTimersByTime(10);
    watcher.stop();

    expect(readTurnEventsSince(eventLogDir, 0).events).toEqual([
      expect.objectContaining({
        node: "worker",
        transcriptOffset: 42,
      }),
    ]);
  });

  test("continues with poll fallback when fs.watch setup throws", () => {
    const eventLogDir = tempDir();
    const transcript = join(tempDir(), "current.jsonl");
    writeFileSync(transcript, "{}\n");
    const { ctx } = makeNodeCtx(transcript);
    const watchFile = vi.fn(() => {
      throw new Error("watch unavailable");
    });

    const watcher = startTurnEventWatcher(ctx, {
      eventLogDir,
      watchFile,
    });
    watcher.stop();

    expect(watchFile).toHaveBeenCalled();
    expect(readTurnEventsSince(eventLogDir, 0).events).toHaveLength(1);
  });
});
