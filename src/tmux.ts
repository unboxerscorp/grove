import { execFile } from "node:child_process";
import { promisify } from "node:util";

const pexec = promisify(execFile);
const PANE_ID_FORMAT = "#{pane_id}";
const PANE_INDEX_TARGET_FORMAT = "#{session_name}:#{window_index}.#{pane_index}";
const WINDOW_PANE_INDEX_FORMAT = "#{window_index}.#{pane_index}";

export interface TmuxError extends Error {
  stderr?: string;
}

async function tmux(args: string[]): Promise<string> {
  const { stdout } = await pexec("tmux", args, {
    maxBuffer: 1024 * 1024 * 32,
  });
  return stdout;
}

async function tmuxOk(args: string[]): Promise<boolean> {
  try {
    await tmux(args);
    return true;
  } catch {
    return false;
  }
}

/** A tmux address: "session:window". */
export function target(session: string, window: string): string {
  return `${session}:${window}`;
}

export interface DetachedPaneRequest {
  session: string;
  window: string;
  cwd?: string;
}

export interface CreateDetachedPaneRequest {
  session: string;
  name: string;
  cwd?: string;
  window?: string;
}

export function detachedNewWindowPaneArgs(req: DetachedPaneRequest): string[] {
  const args = [
    "new-window",
    "-d",
    "-P",
    "-F",
    PANE_ID_FORMAT,
    "-t",
    req.session,
    "-n",
    req.window,
  ];
  if (req.cwd) args.push("-c", req.cwd);
  return args;
}

export function detachedSplitPaneArgs(req: DetachedPaneRequest): string[] {
  const args = [
    "split-window",
    "-d",
    "-P",
    "-F",
    PANE_ID_FORMAT,
    "-t",
    target(req.session, req.window),
  ];
  if (req.cwd) args.push("-c", req.cwd);
  return args;
}

export function tiledLayoutArgs(session: string, window: string): string[] {
  return ["select-layout", "-t", target(session, window), "tiled"];
}

export function newWindowArgs(session: string, window: string, cwd?: string): string[] {
  const args = ["new-window", "-d", "-t", session, "-n", window];
  if (cwd) args.push("-c", cwd);
  return args;
}

export async function activeWindowTarget(session: string): Promise<string> {
  return (
    await tmux(["display-message", "-p", "-t", session, "#{session_name}:#{window_index}"])
  ).trim();
}

export interface PreserveActiveWindowOptions {
  intervalMs?: number;
}

export async function preserveActiveWindow<T>(
  session: string,
  fn: () => Promise<T>,
  opts: PreserveActiveWindowOptions = {},
): Promise<T> {
  const original = await activeWindowTarget(session);
  let restoring = false;
  const restore = async (): Promise<void> => {
    if (restoring) return;
    restoring = true;
    try {
      const current = await activeWindowTarget(session);
      if (current !== original) {
        await tmuxOk(["select-window", "-t", original]);
      }
    } catch {
      /* session disappeared while preserving focus */
    } finally {
      restoring = false;
    }
  };
  const timer = setInterval(() => {
    void restore();
  }, opts.intervalMs ?? 50);
  try {
    return await fn();
  } finally {
    clearInterval(timer);
    await restore();
  }
}

export async function isAvailable(): Promise<boolean> {
  return tmuxOk(["-V"]);
}

export async function hasSession(name: string): Promise<boolean> {
  return tmuxOk(["has-session", "-t", `=${name}`]);
}

export async function newSession(
  name: string,
  opts: { cwd?: string; windowName?: string; width?: number; height?: number } = {},
): Promise<void> {
  const args = ["new-session", "-d", "-s", name];
  if (opts.windowName) args.push("-n", opts.windowName);
  if (opts.cwd) args.push("-c", opts.cwd);
  args.push("-x", String(opts.width ?? 220), "-y", String(opts.height ?? 50));
  await tmux(args);
}

export async function paneTarget(addr: string): Promise<string> {
  return (await tmux(["display-message", "-t", addr, "-p", PANE_INDEX_TARGET_FORMAT])).trim();
}

export async function paneExists(addr: string): Promise<boolean> {
  try {
    const panes = await tmux(["list-panes", "-a", "-F", PANE_INDEX_TARGET_FORMAT]);
    return paneListIncludesTarget(panes, addr);
  } catch {
    return false;
  }
}

export function paneListIncludesTarget(panes: string, addr: string): boolean {
  const exact = addr.trim();
  return panes
    .split("\n")
    .map((line) => line.trim())
    .includes(exact);
}

async function paneIndexTarget(session: string, paneId: string): Promise<string> {
  const windowPane = (
    await tmux(["display-message", "-t", paneId, "-p", WINDOW_PANE_INDEX_FORMAT])
  ).trim();
  return `${session}:${windowPane}`;
}

export async function createDetachedPane(req: CreateDetachedPaneRequest): Promise<string> {
  const window = req.window ?? req.name;
  if (!(await hasSession(req.session))) {
    await newSession(req.session, { cwd: req.cwd, windowName: window });
    if (!req.window) return paneTarget(target(req.session, window));
  } else if (req.window && !(await hasWindow(req.session, req.window))) {
    await tmux(detachedNewWindowPaneArgs({ cwd: req.cwd, session: req.session, window }));
  }

  if (req.window) {
    const paneId = (
      await tmux(detachedSplitPaneArgs({ cwd: req.cwd, session: req.session, window }))
    ).trim();
    await tmux(tiledLayoutArgs(req.session, window));
    return paneIndexTarget(req.session, paneId);
  }

  const paneId = (
    await tmux(detachedNewWindowPaneArgs({ cwd: req.cwd, session: req.session, window }))
  ).trim();
  return paneIndexTarget(req.session, paneId);
}

export async function listWindows(session: string): Promise<string[]> {
  if (!(await hasSession(session))) return [];
  const out = await tmux(["list-windows", "-t", session, "-F", "#{window_name}"]);
  return out
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
}

export async function hasWindow(session: string, window: string): Promise<boolean> {
  const windows = await listWindows(session);
  return windows.includes(window);
}

export async function newWindow(session: string, window: string, cwd?: string): Promise<void> {
  await tmux(newWindowArgs(session, window, cwd));
}

/** Send text to a pane interpreting key names (no submit). */
export async function sendText(addr: string, text: string): Promise<void> {
  await tmux(["send-keys", "-t", addr, "--", text]);
}

/** Send a literal UTF-8 string (no key-name lookup) — used for bracketed paste. */
export async function sendLiteral(addr: string, text: string): Promise<void> {
  await tmux(["send-keys", "-t", addr, "-l", "--", text]);
}

/** Press Enter in a pane. */
export async function sendEnter(addr: string): Promise<void> {
  await tmux(["send-keys", "-t", addr, "Enter"]);
}

export async function capturePane(
  addr: string,
  lines = 200,
  opts: { preserveEscapes?: boolean } = {},
): Promise<string> {
  try {
    return await tmux([
      "capture-pane",
      ...(opts.preserveEscapes ? ["-e"] : []),
      "-t",
      addr,
      "-p",
      "-S",
      `-${lines}`,
    ]);
  } catch {
    return "";
  }
}

export async function paneCommand(addr: string): Promise<string> {
  try {
    return (await tmux(["display-message", "-t", addr, "-p", "#{pane_current_command}"])).trim();
  } catch {
    return "";
  }
}

export async function paneCurrentPath(addr: string): Promise<string> {
  try {
    return (await tmux(["display-message", "-t", addr, "-p", "#{pane_current_path}"])).trim();
  } catch {
    return "";
  }
}

export async function killSession(name: string): Promise<void> {
  await tmuxOk(["kill-session", "-t", `=${name}`]);
}

export async function killWindow(session: string, window: string): Promise<void> {
  await tmuxOk(["kill-window", "-t", target(session, window)]);
}

export function isSinglePaneTarget(addr: string): boolean {
  const target = addr.trim();
  if (!target) return false;
  if (/^%\d+$/.test(target)) return true;
  return /^[A-Za-z0-9][A-Za-z0-9_-]*:[A-Za-z0-9_.-]+\.(?:%\d+|\d+)$/.test(target);
}

export async function killPane(addr: string): Promise<boolean> {
  if (!isSinglePaneTarget(addr)) return false;
  return tmuxOk(["kill-pane", "-t", addr]);
}
