---
name: grove-task
description: Use when checking your own assigned items, claiming an assigned item before working, or moving a human-facing TODO/feedback/ask-human list item through status transitions.
---

# grove-task

Use `grove task` to (1) become aware of items assigned to you, (2) claim an assigned item before you start, and (3) move a human-facing list item through status transitions. Do not use list items as the required node-to-node communication protocol.

## Awareness — what is assigned to me

```bash
grove task mine
grove task mine --json
grove task list --session <project> --board <project> --assignee <node>
```

`grove task mine` resolves the current node from its tmux pane (override with `--node <name>`) and prints only your `ready`/`running` assigned items on the project board. It is read-only: it never claims, starts, or polls. Run it before acting on operator-visible work.

`grove task mine` is executor-only. Service/master/audit panes and the advisor/jester roles get an "executor-only" notice and no list — assigned-task self-check is not their job. Use plain `grove task list --assignee <node>` for an explicit read-only check of any node.

## Claim contract — starting an assigned item

Claiming is operator/lead-initiated, never autonomous. There is **no separate claim endpoint**: a node claims an item it has been assigned (and told to start) by transitioning it with the existing `start` verb under optimistic concurrency.

```bash
grove task start <task_id> --from-status ready --run-id <run_id>
```

- `--from-status ready` makes the claim single-winner: if another node already moved the item out of `ready`, grove-web returns HTTP 409 (conflict) and your claim safely loses. Treat 409 as "already claimed" and move on.
- `--run-id <run_id>` ties the claim to your run for idempotent follow-up transitions.
- Only claim items already assigned to you. grove does not auto-poll or auto-start work; a human or your lead owns assignment and the decision to begin.

## Status transitions

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
