# 🌳 grove

**Grow a tree of AI agents in your terminal.**

Declare an org-chart of [Claude Code](https://claude.com/claude-code) and [Codex](https://openai.com/codex) agents in one YAML file. Bring the whole tree up in tmux with a single command. Any node can delegate work to its children and collect their results through a uniform protocol — so a Claude "lead" can drive a pool of Codex makers, which can each drive their own reviewers, recursively.

You watch the entire fleet think, live, in tmux panes.

```bash
grove up                       # spawn the whole tree in tmux
grove status                   # see every node + what it's doing
grove ask maker-1 "fix the failing test in auth.service.ts"
grove send reviewer "review the diff on branch hotfix"
```

## Why

One agent in one terminal is a chat. A *tree* of agents is an org. grove gives you the org:

- **Declarative** — the org-chart is a file (`grove.yaml`), versioned with your repo.
- **Heterogeneous** — mix `claude` and `codex` nodes freely. Each is just a node.
- **Uniform protocol** — `send` a task, `wait` for the result. Works the same for every agent type via pluggable **adapters**.
- **Live** — every node is a real interactive TUI in a tmux pane. Attach and watch, or drive it programmatically.
- **Resumable** — nodes resume their prior session (full context intact) across restarts.
- **Recursive** — any node that has `grove` can address its own children. The tree grows itself.

## Concepts

```
grove.yaml                     the org-chart you declare
   │
   ├── node = one tmux window running one agent (claude | codex)
   ├── send/wait = the message bus (send-keys in, transcript-tail out)
   └── adapter = per-agent-type plumbing: launch · detect-done · read-result
```

A **node** is one agent instance. It has a name, an agent type, an optional role prompt, and optional children. The **root** is whoever has no parent — a human, or a conductor agent.

An **adapter** teaches grove how to talk to one kind of agent. Adding a new agent type = implementing three operations: how to launch it, how to know it finished a turn, and how to read what it said. Two adapters ship today:

| agent | launch | "turn done" signal |
|-------|--------|--------------------|
| `codex` | `codex resume <id>` | `task_complete` event in the session jsonl |
| `claude` | `claude --resume <id>` | assistant message with `stop_reason: end_turn` |

## Quick start

```bash
pnpm add -g grove          # or: npx grove
grove init                 # scaffold grove.yaml + a protocol doc for your root agent
grove up                   # bring the tree up
grove status
```

### `grove.yaml`

```yaml
session: my-project              # tmux session name
cwd: /path/to/repo               # default working dir for every node
defaults:
  agent: codex
  model: gpt-5.5

nodes:
  lead:
    agent: claude
    role: |
      You are the lead. Delegate implementation to maker-1/maker-2 with
      `grove send <node> "<task>"` and collect results with `grove wait <node>`.
    children: [maker-1, maker-2, reviewer]

  maker-1: { role: "Feature & bug implementation." }
  maker-2: { role: "Feature & bug implementation." }
  reviewer:
    agent: claude
    role: "Read-only code review. Never edit."
```

## Commands

| command | what it does |
|---------|--------------|
| `grove up [--config f]` | create the tmux session and bring up every node (idempotent — adopts already-running windows) |
| `grove down` | kill the session |
| `grove status` | tree view of every node: agent, tmux state, last event |
| `grove send <node> "<msg>"` | give a node a task (non-blocking) |
| `grove wait <node>` | block until the node finishes its current turn, print the result |
| `grove ask <node> "<msg>"` | `send` + `wait` in one shot |
| `grove tail <node>` | follow a node's output live |
| `grove session <node>` | print a node's resolved session id + transcript path |
| `grove init` | scaffold a `grove.yaml` and a delegation-protocol doc |

## Status

Early. The `codex` adapter is battle-tested (it grew out of an 8-node fleet shipping a real SaaS); the `claude` adapter is new. Interactive-tmux mode is the focus; headless (`claude -p` / `codex exec`) structured I/O is on the roadmap.

## License

MIT
