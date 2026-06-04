import { loadContext, nodeOf } from "../context.js";
import { type FanInMode, renderFanInJson, waitForFanIn } from "../fanin.js";
import { clearPending, resolvePending, waitForCompletion } from "../ops.js";
import { color, err, info } from "../util/log.js";
import { parseDuration } from "../util/time.js";

export async function cmdWait(
  name: string,
  opts: { config?: string; timeout?: string },
): Promise<void> {
  const ctx = loadContext(opts.config);
  const nc = nodeOf(ctx, name);
  const timeoutMs = parseDuration(opts.timeout, 30 * 60_000);
  // Use the baseline recorded by `send`/`ask` so a turn that finished between
  // submit and now is still detected (instead of baselining at wait-time).
  const pending = resolvePending(ctx, nc);
  info(`waiting for ${color.bold(name)} …`);
  const res = await waitForCompletion(ctx, nc, {
    timeoutMs,
    fromOffset: pending?.fromOffset,
    transcript: pending?.transcript,
    eventLogOffset: pending?.eventLogOffset,
  });
  if (res === null) {
    err(`${name}: timed out after ${opts.timeout ?? "30m"}`);
    process.exitCode = 1;
    return;
  }
  clearPending(ctx, nc);
  process.stdout.write(res + "\n");
}

export async function cmdWaitCommand(
  names: string[],
  opts: { any?: boolean; all?: boolean; config?: string; timeout?: string },
): Promise<void> {
  const mode: FanInMode | null = opts.any ? "any" : opts.all ? "all" : null;
  if (!mode) {
    if (names.length !== 1) {
      err("wait requires exactly one node unless --any or --all is set");
      process.exitCode = 1;
      return;
    }
    await cmdWait(names[0]!, opts);
    return;
  }

  if (opts.any && opts.all) {
    err("choose only one of --any or --all");
    process.exitCode = 1;
    return;
  }
  if (names.length === 0) {
    err(`wait --${mode} requires at least one node`);
    process.exitCode = 1;
    return;
  }

  const ctx = loadContext(opts.config);
  const timeoutMs = parseDuration(opts.timeout, 30 * 60_000);
  info(`waiting --${mode} for ${names.map((name) => color.bold(name)).join(", ")} …`);
  const result = await waitForFanIn(ctx, names, { mode, timeoutMs });
  process.stdout.write(renderFanInJson(result) + "\n");
  if (mode === "all" && result.deadlineExceeded) {
    process.exitCode = 1;
  }
}
