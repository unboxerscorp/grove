import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";

import { ensureSharedMasterRegistry, loadOrInit, saveRegistry } from "../registry.js";
import { color, info, warn } from "../util/log.js";

function template(session: string, cwd: string): string {
  return `# grove org-chart — declare your tree of agents here.
# docs: see grove-context.md for the direct-org working model

session: ${session}
cwd: ${cwd}

defaults:
  agent: codex          # codex | claude
  # model: gpt-5.5

nodes:
  lead:
    agent: claude
    role: |
      You are the lead of this grove. Keep the org, roles, tmux panes, and cwd
      visible. Use direct node communication with \`grove send\`, \`grove ask\`,
      tmux capture, or tmux input as appropriate. Human-facing list items are
      for operator TODO, feedback, and ask-human records; they are not the
      required node-to-node protocol. See grove-context.md.
    children: [maker-1, maker-2, reviewer]

  maker-1:
    role: "Feature & bug implementation."

  maker-2:
    role: "Feature & bug implementation."

  reviewer:
    agent: claude
    role: "Review diffs, run checks, surface risks, and make focused fixes when asked or practical."
`;
}

const CONTEXT_DOC = `# grove context

You are a node in a *grove* — a tree of AI agents, each running in its own tmux
pane. The tree records ownership and reporting structure; it is not a
communication boundary. You can send or ask any reachable node, including nodes
in another project with \`project:node\` or \`--project <project>\`.

## direct node communication

Use direct node communication for implementation, review, verification, and
blocker traffic. A node can inspect tmux panes, use \`grove send\`, use \`grove
ask\`, or type into another pane when that is the practical route and the
operator has allowed it.

Human-facing list items are for operator TODOs, feedback, and ask-human
decisions. They are durable records for humans, not the required protocol for
node-to-node work.

## Commands you can run

- \`grove org --all --json\` — inspect the full multi-project tree: nodes, roles, panes, cwd, and hierarchy.
- \`grove status\` — see node state and recent activity.
- \`grove send <node> "<message>"\` — send a direct non-blocking message.
- \`grove wait <node>\` — block until that node finishes its current turn and
  print what it produced.
- \`grove ask <node> "<message>"\` — \`send\` + \`wait\` in one call.
- \`grove ask <project:node> "<message>"\` — direct request/response to another
  project.

## Working well

1. Start by checking \`grove org --all --json\` so you know your node name, role,
   parent, children, tmux pane, cwd, and other project leads.
2. Give peers clear, self-contained context: what to inspect or change, which
   files matter, how to verify, and what result to report.
2. Prefer \`grove ask\` when you need the result before continuing.
3. Fan out with \`grove send\` to multiple nodes, then \`grove wait\` or
   \`grove gather\` when you need to join.
4. Any visible node can communicate or work across the org. The hierarchy is
   ownership and reporting metadata, not a capability cage.
5. Do not autonomously spawn, terminate, or rearrange nodes. When the human
   explicitly asks for an org change, use the operator-marked path.

## Example

\`\`\`bash
grove ask maker-1 "Inspect src/auth.ts retry behavior. If a focused fix is
needed, make it, run the relevant tests, and report the result plus commit hash."
\`\`\`
`;

const INIT_CHILDREN = ["maker-1", "maker-2", "reviewer"];

function seedRegistry(session: string, cwd: string): void {
  const registry = loadOrInit(session, cwd);
  const existing = registry.nodes.lead;
  registry.nodes.lead = {
    ...existing,
    agent: existing?.agent ?? "claude",
    children: existing?.children ?? INIT_CHILDREN,
    cwd,
    name: "lead",
    parent: "",
    role:
      existing?.role ??
      "Project lead for this grove. Keep direct node communication moving and use human-facing list items only for operator TODO, feedback, and ask-human records.",
  };
  saveRegistry(registry);
  ensureSharedMasterRegistry(cwd);
}

export async function cmdInit(opts: {
  config?: string;
  session?: string;
  force?: boolean;
}): Promise<void> {
  const cwd = process.cwd();
  const session = opts.session ?? path.basename(cwd);
  const configPath = path.resolve(cwd, "grove.yaml");
  const contextPath = path.resolve(cwd, "grove-context.md");

  if (existsSync(configPath) && !opts.force) {
    warn(`${color.bold("grove.yaml")} already exists — use --force to overwrite`);
  } else {
    writeFileSync(configPath, template(session, cwd));
    info(`wrote ${color.bold("grove.yaml")}`);
  }

  if (existsSync(contextPath) && !opts.force) {
    warn(`grove-context.md already exists — leaving it`);
  } else {
    writeFileSync(contextPath, CONTEXT_DOC);
    info(`wrote ${color.bold("grove-context.md")}`);
  }

  seedRegistry(session, cwd);
  info(`next: edit grove.yaml, then run ${color.cyan("grove up")}`);
}
