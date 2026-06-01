import { loadContext, nodeOf } from "../context.js";
import { submitMessage } from "../ops.js";
import { color, info } from "../util/log.js";

export async function cmdSend(
  name: string,
  message: string,
  opts: { config?: string },
): Promise<void> {
  const ctx = loadContext(opts.config);
  const nc = nodeOf(ctx, name);
  await submitMessage(nc, message);
  info(`sent → ${color.bold(name)}`);
}
