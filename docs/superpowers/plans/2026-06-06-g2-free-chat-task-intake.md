# G2 Free-Chat → Task Intake Implementation Plan

> **Status: DESIGN-FIRST — awaiting grove-dev lead review + advisor/master cross-check before ANY code.**
> Owner: `chat-worker` (G2/G3 slice). Scope per lead assignment `[GO G2, DESIGN-FIRST]`.
> **For agentic workers:** REQUIRED SUB-SKILL when approved: superpowers:subagent-driven-development or superpowers:executing-plans. Steps use `- [ ]` tracking.

**Goal:** When a user free-chats grove-master (Slack mention or web chat) and the message is a probable _new task_, surface a Block Kit / web confirm card; create a board task **only** on explicit human confirm — never auto-create, never double-route.

**Architecture:** Reuse the existing slash-command intake primitive (`SlackIntakeProposal` → `SlackConfirmationStore` → `handle_interaction` buttons → `_execute_task_create` → `store.create_task`). Add one **pure, side-effect-free** detector `classify_for_task(...)` in `assistant.py`, and call it at the top of each surface's chat entry so a message takes exactly one path: **task-detected → confirm card**, XOR **chit-chat → existing master answer route**. The only board write stays on the confirm event (button / `/confirm` endpoint), never on the per-message path.

**Tech Stack:** Python (`bridge/src/grove_bridge/{assistant,slack,web_app}.py`), `SQLiteBoardStore`, Slack Socket Mode + Block Kit, FastAPI, pytest. Verification gate: `pnpm check`.

**Out of scope (separate work):** web-chat queue parity / durability (lead: "별개"); G5 web-chat history (already shipped: `append_master_chat_message` / `list_master_chat_messages`); any change to the live Slack/web → grove-master route; new `chat-master` node (operator-owned Model B); project-select UI + worktree/branch natural-language fields (canonical Block Kit fields — flagged as follow-up, see Open Decisions).

---

## 1. Verified current architecture (for lead/advisor validation of my mental model)

| Surface                                                   | Entry                                                                                                                                                                            | Classifier today                                       | Task path today                                                                                                                                                                                                                  |
| --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Web**                                                   | `POST /api/master/chat` → `_handle_master_chat_request` (web_app.py:5956) → `AssistantBroker.handle_turn` (sync, request thread)                                                 | `classify_master_message` inside broker                | none from free chat; confirm endpoint `/api/master/chat/confirm` → `confirm_action` creates a **decision proposal**, not a task                                                                                                  |
| **Slack (live, `route_chat_to_node=False`)**              | socket `listener` (slack.py:2753) → `handle_event` (858) → `_handle_chat` (2230) → `_handle_assistant_turn` (1993) → `AssistantBroker.handle_turn` **in socket-listener thread** | same                                                   | none from free chat                                                                                                                                                                                                              |
| **Slack (alt, `route_chat_to_node=True`, daemon worker)** | `_handle_chat` enqueues `slack_chat_queue`; daemon `node_chat_queue_thread` → `poll_node_chat_queue` (2267) → `_process_node_chat_queue_item` (2291) → `chat_facade.send`        | **none** (node answers)                                | none                                                                                                                                                                                                                             |
| **Slack slash cmd** `/bug /feedback /task`                | `_handle_intake_command` (1348) → `_preview_intake_task` (1419) → `_build_intake_task_proposal` (3135) → `confirmations.create(command="task_create")`                           | `SlackIntentClassification` (confidence=1.0, explicit) | **YES** → `handle_interaction` (892) buttons `grove_intake_confirm`/`grove_intake_answer_only` OR `confirm <id>` → `consume_for_owner` → `_execute_pending_command` (1652) → `_execute_task_create` (1674) → `store.create_task` |

Key facts:

- `classify_master_message` (master.py:336) is **deterministic, keyword-based, no LLM** (µs). Kinds: `unsupported / feedback_route / workflow_setup / capability_question / node_question / project_question`. `ACTION_KEYWORDS` (만들/생성/추가/create/add/setup/assign…) → `workflow_setup`; `FEEDBACK_KEYWORDS` → `feedback_route`. **No "new board task" intent exists yet.** master.py is **not** in scope — reuse it read-only.
- `INTAKE_ANSWER_ONLY_ACTION_ID` ("answer only: no task created", slack.py:48 / handle_interaction:960) already encodes guard-1 (the user can reject a task proposal and get a plain answer instead).
- `_execute_task_create` writes to `config.board` (dev10) with `metadata.intake.source="slack"`; it does **not** currently link the originating thread to the task — G2 adds `upsert_slack_thread(mode="task", task_id=...)`.
- `SlackConfirmationStore` (542) is in-memory, TTL'd, owner-checked (`consume_for_owner`), single-use (`pop`) → natural idempotency + per-confirmation dedupe.
- Live Slack appears to run `route_chat_to_node=False` (arg is `store_true`, no launch site found passing it). **Confirm with operator — see Open Decision A.**

**The gap = one wire:** free-chat → (deterministic) task detection → existing proposal/confirm/`create_task`, mutually exclusive with the answer route. No new task-creation machinery, no new confirm store, no new node.

---

## 2. Design

### 2.1 Shared detector (pure, no side effects) — `assistant.py`

Add `classify_for_task(message, *, context) -> TaskProposalDraft | None`:

- Calls `classify_master_message(message)` (reuse) + a small G2 task-intent rule.
- Returns a `TaskProposalDraft` (title/body/intent/labels/confidence/reason) **only** when intent is a probable _new task_ AND `confidence >= GROVE_TASK_INTAKE_MIN_CONFIDENCE` (default e.g. 0.75); else `None`.
- **Zero side effects**: no store writes, no pending creation, no posts. Trivially unit-testable. (Matches CHAT_MASTER.md "Next Steps": `classify_for_task` in assistant.py, no side effects.)
- Destructive/injection/feedback already handled by `classify_master_message` + `_pre_filter_block_reason`; G2 detector returns `None` for those so they keep their existing route (no double-handling).

### 2.2 Surface wiring (mutually exclusive — guard-1)

Each surface, at its chat entry, calls `classify_for_task` **before** the answer round-trip:

- **task draft present** → build `SlackIntakeProposal` (reuse `_build_intake_task_proposal`, `source="chat"`), create a pending confirmation (`SlackConfirmationStore` / broker pending), post the confirm card, and **return — do NOT forward to master/node for an answer.**
- **`None`** → existing behavior unchanged (forward to master/node, answer).

| Surface | Where detection runs                                                                                          | Confirm path (board write)                                                                                             |
| ------- | ------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Web     | inside `AssistantBroker.handle_turn` (request thread — not a socket; non-blocking deterministic call is fine) | existing `/api/master/chat/confirm` → routes to `create_task` (G2 adds task branch alongside decision-proposal branch) |
| Slack   | top of `_handle_assistant_turn` (or `_process_node_chat_queue_item` if worker mode live — Open Decision A)    | existing `handle_interaction` buttons / `confirm <id>` → `_execute_task_create` (+ new thread link)                    |

The **only** new board write is `store.create_task` + `upsert_slack_thread(mode="task")`, and it executes **on the confirm event** (button click / `/confirm`), which is a separate, low-frequency event — never on the per-message hot path. Detection added to the per-message path is a µs keyword match + in-memory pending + one Slack post (the path already posts).

### 2.3 Guard → mechanism mapping (the lead's 7 guards)

| #   | Guard                                                                         | Mechanism                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| --- | ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Zero double-routing** (1 msg = chit-chat XOR task-confirm)                  | `classify_for_task` returns draft-or-`None`; task branch `return`s before the answer route. `answer_only` button converts a proposal back to an answer. Test: a task-detected message posts a confirm card and produces **no** assistant answer; a chit-chat message produces an answer and **no** pending confirmation.                                                                                                                                                                       |
| 2   | **`slack_chat_queue` idempotency + task-path idempotency test**               | No change to queue keys `(team,channel,thread_ts/message_ts)` or `response_text` cache. `SlackConfirmationStore` is single-use (`consume_for_owner` pops) → re-clicking a consumed/expired confirm denies, never double-creates. If detection runs in the queue worker, reuse the item lifecycle (mark_running/store_response/complete) so a retried item does not re-post/re-propose. Test: same confirmation_id confirmed twice → one task; queue item re-processed → no duplicate proposal. |
| 3   | **Detection/creation in async worker, NOT socket handler; preserve watchdog** | Board write only on the confirm event (off the per-message socket path). Detection is deterministic/non-blocking. **No new blocking/LLM/DB call added to `handle_event`/socket heartbeat.** If operator confirms worker mode is live, detection moves into `_process_node_chat_queue_item` (the daemon thread) for full compliance. Socket-reconnect/self-exit watchdog (slack.py:2647+) untouched. **→ Needs advisor sign-off, Open Decision A.**                                             |
| 4   | **Board-write scope dev10 + thread link**                                     | `create_task(board=config.board)` (dev10) unchanged. **Add** `upsert_slack_thread(mode="task", task_id=task.id, ...)` in `_execute_task_create` to link the originating thread; per-thread isolation preserved (thread keys unchanged).                                                                                                                                                                                                                                                        |
| 5   | **CONFIRM-GATES-CREATION (0 auto-create)**                                    | `classify_for_task` and proposal building have **no** create path. `create_task` is reachable only via `consume_for_owner` + operator role + `_intake_enabled`. Test: detection alone never calls `create_task`.                                                                                                                                                                                                                                                                               |
| 6   | **Per-thread dedupe / confidence**                                            | Confidence threshold `GROVE_TASK_INTAKE_MIN_CONFIDENCE` gates proposals. Per-thread dedupe: skip proposing if an unconsumed pending confirmation already exists for this `(team,channel,thread_ts)` (anti-spam). Test: two task-like messages in one thread → one live proposal.                                                                                                                                                                                                               |
| 7   | **Chat-created tasks: no auto-start before explicit assignment**              | Created task `status="ready"`, `assignee=None` by default (no auto-pickup). Coordinate with task-worker's assigned-task auto-start model so chat-origin tasks require explicit assignment. Test: created task has no assignee and is not auto-started.                                                                                                                                                                                                                                         |

---

## 3. Open decisions for lead + advisor (flagged before coding)

- **A. Which Slack path is live — `route_chat_to_node` true/false?** Determines whether guard-3 is satisfied by (i) deterministic detection in `_handle_assistant_turn` + board-write-only-on-confirm (my recommended reading: no blocking work added to the socket hot path), or (ii) moving detection into the `_process_node_chat_queue_item` daemon worker (strict "socket handler 금지"). **I recommend (i); please confirm the live flag and whether (i) satisfies guard-3 or you want (ii).**
- **B. Task-intent definition + threshold.** Which `classify_master_message` kinds count as "new task" (e.g. `workflow_setup`/action-keyword, and/or a new heuristic), and the `GROVE_TASK_INTAKE_MIN_CONFIDENCE` value (proposed 0.75). Must not cannibalize `feedback_route` (keeps its existing preview) or capability/node/project questions (stay answers).
- **C. Confirm UI fidelity.** `_preview_intake_task` currently posts a **text** preview (`blocks=()`) + `confirm <id>`, while `handle_interaction` already supports buttons. MVP = reuse text+`confirm <id>` (lowest risk); or render real Block Kit buttons now. Recommend MVP text path first, buttons as a fast follow.
- **D. Canonical fields deferred?** Canonical Block Kit asks for **project (required)** and **worktree/branch (natural language)**. Current `SlackIntakeProposal` has neither (board=dev10 fixed). Propose deferring both to a follow-up and shipping title/body/intent + board=dev10 for G2. Confirm acceptable.
- **E. Web confirm dual-branch.** `confirm_action` today creates a decision proposal. G2 needs the web confirm to reach `create_task` for chat-origin task proposals. Propose a distinct pending-kind so `/api/master/chat/confirm` dispatches task-proposals → `create_task` and leaves the decision-proposal branch intact. Confirm shape.

---

## 4. Implementation tasks (TDD, bite-sized) — execute only after approval

> Each task: write failing test → run (fail) → minimal impl → run (pass) → commit. All tests live in `bridge/tests/`.

### Task 1: Pure `classify_for_task` detector (no side effects)

**Files:** Modify `bridge/src/grove_bridge/assistant.py`; Test `bridge/tests/test_assistant.py`.

- [ ] **Step 1 — failing test:** add `test_classify_for_task_returns_draft_for_task_intent` (a "create/만들" message above threshold → draft with title/body/intent) and `test_classify_for_task_returns_none_for_chit_chat_and_feedback_and_destructive` (greeting, feedback-keyword, destructive → `None`).
- [ ] **Step 2 — run:** `uv run pytest bridge/tests/test_assistant.py -k classify_for_task -v` → FAIL (function undefined).
- [ ] **Step 3 — impl:** add `TaskProposalDraft` dataclass + `classify_for_task(message, *, context)` wrapping `classify_master_message` + threshold `GROVE_TASK_INTAKE_MIN_CONFIDENCE`; return `None` for feedback/destructive/question kinds. No store/post/pending.
- [ ] **Step 4 — run:** same command → PASS.
- [ ] **Step 5 — commit:** `feat(g2): pure classify_for_task task-intent detector (no side effects)`.

### Task 2: Free-chat → proposal in Slack assistant turn (guard-1 mutual exclusion)

**Files:** Modify `slack.py` (`_handle_assistant_turn` / `_handle_chat` entry, per Decision A); Test `test_slack.py`.

- [ ] **Step 1 — failing test:** `test_free_chat_task_intent_posts_confirm_and_no_answer` (task-like mention → confirm preview posted, `assistant_broker.handle_turn` NOT used for an answer, no `create_task`) and `test_free_chat_chit_chat_unchanged` (greeting → answer posted, no pending confirmation).
- [ ] **Step 2 — run:** `uv run pytest bridge/tests/test_slack.py -k free_chat -v` → FAIL.
- [ ] **Step 3 — impl:** at entry, call `classify_for_task`; if draft → `_build_intake_task_proposal(source="chat")` + `confirmations.create(command="task_create", ...)` + post preview (`requires_confirmation=True`) + `return`; else existing path.
- [ ] **Step 4 — run:** PASS.
- [ ] **Step 5 — commit:** `feat(g2): wire free-chat task detection to intake confirm (slack)`.

### Task 3: Thread link on create (guard-4) + no-auto-start (guard-7)

**Files:** Modify `slack.py` `_execute_task_create`; Test `test_slack.py`.

- [ ] **Step 1 — failing test:** `test_intake_create_links_thread_mode_task` (after confirm, `upsert_slack_thread(mode="task", task_id=...)` recorded for the origin thread) and `test_chat_task_has_no_assignee_not_autostarted`.
- [ ] **Step 2 — run:** `uv run pytest bridge/tests/test_slack.py -k intake_create_links -v` → FAIL.
- [ ] **Step 3 — impl:** after `store.create_task`, call `self.store.upsert_slack_thread(board=config.board, task_id=task.id, team_id=..., channel_id=..., thread_ts=..., mode="task", node=...)` using `proposal.slack`. Keep `status="ready"`, `assignee=None` for chat source.
- [ ] **Step 4 — run:** PASS.
- [ ] **Step 5 — commit:** `feat(g2): link origin thread to chat-created task (mode=task)`.

### Task 4: Idempotency + per-thread anti-spam (guards 2, 6)

**Files:** Modify `slack.py` (proposal entry); Test `test_slack.py`.

- [ ] **Step 1 — failing test:** `test_double_confirm_creates_single_task`, `test_existing_pending_confirmation_suppresses_second_proposal_same_thread`.
- [ ] **Step 2 — run:** `uv run pytest bridge/tests/test_slack.py -k "double_confirm or suppresses_second_proposal" -v` → FAIL.
- [ ] **Step 3 — impl:** before creating a pending confirmation, skip if an unconsumed pending exists for `(team,channel,thread_ts)`; rely on `consume_for_owner` single-use for double-confirm safety.
- [ ] **Step 4 — run:** PASS.
- [ ] **Step 5 — commit:** `feat(g2): per-thread proposal dedupe + idempotent confirm`.

### Task 5: Web free-chat proposal + confirm → create_task (guard-1, Decision E)

**Files:** Modify `assistant.py` (`handle_turn`, task-confirm branch) + `web_app.py` (`_handle_master_chat_confirm_request` dispatch); Test `test_assistant.py`, `test_web_app.py`.

- [ ] **Step 1 — failing test:** `test_web_master_chat_task_intent_returns_preview_no_answer`, `test_web_master_chat_confirm_task_creates_task_once`.
- [ ] **Step 2 — run:** `uv run pytest bridge/tests/test_web_app.py -k master_chat_task -v` → FAIL.
- [ ] **Step 3 — impl:** in `handle_turn`, if `classify_for_task` → task-preview response (distinct pending-kind, `requires_confirmation`); in confirm, dispatch task-proposal pending → `create_task` (+ thread link n/a for web), leaving decision-proposal branch intact.
- [ ] **Step 4 — run:** PASS.
- [ ] **Step 5 — commit:** `feat(g2): web free-chat task proposal + confirm to create_task`.

### Task 6: Full gate `pnpm check` + guard regression sweep

- [ ] Run `pnpm check` (Prettier/ESLint/tsc/Vitest/Ruff/mypy/pytest). Expected: PASS.
- [ ] Confirm guard tests present: double-routing, idempotency (task path), no-create-on-detection, thread-link, no-autostart, per-thread dedupe.
- [ ] Commit: `test(g2): guard regression coverage for free-chat intake`.

---

## 5. Self-review (writing-plans gate)

- **Spec coverage:** all 7 lead guards mapped to a mechanism + a named test (§2.3, §4). Scope limited to G2 free-chat intake; web-queue parity excluded per lead.
- **Placeholders:** none — file paths, function names, and confirm IDs are from verified reads.
- **Type consistency:** reuses real symbols (`SlackIntakeProposal`, `SlackConfirmationStore`, `_build_intake_task_proposal`, `_execute_task_create`, `upsert_slack_thread`, `classify_master_message`, `AssistantBroker.handle_turn`/`confirm_action`). New: `classify_for_task`, `TaskProposalDraft`, `GROVE_TASK_INTAKE_MIN_CONFIDENCE` — defined in Task 1 before use.
- **Open risks surfaced:** Decisions A–E require lead/advisor ruling before coding (esp. A = guard-3 placement, E = web confirm dual-branch).

**No execution until lead approves and advisor/master cross-check clears.**
