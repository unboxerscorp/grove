import { loadContext } from "../context.js";
import { color, info, warn } from "../util/log.js";
import { startTurnEventWatcher } from "../watch.js";

export async function cmdWatch(opts: { config?: string }): Promise<void> {
  const ctx = loadContext(opts.config);
  const watcher = startTurnEventWatcher(ctx, {
    reloadContext: () => loadContext(opts.config),
  });
  if (watcher.watched.length === 0) {
    warn("no transcripts resolved; run grove up or grove send first");
  } else {
    info(`watching completions for ${watcher.watched.map((name) => color.bold(name)).join(", ")}`);
  }

  await new Promise<void>((resolve) => {
    const stop = (): void => {
      watcher.stop();
      resolve();
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
}
