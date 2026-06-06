import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
}));

import {
  capturePane,
  createDetachedPane,
  currentPaneTargetArgs,
  detachedNewWindowPaneArgs,
  detachedSplitPaneArgs,
  isSinglePaneTarget,
  killPane,
  newWindowArgs,
  paneListIncludesTarget,
  preserveActiveWindow,
  sendEnter,
  sendLiteral,
  tiledLayoutArgs,
} from "./tmux.js";

const PANE_ID_FORMAT = "#{pane_id}";
const PANE_INDEX_TARGET_FORMAT = "#{session_name}:#{window_index}.#{pane_index}";
const WINDOW_PANE_INDEX_FORMAT = "#{window_index}.#{pane_index}";
const pexec = promisify(execFile);

type ExecFileCallback = (
  error: NodeJS.ErrnoException | null,
  stdout: string,
  stderr: string,
) => void;

interface FakePane {
  id: number;
}

interface FakeWindow {
  index: number;
  name: string;
  panes: FakePane[];
}

interface FakeSession {
  activeWindow: number;
  name: string;
  windows: FakeWindow[];
}

let nextPaneId = 1;
let sessions = new Map<string, FakeSession>();

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

function callbackFrom(optionsOrCallback: unknown, callback: unknown): ExecFileCallback {
  if (typeof optionsOrCallback === "function") return optionsOrCallback as ExecFileCallback;
  if (typeof callback === "function") return callback as ExecFileCallback;
  throw new Error("fake execFile requires a callback");
}

function fail(message: string): NodeJS.ErrnoException {
  return Object.assign(new Error(message), { code: "1" });
}

function argAfter(args: string[], flag: string): string | null {
  const index = args.indexOf(flag);
  return index >= 0 ? (args[index + 1] ?? null) : null;
}

function cleanSessionTarget(target: string): string {
  return target.startsWith("=") ? target.slice(1) : target;
}

function sessionByName(name: string): FakeSession {
  const session = sessions.get(cleanSessionTarget(name));
  if (!session) throw fail(`no such session: ${name}`);
  return session;
}

function addWindow(session: FakeSession, name: string): FakeWindow {
  const window = {
    index: session.windows.length,
    name,
    panes: [{ id: nextPaneId++ }],
  };
  session.windows.push(window);
  return window;
}

function resolveWindow(session: FakeSession, spec?: string): FakeWindow {
  if (!spec) return session.windows[session.activeWindow]!;
  const normalized = spec.replace(/\..*$/, "");
  const byIndex = Number.parseInt(normalized, 10);
  const window = Number.isNaN(byIndex)
    ? session.windows.find((candidate) => candidate.name === normalized)
    : session.windows.find((candidate) => candidate.index === byIndex);
  if (!window) throw fail(`no such window: ${session.name}:${spec}`);
  return window;
}

function findPaneById(paneId: string): {
  session: FakeSession;
  window: FakeWindow;
  pane: FakePane;
} {
  const id = Number.parseInt(paneId.replace(/^%/, ""), 10);
  for (const session of sessions.values()) {
    for (const window of session.windows) {
      const pane = window.panes.find((candidate) => candidate.id === id);
      if (pane) return { pane, session, window };
    }
  }
  throw fail(`no such pane: ${paneId}`);
}

function resolveTarget(targetValue: string): {
  session: FakeSession;
  window: FakeWindow;
  pane: FakePane;
} {
  const cleaned = cleanSessionTarget(targetValue);
  if (cleaned.startsWith("%")) return findPaneById(cleaned);
  const [sessionName, windowSpec] = cleaned.split(":", 2);
  const session = sessionByName(sessionName ?? "");
  const window = resolveWindow(session, windowSpec);
  const paneSpec = windowSpec?.split(".", 2)[1];
  if (paneSpec?.startsWith("%")) return { ...findPaneById(paneSpec), session, window };
  const paneIndex = paneSpec === undefined ? 0 : Number.parseInt(paneSpec, 10);
  const pane = window.panes[paneIndex];
  if (!pane) throw fail(`no such pane: ${targetValue}`);
  return { pane, session, window };
}

function paneIndex(window: FakeWindow, pane: FakePane): number {
  const index = window.panes.indexOf(pane);
  if (index < 0) throw fail(`pane not in window: ${pane.id}`);
  return index;
}

function formatTmux(
  format: string | undefined,
  session: FakeSession,
  window: FakeWindow,
  pane: FakePane,
): string {
  if (format === PANE_ID_FORMAT) return `%${pane.id}\n`;
  if (format === PANE_INDEX_TARGET_FORMAT) {
    return `${session.name}:${window.index}.${paneIndex(window, pane)}\n`;
  }
  if (format === WINDOW_PANE_INDEX_FORMAT) return `${window.index}.${paneIndex(window, pane)}\n`;
  throw fail(`unsupported format: ${format ?? ""}`);
}

function listWindowNames(session: FakeSession): string {
  return `${session.windows.map((window) => window.name).join("\n")}\n`;
}

function runFakeTmux(args: string[]): string {
  const command = args[0];
  if (command === "-V") return "tmux 3.5\n";

  if (command === "has-session") {
    const sessionName = cleanSessionTarget(argAfter(args, "-t") ?? "");
    if (!sessions.has(sessionName)) throw fail(`no such session: ${sessionName}`);
    return "";
  }

  if (command === "new-session") {
    const name = argAfter(args, "-s") ?? "";
    const windowName = argAfter(args, "-n") ?? "0";
    if (!name) throw fail("session name is required");
    const session: FakeSession = { activeWindow: 0, name, windows: [] };
    addWindow(session, windowName);
    sessions.set(name, session);
    return "";
  }

  if (command === "new-window") {
    const session = sessionByName(argAfter(args, "-t") ?? "");
    const window = addWindow(session, argAfter(args, "-n") ?? String(session.windows.length));
    if (!args.includes("-d")) session.activeWindow = window.index;
    return args.includes("-P")
      ? formatTmux(argAfter(args, "-F") ?? "", session, window, window.panes[0]!)
      : "";
  }

  if (command === "split-window") {
    const { session, window } = resolveTarget(argAfter(args, "-t") ?? "");
    const pane = { id: nextPaneId++ };
    window.panes.push(pane);
    if (!args.includes("-d")) session.activeWindow = window.index;
    return args.includes("-P") ? formatTmux(argAfter(args, "-F") ?? "", session, window, pane) : "";
  }

  if (command === "select-window") {
    const { session, window } = resolveTarget(argAfter(args, "-t") ?? "");
    session.activeWindow = window.index;
    return "";
  }

  if (command === "select-layout" || command === "send-keys" || command === "capture-pane") {
    return "";
  }

  if (command === "display-message") {
    const targetValue = argAfter(args, "-t") ?? "";
    const { pane, session, window } = resolveTarget(targetValue);
    const format = args[args.length - 1];
    if (format === "#{window_index}:#{window_name}") return `${window.index}:${window.name}\n`;
    if (format === "#{session_name}:#{window_index}") return `${session.name}:${window.index}\n`;
    return formatTmux(format, session, window, pane);
  }

  if (command === "list-windows") {
    return listWindowNames(sessionByName(argAfter(args, "-t") ?? ""));
  }

  if (command === "list-panes") {
    const format = argAfter(args, "-F");
    if (!args.includes("-a") || format !== PANE_INDEX_TARGET_FORMAT) {
      throw fail("unsupported list-panes invocation");
    }
    const lines: string[] = [];
    for (const session of sessions.values()) {
      for (const window of session.windows) {
        for (const pane of window.panes) {
          lines.push(formatTmux(format, session, window, pane).trim());
        }
      }
    }
    return `${lines.join("\n")}\n`;
  }

  if (command === "kill-session") {
    sessions.delete(cleanSessionTarget(argAfter(args, "-t") ?? ""));
    return "";
  }

  if (command === "kill-pane") {
    return "";
  }

  throw fail(`unsupported tmux command: ${command ?? ""}`);
}

function fakeExecFile(
  command: string,
  argsOrOptions?: unknown,
  optionsOrCallback?: unknown,
  callback?: unknown,
): ReturnType<typeof execFile> {
  const cb = callbackFrom(optionsOrCallback, callback);
  const args = Array.isArray(argsOrOptions) ? argsOrOptions.map(String) : [];
  queueMicrotask(() => {
    try {
      cb(null, command === "tmux" ? runFakeTmux(args) : "", "");
    } catch (error) {
      cb(error instanceof Error ? error : fail(String(error)), "", "");
    }
  });
  return {} as ReturnType<typeof execFile>;
}

beforeEach(() => {
  nextPaneId = 1;
  sessions = new Map<string, FakeSession>();
  vi.mocked(execFile).mockImplementation(fakeExecFile);
});

describe("tmux detached pane commands", () => {
  test("validates single-pane targets before kill-pane", async () => {
    expect(isSinglePaneTarget("%5")).toBe(true);
    expect(isSinglePaneTarget("dev10:1.0")).toBe(true);
    expect(isSinglePaneTarget("dev10:1.%5")).toBe(true);
    expect(isSinglePaneTarget("dev10")).toBe(false);
    expect(isSinglePaneTarget("dev10:1")).toBe(false);
    expect(isSinglePaneTarget("")).toBe(false);

    expect(await killPane("dev10")).toBe(false);
    expect(await killPane("dev10:1")).toBe(false);
    expect(await killPane("")).toBe(false);
  });

  test("builds a detached new-window command that prints the pane id for normalization", () => {
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
      PANE_ID_FORMAT,
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
    ).toEqual([
      "split-window",
      "-d",
      "-P",
      "-F",
      PANE_ID_FORMAT,
      "-t",
      "dev10:lead",
      "-c",
      "/repo",
    ]);
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

  test("matches pane existence by exact list-panes output", () => {
    const panes = "dev10:0.0\ndev10:1.0\n";

    expect(paneListIncludesTarget(panes, "dev10:1.0")).toBe(true);
    expect(paneListIncludesTarget(panes, "dev10:2.0")).toBe(false);
    expect(paneListIncludesTarget(panes, "dev10:1")).toBe(false);
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
        { intervalMs: 50 },
      );

      expect(await activeWindow(session)).toBe(before);
    } finally {
      await tmux(["kill-session", "-t", `=${session}`]);
    }
  });

  test("returns canonical numeric pane targets for multiple splits in the same window", async () => {
    if (!(await tmuxAvailable())) return;
    const session = `grove-split-test-${process.pid}-${Date.now()}`;
    await tmux(["new-session", "-d", "-s", session, "-n", "one"]);
    try {
      const pane1 = await createDetachedPane({
        cwd: process.cwd(),
        name: "node1",
        session,
        window: "one",
      });
      const pane2 = await createDetachedPane({
        cwd: process.cwd(),
        name: "node2",
        session,
        window: "one",
      });
      expect(pane1).not.toBe(pane2);
      expect(pane1).toMatch(new RegExp(`^${session}:0\\.\\d+$`));
      expect(pane2).toMatch(new RegExp(`^${session}:0\\.\\d+$`));
    } finally {
      await tmux(["kill-session", "-t", `=${session}`]);
    }
  });
});

describe("currentPaneTargetArgs", () => {
  test("targets the process's own pane id when TMUX_PANE is set", () => {
    // display-message without -t reports the session's ACTIVE pane, not the
    // pane this process runs in, so self-resolution must target $TMUX_PANE.
    expect(currentPaneTargetArgs("%777")).toEqual([
      "display-message",
      "-t",
      "%777",
      "-p",
      PANE_INDEX_TARGET_FORMAT,
    ]);
  });

  test("falls back to the active pane only when no pane id is available", () => {
    expect(currentPaneTargetArgs(undefined)).toEqual([
      "display-message",
      "-p",
      PANE_INDEX_TARGET_FORMAT,
    ]);
  });
});
