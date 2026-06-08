# Human-facing List Redesign — Candidate Review

> **STATUS — Slack-bot permission slice IMPLEMENTED (2026-06-08, flag-gated):** typed confirm-action dispatcher + Slack wiring + chat-create→`staged` dark flag (default OFF, live-unchanged) — see `SLACK_BOT_LIST_PERMISSION_MODEL.md` STATUS. Backend `staged`/`/dispatch` is task-worker's (`9eeeca8`). Deployment bundled later.

Integrates three node perspectives for the operator's request: list UI/flow + Slack-bot
list permissions. Refs: `docs/design/SLACK_BOT_LIST_PERMISSION_MODEL.md` (chat-worker).

## Problem (operator)

1. The two sections — '피드백 및 할 일' (feedback/TODO) and '사람 판단 필요' (needs
   human judgment) — are fixed-width (`.dr-col` 232px), so they don't fill a wide board.
2. Concurrent work confuses orch/lead. Items should **stack first**; only when a human
   adds an optional comment and presses **실행/제출** does the item go to the node/lead,
   **one at a time**. Applies to feedback/TODO and needs-human-judgment.
3. The Slack bot should manage this list, but the chat runtime lacks board write access.

## Recommended candidate — A (converged across all three perspectives)

- **Layout (fe-master)**: a 2-column grid (`1fr 1fr`) so both sections fill the width;
  ≤760px collapses to one column. Cards become full-width rows that host inline actions.
- **State (task-worker)**: a new `staged` status. New feedback/TODO items are created
  `staged` (stacked, not delivered) instead of `ready`. DB is unchanged (status is TEXT).
- **Gate UI (fe-master B1)**: a per-item inline composer (optional comment, collapsed by
  default) + a **실행/제출** button. **One-by-one only — no bulk "submit all"** (this is
  the anti-spam guard). Lifecycle badge: staged → submitting → delivered / error.
- **Delivery = '제출' (task-worker)**: an atomic `POST /api/tasks/{id}/dispatch
{assignee?, comment?}` = `set_assignee` + `add_comment` + status `staged→ready` with a
  `from_status` guard (idempotent; re-submit → 409 single-winner). The existing
  **task-master wakeup** then nudges the assignee — **no direct `grove send`** (stays on
  the board model). **One-at-a-time gate**: if the target already holds a ready/running
  item, hold (item stays staged); drain the next staged on the target's done/blocked
  event (reuse `_node_has_current_wip`).
- **Slack model (chat-worker)**: LLM tools stay **read-only** (`get_*`). EVERY mutation
  (create/classify/transition/comment/dispatch) is a chat-master **proposal** applied
  only through the existing one-shot, role-gated, scope-exact confirm — generalize
  `SlackConfirmationStore` into a **typed confirm-action dispatcher**. Write is never an
  LLM tool; on apply, stored fields are used verbatim (LLM text ignored). PII redacted [R].
- **wakeup co-change (task-worker)**: exclude `staged` from `is_meaningful_event`; fire
  only on the `staged→ready` dispatch (else staged accumulation → premature nudges).

## The spine: two approval boundaries

1. **confirm-before-CREATE** — item enters `staged` (existing chat/intake confirm).
2. **confirm-before-DISPATCH** — `staged→ready`, delivered to the node (NEW).

Both are human-gated; the `staged` state cleanly separates "filed" from "delivered."

## ask-human placement (Decision 2 = board inline)

ask-human asks a human; the answer flows back to the node via `/api/tasks/{id}/answer`.
**Operator decision: move ask-human answer/submit INLINE onto the board** (replace the
separate InboxDrawer answer flow). The board card hosts the answer composer + submit;
the InboxDrawer answer action is superseded to avoid a duplicate action — reconcile the
two so there is one answer surface.

## Alternatives (not recommended)

- **B — metadata `held` flag (no new status)**: smaller enum surface, but breaks the
  "ready = deliverable" invariant; every list/executor/wakeup filter must check the flag
  (a miss = early-delivery bug) and idempotency is weak. Rejected (task-worker).
- **C — signed action tokens (web/API redeem)**: clean, but essentially A implemented on
  the existing `SlackConfirmationStore`; only worth it if a non-Slack redeem surface is
  needed. Fold into A otherwise (chat-worker).

## Decisions — RESOLVED (operator)

1. **chat-created items → `staged`.** Chat/intake-created items also land in `staged` and
   need an explicit dispatch (consistent gate for every item; create ≠ deliver). The chat
   confirm-create + dispatch is an accepted two-step.
2. **ask-human → board inline.** Move the ask-human answer/submit inline onto the board
   and supersede the InboxDrawer answer action (one answer surface; reconcile the two).

## Minimal implementation order

1. Backend (task-worker): add `staged` status (aliases/validation/board columns/summary,
   TS+Py PARITY); new feedback/TODO default `staged`.
2. Backend (task-worker): `POST /dispatch` (atomic, `from_status` idempotent) +
   one-at-a-time gate.
3. Backend (task-worker): wakeup excludes `staged`, fires on dispatch.
4. FE (board-worker; fe-master design): 2-col grid + TaskCard composer + 실행/제출 +
   staged badge + ≤760 one-column + touch targets ≥40px.
5. Slack (chat-worker): generalize confirm-action (typed dispatcher) + read-only tools,
   staged-aware.
6. ask-human: per Decision 2.

## Risks / verification

- **Enum surface** — `staged` touches validation/board/summary/FE/tests + COMPACT/PARITY
  fixtures (mirror TS+Py). Medium.
- **Behavior change** — new=staged default; `delegate`/chat-intake need an explicit
  dispatch step (scripts expecting `created=ready` are affected).
- **Double gate** for chat-created items (Decision 1).
- **ask-human / InboxDrawer duplication** (Decision 2).
- **Serial-drain stall** if a completion event is missed → timer/poll backup.
- **Card height / ultra-wide** → composer collapse + inner max-width.
- Verify: `from_status` idempotency (409 single-winner), one-at-a-time gate, no premature
  wakeup, confirm-action one-shot/role/scope-exact, [R] redaction, TS+Py PARITY.
- Owners: task-worker (status/dispatch/wakeup), board-worker (board UI), chat-worker
  (Slack confirm-action); fe-master design.
