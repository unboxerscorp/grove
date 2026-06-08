import { rmSync } from "node:fs";

import { beforeEach, describe, expect, test, vi } from "vitest";

import { loadContext, nodeOf } from "../context.js";
import type * as EventsModule from "../events.js";
import { eventLogSize } from "../events.js";
import type * as OpsModule from "../ops.js";
import {
  recordPending,
  recordProvisionalPending,
  resolveTranscript,
  submitMessage,
} from "../ops.js";
import { resolveProjectNodeTarget } from "../project-address.js";
import type * as RegistryModule from "../registry.js";
import type { Registry } from "../registry.js";
import { info, warn } from "../util/log.js";
import type * as PathsModule from "../util/paths.js";
import { cmdSend } from "./send.js";

type OpsModuleType = typeof OpsModule;
type EventsModuleType = typeof EventsModule;
type PathsModuleType = typeof PathsModule;
type RegistryModuleType = typeof RegistryModule;

vi.mock("../context.js", () => ({
  loadContext: vi.fn(),
  nodeOf: vi.fn(),
}));

vi.mock("../ops.js", () => ({
  recordPending: vi.fn(),
  recordProvisionalPending: vi.fn(),
  resolveSelfNodeName: vi.fn(async () => null),
  resolveTranscript: vi.fn(),
  submitMessage: vi.fn(),
}));

vi.mock("../project-address.js", () => ({
  resolveProjectNodeTarget: vi.fn(),
}));

vi.mock("../events.js", async (importOriginal) => {
  const actual = await importOriginal<EventsModuleType>();
  return {
    ...actual,
    eventLogSize: vi.fn(),
  };
});

vi.mock("../util/log.js", () => ({
  color: { bold: (value: string) => value },
  info: vi.fn(),
  warn: vi.fn(),
}));

describe("cmdSend", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(recordPending).mockReset();
    vi.mocked(recordProvisionalPending).mockReset();
    vi.mocked(resolveTranscript).mockReset();
    vi.mocked(submitMessage).mockReset();
    vi.mocked(eventLogSize).mockReset();
    vi.mocked(info).mockReset();
    vi.mocked(warn).mockReset();
    vi.mocked(loadContext).mockReset();
    vi.mocked(nodeOf).mockReset();
    vi.mocked(resolveProjectNodeTarget).mockReset();
    vi.mocked(eventLogSize).mockReturnValue(0);
  });

  test("sends to a target project node with the target project context", async () => {
    const callerCtx = {
      config: { session: "sample" },
      registry: { nodes: {} },
    };
    const targetCtx = {
      config: { session: "dev11" },
      registry: { nodes: {} },
    };
    const targetNc = {
      node: { agent: "codex", cwd: "/tmp/dev11", name: "worker" },
      adapter: {
        detectNew: vi.fn(() => null),
        size: vi.fn(() => 100),
        snapshot: vi.fn(() => new Map<string, number>()),
      },
    };
    vi.mocked(loadContext).mockReturnValue(callerCtx as never);
    vi.mocked(resolveProjectNodeTarget).mockReturnValue({
      callerCtx: callerCtx as never,
      crossProject: true,
      label: "dev11:worker",
      nc: targetNc as never,
      node: "worker",
      project: "dev11",
      targetCtx: targetCtx as never,
    });
    vi.mocked(resolveTranscript).mockReturnValue("/tmp/dev11/current.jsonl");
    vi.mocked(submitMessage).mockResolvedValue();

    const pending = cmdSend("worker", "hello", { project: "dev11" });
    await vi.runAllTimersAsync();
    await pending;

    expect(resolveProjectNodeTarget).toHaveBeenCalledWith(
      callerCtx,
      "worker",
      expect.objectContaining({ project: "dev11" }),
    );
    expect(recordPending).toHaveBeenCalledWith(
      targetCtx,
      targetNc,
      "/tmp/dev11/current.jsonl",
      100,
      expect.objectContaining({ eventLogOffset: 0 }),
    );
    expect(submitMessage).toHaveBeenCalledWith(targetNc, "hello", {
      callerNode: "grove send CLI",
      context: targetCtx,
      contextMode: "compact",
      project: "dev11",
    });
  });

  test("records pending when submission is not confirmed before the probe times out", async () => {
    const ctx = { config: { session: "grove-test" }, registry: { nodes: {} } };
    const nc = {
      node: { name: "worker", agent: "codex", cwd: "/tmp/grove-test" },
      adapter: {
        size: vi.fn(() => 100),
        snapshot: vi.fn(() => new Map<string, number>()),
        detectNew: vi.fn(() => null),
      },
    };
    vi.mocked(loadContext).mockReturnValue(ctx as never);
    vi.mocked(nodeOf).mockReturnValue(nc as never);
    vi.mocked(resolveTranscript).mockReturnValue("/tmp/grove-test/current.jsonl");
    vi.mocked(submitMessage).mockResolvedValue();

    const pending = cmdSend("worker", "hello", {});
    await vi.runAllTimersAsync();
    await pending;

    expect(recordPending).toHaveBeenCalledWith(
      ctx,
      nc,
      "/tmp/grove-test/current.jsonl",
      100,
      expect.objectContaining({ eventLogOffset: 0 }),
    );
    expect(recordProvisionalPending).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalledWith(expect.stringContaining("submission unconfirmed"));
    expect(warn).not.toHaveBeenCalled();
  });

  test("records pending on a detected brand-new transcript and updates registry binding", async () => {
    const ctx = {
      config: { session: "grove-test" },
      registry: {
        nodes: {
          worker: {
            name: "worker",
            agent: "codex",
            sessionId: "session-old",
            transcript: "/tmp/grove-test/old.jsonl",
          },
        },
      },
    };
    const nc = {
      node: { name: "worker", agent: "codex", cwd: "/tmp/grove-test" },
      adapter: {
        size: vi.fn(() => 0),
        snapshot: vi.fn(() => new Map<string, number>()),
        detectNew: vi.fn(() => ({
          sessionId: "session-new",
          transcript: "/tmp/grove-test/new.jsonl",
        })),
      },
    };
    vi.mocked(loadContext).mockReturnValue(ctx as never);
    vi.mocked(nodeOf).mockReturnValue(nc as never);
    vi.mocked(resolveTranscript).mockReturnValue("");
    vi.mocked(submitMessage).mockResolvedValue();

    await cmdSend("worker", "hello", {});

    expect(ctx.registry.nodes.worker?.sessionId).toBe("session-new");
    expect(ctx.registry.nodes.worker?.transcript).toBe("/tmp/grove-test/new.jsonl");
    expect(recordProvisionalPending).toHaveBeenCalledWith(
      ctx,
      nc,
      0,
      expect.objectContaining({ eventLogOffset: 0 }),
    );
    expect(recordPending).toHaveBeenCalledWith(
      ctx,
      nc,
      "/tmp/grove-test/new.jsonl",
      0,
      expect.objectContaining({ eventLogOffset: 0 }),
    );
    expect(warn).not.toHaveBeenCalled();
  });

  test("captures event log offset before submitting so fast completions are not missed", async () => {
    const calls: string[] = [];
    const ctx = { config: { session: "grove-test" }, registry: { nodes: {} } };
    const size = vi.fn().mockReturnValueOnce(100).mockReturnValue(101);
    const nc = {
      node: { name: "worker", agent: "codex", cwd: "/tmp/grove-test" },
      adapter: {
        size,
        snapshot: vi.fn(() => new Map<string, number>()),
        detectNew: vi.fn(() => null),
      },
    };
    vi.mocked(loadContext).mockReturnValue(ctx as never);
    vi.mocked(nodeOf).mockReturnValue(nc as never);
    vi.mocked(resolveTranscript).mockReturnValue("/tmp/grove-test/current.jsonl");
    vi.mocked(eventLogSize).mockImplementation(() => {
      calls.push("eventLogSize");
      return 7;
    });
    vi.mocked(submitMessage).mockImplementation(async () => {
      calls.push("submitMessage");
    });

    await cmdSend("worker", "hello", {});

    expect(calls).toEqual(["eventLogSize", "submitMessage"]);
    expect(recordPending).toHaveBeenCalledWith(
      ctx,
      nc,
      "/tmp/grove-test/current.jsonl",
      100,
      expect.objectContaining({ eventLogOffset: 7 }),
    );
  });

  test("persists a detected new transcript binding through real recordPending", async () => {
    const actualOps = await vi.importActual<OpsModuleType>("../ops.js");
    const { loadRegistry, saveRegistry } =
      await vi.importActual<RegistryModuleType>("../registry.js");
    const { sessionDir } = await vi.importActual<PathsModuleType>("../util/paths.js");
    const session = `senddetect-${process.pid}-${Date.now()}`;
    const initial: Registry = {
      cwd: "/tmp/grove-test",
      nodes: {
        worker: {
          agent: "codex",
          name: "worker",
          sessionId: "session-old",
          transcript: "/tmp/grove-test/old.jsonl",
        },
      },
      session,
      updatedAt: "before",
    };
    saveRegistry(initial);
    const staleRegistry = structuredClone(initial);
    const latest = loadRegistry(session)!;
    latest.nodes.worker = {
      agent: "codex",
      name: "worker",
      role: "live-role",
      sessionId: "session-old",
      transcript: "/tmp/grove-test/old.jsonl",
    };
    saveRegistry(latest);

    vi.mocked(recordPending).mockImplementation(actualOps.recordPending);
    vi.mocked(recordProvisionalPending).mockImplementation(actualOps.recordProvisionalPending);
    vi.mocked(loadContext).mockReturnValue({
      config: { session },
      nodes: [{ agent: "codex", children: [], cwd: "/tmp/grove-test", name: "worker" }],
      registry: staleRegistry,
    } as never);
    vi.mocked(nodeOf).mockReturnValue({
      node: { name: "worker", agent: "codex", cwd: "/tmp/grove-test" },
      adapter: {
        size: vi.fn(() => 0),
        snapshot: vi.fn(() => new Map()),
        detectNew: vi.fn(() => ({
          sessionId: "session-new",
          transcript: "/tmp/grove-test/new.jsonl",
        })),
      },
    } as never);
    vi.mocked(resolveTranscript).mockReturnValue("");
    vi.mocked(submitMessage).mockResolvedValue();

    try {
      await cmdSend("worker", "hello", {});

      const reloaded = loadRegistry(session);
      expect(reloaded?.nodes.worker?.role).toBe("live-role");
      expect(reloaded?.nodes.worker?.sessionId).toBe("session-new");
      expect(reloaded?.nodes.worker?.transcript).toBe("/tmp/grove-test/new.jsonl");
      expect(reloaded?.nodes.worker?.pending).toEqual(
        expect.objectContaining({
          eventLogOffset: 0,
          fromOffset: 0,
          transcript: "/tmp/grove-test/new.jsonl",
        }),
      );
    } finally {
      rmSync(sessionDir(session), { force: true, recursive: true });
    }
  });

  test("does not clobber live browser registry writes from a stale send snapshot", async () => {
    const actualOps = await vi.importActual<OpsModuleType>("../ops.js");
    const { loadRegistry, saveRegistry } =
      await vi.importActual<RegistryModuleType>("../registry.js");
    const { sessionDir } = await vi.importActual<PathsModuleType>("../util/paths.js");
    const session = `sendreg-${process.pid}-${Date.now()}`;
    const initial: Registry = {
      cwd: "/tmp/grove-test",
      nodes: {
        browser: {
          agent: "codex",
          name: "browser",
          role: "stale-browser-role",
        },
        worker: {
          agent: "codex",
          name: "worker",
          pending: {
            eventLogOffset: 0,
            fromOffset: 0,
            submittedAt: "before",
            transcript: "/tmp/grove-test/old.jsonl",
          },
          tmux_pane: "sample:1.0",
        },
      },
      session,
      updatedAt: "before",
    };
    saveRegistry(initial);
    const staleRegistry = structuredClone(initial);
    const latest = loadRegistry(session)!;
    latest.nodes.browser = {
      agent: "codex",
      name: "browser",
      role: "live-browser-role",
    };
    delete latest.nodes.worker?.pending;
    saveRegistry(latest);

    vi.mocked(recordPending).mockImplementation(actualOps.recordPending);
    vi.mocked(recordProvisionalPending).mockImplementation(actualOps.recordProvisionalPending);
    vi.mocked(loadContext).mockReturnValue({
      config: { session },
      nodes: [{ agent: "codex", children: [], cwd: "/tmp/grove-test", name: "worker" }],
      registry: staleRegistry,
    } as never);
    vi.mocked(nodeOf).mockReturnValue({
      node: { name: "worker", agent: "codex", cwd: "/tmp/grove-test" },
      adapter: {
        size: vi.fn().mockReturnValueOnce(100).mockReturnValue(101),
        snapshot: vi.fn(() => new Map()),
        detectNew: vi.fn(() => null),
      },
    } as never);
    vi.mocked(resolveTranscript).mockReturnValue("/tmp/grove-test/current.jsonl");
    vi.mocked(submitMessage).mockResolvedValue();

    try {
      await cmdSend("worker", "hello", {});

      const reloaded = loadRegistry(session);
      expect(reloaded?.nodes.browser?.role).toBe("live-browser-role");
      expect(reloaded?.nodes.worker?.pending).toEqual(
        expect.objectContaining({
          eventLogOffset: 0,
          fromOffset: 100,
          transcript: "/tmp/grove-test/current.jsonl",
        }),
      );
      expect(reloaded?.nodes.worker?.tmux_pane).toBe("sample:1.0");
    } finally {
      rmSync(sessionDir(session), { force: true, recursive: true });
    }
  });

  test("records pending before submit so a post-submit crash can still be waited", async () => {
    const actualEvents = await vi.importActual<EventsModuleType>("../events.js");
    const actualOps = await vi.importActual<OpsModuleType>("../ops.js");
    const { loadRegistry, saveRegistry } =
      await vi.importActual<RegistryModuleType>("../registry.js");
    const { eventsDir, sessionDir } = await vi.importActual<PathsModuleType>("../util/paths.js");
    const session = `sendcrash-${process.pid}-${Date.now()}`;
    const transcript = "/tmp/grove-test/current.jsonl";
    const eventLogDir = eventsDir(session);
    const registry: Registry = {
      cwd: "/tmp/grove-test",
      nodes: {
        worker: {
          agent: "codex",
          name: "worker",
          sessionId: "session-current",
          transcript,
        },
      },
      session,
      updatedAt: "before",
    };
    saveRegistry(registry);
    const adapter = {
      size: vi.fn(() => 100),
      snapshot: vi.fn(() => new Map<string, number>()),
      detectNew: vi.fn(() => null),
      sessionIdFromPath: vi.fn(() => "session-current"),
      readCompletionSince: vi.fn((_: string, offset: number) => ({ done: false, offset })),
    };
    const nc = {
      node: { name: "worker", agent: "codex", cwd: "/tmp/grove-test" },
      adapter,
    };
    vi.mocked(recordPending).mockImplementation(actualOps.recordPending);
    vi.mocked(recordProvisionalPending).mockImplementation(actualOps.recordProvisionalPending);
    vi.mocked(loadContext).mockReturnValue({
      config: { session },
      nodes: [{ agent: "codex", children: [], cwd: "/tmp/grove-test", name: "worker" }],
      registry: structuredClone(registry),
    } as never);
    vi.mocked(nodeOf).mockReturnValue(nc as never);
    vi.mocked(resolveTranscript).mockReturnValue(transcript);
    vi.mocked(submitMessage).mockImplementation(async () => {
      actualEvents.appendTurnEvent(eventLogDir, {
        marker: "completion@101",
        node: "worker",
        nonce: "worker-session-current-101",
        schema: 1,
        status: "done",
        summary: "durable result",
        transcriptId: "session-current",
        transcriptOffset: 101,
        ts: 1_781_000_000_000,
        turnId: "worker:session-current:101",
        type: "turn.done",
      });
      throw new Error("simulated crash");
    });

    try {
      await expect(cmdSend("worker", "hello", {})).rejects.toThrow("simulated crash");

      const reloaded = loadRegistry(session);
      expect(reloaded?.nodes.worker?.pending).toEqual(
        expect.objectContaining({
          eventLogOffset: 0,
          fromOffset: 100,
          transcript,
        }),
      );
      const result = await actualOps.waitForCompletion(
        {
          byName: new Map([["worker", nc]]),
          config: { session },
          configPath: "/tmp/grove.yaml",
          nodes: [{ agent: "codex", children: [], cwd: "/tmp/grove-test", name: "worker" }],
          registry: reloaded!,
        } as never,
        nc as never,
        {
          eventLogOffset: reloaded?.nodes.worker?.pending?.eventLogOffset,
          fromOffset: reloaded?.nodes.worker?.pending?.fromOffset,
          timeoutMs: 10,
          transcript: reloaded?.nodes.worker?.pending?.transcript,
        },
      );
      expect(result).toBe("durable result");
    } finally {
      rmSync(sessionDir(session), { force: true, recursive: true });
    }
  });
});
