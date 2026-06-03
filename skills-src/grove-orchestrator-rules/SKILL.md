---
name: grove-orchestrator-rules
description: Use when the current grove node has children or is coordinating work rather than doing leaf implementation.
---

# grove-orchestrator-rules (alias: grove:orchestrator-rules)

## Rule

If the current grove node has children, it is an orchestrator by default. It should not do leaf implementation.

Allowed orchestrator work:

- decompose work
- create and assign board tasks
- unblock or block tasks
- request verification
- spawn missing roles
- collect results and make integration decisions
- fan out and fan in group discussions

Exceptions:

- the user explicitly orders the current node to implement
- there is an urgent repair and no child can take it
- the current node has no children

TDD belongs to childless maker nodes. An orchestrator asks a maker to do TDD via a board task.

## Commands and APIs

```bash
grove org --json
grove status
```

Board operations:

```text
create_task(board, assignee, title, body, metadata)
add_comment(task, author, body)
block(task, reason)
unblock(task, actor, comment)
list_tasks(board, status, assignee)
```

Use task metadata for workspace path, branch, session, and routing details. Do not encode workspace ownership only in the prompt text.
