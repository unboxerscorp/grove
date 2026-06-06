# G2 Free-Chat → Task Intake Implementation Plan

> **Status: DESIGN APPROVED (option ii) — advisor + master cross-check PASSED. Implementation sequenced & gated by lead review + master deploy approval. NOT deployed.**
> Owner: `chat-worker` (G2/G3 slice). Updated 2026-06-06 to option (ii) per lead `[G2 해소: 옵션(ii) 확정]` + grove-master `[G2/G3 master cross-check]`.
> **For agentic workers:** REQUIRED SUB-SKILL when sequenced: superpowers:subagent-driven-development or superpowers:executing-plans. Steps use `- [ ]` tracking.

> **ADDENDUM 2026-06-06 (post-364b6df + HARD REQUIREMENT + chat-master re-target):**
> (1) The core landed as commit `364b6df` = FOUNDATION (lead: harden, do not rewrite). This plan's
> Task 1–2 are largely realized there; remaining = hardening (Caveat-2 exception-safety, Caveat-1
> non-blocking test, threshold **0.75→0.8**, retry-idempotency, thread-link, anti-spam) — **queued**
> until grove-master stabilizes `slack.py`; flip-gate = caveats green + lead review + master deploy.
> (2) Operator HARD REQUIREMENT now binds: **all user-facing text = chat-master-generated**; the
> bridge may not author the confirm card or judge tasks alone (no creation from deterministic
> classification/template alone). `classify_for_task` is demoted to an internal pre-filter at most;
> the confirm card + task judgment come from chat-master's structured turn result. See
> `docs/design/CHAT_MASTER_INTAKE_RETARGET.md` §1a, §6, §6a. Sections below predate this and are
> superseded where they assume bridge-authored preview text.

**Goal:** When a user free-chats grove-master (Slack mention or web chat) and the message is a probable _new task_, surface a confirm card; create a board task **only** on explicit human confirm — never auto-create, never double-route.

**Architecture (option ii):** Live Slack runs `--route-chat-to-node` (pid 67302, grove-master confirmed), so the live chat path is the **durable queue async worker** `_process_node_chat_queue_item`, not the socket handler. Add one **pure, side-effect-free, exception-safe** detector `classify_for_task(...)` in `assistant.py`. Call it inside the worker (Slack) and inside `AssistantBroker.handle_turn` (web), so a message takes exactly one path: **task-detected → confirm card (no node/master answer)**, XOR **chit-chat → existing node/master answer route**. Reuse the existing slash-command intake primitive for the confirm + creation (`SlackIntakeProposal` → `SlackConfirmationStore` → `handle_interaction`/`confirm <id>` → `_execute_task_create` → `store.create_task`). The only board write is on the discrete **confirm event** — never the per-message path.

**Tech Stack:** Python (`bridge/src/grove_bridge/{assistant,slack,web_app}.py`), `SQLiteBoardStore`, Slack Socket Mode, FastAPI, pytest. Verification gate: `pnpm check`. Targeted checks during dev: `uv run pytest bridge/tests/...`.

**Out of scope (separate work):** web-chat queue parity/durability (lead: "별개"); G5 web-chat history (shipped: `append_master_chat_message`/`list_master_chat_messages`); any change to the live Slack/web → grove-master route or chat-master handoff (approval-gated); new `chat-master` node topology (operator-owned Model B); project-select UI + worktree/branch natural-language Block Kit fields (deferred per lead); real Block Kit button rendering (MVP = text-confirm first).

---

## 1. Verified current architecture

| Surface                                    | Entry                                                                                                                                                                                                                                                                                             | Classifier today                                       | Task path today                                                                                                                                                                                                                                                     |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Slack (LIVE, `--route-chat-to-node`)**   | socket `listener` (slack.py:2753) acks → `handle_event` (858) → `_handle_chat` (2230) **enqueues `slack_chat_queue`** + posts working notice; daemon `node_chat_queue_thread` (2636) → `poll_node_chat_queue` (2267) → `_process_node_chat_queue_item` (2291) → `chat_facade.send` (node answers) | **none** in worker                                     | none from free chat                                                                                                                                                                                                                                                 |
| **Web**                                    | `POST /api/master/chat` → `_handle_master_chat_request` (web_app.py:5956) → `AssistantBroker.handle_turn` (sync, request thread)                                                                                                                                                                  | `classify_master_message` inside broker                | none; `/api/master/chat/confirm` → `confirm_action` creates a **decision proposal**, not a task                                                                                                                                                                     |
| **Slack slash cmd** `/bug /feedback /task` | `_handle_intake_command` (1348) → `_preview_intake_task` (1419) → `_build_intake_task_proposal` (3135) → `confirmations.create(command="task_create")`                                                                                                                                            | `SlackIntentClassification` (confidence 1.0, explicit) | **YES** → `handle_interaction` (892) buttons `grove_intake_confirm`/`grove_intake_answer_only` OR `confirm <id>` → `_handle_command_confirm` (1462) → `consume_for_owner` → `_execute_pending_command` (1652) → `_execute_task_create` (1674) → `store.create_task` |

Key facts:

- `classify_master_message` (master.py:336) is **deterministic, keyword-based, no LLM** (µs), zero I/O. Kinds: `unsupported / feedback_route / workflow_setup / capability_question / node_question / project_question`. `ACTION_KEYWORDS` (만들/생성/추가/create/add/setup/assign…) → `workflow_setup`; `FEEDBACK_KEYWORDS` → `feedback_route`. **No "new board task" intent yet.** master.py is **read-only / not in scope.**
- `_process_node_chat_queue_item` already has the idempotency envelope: `response_text = item.response_text; if response_text is None: <send>` then `store_slack_chat_message_response` (cache) / `defer` / `fail` / `complete`. Detection slots **inside** the `if response_text is None:` block so retries reuse the cached card and never re-detect/re-propose.
- `INTAKE_ANSWER_ONLY_ACTION_ID` ("answer only: no task created", slack.py:48 / handle_interaction:960) already encodes guard-1 (reject proposal → plain answer).
- `_execute_task_create` writes to `config.board` (dev10) with `metadata.intake.source`; it does **not** currently link the origin thread → G2 adds `upsert_slack_thread(mode="task", task_id=...)`.
- `SlackConfirmationStore` (542) is in-memory, TTL'd, owner-checked (`consume_for_owner`), single-use (`pop`) → natural idempotency + per-confirmation dedupe. (In-memory pendings do not survive a bridge restart — same limitation as the existing slash intake; acceptable for MVP, noted §6.)
- `_build_intake_task_proposal` (3135) takes a `SlackEvent` + `SlackIntentClassification`; in the worker we reconstruct a minimal `SlackEvent` from the queue item (`team_id/channel_id/user_id/text/message_ts/thread_ts`).

**The gap = one wire:** free-chat → deterministic task detection → existing proposal/confirm/`create_task`, mutually exclusive with the answer route. No new task-creation machinery, no new confirm store, no new node, no route change.

---

## 2. Design (option ii)

### 2.1 Shared detector — pure, non-blocking, exception-safe (`assistant.py`)

`classify_for_task(message: str, *, context) -> TaskProposalDraft | None`:

- Wraps `classify_master_message(message)` (reuse) + a conservative G2 task-intent rule. Returns a `TaskProposalDraft` (title/body/intent/labels/confidence/reason) **only** when the message is a probable _new task_ AND `confidence >= GROVE_TASK_INTAKE_MIN_CONFIDENCE` (conservative default **0.8**); else `None`.
- **Caveat 1 — PROVABLY non-blocking (lead):** zero I/O — no `store`, no network, no subprocess, no LLM. Enforced by a test that injects a `store` double raising on **any** attribute/method access; `classify_for_task` must return without touching it. (`context` is accepted only for signature symmetry / future redaction; the MVP body uses only `message`.)
- **Caveat 2 — EXCEPTION-SAFE (lead):** call sites wrap it `try/except Exception: draft=None` and **fall through to the normal answer route**. A detector raising must never propagate into the worker loop or socket handler, never wedge, never drop the turn. Test: monkeypatch the detector to raise → worker still answers via `chat_facade.send`, item completes, no exception escapes.
- Destructive/injection/feedback/questions → `None` (keep their existing route; no double-handling).

### 2.2 Surface wiring (mutually exclusive — guard-1)

| Surface          | Detection site                                                                                     | If task-detected                                                                                                                                                                                                   | If `None` (chit-chat)                        |
| ---------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------- |
| **Slack (live)** | `_process_node_chat_queue_item`, inside `if response_text is None:`, **before** `chat_facade.send` | build proposal + create pending (`SlackConfirmationStore`) + set `response_text` = confirm-card text → cache via `store_slack_chat_message_response` → **skip `chat_facade.send`**; normal delivery posts the card | unchanged: `chat_facade.send` → node answers |
| **Web**          | `AssistantBroker.handle_turn` (request thread — no socket heartbeat)                               | return task-preview `MasterChatResponse` (distinct pending-kind), `requires_confirmation`                                                                                                                          | unchanged: forward to master, answer         |

Creation (board write) happens **only** on the discrete confirm event — Slack `handle_interaction`/`_handle_command_confirm` → `_execute_task_create`; Web `/api/master/chat/confirm` → task branch → `create_task`. Confirm events are low-frequency discrete actions (the accepted board-write site, identical to existing slash intake), never the per-message hot path.

### 2.3 Guard → mechanism mapping (all approved)

| #   | Guard                                                                     | Mechanism (option ii)                                                                                                                                                                                                                                                                                                                                                    |
| --- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | **Zero double-routing** (1 msg = chit-chat XOR task)                      | Worker branches on `classify_for_task`: task → proposal + skip `chat_facade.send`; chit-chat → node answer. `answer_only` button reverts a proposal to an answer. Test: task-detected item posts a card and `chat_facade.send` is **not** called; chit-chat item answers and creates **no** pending.                                                                     |
| 2   | **`slack_chat_queue` idempotency + task-path test**                       | Detection runs only when `item.response_text is None`; card text is cached via `store_slack_chat_message_response` so retries redeliver, never re-detect/re-propose. Queue keys `(team,channel,thread_ts/message_ts)` unchanged. `consume_for_owner` single-use → double-confirm = one task. Tests: re-processed item → one proposal/one post; confirm twice → one task. |
| 3   | **Detection/creation off socket handler; worker only; preserve watchdog** | Detection in the daemon worker `_process_node_chat_queue_item`; **nothing added to `handle_event`/socket heartbeat**; socket-reconnect/self-exit watchdog (2647+) untouched. Board write only on the discrete confirm event. Caveats 1+2 keep the worker non-blocking & wedge-proof.                                                                                     |
| 4   | **Board-write scope dev10 + thread link**                                 | `create_task(board=config.board)` (dev10) unchanged. **Add** `upsert_slack_thread(mode="task", task_id=task.id, ...)` in `_execute_task_create` from `proposal.slack`. Per-thread isolation preserved (keys unchanged).                                                                                                                                                  |
| 5   | **CONFIRM-GATES-CREATION (0 auto-create)**                                | Detector + proposal building have **no** create path. `create_task` reachable only via `consume_for_owner` + operator/admin role + `_intake_enabled`. Test: detection alone never calls `create_task`.                                                                                                                                                                   |
| 6   | **Per-thread dedupe / conservative confidence**                           | Threshold `GROVE_TASK_INTAKE_MIN_CONFIDENCE=0.8`. Anti-spam: if an unconsumed pending exists for `(team,channel,thread_ts)`, skip proposing and fall through to the node answer (one action per message). Test: two task-like msgs in a thread → one live proposal.                                                                                                      |
| 7   | **Chat-origin task: no auto-start before explicit assignment**            | Created task `status="ready"`, `assignee=None`; metadata `intake.source="chat"`. Coordinate with task-worker's auto-start model (chat-origin requires explicit assignment). Test: created task has no assignee, not auto-started.                                                                                                                                        |

---

## 3. Resolved decisions (cross-check)

- **A. Slack path — RESOLVED → (ii).** Live = `--route-chat-to-node` (pid 67302). Detection in `_process_node_chat_queue_item`, not the socket handler. ✅ advisor + master.
- **B. Task-intent + threshold — RESOLVED.** Conservative threshold `0.8`; task-intent = `workflow_setup`/action-keyword class above threshold; `feedback_route`, capability/node/project questions, destructive/injection → `None` (unchanged routes).
- **C. Confirm UI — RESOLVED.** MVP = text preview + `confirm <id>` (reuse `_preview_intake_task`). Real Block Kit buttons = fast follow.
- **D. Canonical fields — RESOLVED (deferred).** Ship title/body/intent + board=dev10. `project`-select + worktree/branch natural-language = follow-up.
- **E. Web confirm — RESOLVED.** Distinct pending-kind so `/api/master/chat/confirm` dispatches chat task-proposals → `create_task`, leaving the decision-proposal branch intact.

---

## 4. Implementation tasks (TDD, bite-sized) — execute only when lead sequences

> Each task: write failing test → run (fail) → minimal impl → run (pass) → commit. Targeted checks only; full `pnpm check` at the end. All tests in `bridge/tests/`.

### Task 1: Pure, non-blocking, exception-safe `classify_for_task`

**Files:** Modify `assistant.py`; Test `test_assistant.py`.

- [ ] **Step 1 — failing tests:** `test_classify_for_task_draft_for_task_intent` (a "create/만들" msg ≥0.8 → draft with title/body/intent); `test_classify_for_task_none_for_chitchat_feedback_destructive_questions`; **`test_classify_for_task_is_nonblocking_zero_io`** (inject a `store` double raising on any access → returns, never touches it); **`test_classify_for_task_caller_falls_through_on_exception`** (detector raising is contained — asserted at call sites in Tasks 2/5; here assert the detector's own purity).
- [ ] **Step 2 — run:** `uv run pytest bridge/tests/test_assistant.py -k classify_for_task -v` → FAIL.
- [ ] **Step 3 — impl:** add `TaskProposalDraft` dataclass + `classify_for_task` wrapping `classify_master_message` + `GROVE_TASK_INTAKE_MIN_CONFIDENCE` (0.8). Body uses only `message`; touches no I/O. Return `None` for non-task kinds.
- [ ] **Step 4 — run:** PASS.
- [ ] **Step 5 — commit:** `feat(g2): pure non-blocking classify_for_task task-intent detector`.

### Task 2: Slack worker detection → proposal (guards 1, 3) + exception-safety

**Files:** Modify `slack.py` `_process_node_chat_queue_item` (+ a `_build_chat_intake_proposal` helper / minimal `SlackEvent` from queue item); Test `test_slack.py`.

- [ ] **Step 1 — failing tests:** `test_worker_task_intent_posts_confirm_and_skips_node_send` (task-like item → confirm card posted, `chat_facade.send` NOT called, no `create_task`); `test_worker_chitchat_unchanged` (greeting → `chat_facade.send` answers, no pending); **`test_worker_detector_exception_falls_through_to_node_answer`** (detector raises → `chat_facade.send` still answers, item completes, no raise).
- [ ] **Step 2 — run:** `uv run pytest bridge/tests/test_slack.py -k "worker_task_intent or worker_chitchat or worker_detector_exception" -v` → FAIL.
- [ ] **Step 3 — impl:** inside `if response_text is None:`, `try: draft = classify_for_task(item.text, context=...) except Exception: draft=None`. If draft → build proposal, `confirmations.create(command="task_create", ...)`, set `response_text` = preview text, `store_slack_chat_message_response`, skip `chat_facade.send`. Else existing path.
- [ ] **Step 4 — run:** PASS.
- [ ] **Step 5 — commit:** `feat(g2): detect free-chat task intent in durable queue worker (xor, exception-safe)`.

### Task 3: Idempotency + per-thread anti-spam (guards 2, 6)

**Files:** Modify `slack.py` (worker proposal branch); Test `test_slack.py`.

- [ ] **Step 1 — failing tests:** `test_worker_reprocess_item_no_duplicate_proposal` (response_text cached → redeliver, no second pending); `test_existing_pending_suppresses_second_proposal_same_thread` (second task-like msg in thread → falls through to node answer); `test_double_confirm_creates_single_task`.
- [ ] **Step 2 — run:** `uv run pytest bridge/tests/test_slack.py -k "reprocess_item or suppresses_second or double_confirm" -v` → FAIL.
- [ ] **Step 3 — impl:** detection guarded by `response_text is None`; skip proposing if an unconsumed pending exists for `(team,channel,thread_ts)`; rely on `consume_for_owner` single-use.
- [ ] **Step 4 — run:** PASS.
- [ ] **Step 5 — commit:** `feat(g2): idempotent worker proposal + per-thread anti-spam`.

### Task 4: Thread link + no-auto-start (guards 4, 7)

**Files:** Modify `slack.py` `_execute_task_create`; Test `test_slack.py`.

- [ ] **Step 1 — failing tests:** `test_intake_create_links_thread_mode_task`; `test_chat_origin_task_ready_no_assignee`.
- [ ] **Step 2 — run:** `uv run pytest bridge/tests/test_slack.py -k "links_thread or chat_origin_task" -v` → FAIL.
- [ ] **Step 3 — impl:** after `store.create_task`, `self.store.upsert_slack_thread(board=config.board, task_id=task.id, team_id=…, channel_id=…, thread_ts=…, mode="task", node=…)` from `proposal.slack`. Keep `status="ready"`, `assignee=None` for chat source.
- [ ] **Step 4 — run:** PASS.
- [ ] **Step 5 — commit:** `feat(g2): link origin thread to chat-created task (mode=task), no auto-start`.

### Task 5: Web free-chat proposal + confirm → create_task (guard 1, Decision E)

**Files:** Modify `assistant.py` (`handle_turn` task-preview, distinct pending-kind) + `web_app.py` (`_handle_master_chat_confirm_request` dual-branch dispatch); Test `test_assistant.py`, `test_web_app.py`.

- [ ] **Step 1 — failing tests:** `test_web_chat_task_intent_returns_preview_no_answer`; `test_web_chat_confirm_task_creates_task_once`; `test_web_chat_detector_exception_falls_through_to_answer`.
- [ ] **Step 2 — run:** `uv run pytest bridge/tests/test_web_app.py -k "web_chat_task or web_chat_confirm or web_chat_detector" -v` → FAIL.
- [ ] **Step 3 — impl:** in `handle_turn`, `try: draft = classify_for_task(...) except Exception: draft=None`; draft → task-preview (distinct pending-kind, `requires_confirmation`). Confirm dual-branch: task-proposal pending → `create_task`; existing → decision proposal (untouched).
- [ ] **Step 4 — run:** PASS.
- [ ] **Step 5 — commit:** `feat(g2): web free-chat task proposal + confirm dual-branch to create_task`.

### Task 6: Full gate + guard regression sweep

- [ ] `pnpm check` (Prettier/ESLint/tsc/Vitest/Ruff/mypy/pytest) → PASS.
- [ ] Confirm guard coverage present: xor, worker-not-socket placement, non-blocking assertion, exception fall-through, queue idempotency, per-thread dedupe, no-create-on-detection, thread-link, no-autostart, web dual-branch.
- [ ] Commit: `test(g2): guard regression coverage for free-chat intake`.

---

## 5. Test → guard matrix

- Guard 1: `test_worker_task_intent_posts_confirm_and_skips_node_send`, `test_worker_chitchat_unchanged`, `test_web_chat_task_intent_returns_preview_no_answer`
- Guard 2: `test_worker_reprocess_item_no_duplicate_proposal`, `test_double_confirm_creates_single_task`, `test_web_chat_confirm_task_creates_task_once`
- Guard 3 (+ caveats 1/2): `test_classify_for_task_is_nonblocking_zero_io`, `test_worker_detector_exception_falls_through_to_node_answer`, `test_web_chat_detector_exception_falls_through_to_answer`
- Guard 4: `test_intake_create_links_thread_mode_task`
- Guard 5: `test_classify_for_task_*` (no create) + detection-only assertions in worker/web tests
- Guard 6: `test_existing_pending_suppresses_second_proposal_same_thread`
- Guard 7: `test_chat_origin_task_ready_no_assignee`

---

## 6. Known limitations / follow-ups (flagged, out of MVP scope)

- In-memory `SlackConfirmationStore` pendings do not survive bridge restart (same as existing slash intake); a restart between proposal and confirm loses the pending. Persisting pendings = follow-up.
- MVP confirm is text + `confirm <id>`; real Block Kit buttons = fast follow.
- Canonical `project`-select + worktree/branch natural-language fields deferred.
- Confirm-owner model: pending.actor = original chatter (mirrors slash intake owner check); if "any operator may confirm" is desired, adjust `consume_for_owner` usage — confirm with lead.

## 7. Self-review (writing-plans gate)

- **Spec coverage:** all 7 guards + both lead caveats mapped to a mechanism and a named test (§2.3, §4, §5).
- **Placeholders:** none — paths/symbols/IDs from verified reads.
- **Type consistency:** reuses real symbols (`_process_node_chat_queue_item`, `store_slack_chat_message_response`, `SlackIntakeProposal`, `SlackConfirmationStore`, `_build_intake_task_proposal`, `_execute_task_create`, `upsert_slack_thread`, `classify_master_message`, `AssistantBroker.handle_turn`/`confirm_action`). New: `classify_for_task`, `TaskProposalDraft`, `GROVE_TASK_INTAKE_MIN_CONFIDENCE` — defined in Task 1 before use.

**No execution until lead sequences implementation; no deploy before lead review + master deploy approval.**

---

## 8. READY-TO-APPLY: Caveat-1/2 hardening of 364b6df (awaiting slack.py window)

> Lane confirmed by lead (2026-06-06): predicate = grove-master; **my lane = G2 Caveat-1/2 + caveat tests**.
> Intake is DARK again (`gui_features.intake={enabled:false,configured:true}`) → NORMAL priority, but
> **Caveat-2 green is the flip-gate precondition** before any re-enable. slack.py/assistant.py are clean/
> committed; **hold edits until lead opens the window**, then apply atomically + run targeted tests +
> report diff (lead commits). Already covered by existing `test_chat_routing_task_like_message_posts_intake_confirm_before_node_route`
> (slack.py test ~1292): guard-1 XOR (`chat.calls==[]`), confirm-gates-creation, guard-7 (`assignee is None`).
> Out of this lane (noted follow-ups): guard-4 thread-link, guard-2 retry-idempotency, guard-6 per-thread anti-spam.

### 8a. Caveat-2 — exception-safe detector (slack.py `_process_node_chat_task_intake` ~2332)

Wrap detection+preview-build so any exception falls through to the normal node answer route (never
propagate into the queue worker / drop the turn). Ops-log only; never user-facing.

```python
        actor = self._assistant_member(item.user_id)
        if actor is None or actor.role not in {"admin", "operator"}:
            return False
        try:
            draft = classify_for_task(item.text)
            if draft is None:
                return False
            event = _slack_event_from_chat_queue_item(item)
            classification = SlackIntentClassification(
                intent="task_request",
                confidence=draft.confidence,
                title=draft.title,
                summary=draft.body,
                labels=("task", "slack-chat"),
                reason=draft.reason,
            )
            preview = self._preview_intake_task(
                event=event,
                actor=actor,
                classification=classification,
            )
        except Exception as exc:  # Caveat-2: detector/preview failure -> answer route
            LOGGER.warning(
                "Slack chat task intake detection failed; falling back to answer route: %s",
                _safe_log_error(exc),
            )
            return False
        if preview is None:
            return False
        # (unchanged) post preview + complete/defer ...
```

### 8b. Caveat-1 test — classify_for_task is zero-I/O (test_assistant.py)

`classify_for_task(message)` takes no store, so prove zero net/subprocess I/O by making them raise.
Add `import urllib.request` at top.

```python
def test_classify_for_task_is_nonblocking_zero_io(monkeypatch: pytest.MonkeyPatch) -> None:
    def _boom(*args: object, **kwargs: object) -> object:
        raise AssertionError("classify_for_task performed I/O")

    monkeypatch.setattr(subprocess, "run", _boom)
    monkeypatch.setattr(urllib.request, "urlopen", _boom)
    # Pure, deterministic classification straight from the message — no I/O.
    assert classify_for_task("task: add board export") is not None
    assert classify_for_task("summarize status") is None
```

### 8c. Caveat-2 test — detector raise falls through to node answer (test_slack.py)

Model on `test_chat_routing_task_like_message_posts_intake_confirm_before_node_route` harness.

```python
def test_chat_routing_task_detector_exception_falls_through_to_node_answer(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    store, slack, chat = _intake_connector_fixtures()  # same setup as the routing test
    connector = SlackConnector(
        store=store, slack_client=slack, chat_facade=chat,
        human_gate=HumanGateConfig(board="main", channel="C123"),
        chat_route=ChatRouteConfig(default_node="grove-master"),
        command_config=SlackCommandConfig(
            board="main",
            members={"UOP": SlackCommandMember("member-op", "olivia", "operator")},
            intake_enabled=True,
        ),
        assistant_broker=FakeAssistantBroker("assistant should not run"),
        route_chat_to_node=True,
    )

    def _boom(_text: str) -> object:
        raise RuntimeError("detector blew up")

    monkeypatch.setattr("grove_bridge.slack.classify_for_task", _boom)
    connector.handle_event(SlackEvent(team="T1", channel="C123", user="UOP",
        text="<@BOT> task add board export", ts="111.222", thread_ts=None,
        event_type="app_mention"))

    assert connector.poll_node_chat_queue() == 1   # no exception escapes
    assert chat.calls != []                        # fell through to node answer route
    assert store.list_tasks(board="main") == []    # no task/proposal created
    assert store.list_due_slack_chat_messages(board="main", now=9999999999,
        running_stale_before=9999999999, limit=10) == []   # item completed, not stuck
```

(Finalize fixture/helper names against test_slack.py at apply time.)

### 8d. Threshold 0.75 → 0.8 (chat-master-owned semantics) + existing-test update

assistant.py: `GROVE_TASK_INTAKE_MIN_CONFIDENCE = 0.8`. Update `test_classify_for_task_requires_explicit_task_intake`
for two-way coverage (chat-master): conf<0.8 & no explicit prefix → `None`; explicit prefix → draft.

```python
def test_classify_for_task_requires_explicit_task_intake() -> None:
    # Conservative (0.8): action-keyword without an explicit prefix routes to answer.
    assert classify_for_task("task add board export") is None
    # Explicit prefix is a strong signal -> draft.
    draft = classify_for_task("task: add board export")
    assert draft is not None
    assert draft.title == "board export"
    assert classify_for_task("summarize status") is None
    assert classify_for_task("feedback simplify setup") is None
```

### 8e. Apply procedure (at window)

1. Apply 8a (slack.py), 8d (assistant.py const) — atomic with their tests 8b/8c/8d.
2. `uv run pytest bridge/tests/test_assistant.py -k "classify_for_task" -q` and
   `uv run pytest bridge/tests/test_slack.py -k "task_detector_exception or routing_task_like" -q` → green.
3. Report diff to lead → lead commits. Flip-gate: Caveat-2 green recorded before any intake re-enable.
