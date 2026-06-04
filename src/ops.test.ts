import { appendFileSync, existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import type { AgentAdapter } from "./adapters/types.js";
import type { Context, NodeCtx } from "./context.js";
import { appendTurnEvent } from "./events.js";
import { clearPending, recordPending, waitForCompletion } from "./ops.js";
import { loadRegistry, saveRegistry } from "./registry.js";
import { sessionDir } from "./util/paths.js";

let tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs = [];
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "grove-ops-test-"));
  tempDirs.push(dir);
  return dir;
}

function makeNodeCtx(currentTranscript: string): { ctx: Context; nc: NodeCtx } {
  const adapter = {
    name: "codex",
    label: "Codex",
    submit: "enter",
    readyPattern: /ready/,
    launchCommand: () => "codex",
    transcriptForSession: () => currentTranscript,
    snapshot: () => new Map<string, number>(),
    detectNew: () => null,
    sessionIdFromPath: () => "session-current",
    size: (path: string) => (path === currentTranscript ? 10 : 0),
    readCompletionSince: (path: string, offset: number) => ({
      done: true,
      text: `read ${path}`,
      offset,
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
          transcript: currentTranscript,
          pending: {
            transcript: "/tmp/grove-test/old.jsonl",
            fromOffset: 0,
            submittedAt: "2026-06-03T00:00:00.000Z",
          },
        },
      },
    },
  };

  return { ctx, nc };
}

describe("waitForCompletion", () => {
  test("rejects a pending transcript when the resolved transcript moved", async () => {
    const { ctx, nc } = makeNodeCtx("/tmp/grove-test/current.jsonl");
    const opts = {
      timeoutMs: 10,
      fromOffset: 0,
      transcript: "/tmp/grove-test/old.jsonl",
    };

    await expect(waitForCompletion(ctx, nc, opts)).rejects.toThrow(
      "transcript stale — run fleet repair",
    );
  });

  test("returns a durable completion event that was appended before wait started", async () => {
    const { ctx, nc } = makeNodeCtx("/tmp/grove-test/current.jsonl");
    const eventLogDir = tempDir();
    appendTurnEvent(eventLogDir, {
      schema: 1,
      type: "turn.done",
      node: "worker",
      turnId: "worker:session-current:42",
      transcriptId: "session-current",
      transcriptOffset: 42,
      marker: "completion@42",
      ts: 1_781_000_000_000,
      nonce: "worker-session-current-42",
      status: "done",
      summary: "durable result",
    });

    const result = await waitForCompletion(ctx, nc, {
      timeoutMs: 10,
      fromOffset: 10,
      transcript: "/tmp/grove-test/current.jsonl",
      eventLogOffset: 0,
      eventLogDir,
    });

    expect(result).toBe("durable result");
  });

  test("wakes on transcript append without waiting for the safety interval", async () => {
    const dir = tempDir();
    const transcript = join(dir, "current.jsonl");
    writeFileSync(transcript, "");
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
      size: (file: string) => (existsSync(file) ? statSync(file).size : 0),
      readCompletionSince: (file: string, offset: number) => {
        const size = existsSync(file) ? statSync(file).size : 0;
        return size > offset
          ? { done: true, offset: size, text: "append result" }
          : { done: false, offset };
      },
      readLast: () => null,
    } satisfies AgentAdapter;
    const nc: NodeCtx = {
      adapter,
      addr: "grove:worker",
      node: {
        agent: "codex",
        children: [],
        cwd: dir,
        name: "worker",
      },
    };
    const ctx: Context = {
      byName: new Map([["worker", nc]]),
      config: {
        cwd: dir,
        defaults: { agent: "codex" },
        nodes: { worker: { agent: "codex", children: [] } },
        session: "grove-test",
      },
      configPath: join(dir, "grove.yaml"),
      nodes: [nc.node],
      registry: {
        cwd: dir,
        nodes: { worker: { agent: "codex", name: "worker", transcript } },
        session: "grove-test",
        updatedAt: "2026-06-03T00:00:00.000Z",
      },
    };
    const started = Date.now();
    setTimeout(() => {
      appendFileSync(transcript, "done\n");
    }, 10);

    const result = await waitForCompletion(ctx, nc, {
      intervalMs: 2000,
      timeoutMs: 5000,
    });

    expect(result).toBe("append result");
    expect(Date.now() - started).toBeLessThan(1000);
  });

  test("fails fast with a repair hint when a bound session transcript is missing", async () => {
    const dir = tempDir();
    const missingTranscript = join(dir, "missing.jsonl");
    const { ctx, nc } = makeNodeCtx(missingTranscript);
    nc.adapter.size = () => 0;
    ctx.registry.nodes.worker = {
      agent: "codex",
      name: "worker",
      sessionId: "session-current",
      transcript: missingTranscript,
    };

    await expect(waitForCompletion(ctx, nc, { timeoutMs: 100 })).rejects.toThrow(
      "session transcript missing",
    );
  });

  test("fails fast with a repair hint when a bound session transcript is empty", async () => {
    const dir = tempDir();
    const emptyTranscript = join(dir, "empty.jsonl");
    writeFileSync(emptyTranscript, "");
    const { ctx, nc } = makeNodeCtx(emptyTranscript);
    nc.adapter.size = () => 0;
    ctx.registry.nodes.worker = {
      agent: "codex",
      name: "worker",
      sessionId: "session-current",
      transcript: emptyTranscript,
    };

    await expect(
      waitForCompletion(ctx, nc, {
        intervalMs: 1000,
        timeoutMs: 10_000,
      }),
    ).rejects.toThrow("session transcript missing");
  });

  test("clearPending preserves live registry writes from a stale in-memory context", () => {
    const session = `opsreg-${process.pid}-${Date.now()}`;
    const { ctx, nc } = makeNodeCtx("/tmp/grove-test/current.jsonl");
    ctx.config.session = session;
    ctx.registry.session = session;
    ctx.registry.nodes.browser = {
      agent: "codex",
      name: "browser",
      role: "stale-browser-role",
    };
    ctx.registry.nodes.worker = {
      agent: "codex",
      name: "worker",
      pending: { transcript: "x", fromOffset: 0, submittedAt: "now" },
    };
    saveRegistry(ctx.registry);
    const latest = loadRegistry(session)!;
    latest.nodes.browser = {
      agent: "codex",
      name: "browser",
      role: "live-browser-role",
    };
    saveRegistry(latest);

    try {
      clearPending(ctx, nc);

      const reloaded = loadRegistry(session);
      expect(reloaded?.nodes.worker?.pending).toBeUndefined();
      expect(reloaded?.nodes.browser?.role).toBe("live-browser-role");
    } finally {
      rmSync(sessionDir(session), { force: true, recursive: true });
    }
  });

  test("recordPending preserves latest transcript and session binding over stale in-memory state", () => {
    const session = `opsbind-${process.pid}-${Date.now()}`;
    const { ctx, nc } = makeNodeCtx("/tmp/grove-test/current.jsonl");
    ctx.config.session = session;
    ctx.registry.session = session;
    ctx.registry.nodes.worker = {
      agent: "codex",
      name: "worker",
      sessionId: "stale-session",
      transcript: "/tmp/grove-test/current.jsonl",
    };
    saveRegistry(ctx.registry);
    const latest = loadRegistry(session)!;
    latest.nodes.worker = {
      agent: "codex",
      name: "worker",
      role: "live-role",
      sessionId: "live-session",
      transcript: "/tmp/grove-test/live.jsonl",
    };
    saveRegistry(latest);

    try {
      recordPending(ctx, nc, "/tmp/grove-test/current.jsonl", 100, { eventLogOffset: 9 });

      const reloaded = loadRegistry(session);
      expect(reloaded?.nodes.worker?.sessionId).toBe("live-session");
      expect(reloaded?.nodes.worker?.transcript).toBe("/tmp/grove-test/live.jsonl");
      expect(reloaded?.nodes.worker?.role).toBe("live-role");
      expect(reloaded?.nodes.worker?.pending).toEqual(
        expect.objectContaining({
          eventLogOffset: 9,
          fromOffset: 100,
          transcript: "/tmp/grove-test/current.jsonl",
        }),
      );
    } finally {
      rmSync(sessionDir(session), { force: true, recursive: true });
    }
  });

  test("recordPending preserves concurrent latest binding over detected stale binding", () => {
    const session = `opsdetected-${process.pid}-${Date.now()}`;
    const { ctx, nc } = makeNodeCtx("/tmp/grove-test/current.jsonl");
    ctx.config.session = session;
    ctx.registry.session = session;
    ctx.registry.nodes.worker = {
      agent: "codex",
      name: "worker",
      sessionId: "stale-session",
      transcript: "/tmp/grove-test/current.jsonl",
    };
    saveRegistry(ctx.registry);
    const latest = loadRegistry(session)!;
    latest.nodes.worker = {
      agent: "codex",
      name: "worker",
      role: "live-role",
      sessionId: "live-session",
      transcript: "/tmp/grove-test/live.jsonl",
    };
    saveRegistry(latest);

    try {
      recordPending(ctx, nc, "/tmp/grove-test/new.jsonl", 0, {
        binding: {
          previous: {
            sessionId: "stale-session",
            transcript: "/tmp/grove-test/current.jsonl",
          },
          sessionId: "session-new",
          transcript: "/tmp/grove-test/new.jsonl",
        },
        eventLogOffset: 10,
      });

      const reloaded = loadRegistry(session);
      expect(reloaded?.nodes.worker?.sessionId).toBe("live-session");
      expect(reloaded?.nodes.worker?.transcript).toBe("/tmp/grove-test/live.jsonl");
      expect(reloaded?.nodes.worker?.role).toBe("live-role");
      expect(reloaded?.nodes.worker?.pending).toEqual(
        expect.objectContaining({
          eventLogOffset: 10,
          fromOffset: 0,
          transcript: "/tmp/grove-test/new.jsonl",
        }),
      );
    } finally {
      rmSync(sessionDir(session), { force: true, recursive: true });
    }
  });

  test("recordPending fills incomplete latest binding with detected binding", () => {
    const session = `opsincomplete-${process.pid}-${Date.now()}`;
    const { ctx, nc } = makeNodeCtx("/tmp/grove-test/current.jsonl");
    ctx.config.session = session;
    ctx.registry.session = session;
    ctx.registry.nodes.worker = {
      agent: "codex",
      name: "worker",
      sessionId: "stale-session",
      transcript: "/tmp/grove-test/current.jsonl",
    };
    saveRegistry(ctx.registry);
    const latest = loadRegistry(session)!;
    latest.nodes.worker = {
      agent: "codex",
      name: "worker",
      role: "live-role",
      sessionId: "stale-session",
    };
    saveRegistry(latest);

    try {
      recordPending(ctx, nc, "/tmp/grove-test/new.jsonl", 0, {
        binding: {
          previous: {
            sessionId: "stale-session",
            transcript: "/tmp/grove-test/current.jsonl",
          },
          sessionId: "session-new",
          transcript: "/tmp/grove-test/new.jsonl",
        },
        eventLogOffset: 12,
      });

      const reloaded = loadRegistry(session);
      expect(reloaded?.nodes.worker?.role).toBe("live-role");
      expect(reloaded?.nodes.worker?.sessionId).toBe("session-new");
      expect(reloaded?.nodes.worker?.transcript).toBe("/tmp/grove-test/new.jsonl");
      expect(reloaded?.nodes.worker?.pending).toEqual(
        expect.objectContaining({
          eventLogOffset: 12,
          fromOffset: 0,
          transcript: "/tmp/grove-test/new.jsonl",
        }),
      );
    } finally {
      rmSync(sessionDir(session), { force: true, recursive: true });
    }
  });

  test("recordPending preserves incomplete latest binding when present fields changed", () => {
    const session = `opsincompletechanged-${process.pid}-${Date.now()}`;
    const { ctx, nc } = makeNodeCtx("/tmp/grove-test/current.jsonl");
    ctx.config.session = session;
    ctx.registry.session = session;
    ctx.registry.nodes.worker = {
      agent: "codex",
      name: "worker",
      sessionId: "stale-session",
      transcript: "/tmp/grove-test/current.jsonl",
    };
    saveRegistry(ctx.registry);
    const latest = loadRegistry(session)!;
    latest.nodes.worker = {
      agent: "codex",
      name: "worker",
      role: "live-role",
      sessionId: "live-session",
    };
    saveRegistry(latest);

    try {
      recordPending(ctx, nc, "/tmp/grove-test/new.jsonl", 0, {
        binding: {
          previous: {
            sessionId: "stale-session",
            transcript: "/tmp/grove-test/current.jsonl",
          },
          sessionId: "session-new",
          transcript: "/tmp/grove-test/new.jsonl",
        },
        eventLogOffset: 14,
      });

      const reloaded = loadRegistry(session);
      expect(reloaded?.nodes.worker?.role).toBe("live-role");
      expect(reloaded?.nodes.worker?.sessionId).toBe("live-session");
      expect(reloaded?.nodes.worker?.transcript).toBeUndefined();
      expect(reloaded?.nodes.worker?.pending).toEqual(
        expect.objectContaining({
          eventLogOffset: 14,
          fromOffset: 0,
          transcript: "/tmp/grove-test/new.jsonl",
        }),
      );
    } finally {
      rmSync(sessionDir(session), { force: true, recursive: true });
    }
  });

  test("recordPending does not resurrect non-target nodes deleted from latest registry", () => {
    const session = `opsdelete-${process.pid}-${Date.now()}`;
    const { ctx, nc } = makeNodeCtx("/tmp/grove-test/current.jsonl");
    ctx.config.session = session;
    ctx.registry.session = session;
    ctx.registry.nodes.deleted = {
      agent: "codex",
      name: "deleted",
      role: "stale-node",
    };
    ctx.registry.nodes.worker = {
      agent: "codex",
      name: "worker",
      role: "stale-worker",
    };
    saveRegistry(ctx.registry);
    const latest = loadRegistry(session)!;
    delete latest.nodes.deleted;
    latest.nodes.worker = {
      agent: "codex",
      name: "worker",
      role: "live-worker",
    };
    saveRegistry(latest);

    try {
      recordPending(ctx, nc, "/tmp/grove-test/current.jsonl", 100, { eventLogOffset: 11 });

      const reloaded = loadRegistry(session);
      expect(reloaded?.nodes.deleted).toBeUndefined();
      expect(reloaded?.nodes.worker?.role).toBe("live-worker");
      expect(reloaded?.nodes.worker?.pending).toEqual(
        expect.objectContaining({
          eventLogOffset: 11,
          fromOffset: 100,
          transcript: "/tmp/grove-test/current.jsonl",
        }),
      );
      expect(ctx.registry.nodes.deleted).toBeDefined();
    } finally {
      rmSync(sessionDir(session), { force: true, recursive: true });
    }
  });

  test("recordPending does not resurrect a deleted registry-only target node", () => {
    const session = `opstargetdelete-${process.pid}-${Date.now()}`;
    const { ctx, nc } = makeNodeCtx("/tmp/grove-test/current.jsonl");
    ctx.config.session = session;
    ctx.config.nodes = {};
    ctx.nodes = [];
    ctx.registry.session = session;
    saveRegistry(ctx.registry);
    const latest = loadRegistry(session)!;
    delete latest.nodes.worker;
    saveRegistry(latest);

    try {
      recordPending(ctx, nc, "/tmp/grove-test/current.jsonl", 100, { eventLogOffset: 13 });

      expect(loadRegistry(session)?.nodes.worker).toBeUndefined();
      expect(ctx.registry.nodes.worker).toBeUndefined();
    } finally {
      rmSync(sessionDir(session), { force: true, recursive: true });
    }
  });

  test("clearPending does not resurrect a deleted registry-only target node", () => {
    const session = `opscleartargetdelete-${process.pid}-${Date.now()}`;
    const { ctx, nc } = makeNodeCtx("/tmp/grove-test/current.jsonl");
    ctx.config.session = session;
    ctx.config.nodes = {};
    ctx.nodes = [];
    ctx.registry.session = session;
    saveRegistry(ctx.registry);
    const latest = loadRegistry(session)!;
    delete latest.nodes.worker;
    saveRegistry(latest);

    try {
      clearPending(ctx, nc);

      expect(loadRegistry(session)?.nodes.worker).toBeUndefined();
      expect(ctx.registry.nodes.worker).toBeUndefined();
    } finally {
      rmSync(sessionDir(session), { force: true, recursive: true });
    }
  });
});
