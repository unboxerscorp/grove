---
name: grove-org
description: Use before asking, assigning, spawning, or routing work to another grove node.
---

# grove-org (alias: grove:org)

## Inspect first

Before asking, assigning, spawning, or routing work, inspect the current grove organization. Do not ask the user what the current org is if it can be queried.

```bash
grove org --json
grove status
```

Check:

- current node name, role, group, and parent
- current node children
- target node role, group, agent, status, and pane binding
- whether the target is a leaf maker or an orchestrator

## Routing rules

If the current node has children, do not take leaf implementation work by default. Coordinate through child nodes and board tasks.

If the target node does not exist, use `grove:spawn-node` before assigning durable work.

If the work needs tracking, review, verification, or implementation, use a board task rather than an untracked chat. Use direct conversation only for short questions or clarification.

## Org fields

Expected org node fields:

```json
{
  "name": "worker-1",
  "agent": "codex",
  "role": "maker",
  "parent": "lead",
  "children": [],
  "group": "core",
  "tmux_pane": "dev10:1.2",
  "session_id": "session-id",
  "status": "idle"
}
```

Treat missing or stale bindings as a reason to rebind or spawn, not as a reason to guess.
