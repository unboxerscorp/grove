---
name: grove-task
description: Use when moving a human-facing TODO, feedback, or ask-human task through status transitions.
---

# grove-task

Use `grove task` when a human-facing task already exists and the operator-facing state needs an update. Do not use tasks as the required node-to-node communication protocol.

## Commands

```bash
grove task start <task_id> --run-id <run_id> --from-status ready
grove task done <task_id> --comment "verified"
grove task block <task_id> --comment "blocked on ..."
grove task ask-human <task_id> --comment "need human decision"
```

Status mapping:

- `start` -> `running`
- `done` -> `done`
- `block` -> `blocked`
- `ask-human` -> `ask_human`

## Safety

The CLI talks to local `grove-web` using the dashboard token. Non-loopback `GROVE_WEB_URL` targets are rejected unless the operator passes `--allow-remote`.

Prefer `--idempotency-key` for repeated executor updates and `--from-status` when avoiding stale transitions.
