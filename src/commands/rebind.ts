import { loadContext } from "../context.js";
import { applyTranscriptRebinds, planTranscriptRebinds } from "../rebind.js";
import type { NodeRuntime } from "../registry.js";
import { loadOrInit, saveRegistry } from "../registry.js";
import { paneTarget, target } from "../tmux.js";
import { color, info, warn } from "../util/log.js";

interface PaneRepairUpdate {
  node: string;
  before?: string;
  after: string;
}

interface PaneRepairSkip {
  node: string;
  detail: string;
}

function runtimeFromNode(ctx: ReturnType<typeof loadContext>, name: string): NodeRuntime {
  const nc = ctx.byName.get(name)!;
  return {
    agent: nc.node.agent,
    children: [...nc.node.children],
    description: nc.node.description,
    group: nc.node.group,
    name,
    parent: nc.node.parent,
    role: nc.node.role,
  };
}

async function planPaneRepairs(ctx: ReturnType<typeof loadContext>): Promise<{
  skipped: PaneRepairSkip[];
  updates: PaneRepairUpdate[];
}> {
  const updates: PaneRepairUpdate[] = [];
  const skipped: PaneRepairSkip[] = [];
  for (const nc of ctx.byName.values()) {
    if (!nc.node.tmux) continue;
    try {
      const after = await paneTarget(target(ctx.config.session, nc.node.tmux));
      const before = ctx.registry.nodes[nc.node.name]?.tmux_pane;
      if (before !== after) {
        updates.push({ after, before, node: nc.node.name });
      }
    } catch (error) {
      skipped.push({
        detail: error instanceof Error ? error.message : String(error),
        node: nc.node.name,
      });
    }
  }
  return { skipped, updates };
}

function applyPaneRepairs(ctx: ReturnType<typeof loadContext>, updates: PaneRepairUpdate[]): void {
  for (const update of updates) {
    const current = ctx.registry.nodes[update.node] ?? runtimeFromNode(ctx, update.node);
    ctx.registry.nodes[update.node] = {
      ...current,
      tmux_pane: update.after,
    };
  }
}

export async function cmdRebind(opts: {
  config?: string;
  dryRun?: boolean;
  session?: string;
}): Promise<void> {
  const loaded = loadContext(opts.config);
  const session = opts.session?.trim();
  const ctx = session
    ? {
        ...loaded,
        config: { ...loaded.config, session },
        registry: loadOrInit(session, loaded.config.cwd),
      }
    : loaded;
  const plan = planTranscriptRebinds(ctx);
  const panePlan = await planPaneRepairs(ctx);

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

  for (const update of panePlan.updates) {
    console.log(
      [
        update.node,
        `pane ${update.before ?? "(none)"} -> ${update.after}`,
        "tmux pane rebound",
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

  for (const skipped of panePlan.skipped) {
    warn(`${skipped.node}: pane rebind skipped ${color.dim(skipped.detail)}`);
  }

  if (opts.dryRun) {
    info(`rebind dry-run: ${plan.updates.length + panePlan.updates.length} update(s) planned`);
    return;
  }

  if (plan.updates.length === 0 && panePlan.updates.length === 0) {
    info("rebind: no registry changes");
    return;
  }

  applyTranscriptRebinds(ctx, plan);
  applyPaneRepairs(ctx, panePlan.updates);
  saveRegistry(ctx.registry);
  info(`rebind: wrote ${plan.updates.length + panePlan.updates.length} registry update(s)`);
}
