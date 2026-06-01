import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { color, info, warn } from "../util/log.js";

function template(session: string, cwd: string): string {
  return `# grove org-chart — declare your tree of agents here.
# docs: https://github.com/  (see grove-protocol.md for the delegation protocol)

session: ${session}
cwd: ${cwd}

defaults:
  agent: codex          # codex | claude
  # model: gpt-5.5

nodes:
  lead:
    agent: claude
    role: |
      You are the lead of this grove. Break work down and delegate to your
      children with \`grove send <node> "<task>"\`, then collect results with
      \`grove wait <node>\`. See grove-protocol.md.
    children: [maker-1, maker-2, reviewer]

  maker-1:
    role: "Feature & bug implementation."

  maker-2:
    role: "Feature & bug implementation."

  reviewer:
    agent: claude
    role: "Read-only code review of diffs. Never edit files."
`;
}

const PROTOCOL = `# grove delegation protocol

You are a node in a *grove* — a tree of AI agents, each running in its own tmux
pane. You can delegate work to your children and collect their results with the
\`grove\` CLI.

## Commands you can run

- \`grove status\` — see every node in the tree and what it last did.
- \`grove send <node> "<task>"\` — hand a child a task (returns immediately).
- \`grove wait <node>\` — block until that child finishes its current turn and
  print what it produced.
- \`grove ask <node> "<task>"\` — \`send\` + \`wait\` in one call (use this for
  request/response delegation).

## How to delegate well

1. Give each child a *self-contained* task: what to do, which files, how to
   verify, and what to report back.
2. Prefer \`grove ask\` when you need the result before continuing.
3. Fan out with \`grove send\` to multiple children, then \`grove wait\` each one
   when you need to join.
4. Children are themselves full agents — they can have their own children. Keep
   tasks at the altitude of the node you're addressing.

## Example

\`\`\`bash
grove ask maker-1 "Implement input validation in src/auth.ts. Run the tests in
auth.test.ts and report pass/fail plus the commit hash."
\`\`\`
`;

export async function cmdInit(opts: {
  config?: string;
  session?: string;
  force?: boolean;
}): Promise<void> {
  const cwd = process.cwd();
  const session = opts.session ?? path.basename(cwd);
  const configPath = path.resolve(cwd, "grove.yaml");
  const protocolPath = path.resolve(cwd, "grove-protocol.md");

  if (existsSync(configPath) && !opts.force) {
    warn(`${color.bold("grove.yaml")} already exists — use --force to overwrite`);
  } else {
    writeFileSync(configPath, template(session, cwd));
    info(`wrote ${color.bold("grove.yaml")}`);
  }

  if (existsSync(protocolPath) && !opts.force) {
    warn(`grove-protocol.md already exists — leaving it`);
  } else {
    writeFileSync(protocolPath, PROTOCOL);
    info(`wrote ${color.bold("grove-protocol.md")}`);
  }

  info(`next: edit grove.yaml, then run ${color.cyan("grove up")}`);
}
