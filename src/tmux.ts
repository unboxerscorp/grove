import { execFile } from "node:child_process";
import { promisify } from "node:util";

const pexec = promisify(execFile);

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
  const args = ["new-window", "-t", session, "-n", window];
  if (cwd) args.push("-c", cwd);
  await tmux(args);
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

export async function capturePane(addr: string, lines = 200): Promise<string> {
  try {
    return await tmux(["capture-pane", "-t", addr, "-p", "-S", `-${lines}`]);
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

export async function killSession(name: string): Promise<void> {
  await tmuxOk(["kill-session", "-t", `=${name}`]);
}

export async function killWindow(session: string, window: string): Promise<void> {
  await tmuxOk(["kill-window", "-t", target(session, window)]);
}
