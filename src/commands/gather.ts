import { loadContext } from "../context.js";
import {
  type FanInPendingResult,
  type FanInResult,
  type FanInTerminalResult,
  renderGatherJson,
  renderGatherText,
  waitForFanIn,
} from "../fanin.js";
import { type GatherTargetGroup, resolveGatherTargets } from "../project-address.js";
import { color, err, info } from "../util/log.js";
import { parseDuration } from "../util/time.js";

export async function cmdGather(
  names: string[],
  opts: { config?: string; project?: string; timeout?: string; json?: boolean },
): Promise<void> {
  if (names.length === 0) {
    err("gather requires at least one node");
    process.exitCode = 1;
    return;
  }

  const callerCtx = loadContext(opts.config);
  const targets =
    opts.project || names.some((name) => name.includes(":"))
      ? resolveGatherTargets(callerCtx, names, opts)
      : [
          {
            callerCtx,
            crossProject: false,
            labels: names,
            nodes: names,
            project: callerCtx.config.session,
            targetCtx: callerCtx,
          },
        ];
  const labels = targets.flatMap((target) => target.labels);
  const timeoutMs = parseDuration(opts.timeout, 30 * 60_000);
  info(`gathering ${labels.map((name) => color.bold(name)).join(", ")} …`);
  const results = await Promise.all(
    targets.map((target) =>
      waitForFanIn(target.targetCtx, target.nodes, {
        mode: "all",
        timeoutMs,
      }),
    ),
  );
  const result = mergeGatherResults(targets, results);
  process.stdout.write(opts.json ? `${renderGatherJson(result)}\n` : renderGatherText(result));
  if (result.deadlineExceeded) {
    process.exitCode = 1;
  }
}

function mergeGatherResults(targets: GatherTargetGroup[], results: FanInResult[]): FanInResult {
  if (results.length === 1) {
    return relabelGatherResult(results[0]!, targets[0]!);
  }
  const relabeled = results.map((result, index) => relabelGatherResult(result, targets[index]!));
  const order = relabeled
    .flatMap((result) => result.order)
    .sort((left, right) => left.ts - right.ts);
  const summaries: Record<string, string> = {};
  for (const result of relabeled) {
    Object.assign(summaries, result.summaries);
  }
  return {
    completed: relabeled.flatMap((result) => result.completed),
    deadlineExceeded: relabeled.some((result) => result.deadlineExceeded),
    failed: relabeled.flatMap((result) => result.failed),
    mode: "all",
    nextEventLogOffset: Math.max(...relabeled.map((result) => result.nextEventLogOffset)),
    order,
    pending: relabeled.flatMap((result) => result.pending),
    summaries,
  };
}

function relabelGatherResult(result: FanInResult, target: GatherTargetGroup): FanInResult {
  const labels = new Map(target.nodes.map((node, index) => [node, target.labels[index] ?? node]));
  return {
    ...result,
    completed: result.completed.map((item) => relabelTerminalResult(item, labels)),
    failed: result.failed.map((item) => relabelTerminalResult(item, labels)),
    order: result.order.map((item) => relabelTerminalResult(item, labels)),
    pending: result.pending.map((item) => relabelPendingResult(item, labels)),
    summaries: Object.fromEntries(
      Object.entries(result.summaries).map(([node, summary]) => [
        labels.get(node) ?? node,
        summary,
      ]),
    ),
  };
}

function relabelTerminalResult(
  item: FanInTerminalResult,
  labels: ReadonlyMap<string, string>,
): FanInTerminalResult {
  return { ...item, node: labels.get(item.node) ?? item.node };
}

function relabelPendingResult(
  item: FanInPendingResult,
  labels: ReadonlyMap<string, string>,
): FanInPendingResult {
  return { ...item, node: labels.get(item.node) ?? item.node };
}
