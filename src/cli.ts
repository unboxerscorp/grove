#!/usr/bin/env node
import { Command } from "commander";

import { cmdAsk } from "./commands/ask.js";
import { cmdDelegate } from "./commands/delegate.js";
import { cmdDespawn } from "./commands/despawn.js";
import { cmdDown } from "./commands/down.js";
import { cmdExportProject } from "./commands/export-project.js";
import { cmdGather } from "./commands/gather.js";
import { cmdImportProject } from "./commands/import-project.js";
import { cmdInit } from "./commands/init.js";
import { cmdLoadProject } from "./commands/load-project.js";
import { cmdNewProject } from "./commands/new-project.js";
import { cmdOrg } from "./commands/org.js";
import { cmdRebind } from "./commands/rebind.js";
import { cmdRepair } from "./commands/repair.js";
import { cmdSend } from "./commands/send.js";
import { cmdServe } from "./commands/serve.js";
import { cmdSession } from "./commands/session.js";
import { cmdSpawn } from "./commands/spawn.js";
import { cmdStatus } from "./commands/status.js";
import { cmdTail } from "./commands/tail.js";
import { cmdTask, type TaskAction } from "./commands/task.js";
import { cmdUp } from "./commands/up.js";
import { cmdWaitCommand } from "./commands/wait.js";
import { cmdWatch } from "./commands/watch.js";
import { cmdWatchdog } from "./commands/watchdog.js";
import { rawVariadicMessage } from "./util/argv.js";
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
  .command("org")
  .description("print the current grove team graph from the session registry")
  .option("-c, --config <file>", "path to grove.yaml")
  .option("--json", "print the team graph as JSON")
  .action(run((opts: Record<string, unknown>) => cmdOrg(withConfig(opts))));

program
  .command("new-project <name>")
  .description("create a detached tmux project session and spawn its initial grove nodes")
  .option("--template <name>", "template name from ~/.grove/templates/<name>.yaml")
  .option("--dir <path>", "workspace directory (default: ~/grove-projects/<name>)")
  .option("--clone <owner/repo>", "clone a GitHub repo into the workspace when gh is authenticated")
  .option("--json", "print the project summary as JSON")
  .action(run((name: string, opts: Record<string, unknown>) => cmdNewProject(name, opts)));

program
  .command("load-project <path>")
  .description("load a grove.project.json file or project folder and restore its grove nodes")
  .option("--json", "print the load summary as JSON")
  .action(
    run((projectPath: string, opts: Record<string, unknown>) => cmdLoadProject(projectPath, opts)),
  );

program
  .command("export-project [name]")
  .description("export a portable grove project bundle")
  .option("--out <bundle>", "output bundle directory")
  .option("--session <session>", "project/session name")
  .option("--json", "print the export result as JSON")
  .action(
    run((name: string | undefined, opts: Record<string, unknown>) => cmdExportProject(name, opts)),
  );

program
  .command("import-project <bundle>")
  .description("import a portable grove project bundle into a local project folder")
  .option("--dir <path>", "destination project directory")
  .option("--json", "print the import result as JSON")
  .action(run((bundle: string, opts: Record<string, unknown>) => cmdImportProject(bundle, opts)));

program
  .command("spawn")
  .description("create a detached tmux pane and launch a new grove node")
  .requiredOption("--name <name>", "new node name")
  .requiredOption("--agent <agent>", "agent adapter: codex, claude, or antigravity")
  .option("--role <role>", "role / initial prompt for the new node")
  .option("--role-preset <type>", "role preset to expand into the initial prompt")
  .option("--description <text>", "short human-readable note for the new node")
  .option("--parent <node>", "parent node name")
  .option("--group <group>", "team group")
  .option("--session <session>", "target tmux/grove session")
  .option("--window <window>", "split this existing window instead of creating a new window")
  .option("--cwd <dir>", "working directory for the new node")
  .option("-c, --config <file>", "path to grove.yaml")
  .option("--json", "print the spawn result as JSON")
  .action(run((opts: Record<string, unknown>) => cmdSpawn(withConfig(opts))));

program
  .command("despawn [node]")
  .description("kill a node pane and remove it from the session registry")
  .option("--session <session>", "target tmux/grove session")
  .option("--group <group>", "despawn every node in a group (requires --yes)")
  .option("--all", "despawn every node in the session registry (requires --yes)")
  .option("-y, --yes", "confirm bulk despawn")
  .option("-c, --config <file>", "path to grove.yaml")
  .option("--json", "print the despawn result as JSON")
  .action(
    run((node: string | undefined, opts: Record<string, unknown>) =>
      cmdDespawn(node, withConfig(opts)),
    ),
  );

program
  .command("delegate <node> <title...>")
  .description("create a ready board task assigned to a grove node")
  .option("--body <text>", "task body")
  .option("--board <board>", "target board slug", "default")
  .option("--session <session>", "target grove session/project")
  .option("--allow-remote", "allow sending the dashboard token to a non-loopback grove-web URL")
  .option("-c, --config <file>", "path to grove.yaml")
  .option("--json", "print the created task as JSON")
  .action(
    run((node: string, title: string[], opts: Record<string, unknown>) =>
      cmdDelegate(node, rawVariadicMessage("delegate", node, title), withConfig(opts)),
    ),
  );

const taskCommand = program
  .command("task")
  .description("transition a grove board task through the hybrid task flow");

function taskTransitionCommand(action: TaskAction, description: string): void {
  taskCommand
    .command(`${action} <task_id>`)
    .description(description)
    .option("--board <board>", "target board slug", "default")
    .option("--session <session>", "target grove session/project")
    .option("--allow-remote", "allow sending the dashboard token to a non-loopback grove-web URL")
    .option("--from-status <status>", "expected previous task status")
    .option("--run-id <id>", "task run id for idempotent executor updates")
    .option("--idempotency-key <key>", "idempotency key for repeat-safe transitions")
    .option("--comment <text>", "status transition comment")
    .option("--reviewer <node>", "reviewer node for review transitions")
    .option("-c, --config <file>", "path to grove.yaml")
    .option("--json", "print the updated task as JSON")
    .action(
      run((taskId: string, opts: Record<string, unknown>) =>
        cmdTask(action, taskId, withConfig(opts)),
      ),
    );
}

taskTransitionCommand("start", "mark a board task as running");
taskTransitionCommand("done", "mark a board task as done");
taskTransitionCommand("review", "mark a board task as ready for review");
taskTransitionCommand("block", "mark a board task as blocked");
taskTransitionCommand("ask-human", "mark a board task as waiting for human input");

program
  .command("send <node> <message...>")
  .description("give a node a task (non-blocking)")
  .option("-c, --config <file>", "path to grove.yaml")
  .action(
    run((node: string, message: string[], opts: Record<string, unknown>) =>
      cmdSend(node, rawVariadicMessage("send", node, message), withConfig(opts)),
    ),
  );

program
  .command("wait [nodes...]")
  .description("block until one node finishes, or fan in several nodes with --any/--all")
  .option("-c, --config <file>", "path to grove.yaml")
  .option("-t, --timeout <dur>", "max wait, e.g. 30s 20m 1h", "30m")
  .option("--any", "return on the first terminal event among listed nodes")
  .option("--all", "return after all listed nodes reach terminal events or the deadline")
  .action(
    run((nodes: string[], opts: Record<string, unknown>) =>
      cmdWaitCommand(nodes, withConfig(opts)),
    ),
  );

program
  .command("ask <node> <message...>")
  .description("send a task and wait for the result (send + wait)")
  .option("-c, --config <file>", "path to grove.yaml")
  .option("-t, --timeout <dur>", "max wait, e.g. 30s 20m 1h", "30m")
  .action(
    run((node: string, message: string[], opts: Record<string, unknown>) =>
      cmdAsk(node, rawVariadicMessage("ask", node, message), withConfig(opts)),
    ),
  );

program
  .command("watch")
  .description("append durable turn completion events for all configured node transcripts")
  .option("-c, --config <file>", "path to grove.yaml")
  .action(run((opts: Record<string, unknown>) => cmdWatch(withConfig(opts))));

program
  .command("watchdog")
  .description("inspect node health and plan staggered recovery from tmux pane/transcript output")
  .option("-c, --config <file>", "path to grove.yaml")
  .option("--execute", "perform one due recovery action; default is dry-run")
  .option("--hung-after <dur>", "mark a node hung after no pane/transcript output", "10m")
  .option("--json", "print the node_health payload as JSON")
  .action(run((opts: Record<string, unknown>) => cmdWatchdog(withConfig(opts))));

program
  .command("gather <nodes...>")
  .description("wait --all alias with a human summary, or machine JSON via --json")
  .option("-c, --config <file>", "path to grove.yaml")
  .option("-t, --timeout <dur>", "max wait, e.g. 30s 20m 1h", "30m")
  .option("--json", "print the fixed fan-in result schema as JSON")
  .action(
    run((nodes: string[], opts: Record<string, unknown>) => cmdGather(nodes, withConfig(opts))),
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
  .command("rebind")
  .description("repair registry session/transcript bindings using node startup markers")
  .option("-c, --config <file>", "path to grove.yaml")
  .option("--session <session>", "target grove registry session")
  .option("--dry-run", "show planned registry changes without writing")
  .action(run((opts: Record<string, unknown>) => cmdRebind(withConfig(opts))));

program
  .command("repair")
  .description("detect and repair stale grove node pane/transcript bindings")
  .option("-c, --config <file>", "path to grove.yaml")
  .option("--session <session>", "target grove registry session")
  .option("--node <node>", "repair one registry node")
  .option("--all", "repair every registry node (default)")
  .option("--json", "print the repair result as JSON")
  .action(run((opts: Record<string, unknown>) => cmdRepair(withConfig(opts))));

program
  .command("serve [nodes...]")
  .description("serve an OpenAI-compatible chat completions SSE facade backed by grove nodes")
  .option("-c, --config <file>", "path to grove.yaml")
  .option("--host <host>", "loopback host to bind (default: 127.0.0.1)")
  .option("-p, --port <port>", "port to bind", "8787")
  .option("-t, --timeout <dur>", "max grove turn wait, e.g. 30s 20m 1h", "30m")
  .action(
    run((nodes: string[], opts: Record<string, unknown>) => cmdServe(nodes, withConfig(opts))),
  );

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
