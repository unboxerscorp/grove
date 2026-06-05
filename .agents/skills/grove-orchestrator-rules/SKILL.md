---
name: grove-orchestrator-rules
description: Use when the current grove node is coordinating work across visible peers.
---

# grove-orchestrator-rules (alias: grove:orchestrator-rules)

## Rule

The org hierarchy describes ownership and responsibility, not a hard execution firewall. A coordinating node should usually route, clarify, verify, and integrate, but it may do direct work when that is the practical route or when the human asks.

Allowed orchestrator work:

- decompose work
- send direct messages to the right nodes
- inspect tmux panes and node cwd before routing
- request verification
- collect results and make integration decisions
- fan out and fan in group discussions
- create a human-facing TODO or ask-human item when human judgment is needed

Org changes:

- Do not autonomously spawn, terminate, or rearrange nodes from a node session.
- Ask the human operator or project lead when a new role or org change is needed; if the human explicitly asks you to perform it, use the operator-marked GUI/API/CLI path.

TDD belongs wherever it is useful. Coordinate directly with the relevant node.

## Commands and APIs

```bash
grove org --json
grove status
```

Human-facing list item operations:

```text
create_task(board, title, body, metadata)
add_comment(task, author, body)
ask_human(task, reason)
done(task, comment)
```

Use list items only for human-facing TODO, feedback, and ask-human records. Use direct node communication for node-to-node work.
