import { loadContext, nodeOf } from "../context.js";
import { ask } from "../ops.js";
import { color, err, info } from "../util/log.js";
import { parseDuration } from "../util/time.js";

export async function cmdAsk(
  name: string,
  message: string,
  opts: { config?: string; timeout?: string },
): Promise<void> {
  const ctx = loadContext(opts.config);
  const nc = nodeOf(ctx, name);
  const timeoutMs = parseDuration(opts.timeout, 30 * 60_000);
  info(`ask → ${color.bold(name)} …`);
  const res = await ask(ctx, nc, message, timeoutMs);
  if (res === null) {
    err(`${name}: timed out after ${opts.timeout ?? "30m"}`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(res + "\n");
}
