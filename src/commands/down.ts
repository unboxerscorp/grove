import { loadContext } from "../context.js";
import { hasSession, killSession } from "../tmux.js";
import { color, info } from "../util/log.js";

export async function cmdDown(opts: { config?: string }): Promise<void> {
  const ctx = loadContext(opts.config);
  const session = ctx.config.session;
  if (!(await hasSession(session))) {
    info(`session ${color.bold(session)} is already down`);
    return;
  }
  await killSession(session);
  info(`killed tmux session ${color.bold(session)}`);
}
