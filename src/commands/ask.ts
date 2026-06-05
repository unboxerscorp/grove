import { loadContext, nodeOf } from "../context.js";
import { ask } from "../ops.js";
import { resolveProjectNodeTarget } from "../project-address.js";
import { color, err, info } from "../util/log.js";
import { parseDuration } from "../util/time.js";

export async function cmdAsk(
  name: string,
  message: string,
  opts: { config?: string; project?: string; timeout?: string },
): Promise<void> {
  const callerCtx = loadContext(opts.config);
  const target =
    opts.project || name.includes(":") ? resolveProjectNodeTarget(callerCtx, name, opts) : null;
  const ctx = target?.targetCtx ?? callerCtx;
  const nc = target?.nc ?? nodeOf(ctx, name);
  const label = target?.label ?? name;
  const timeoutMs = parseDuration(opts.timeout, 30 * 60_000);
  info(`ask → ${color.bold(label)} …`);
  const res = target
    ? await ask(ctx, nc, message, timeoutMs, {
        submissionContext: target.callerCtx,
        submissionProject: target.callerCtx.config.session,
      })
    : await ask(ctx, nc, message, timeoutMs);
  if (res === null) {
    err(`${label}: timed out after ${opts.timeout ?? "30m"}`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(res + "\n");
}
