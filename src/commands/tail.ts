import { loadContext, nodeOf } from "../context.js";
import { resolveTranscript } from "../ops.js";
import { color, err, info } from "../util/log.js";
import { waitForChangeOrTimeout } from "../util/time.js";

/** Stream a node's completed turns as they land. Runs until interrupted. */
export async function cmdTail(name: string, opts: { config?: string }): Promise<void> {
  const ctx = loadContext(opts.config);
  const nc = nodeOf(ctx, name);
  const transcript = resolveTranscript(ctx, nc);
  if (!transcript || nc.adapter.size(transcript) === 0) {
    err(`${name}: no transcript yet — send it a message first`);
    process.exitCode = 1;
    return;
  }
  info(`tailing ${color.bold(name)} ${color.dim(transcript)} — Ctrl-C to stop`);
  let offset = nc.adapter.size(transcript);
  for (;;) {
    const comp = nc.adapter.readCompletionSince(transcript, offset);
    offset = comp.offset;
    if (comp.done && comp.text) {
      console.log(`\n${color.cyan(`◆ ${name}`)}\n${comp.text}`);
    }
    // Wake on the next transcript append, or after 1.5s as a safety net.
    await waitForChangeOrTimeout(transcript, 1500);
  }
}
