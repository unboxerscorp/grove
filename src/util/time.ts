export { waitForChangeOrTimeout } from "./watch.js";

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
