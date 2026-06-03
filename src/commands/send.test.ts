import { beforeEach, describe, expect, test, vi } from "vitest";

import { loadContext, nodeOf } from "../context.js";
import { eventLogSize } from "../events.js";
import { recordPending, resolveTranscript, submitMessage } from "../ops.js";
import { info, warn } from "../util/log.js";
import { cmdSend } from "./send.js";

vi.mock("../context.js", () => ({
  loadContext: vi.fn(),
  nodeOf: vi.fn(),
}));

vi.mock("../ops.js", () => ({
  recordPending: vi.fn(),
  resolveTranscript: vi.fn(),
  submitMessage: vi.fn(),
}));

vi.mock("../events.js", () => ({
  eventLogSize: vi.fn(),
}));

vi.mock("../util/log.js", () => ({
  color: { bold: (value: string) => value },
  info: vi.fn(),
  warn: vi.fn(),
}));

describe("cmdSend", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(recordPending).mockReset();
    vi.mocked(resolveTranscript).mockReset();
    vi.mocked(submitMessage).mockReset();
    vi.mocked(eventLogSize).mockReset();
    vi.mocked(info).mockReset();
    vi.mocked(warn).mockReset();
    vi.mocked(loadContext).mockReset();
    vi.mocked(nodeOf).mockReset();
    vi.mocked(eventLogSize).mockReturnValue(0);
  });

  test("records pending when submission is not confirmed before the probe times out", async () => {
    const ctx = { config: { session: "grove-test" } };
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
});
