---
name: grove-delegate
description: Use when giving work to another grove node, deciding between conversation and assigned board work.
---

# grove-delegate (alias: grove:delegate)

## Choose ask or assign

Use `ask` for short, single-turn conversation:

```bash
grove ask <node> "<question>"
```

Use `send` plus `wait` for an interactive exchange that does not need durable tracking:

```bash
grove send <node> "<message>"
grove wait <node>
```

Use a board task for implementation, verification, review, multi-step work, or anything that must survive restarts:

```text
create_task(board=<board>, assignee=<child>, ...)
claim -> complete
claim -> block
```

Do not create ephemeral subagents. Persistent grove nodes receive board tasks.

## Task spec

A delegated task spec should include:

- goal and expected output
- scope and files that may be touched
- files or areas that must not be touched
- workspace metadata: kind, path, branch, or session if relevant
- verification command
- reporting format
- blocking criteria

Assign reviewers as board tasks or spawn a reviewer node when no suitable reviewer exists.

## Board operations

```http
POST /api/boards/{board_id}/tasks
GET /api/boards/{board_id}/tasks?status=ready&assignee=<child>
POST /api/tasks/{task_id}/comments
```

Store routing data in task metadata. Complete only after the assignee reports verification evidence.
