import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { GroveConfigSchema, resolveNodes } from "../config.js";
import { cwdSlug } from "../util/paths.js";
import { antigravityAdapter } from "./antigravity.js";

let tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs = [];
});

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "grove-agy-test-"));
  tempDirs.push(dir);
  return dir;
}

describe("antigravity adapter", () => {
  test("uses the same double-enter bracketed-paste submit mode as codex and claude", () => {
    expect(antigravityAdapter.submit).toBe("enter-enter");
  });

  test("builds an interactive launch command with initial prompt and log file", () => {
    const command = antigravityAdapter.launchCommand({
      cwd: "/tmp/grove project",
      initialPrompt: "You are the agy maker. Ship it.",
    });

    expect(command).toContain("agy -i 'You are the agy maker. Ship it.'");
    expect(command).toContain("--dangerously-skip-permissions");
    expect(command).toContain("--log-file ");
  });

  test("builds a resume command from the conversation id", () => {
    const command = antigravityAdapter.launchCommand({
      cwd: "/tmp/grove",
      resumeId: "conv_123",
    });

    expect(command).toContain("agy --conversation 'conv_123'");
    expect(command).toContain("--dangerously-skip-permissions");
    expect(command).toContain("--log-file ");
  });

  test("detects completion from structured log records", () => {
    const dir = tempDir();
    const transcript = path.join(dir, "conv_123.log");
    writeFileSync(transcript, '{"type":"message","text":"working"}\n');
    const offset = antigravityAdapter.size(transcript);
    appendFileSync(
      transcript,
      JSON.stringify({
        conversation_id: "conv_123",
        message: "finished from agy",
        type: "turn_complete",
      }) + "\n",
    );

    expect(antigravityAdapter.readCompletionSince(transcript, offset)).toEqual({
      done: true,
      offset: antigravityAdapter.size(transcript),
      text: "finished from agy",
    });
    expect(antigravityAdapter.readLast(transcript)).toBe("finished from agy");
  });

  test("falls back to idle prompt log markers when no structured completion exists", () => {
    const dir = tempDir();
    const transcript = path.join(dir, "conv_123.log");
    writeFileSync(transcript, "thinking\n");
    const offset = antigravityAdapter.size(transcript);
    appendFileSync(transcript, "status: idle\n> \n");

    const completion = antigravityAdapter.readCompletionSince(transcript, offset);

    expect(completion.done).toBe(true);
    expect(completion.text).toBe("");
  });

  test("detects new log files and extracts a conversation id when available", () => {
    const dir = tempDir();
    const before = antigravityAdapter.snapshot(dir);
    const transcript = path.join(dir, ".grove", "antigravity", cwdSlug(dir), "pending.log");
    mkdirSync(path.dirname(transcript), { recursive: true });
    writeFileSync(transcript, '{"conversation_id":"conv_999"}\n');

    expect(antigravityAdapter.detectNew(dir, before)).toEqual({
      sessionId: "conv_999",
      transcript,
    });
  });
});

describe("antigravity config parsing", () => {
  test("accepts antigravity and agy as agent names", () => {
    const config = GroveConfigSchema.parse({
      cwd: "/tmp/grove",
      defaults: { agent: "agy" },
      nodes: {
        assistant: { agent: "antigravity" },
        maker: {},
      },
      session: "dev10",
    });

    expect(config.defaults.agent).toBe("antigravity");
    expect(resolveNodes(config).map((node) => [node.name, node.agent])).toEqual([
      ["assistant", "antigravity"],
      ["maker", "antigravity"],
    ]);
  });
});
