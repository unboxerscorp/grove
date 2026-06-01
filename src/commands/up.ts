import { loadContext } from "../context.js";
import { bringUp } from "../ops.js";
import { color, info } from "../util/log.js";
import { renderStatus } from "./status.js";

export async function cmdUp(opts: { config?: string }): Promise<void> {
  const ctx = loadContext(opts.config);
  const res = await bringUp(ctx);
  info(
    `${color.green("ready")} — ${res.adopted.length} adopted, ${res.launched.length} launched` +
      (res.created ? color.dim(" (session created)") : ""),
  );
  console.log("");
  await renderStatus(ctx);
}
