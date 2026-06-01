#!/usr/bin/env node
import { Command } from "commander";
import { cmdAsk } from "./commands/ask.js";
import { cmdDown } from "./commands/down.js";
import { cmdInit } from "./commands/init.js";
import { cmdSend } from "./commands/send.js";
import { cmdSession } from "./commands/session.js";
import { cmdStatus } from "./commands/status.js";
import { cmdTail } from "./commands/tail.js";
import { cmdUp } from "./commands/up.js";
import { cmdWait } from "./commands/wait.js";
import { err } from "./util/log.js";

type AnyFn = (...args: never[]) => Promise<void>;

function run(fn: AnyFn) {
  return (...args: unknown[]): void => {
    (fn as (...a: unknown[]) => Promise<void>)(...args).catch((e: unknown) => {
      err(e instanceof Error ? e.message : String(e));
      process.exit(1);
    });
  };
}

const program = new Command();

program
  .name("grove")
  .description("Grow a tree of AI agents (Claude Code + Codex) in your terminal.")
  .version("0.1.0")
  .option("-c, --config <file>", "path to grove.yaml");

// Merge the root --config into each subcommand's options.
function withConfig<T extends Record<string, unknown>>(opts: T): T & { config?: string } {
  const rootConfig = program.opts<{ config?: string }>().config;
  return { ...opts, config: (opts as { config?: string }).config ?? rootConfig };
}

program
  .command("up")
  .description("create the tmux session and bring up every node (idempotent)")
  .option("-c, --config <file>", "path to grove.yaml")
  .action(run((opts: Record<string, unknown>) => cmdUp(withConfig(opts))));

program
  .command("down")
  .description("kill the tmux session")
  .option("-c, --config <file>", "path to grove.yaml")
  .action(run((opts: Record<string, unknown>) => cmdDown(withConfig(opts))));

program
  .command("status")
  .alias("st")
  .description("show the tree: every node, its agent, tmux state, last output")
  .option("-c, --config <file>", "path to grove.yaml")
  .action(run((opts: Record<string, unknown>) => cmdStatus(withConfig(opts))));

program
  .command("send <node> <message...>")
  .description("give a node a task (non-blocking)")
  .option("-c, --config <file>", "path to grove.yaml")
  .action(
    run((node: string, message: string[], opts: Record<string, unknown>) =>
      cmdSend(node, message.join(" "), withConfig(opts)),
    ),
  );

program
  .command("wait <node>")
  .description("block until the node finishes its current turn, print the result")
  .option("-c, --config <file>", "path to grove.yaml")
  .option("-t, --timeout <dur>", "max wait, e.g. 30s 20m 1h", "30m")
  .action(run((node: string, opts: Record<string, unknown>) => cmdWait(node, withConfig(opts))));

program
  .command("ask <node> <message...>")
  .description("send a task and wait for the result (send + wait)")
  .option("-c, --config <file>", "path to grove.yaml")
  .option("-t, --timeout <dur>", "max wait, e.g. 30s 20m 1h", "30m")
  .action(
    run((node: string, message: string[], opts: Record<string, unknown>) =>
      cmdAsk(node, message.join(" "), withConfig(opts)),
    ),
  );

program
  .command("tail <node>")
  .description("stream a node's completed turns as they land")
  .option("-c, --config <file>", "path to grove.yaml")
  .action(run((node: string, opts: Record<string, unknown>) => cmdTail(node, withConfig(opts))));

program
  .command("session <node>")
  .description("print a node's resolved session id + transcript path")
  .option("-c, --config <file>", "path to grove.yaml")
  .action(run((node: string, opts: Record<string, unknown>) => cmdSession(node, withConfig(opts))));

program
  .command("init")
  .description("scaffold a grove.yaml and delegation-protocol doc")
  .option("-s, --session <name>", "tmux session name (default: cwd basename)")
  .option("--force", "overwrite existing files")
  .action(run((opts: Record<string, unknown>) => cmdInit(opts)));

program.parseAsync(process.argv).catch((e: unknown) => {
  err(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
