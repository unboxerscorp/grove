import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { describe, expect, test } from "vitest";

import {
  capturePane,
  createDetachedPane,
  detachedNewWindowPaneArgs,
  detachedSplitPaneArgs,
  newWindowArgs,
  preserveActiveWindow,
  sendEnter,
  sendLiteral,
  tiledLayoutArgs,
} from "./tmux.js";

const TARGET_FORMAT = "#{session_name}:#{window_index}.#{pane_index}";
const pexec = promisify(execFile);

async function tmux(args: string[]): Promise<string> {
  const { stdout } = await pexec("tmux", args);
  return stdout.trim();
}

async function tmuxAvailable(): Promise<boolean> {
  try {
    await tmux(["-V"]);
    return true;
  } catch {
    return false;
  }
}

async function activeWindow(session: string): Promise<string> {
  return tmux(["display-message", "-p", "-t", session, "#{window_index}:#{window_name}"]);
}

describe("tmux detached pane commands", () => {
  test("builds a detached new-window command that prints the full pane target", () => {
    expect(
      detachedNewWindowPaneArgs({
        cwd: "/repo",
        session: "dev10",
        window: "maker",
      }),
    ).toEqual([
      "new-window",
      "-d",
      "-P",
      "-F",
      TARGET_FORMAT,
      "-t",
      "dev10",
      "-n",
      "maker",
      "-c",
      "/repo",
    ]);
  });

  test("builds a detached split command and a tiled layout command for an existing window", () => {
    expect(
      detachedSplitPaneArgs({
        cwd: "/repo",
        session: "dev10",
        window: "lead",
      }),
    ).toEqual(["split-window", "-d", "-P", "-F", TARGET_FORMAT, "-t", "dev10:lead", "-c", "/repo"]);
    expect(tiledLayoutArgs("dev10", "lead")).toEqual([
      "select-layout",
      "-t",
      "dev10:lead",
      "tiled",
    ]);
  });

  test("builds detached args for the shared newWindow helper", () => {
    expect(newWindowArgs("dev10", "maker", "/repo")).toEqual([
      "new-window",
      "-d",
      "-t",
      "dev10",
      "-n",
      "maker",
      "-c",
      "/repo",
    ]);
  });

  test("leaves the active window unchanged while spawning and launching into a new pane", async () => {
    if (!(await tmuxAvailable())) return;
    const session = `grove-focus-test-${process.pid}-${Date.now()}`;
    await tmux(["new-session", "-d", "-s", session, "-n", "one"]);
    try {
      await tmux(["new-window", "-d", "-t", session, "-n", "two"]);
      await tmux(["select-window", "-t", `${session}:one`]);
      const before = await activeWindow(session);

      const pane = await createDetachedPane({
        cwd: process.cwd(),
        name: "spawned",
        session,
      });
      await sendLiteral(pane, "printf focus-test");
      await sendEnter(pane);
      await capturePane(pane, 5);

      expect(await activeWindow(session)).toBe(before);
    } finally {
      await tmux(["kill-session", "-t", `=${session}`]);
    }
  });

  test("restores the active window when a spawned program switches it asynchronously", async () => {
    if (!(await tmuxAvailable())) return;
    const session = `grove-focus-restore-test-${process.pid}-${Date.now()}`;
    await tmux(["new-session", "-d", "-s", session, "-n", "one"]);
    try {
      await tmux(["new-window", "-d", "-t", session, "-n", "two"]);
      await tmux(["select-window", "-t", `${session}:one`]);
      const before = await activeWindow(session);

      await preserveActiveWindow(
        session,
        async () => {
          await tmux(["select-window", "-t", `${session}:two`]);
        },
        { intervalMs: 10 },
      );

      expect(await activeWindow(session)).toBe(before);
    } finally {
      await tmux(["kill-session", "-t", `=${session}`]);
    }
  });
});
