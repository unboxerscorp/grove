import { existsSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { validateGroveName } from "./names.js";

/** Root for grove's runtime state. Override with $GROVE_HOME. */
export const GROVE_HOME = path.resolve(process.env.GROVE_HOME ?? path.join(os.homedir(), ".grove"));
export const MASTER_REGISTRY_SESSION = ".master";

function insideGroveHome(candidate: string): boolean {
  const rel = path.relative(GROVE_HOME, candidate);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function insideRoot(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function realpathIfExists(candidate: string): string | null {
  try {
    return existsSync(candidate) ? realpathSync(candidate) : null;
  } catch {
    return null;
  }
}

function assertRealPathInsideGroveHome(candidate: string, session: string): void {
  const realRoot = realpathIfExists(GROVE_HOME);
  if (!realRoot) return;

  const realCandidate = realpathIfExists(candidate);
  if (realCandidate) {
    if (!insideRoot(realRoot, realCandidate)) {
      throw new Error(`session path escaped GROVE_HOME: ${session}`);
    }
    return;
  }

  const realParent = realpathIfExists(path.dirname(candidate));
  if (realParent && !insideRoot(realRoot, realParent)) {
    throw new Error(`session path escaped GROVE_HOME: ${session}`);
  }
}

export function sessionDir(session: string): string {
  const safeSession =
    session === MASTER_REGISTRY_SESSION
      ? MASTER_REGISTRY_SESSION
      : validateGroveName(session, "session");
  const dir = path.resolve(GROVE_HOME, safeSession);
  if (!insideGroveHome(dir)) {
    throw new Error(`session path escaped GROVE_HOME: ${session}`);
  }
  assertRealPathInsideGroveHome(dir, session);
  return dir;
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
