import { watch, type FSWatcher } from "node:fs";
import { dirname } from "node:path";

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Resolve on the next `fs.watch` event for `path`, or after `ms`, whichever is
 * first; the watcher is always closed. Used to wake a check loop on file append
 * instead of sleeping a fixed interval. This is only a wake-up *hint* — callers
 * must still re-check authoritative state, since fs.watch events can coalesce,
 * drop, or arrive before the watcher is installed.
 */
export function waitForChangeOrTimeout(path: string, ms: number): Promise<void> {
  return new Promise((resolve) => {
    let watcher: FSWatcher | undefined;
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        watcher?.close();
      } catch {
        /* already closed */
      }
      resolve();
    };
    try {
      watcher = watch(path, finish);
    } catch {
      try {
        watcher = watch(dirname(path), finish);
      } catch {
        /* no watcher available — rely on the timeout */
      }
    }
    watcher?.on("error", finish);
    const timer = setTimeout(finish, ms);
  });
}

/** Parse "30s" | "20m" | "1h" | "500ms" | "45" (seconds) into ms. */
export function parseDuration(s: string | undefined, defaultMs: number): number {
  if (!s) return defaultMs;
  const m = s.trim().match(/^(\d+(?:\.\d+)?)(ms|s|m|h)?$/i);
  if (!m) return defaultMs;
  const n = parseFloat(m[1]!);
  const unit = (m[2] ?? "s").toLowerCase();
  const mult = unit === "ms" ? 1 : unit === "s" ? 1000 : unit === "m" ? 60_000 : 3_600_000;
  return Math.round(n * mult);
}

/**
 * Repeatedly call `fn` until `until(value)` is true or the timeout elapses.
 * Returns the last value and whether it timed out.
 */
export async function poll<T>(
  fn: () => T | Promise<T>,
  opts: { timeoutMs: number; intervalMs: number; until: (v: T) => boolean },
): Promise<{ value: T; timedOut: boolean }> {
  const deadline = Date.now() + opts.timeoutMs;
  let value = await fn();
  while (!opts.until(value)) {
    if (Date.now() >= deadline) return { value, timedOut: true };
    await sleep(opts.intervalMs);
    value = await fn();
  }
  return { value, timedOut: false };
}
