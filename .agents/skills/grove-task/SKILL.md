---
name: grove-task
description: Use when moving an existing grove board task through start, review, done, blocked, or ask-human status transitions from the CLI.
---

# grove-task

Use `grove task` when a board task already exists and the current work needs a durable status update.

## Commands

```bash
grove task start <task_id> --run-id <run_id> --from-status ready
grove task review <task_id> --reviewer <node> --comment "ready for review"
grove task done <task_id> --comment "verified"
grove task block <task_id> --comment "blocked on ..."
grove task ask-human <task_id> --comment "need human decision"
```

Status mapping:

- `start` -> `running`
- `review` -> `review`
- `done` -> `done`
- `block` -> `blocked`
- `ask-human` -> `ask_human`

## Safety

The CLI talks to local `grove-web` using the dashboard token. Non-loopback `GROVE_WEB_URL` targets are rejected unless the operator passes `--allow-remote`.

Prefer `--idempotency-key` for repeated executor updates and `--from-status` when avoiding stale transitions.
