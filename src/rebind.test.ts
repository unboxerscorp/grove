import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import type { AgentAdapter } from "./adapters/types.js";
import type { Context, NodeCtx } from "./context.js";
import { applyTranscriptRebinds, planTranscriptRebinds } from "./rebind.js";

let tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs = [];
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "grove-rebind-test-"));
  tempDirs.push(dir);
  return dir;
}

function writeCodexTranscript(
  dir: string,
  sessionId: string,
  cwd: string,
  userText: string,
): string {
  const transcript = join(dir, `rollout-${sessionId}.jsonl`);
  writeFileSync(
    transcript,
    [
      JSON.stringify({
        type: "session_meta",
        payload: { id: sessionId, cwd },
      }),
      JSON.stringify({
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: userText }],
        },
      }),
      "",
    ].join("\n"),
  );
  return transcript;
}

function makeContext(transcripts: string[]): {
  ctx: Context;
  nc: NodeCtx;
  role: string;
} {
  const role = '너는 "docs" 노드이고, lead가 grove로 작업을 배정한다.';
  const cwd = "/repo";
  const adapter = {
    name: "codex",
    label: "codex",
    submit: "enter",
    readyPattern: /ready/,
    launchCommand: () => "codex",
    transcriptForSession: () => "",
    snapshot: () =>
      new Map(transcripts.map((transcript) => [transcript, statSync(transcript).mtimeMs])),
    detectNew: () => null,
    sessionIdFromPath: (transcript: string) =>
      transcript.match(/rollout-(session-[^.]+)\.jsonl$/)?.[1] ?? null,
    size: () => 1,
    readCompletionSince: () => ({ done: false, offset: 0 }),
    readLast: () => null,
  } satisfies AgentAdapter;

  const nc: NodeCtx = {
    node: {
      name: "docs",
      agent: "codex",
      cwd,
      role,
      children: [],
    },
    adapter,
    addr: "dev10:0.15",
  };

  const ctx: Context = {
    configPath: "/repo/grove.yaml",
    config: {
      session: "dev10",
      cwd,
      defaults: { agent: "codex" },
      nodes: { docs: { agent: "codex", role, children: [] } },
    },
    nodes: [nc.node],
    byName: new Map([["docs", nc]]),
    registry: {
      session: "dev10",
      cwd,
      updatedAt: "2026-06-03T00:00:00.000Z",
      nodes: {
        docs: {
          name: "docs",
          agent: "codex",
          sessionId: "session-old",
          transcript: "/old/transcript.jsonl",
          pending: {
            transcript: "/old/transcript.jsonl",
            fromOffset: 123,
            submittedAt: "2026-06-03T00:00:00.000Z",
          },
        },
      },
    },
  };

  return { ctx, nc, role };
}

describe("planTranscriptRebinds", () => {
  test("plans and applies a unique role-matched transcript rebind", () => {
    const dir = tempDir();
    const transcript = writeCodexTranscript(
      dir,
      "session-new",
      "/repo",
      '이 repo에서는 harness를 따른다. 너는 "docs" 노드이고, lead가 grove로 작업을 배정한다.',
    );
    const { ctx } = makeContext([transcript]);

    const plan = planTranscriptRebinds(ctx);
    expect(plan.updates).toEqual([
      expect.objectContaining({
        node: "docs",
        beforeSessionId: "session-old",
        afterSessionId: "session-new",
        beforeTranscript: "/old/transcript.jsonl",
        afterTranscript: transcript,
        pendingCleared: true,
      }),
    ]);

    applyTranscriptRebinds(ctx, plan);

    expect(ctx.registry.nodes.docs?.sessionId).toBe("session-new");
    expect(ctx.registry.nodes.docs?.transcript).toBe(transcript);
    expect(ctx.registry.nodes.docs?.pending).toBeUndefined();
  });

  test("skips a node when more than one transcript matches conservatively", () => {
    const dir = tempDir();
    const first = writeCodexTranscript(
      dir,
      "session-one",
      "/repo",
      '너는 "docs" 노드이고, lead가 grove로 작업을 배정한다.',
    );
    const second = writeCodexTranscript(
      dir,
      "session-two",
      "/repo",
      '너는 "docs" 노드이고, lead가 grove로 작업을 배정한다.',
    );
    const { ctx } = makeContext([first, second]);

    const plan = planTranscriptRebinds(ctx);

    expect(plan.updates).toEqual([]);
    expect(plan.skipped).toEqual([expect.objectContaining({ node: "docs", reason: "ambiguous" })]);
  });
});
