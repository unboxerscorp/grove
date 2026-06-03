import { loadContext } from "../context.js";
import { applyTranscriptRebinds, planTranscriptRebinds } from "../rebind.js";
import { saveRegistry } from "../registry.js";
import { color, info, warn } from "../util/log.js";

export async function cmdRebind(opts: { config?: string; dryRun?: boolean }): Promise<void> {
  const ctx = loadContext(opts.config);
  const plan = planTranscriptRebinds(ctx);

  for (const update of plan.updates) {
    console.log(
      [
        update.node,
        `${update.beforeSessionId ?? "(none)"} -> ${update.afterSessionId}`,
        `${update.beforeTranscript ?? "(none)"} -> ${update.afterTranscript}`,
        update.pendingCleared ? "pending cleared" : "pending kept",
      ].join("\t"),
    );
  }

  for (const skipped of plan.skipped) {
    warn(
      `${skipped.node}: rebind skipped (${skipped.reason})${
        skipped.detail ? ` ${color.dim(skipped.detail)}` : ""
      }`,
    );
  }

  if (opts.dryRun) {
    info(`rebind dry-run: ${plan.updates.length} update(s) planned`);
    return;
  }

  if (plan.updates.length === 0) {
    info("rebind: no registry changes");
    return;
  }

  applyTranscriptRebinds(ctx, plan);
  saveRegistry(ctx.registry);
  info(`rebind: wrote ${plan.updates.length} registry update(s)`);
}
