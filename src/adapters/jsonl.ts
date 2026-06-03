import { closeSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import path from "node:path";

export function fileSize(p: string): number {
  try {
    return statSync(p).size;
  } catch {
    return 0;
  }
}

export function mtimeMs(p: string): number {
  try {
    return statSync(p).mtimeMs;
  } catch {
    return 0;
  }
}

/** Read bytes [offset, EOF) as utf8. Returns the text and the file's current size. */
export function readFrom(p: string, offset: number): { text: string; size: number } {
  const size = fileSize(p);
  if (size <= offset) return { text: "", size };
  const fd = openSync(p, "r");
  try {
    const len = size - offset;
    const buf = Buffer.allocUnsafe(len);
    const read = readSync(fd, buf, 0, len, offset);
    return { text: buf.toString("utf8", 0, read), size };
  } finally {
    closeSync(fd);
  }
}

/** Parse newline-delimited JSON, skipping blank/partial lines. */
export function* jsonLines(text: string): Generator<Record<string, unknown>> {
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      yield JSON.parse(t) as Record<string, unknown>;
    } catch {
      /* partial or non-JSON line — skip */
    }
  }
}

/** Recursively collect file paths under `dir` matching `filter`. */
export function walk(dir: string, filter: (p: string) => boolean): string[] {
  const out: string[] = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(full, filter));
    else if (filter(full)) out.push(full);
  }
  return out;
}

/** Map of path → mtimeMs for all files under `dir` matching `filter`. */
export function snapshotMtimes(dir: string, filter: (p: string) => boolean): Map<string, number> {
  const m = new Map<string, number>();
  for (const p of walk(dir, filter)) m.set(p, mtimeMs(p));
  return m;
}

/**
 * Find the transcript created since `before` (a brand-new path, newest mtime).
 * We deliberately ignore pre-existing files whose mtime merely changed — other
 * agent sessions (including the caller's own) are written constantly and would
 * otherwise be mistaken for the freshly-launched node's transcript.
 */
export function newestChanged(
  current: Map<string, number>,
  before: Map<string, number>,
): string | null {
  let best: string | null = null;
  let bestMtime = -1;
  for (const [p, mt] of current) {
    if (before.has(p)) continue; // only brand-new paths
    if (mt > bestMtime) {
      best = p;
      bestMtime = mt;
    }
  }
  return best;
}
