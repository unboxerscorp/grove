import { loadContext } from "../context.js";
import { renderGatherJson, renderGatherText, waitForFanIn } from "../fanin.js";
import { color, err, info } from "../util/log.js";
import { parseDuration } from "../util/time.js";

export async function cmdGather(
  names: string[],
  opts: { config?: string; timeout?: string; json?: boolean },
): Promise<void> {
  if (names.length === 0) {
    err("gather requires at least one node");
    process.exitCode = 1;
    return;
  }

  const ctx = loadContext(opts.config);
  const timeoutMs = parseDuration(opts.timeout, 30 * 60_000);
  info(`gathering ${names.map((name) => color.bold(name)).join(", ")} …`);
  const result = await waitForFanIn(ctx, names, {
    mode: "all",
    timeoutMs,
  });
  process.stdout.write(opts.json ? `${renderGatherJson(result)}\n` : renderGatherText(result));
  if (result.deadlineExceeded) {
    process.exitCode = 1;
  }
}
