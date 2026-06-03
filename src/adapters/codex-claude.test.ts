import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, test } from "vitest";

import { claudeAdapter } from "./claude.js";
import { codexAdapter } from "./codex.js";

describe("codex adapter pure behavior", () => {
  test("quotes resume and model launch arguments", () => {
    expect(codexAdapter.launchCommand({ cwd: "/repo", resumeId: "abc$(x)" })).toBe(
      "codex resume 'abc$(x)'",
    );
    expect(codexAdapter.launchCommand({ cwd: "/repo", model: "gpt;rm" })).toBe("codex -m 'gpt;rm'");
  });

  test("extracts completion text from task_complete JSONL", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "grove-codex-adapter-"));
    try {
      const transcript = path.join(root, "session-123e4567-e89b-12d3-a456-426614174000.jsonl");
      writeFileSync(
        transcript,
        [
          JSON.stringify({ payload: { type: "message", text: "working" } }),
          JSON.stringify({
            payload: { last_agent_message: "done", type: "task_complete" },
          }),
        ].join("\n") + "\n",
      );

      expect(codexAdapter.sessionIdFromPath(transcript)).toBe(
        "123e4567-e89b-12d3-a456-426614174000",
      );
      expect(codexAdapter.readCompletionSince(transcript, 0)).toEqual({
        done: true,
        offset: codexAdapter.size(transcript),
        text: "done",
      });
      expect(codexAdapter.readLast(transcript)).toBe("done");
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });
});

describe("claude adapter pure behavior", () => {
  test("quotes resume and model launch arguments", () => {
    expect(claudeAdapter.launchCommand({ cwd: "/repo", resumeId: "abc$(x)" })).toBe(
      "claude --resume 'abc$(x)'",
    );
    expect(claudeAdapter.launchCommand({ cwd: "/repo", model: "sonnet;rm" })).toBe(
      "claude --model 'sonnet;rm'",
    );
  });

  test("extracts end_turn assistant text from JSONL", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "grove-claude-adapter-"));
    try {
      const transcript = path.join(root, "claude-session.jsonl");
      writeFileSync(
        transcript,
        [
          JSON.stringify({ type: "user", message: { content: "go" } }),
          JSON.stringify({
            message: {
              content: [
                { text: "first", type: "text" },
                { text: "second", type: "text" },
              ],
              stop_reason: "end_turn",
            },
            type: "assistant",
          }),
        ].join("\n") + "\n",
      );

      expect(claudeAdapter.sessionIdFromPath(transcript)).toBe("claude-session");
      expect(claudeAdapter.readCompletionSince(transcript, 0)).toEqual({
        done: true,
        offset: claudeAdapter.size(transcript),
        text: "first\nsecond",
      });
      expect(claudeAdapter.readLast(transcript)).toBe("first\nsecond");
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });
});
