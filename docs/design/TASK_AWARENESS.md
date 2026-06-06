# Node Task-Awareness & Safe Claim (task_8e647)

Status: **design only** (grove-dev). No code/activation until grove-master
approves. First pass = awareness + explicit claim; auto-execution stays OFF
behind a kill switch until a one-node pilot.

## Goal

Each **work** node periodically becomes aware of the board tasks assigned to it
and can safely claim / update status — without duplicate work, runaway loops, or
unapproved auto-execution. Tasks remain operator-visible work, not a required
node-to-node protocol.

## What already exists (REUSE — do not rebuild)

The pickup/execution machinery is production-grade and currently dormant/gated:

- **Atomic claim + dup-prevention:** `store.claim_next` (store.py ~1210) — CAS on
  `tasks.claim_lock IS NULL`, sets `claim_lock`/`claim_expires`/`current_run_id`
  - a `runs` row; per-node WIP guard; `release_stale` (expired claims → ready);
    `heartbeat` extends TTL. Double-claim already impossible.
- **Autopickup gating:** per-node + global enable + `kill_switch` + cooldown +
  `last_autopickup_at` (store + `/api/nodes/{node}/autopickup`). Per-node default
  **unconfigured → off**.
- **Guarded execution FSM:** `claimed→preflight→approval-pending→approved→
executing→verify→complete/rollback/abort`, with kill switches at
  global/board/node/task and short-lived dispatch leases (`/api/execution`,
  `/api/nodes/{node}/execution`, `/api/tasks/{id}/approve|abort`). Global
  execution default **enabled=False**.
- **pull_executor** (`bridge/.../pull_executor.py`): `run_once`/`run_forever`,
  `poll_interval`, `max_tasks_per_tick=1` (backpressure), `claim_conflicts`
  metrics. **Not deployed** (no LaunchAgent/loop) — dormant today.
- **Awareness read path:** `grove task list --assignee <node>` →
  `GET /api/boards/{board}/tasks?assignee=`. AGENTS.md/CLAUDE.md already instruct
  the startup check.
- **Node scope:** `kind=service` (web/slack), human, reviewer, group/role/name
  are all readable from the registry for excluding non-work nodes.

## What's missing for the first pass

1. **Periodic/contextual awareness** of a node's _own_ assigned ready/running
   tasks (today: only manual `grove task list` or execution-time prompt). Must be
   convention/skill-driven (canonical: not rule-injected, no auto-executor).
2. **Explicit, node-initiated claim** that does NOT start guarded execution
   (today `claim_next` is wired to `begin_guarded_execution` in the executor).
3. **Worker-scope filter** so only work nodes participate (exclude
   service/advisor/grove-master/whip-audit).
4. **Auto-exec stays OFF** by default with an explicit kill switch separate from
   the full execution gate.

## Design — staged, each stage independently shippable

**Stage 1 — Awareness (read-only, zero execution).**

- A node-scoped surface for "my assigned ready/running tasks": reuse the tasks
  API (optionally a thin `GET /api/nodes/{node}/assigned-tasks` = `list_tasks`
  filtered to `assignee=node AND status IN (ready,running)`), and a **skill**
  (`grove-task-check`) + AGENTS.md/CLAUDE.md convention that a work node checks it
  at session start and periodically. No polling daemon, no rule-injection, no
  claim. Backpressure: this is read-only.
- Scope: a single source of truth for "is this a work node" — exclude
  `kind=service`, the master, advisor, jester, and `group=audit` (whip). Encode
  as a reusable `_is_pickup_eligible(node)` helper (reuses kind/group/role).

**Stage 2 — Explicit claim + status (node-initiated, still no auto-exec).**

- `grove task claim <id>` CLI (+ `POST /api/tasks/{id}/claim`): **assigned-only**
  (rejects unless `assignee == caller node` and status `ready`), atomic via a
  claim path that sets running/claim_lock/claim_expires/current_run_id **without**
  `begin_guarded_execution` (decouple claim from the executor's guarded dispatch).
  Duplicate-prevented by the existing CAS. `release_stale`/heartbeat reused so an
  abandoned claim returns to ready.
- Status updates reuse the existing `grove task <done|block|...>` / PATCH.
- Backpressure: per-node max-active = 1 (reuse the WIP guard); claim is explicit,
  so no runaway.

**Stage 3 — Gated auto-pickup pilot (auto-exec, ONE node, behind kill switch).**

- Only after Stages 1–2 are green and approved: enable the existing pull_executor
  autopickup for **one** pilot work node, with global execution gate +
  per-node autopickup explicitly toggled on, `max_tasks_per_tick=1`, cooldown,
  per-node WIP, claim_conflicts/observability, and the kill switch wired to a
  one-flag global stop. Auto-execution remains OFF for everyone else.
- This stage is its own approval + deploy/verify cycle; not in the first pass.

## Guards (grove-master's requirements, mapped)

- **Scope = work nodes only:** `_is_pickup_eligible` excludes service/master/
  advisor/jester/whip(audit). whip stays audit-only.
- **Awareness + explicit claim first; auto-exec off:** Stages 1–2 only; Stage 3
  gated behind kill switch + one-node pilot.
- **Duplicate prevention:** reuse `claim_next` CAS + claim_lock/claim_expires/
  current_run_id + release_stale.
- **Backpressure:** per-node max-active=1 (WIP guard), poll interval + cooldown
  (Stage 3), claim_conflicts metric, global kill switch / circuit breaker.
- **Assigned-only:** claim rejects unless `assignee == node` and status ready;
  no arbitrary self-claim.
- **Human-facing semantics:** tasks stay operator-visible; awareness is a skill/
  convention, never a forced rule-injection or hidden executor.

## Changed-files estimate (when approved)

- Bridge: `store.py` (claim-only method decoupled from guarded exec;
  `_is_pickup_eligible` helper), `web_app.py` (assigned-tasks + claim endpoints,
  assigned-only guard), `pull_executor.py` (worker-scope filter — Stage 3).
- CLI: `src/commands/task.ts` (+`claim` action), `src/cli.ts`.
- Skill/docs: a `grove-task-check` skill + AGENTS.md/CLAUDE.md convention note.
- Tests: `test_store.py` (claim decoupled/atomic/assigned-only/stale),
  `test_web_app.py` (assigned-tasks + claim endpoints + scope/permission),
  `src/commands/task.test.ts` (claim CLI), `test_pull_executor.py` (Stage 3 scope).

## Risks

- **Claim↔execution coupling:** `claim_next` currently triggers guarded execution
  in the executor path. Stage 2 must claim WITHOUT starting dispatch — verify no
  accidental auto-exec. (Primary risk.)
- **Awareness vs auto-exec:** the skill/convention must not become a de-facto
  auto-executor (canonical forbids rule-injection); keep it read + explicit.
- **Runaway (Stage 3):** mitigated by default-off autopickup, per-node WIP,
  cooldown, max_tasks_per_tick=1, kill switch; pilot one node only.
- **Pane-input collision** when a node surfaces/acts on tasks: reuse the existing
  input guard; never inject into a busy human pane.
- **Scope drift:** non-work nodes (service/audit) must never be pickup-eligible;
  lock with tests.

## Non-Goals (first pass)

- No auto-execution rollout; no pull_executor deployment beyond the gated pilot.
- No rule-based task injection into prompts; no polling daemon.
- No change to chat-routing (G2/G3 separate) or org/services/fleet.
