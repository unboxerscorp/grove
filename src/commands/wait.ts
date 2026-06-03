import { loadContext, nodeOf } from "../context.js";
import { clearPending, waitForCompletion } from "../ops.js";
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
  const pending = ctx.registry.nodes[nc.node.name]?.pending;
  info(`waiting for ${color.bold(name)} …`);
  const res = await waitForCompletion(ctx, nc, {
    timeoutMs,
    fromOffset: pending?.fromOffset,
    transcript: pending?.transcript,
  });
  if (res === null) {
    err(`${name}: timed out after ${opts.timeout ?? "30m"}`);
    process.exitCode = 1;
    return;
  }
  clearPending(ctx, nc);
  process.stdout.write(res + "\n");
}
