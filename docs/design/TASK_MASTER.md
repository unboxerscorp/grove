# Task Master — Active Board Coordination

A **master-group node directly under GROVE MASTER** that keeps every project's task
board _live_ by **dispatching, monitoring, and escalating** — without auto-executing
code or auto-mutating tasks. It is the active counterpart to the read-only
`grove task mine` awareness model (task_8e647): coordination, not execution.

## Loop (~every 5 min, advisor cadence)

1. **Read** every project's board (cross-project): list projects, then per project
   read ready/running tasks + assignees (`grove task list` / API per project).
2. **Dispatch ready** — for each `ready` task **with an assigned executor-eligible
   node** (group ∈ {lead, workers}): `grove send` that node a nudge
   ("ready task `<id>` '`<title>`' is assigned to you — claim/start when able").
   - **Idempotent + backoff**: track what was dispatched per task; re-nudge only
     after a cooldown; after N nudges with no movement → escalate (don't spam).
   - `ready` task with **no assignee** → escalate to human (needs assignment).
3. **Monitor running** — for each `running` task: check the assigned node is
   actually progressing (recent activity / ask the node). Stale-running past a
   threshold → nudge once, then flag/escalate.
4. **Escalate** — unassigned / blocked / `ask_human` / stale / needs-judgment →
   Slack (via the bridge) for a human decision.

## Safety (hard lines)

- **Coordinates only**: never auto-executes code; never auto-creates tasks; never
  force-changes a task's status. Nodes move `ready→running` themselves (the existing
  claim: `grove task start <id> --from-status ready`, 409 = single-winner; --run-id
  verifies a later transition of an already-running item, NOT the initial claim). The
  task-master only _nudges_.
- Dispatch only to **assigned, executor-eligible** nodes; unassigned → human.
- **Idempotent + rate-limited** (cooldown/backoff per task; no nudge storms).
- **confirm-before-create unchanged**; read-only on task data except its own nudges.
- Exclude service/master/audit groups + advisor/jester from dispatch targeting
  (reuse the executor-eligibility rule from the assignee gate, 781ae8f).

## Reuse (minimal new code)

- `grove task list` / `grove task mine` (task_8e647) for board awareness.
- Executor-eligible targeting from the assignee gate (781ae8f).
- Multi-project boards (already project-aware via `X-Grove-Project`).
- Slack/bridge for human escalation.

## Node

- Master-group node under `grove-master` (next to chat-master). Its
  `work_instructions` encode the loop + safety above. Spawn = operator/grove-master
  (org change). The only possible new code is a small cross-project "actionable view"
  helper if `grove task list` per project is not enough — kept minimal.
