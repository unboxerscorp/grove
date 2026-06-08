---
name: grove-org
description: Use before asking, sending, inspecting, or routing work to another grove node.
---

# grove-org (alias: grove:org)

## Inspect first

Before asking, sending, inspecting, or routing work, inspect the current grove organization. Do not ask the user what the current org is if it can be queried.

```bash
grove org --all --json
grove status
```

Use `grove org --all --json` for startup and routing decisions so multi-project leads and services are visible. Use project-scoped org output only after deliberately narrowing the task.

Check:

- current node name, role, group, and parent
- current node children
- target node role, group, agent, status, tmux pane, and cwd
- whether the target is the practical node to contact

## Routing rules

Hierarchy is ownership and reporting metadata, not a communication restriction. Nodes may address reachable nodes in any project with `project:node` or command `--project`.

Use direct conversation for node-to-node work. Do not force implementation, review, or blocker traffic through human-facing list items.

If the target node does not exist, ask the human operator or project lead to request an org change. Do not spawn it yourself unless the human explicitly asks you to create it through the operator-marked path.

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
  "tmux_pane": "sample:1.2",
  "cwd": "/repo/project",
  "session_id": "session-id",
  "status": "idle"
}
```

Treat missing or stale pane/cwd bindings as a reason to rebind or ask for operator repair, not as a reason to guess.
