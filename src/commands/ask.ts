import { loadContext, nodeOf } from "../context.js";
import { resolveContextMode } from "../context-pack.js";
import { ask, resolveSelfNodeName } from "../ops.js";
import { resolveProjectNodeTarget } from "../project-address.js";
import { color, err, info } from "../util/log.js";
import { parseDuration } from "../util/time.js";

export async function cmdAsk(
  name: string,
  message: string,
  opts: { config?: string; context?: string; project?: string; session?: string; timeout?: string },
): Promise<void> {
  // Live node-to-node ask defaults to the compact pack; --context / env override.
  const contextMode = resolveContextMode(opts.context, "compact");
  const callerCtx = loadContext(opts.config);
  // Identify the sending node so the pack reads "From: <self>@…"; sentinel otherwise.
  const callerNode = (await resolveSelfNodeName(callerCtx)) ?? "grove ask CLI";
  // --session is the canonical registry/session selector; --project is a kept
  // deprecated alias. node@project / legacy project:node also trigger resolution.
  const session = opts.session ?? opts.project;
  const target =
    session || name.includes("@") || name.includes(":")
      ? resolveProjectNodeTarget(callerCtx, name, { project: session })
      : null;
  const ctx = target?.targetCtx ?? callerCtx;
  const nc = target?.nc ?? nodeOf(ctx, name);
  const label = target?.label ?? name;
  const timeoutMs = parseDuration(opts.timeout, 30 * 60_000);
  info(`ask → ${color.bold(label)} …`);
  const res = target
    ? await ask(ctx, nc, message, timeoutMs, {
        callerNode,
        contextMode,
        submissionContext: target.callerCtx,
        submissionProject: target.callerCtx.config.session,
      })
    : await ask(ctx, nc, message, timeoutMs, { callerNode, contextMode });
  if (res === null) {
    err(`${label}: timed out after ${opts.timeout ?? "30m"}`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(res + "\n");
}
