import type { Context } from "../context.js";
import { resolveTranscript } from "../ops.js";
import { hasSession, paneCommand } from "../tmux.js";
import { loadContext } from "../context.js";
import { color } from "../util/log.js";

const SHELLS = new Set(["zsh", "-zsh", "bash", "-bash", "sh", "fish", "tmux"]);

export async function cmdStatus(opts: { config?: string }): Promise<void> {
  const ctx = loadContext(opts.config);
  await renderStatus(ctx);
}

export async function renderStatus(ctx: Context): Promise<void> {
  const session = ctx.config.session;
  const alive = await hasSession(session);
  console.log(
    `${color.bold(`🌳 ${session}`)} ${alive ? color.green("● up") : color.red("● down")} ${color.dim(ctx.configPath)}`,
  );

  const childrenOf = new Map<string, string[]>();
  const roots: string[] = [];
  for (const n of ctx.nodes) {
    if (n.parent) {
      const arr = childrenOf.get(n.parent) ?? [];
      arr.push(n.name);
      childrenOf.set(n.parent, arr);
    } else {
      roots.push(n.name);
    }
  }

  const lines: string[] = [];
  const render = async (
    name: string,
    prefix: string,
    last: boolean,
    isRoot: boolean,
  ): Promise<void> => {
    const nc = ctx.byName.get(name)!;
    const branch = isRoot ? "" : last ? "└─ " : "├─ ";
    const cmd = alive ? await paneCommand(nc.addr) : "";
    const dot =
      cmd && !SHELLS.has(cmd)
        ? color.green("●")
        : cmd
          ? color.yellow("◐")
          : color.gray("○");
    const transcript = resolveTranscript(ctx, nc);
    const last_ = transcript ? nc.adapter.readLast(transcript) ?? "" : "";
    const snippet = last_.replace(/\s+/g, " ").trim().slice(0, 60);
    lines.push(
      `${prefix}${branch}${dot} ${color.bold(name)} ${color.dim(`[${nc.adapter.label}]`)}  ${color.gray(snippet)}`,
    );
    const kids = childrenOf.get(name) ?? [];
    for (let i = 0; i < kids.length; i++) {
      const childPrefix = prefix + (isRoot ? "" : last ? "   " : "│  ");
      await render(kids[i]!, childPrefix, i === kids.length - 1, false);
    }
  };

  for (let i = 0; i < roots.length; i++) {
    await render(roots[i]!, "", i === roots.length - 1, true);
  }
  console.log(lines.join("\n"));
}
