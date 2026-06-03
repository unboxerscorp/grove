import os from "node:os";
import path from "node:path";

/** Root for grove's runtime state. Override with $GROVE_HOME. */
export const GROVE_HOME = process.env.GROVE_HOME ?? path.join(os.homedir(), ".grove");

export function sessionDir(session: string): string {
  return path.join(GROVE_HOME, session);
}

export function registryPath(session: string): string {
  return path.join(sessionDir(session), "registry.json");
}

export function eventsDir(session: string): string {
  return path.join(sessionDir(session), "events");
}

/**
 * Claude Code's cwd → project-dir slug: every "/" becomes "-".
 * e.g. /Users/x/repo → -Users-x-repo
 */
export function cwdSlug(cwd: string): string {
  return cwd.replace(/\//g, "-");
}

export function expandHome(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

export function homedir(): string {
  return os.homedir();
}
