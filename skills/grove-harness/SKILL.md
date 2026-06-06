---
name: grove-harness
description: Use when a request involves grove org structure, direct node communication, human-facing items, groups, or routing work.
---

# grove-harness (alias: grove:harness)

## Start here

Use this skill first for any grove org lookup, direct node communication, group, human-facing item, or routing action. After loading it, select the additional grove skill that matches the action:

- `grove:org` before asking, sending, or routing.
- `grove:delegate` when context or work is handed directly to another node.
- `grove:spawn-node` only to understand the human-operator node creation flow.
- `grove:form-group` when peers need to compare or converge.
- `grove:orchestrator-rules` when the current node is coordinating work.

## Decide mode

Before acting, determine where you sit in the org.

1. Query the org if the answer is not already known.
2. Note the target node's role, tmux pane, and cwd.
3. Communicate directly with the right node, or act directly if that is the practical route.

Do not autonomously create or delete nodes. Organization changes require explicit human instruction and the operator-marked GUI/API/CLI path. If a plan needs roles that do not exist, ask the human operator or project lead.

## Commands and APIs

```bash
grove org --json
grove status
```

Human-facing item API:

```http
GET /api/org
GET /api/boards
POST /api/boards/{board_id}/tasks
POST /api/tasks/{task_id}/comments
```

Task lifecycle names are for human-facing TODO, feedback, and ask-human records:

```text
ready -> running -> done
ready -> ask_human
running -> blocked -> running
```

Workspace routing belongs in the project and node cwd. Do not rely on hidden local state.

## Surface parity

The generated targets `skills/`, `.codex-plugin/`, and `.agents/skills/` carry the same grove protocol. For `agy`/`antigravity` nodes, use the `.agents/skills` surface and apply the same org-awareness and direct-communication model as `codex` and `claude` nodes.
