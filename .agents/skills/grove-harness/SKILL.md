---
name: grove-harness
description: Use when a request involves grove delegation, node creation, groups, org structure, board tasks, or routing work.
---

# grove-harness (alias: grove:harness)

## Start here

Use this skill first for any grove delegation, node creation, group, org, board task, or routing action. After loading it, select the additional grove skill that matches the action:

- `grove:org` before asking, assigning, spawning, or routing.
- `grove:delegate` when work is handed to another node.
- `grove:spawn-node` when a persistent node is needed.
- `grove:form-group` when peers need to compare or converge.
- `grove:orchestrator-rules` when the current node has children or is coordinating work.

## Decide mode

Before direct implementation, determine whether the current node has children.

1. Query the org if the answer is not already known.
2. If the current node has children, use delegation mode: split, assign, unblock, request verification, and fan in results.
3. If the current node has no children, it may act as a maker and use leaf implementation practices such as TDD.

Do not create an ephemeral subagent for grove work. Create a board task assigned to a persistent node instead. If a plan needs parallel execution, distribute it as board tasks.

## Commands and APIs

```bash
grove org --json
grove status
```

Board API:

```http
GET /api/org
GET /api/boards
GET /api/boards/{board_id}/tasks?status=ready&assignee=<node>
POST /api/boards/{board_id}/tasks
POST /api/tasks/{task_id}/comments
```

Task lifecycle names used by the board store:

```text
create_task -> claim -> complete
create_task -> claim -> block -> unblock -> claim
```

Workspace assignment belongs in task metadata. Do not rely on hidden local state for workspace routing.
