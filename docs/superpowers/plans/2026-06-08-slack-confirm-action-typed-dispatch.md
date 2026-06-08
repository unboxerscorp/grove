# Slack Confirm-Action: Typed Dispatch + Chat-Create-Staged Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Generalize the Slack bridge-native runtime's single-purpose "create-task confirm" into a **typed confirm-action** model (create / classify / transition / comment / dispatch), so the chat bot can _propose_ any human-list mutation but **apply nothing without an explicit human confirm** — preserving confirm-before-create, never exposing writes as LLM tools, applying stored fields verbatim, redacting per [R], and staged-aware.

**Architecture:** A frozen `ChatConfirmAction` value object captures the _exact_ proposed mutation (kind + target + fields). The existing `SlackConfirmationStore` (one-shot, owner/role-gated) carries it as a pending action. On the human confirm interaction, a single pure dispatcher `apply_chat_confirm_action(store, action, *, actor)` applies **only the stored fields** (no LLM re-interpretation) by routing on `kind` to existing store primitives (`create_task`, `set_task_status` CAS, `add_comment_to_task`). Chat-originated _create_ defaults to `status="staged"` behind a dark gui flag. LLM-callable tools stay **read-only**; the action types are never tools.

**Tech Stack:** Python bridge (`bridge/src/grove_bridge/`), SQLite store, Slack Block Kit confirm + `SlackConfirmationStore`, Gemini function-calling (read-only tools only). Verify with `uv run mypy src tests` + `uv run pytest` + `uv run ruff check/format`.

---

## Scope, decisions, and invariants (from lead, operator-approved Candidate A)

- **In scope:** (1) typed action model + dispatcher; (2) wire the `dispatch` action to the staged→ready gate (mirror web `POST /api/tasks/{id}/dispatch`); (3) chat-create → `status="staged"` wiring, **dark-gated** (decision 1).
- **Decision 1 (confirmed):** chat-created items land in `staged` (stack-then-gate), behind a default-OFF gui flag (no live behavior change until enabled).
- **Decision 2 (confirmed):** ask-human is board-inline (its gate stays the answer flow) — ask-human create keeps explicit status, NOT staged. The dispatcher honors an explicit status.
- **Invariants (must hold + be tested):**
  - **Writes are never LLM tools.** The LLM tool set stays read-only (`get_project_tasks`, …). Mutations are _proposals_ only.
  - **Apply uses stored fields verbatim** — the dispatcher reads the `ChatConfirmAction` captured at proposal time; it never re-reads or re-interprets LLM text at apply time.
  - **Confirm-before-create / human-approval:** apply fires only inside the confirm handler, via `SlackConfirmationStore.consume_for_owner` (one-shot) + actor role gate (operator/admin), scope-exact (target_task_id pinned).
  - **[R] redaction:** any text persisted/echoed at apply (comment, card) passes through `redact_secret_text`.
  - **Staged-aware:** `transition`/`dispatch` use `set_task_status(..., expected_status=...)` CAS; `dispatch` is staged→ready.

## Backend baseline (landed `9eeeca8`, read-only reference — do not re-implement)

- `staged` status: manual-status set + first board column + `staged→ready` transition; excluded from SUMMARY/MASTER_BOARD; task_wakeup fires only on `staged→ready`.
- `store.create_task(..., status="ready"[default])` keeps `ready` internally (`bridge/src/grove_bridge/store.py:308`). The staged default lives at the **endpoint/payload** layer (`web_app.py` `TaskCreatePayload.status` default `"staged"`, `:468`). So **chat-create must pass `status="staged"` explicitly** (do not change `create_task`'s default).
- `store.set_task_status(self, *, board, task_id, status, expected_status=None, …)` (`store.py:365`) — CAS; raises if `expected_status` mismatches current (`:419`).
- `store.add_comment_to_task(self, *, task_id, …)` (`store.py:1842`).
- Web dispatch (`POST /api/tasks/{id}/dispatch {assignee?, comment?}`, operator-gated): set assignee (executor-eligible) → add comment → `set_task_status(ready, expected_status="staged")` CAS; 409 if not staged. Mirror this logic for the Slack `dispatch` action (do not call the HTTP endpoint).
- `SlackConfirmationStore` (`slack.py:546`): `token_factory()` mints a one-shot `confirmation_id`; `consume_for_owner(confirmation_id, member_id=…)` → `(pending, error)` (owner/role gate). `SlackPendingCommand` (`slack.py`, frozen): `confirmation_id, command, args, event, actor, expires_at`.
- Chat proposal→confirm today: `_chat_bridge_runtime_task_preview` (`slack.py:2649`) builds the Block Kit card; the confirm handler applies it; `create_task` fires at `slack.py:1808`.

## File map

- **Create** `bridge/src/grove_bridge/chat_actions.py` — the typed action model + the pure dispatcher (one responsibility: define `ChatConfirmAction` + `apply_chat_confirm_action`; depends only on `store` + `auth_status.redact_secret_text`; **no Slack/LLM imports** so it is trivially unit-testable and reusable by web later).
- **Modify** `bridge/src/grove_bridge/slack.py` — carry a `ChatConfirmAction` on the pending confirm, route the confirm handler to `apply_chat_confirm_action`, and the proposal builder for non-create actions. Chat-create → staged wiring (dark flag).
- **Create** `bridge/tests/test_chat_actions.py` — unit tests for the model + dispatcher (no Slack).
- **Modify** `bridge/tests/test_chat_runtime_slack_hook.py` — confirm→apply integration tests (reuse harness; HOME isolated by conftest).
- **Reference only** `store.py`, `web_app.py` (dispatch logic to mirror), `chat_runtime.py` (read-only tools — unchanged).

## Open question for lead review (before coding the `classify` case)

`classify` semantics are ambiguous: is it (a) re-status between human-list buckets (`todo`/`feedback`/`ask_human` are statuses) via `set_task_status`, or (b) a metadata/label set? The `Task` dataclass has `status` + `metadata` (no `labels` field). **Recommendation:** model `classify` as a **status re-bucket** (`set_task_status` to an allowlisted target status, no `expected_status` since classify is free re-bucketing of a staged item) — this reuses an existing primitive and matches the staged stack-then-gate model. Confirm before Task 4.

---

## Task 1: Typed action model (`ChatConfirmAction`)

**Files:**

- Create: `bridge/src/grove_bridge/chat_actions.py`
- Test: `bridge/tests/test_chat_actions.py`

- [ ] **Step 1: Write the failing test**

```python
# bridge/tests/test_chat_actions.py
from __future__ import annotations

from grove_bridge.chat_actions import ChatConfirmAction


def test_action_is_frozen_value_object_with_kind_and_fields() -> None:
    action = ChatConfirmAction(
        kind="create",
        board="dev10",
        target_task_id=None,
        fields={"title": "ship", "body": "do it"},
    )
    assert action.kind == "create"
    assert action.board == "dev10"
    assert action.target_task_id is None
    assert action.fields["title"] == "ship"
    # frozen: cannot mutate (apply-verbatim guarantee starts at the type)
    import dataclasses

    try:
        action.kind = "transition"  # type: ignore[misc]
        raise AssertionError("expected FrozenInstanceError")
    except dataclasses.FrozenInstanceError:
        pass
```

- [ ] **Step 2: Run test to verify it fails** — `uv run pytest tests/test_chat_actions.py -v` → FAIL (module/class missing).

- [ ] **Step 3: Write minimal implementation**

```python
# bridge/src/grove_bridge/chat_actions.py
"""Typed confirm-action model + dispatcher for the bridge-native chat runtime.

A chat turn may PROPOSE a human-list mutation; nothing is applied until a human
confirms. This module captures the exact proposed mutation as an immutable value
object and applies it verbatim — it never re-interprets LLM text at apply time.
No Slack/LLM imports here (pure store-facing), so it is unit-testable in isolation.
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from typing import Literal

ChatActionKind = Literal["create", "classify", "transition", "comment", "dispatch"]


@dataclass(frozen=True)
class ChatConfirmAction:
    """The exact, human-confirmable mutation captured at proposal time.

    ``fields`` holds only the stored proposed values (title/body/status/assignee/
    comment/to_status/…). ``target_task_id`` is ``None`` for ``create`` and pinned
    (scope-exact) for every other kind.
    """

    kind: ChatActionKind
    board: str
    target_task_id: str | None
    fields: Mapping[str, object]
```

- [ ] **Step 4: Run test to verify it passes** — `uv run pytest tests/test_chat_actions.py -v` → PASS.

- [ ] **Step 5: Commit** — `git add bridge/src/grove_bridge/chat_actions.py bridge/tests/test_chat_actions.py && git commit -m "feat(chat): typed ChatConfirmAction value object"`

---

## Task 2: Dispatcher — `create` (staged-aware, dark-gated), with role gate + audit

**Files:**

- Modify: `bridge/src/grove_bridge/chat_actions.py`
- Test: `bridge/tests/test_chat_actions.py`

- [ ] **Step 1: Write the failing test** (uses a real tmp `SQLiteBoardStore`; HOME isolated by conftest)

```python
from pathlib import Path

from grove_bridge.chat_actions import (
    ChatConfirmAction,
    ChatActionDenied,
    apply_chat_confirm_action,
)
from grove_bridge.store import SQLiteBoardStore


def _actor(role: str = "operator") -> dict[str, str]:
    return {"member_id": "lead", "name": "lead", "role": role}


def test_create_action_applies_stored_fields_and_audits(tmp_path: Path) -> None:
    store = SQLiteBoardStore(tmp_path / "b.db")
    action = ChatConfirmAction(
        kind="create", board="dev10", target_task_id=None,
        fields={"title": "ship export", "body": "details", "status": "staged"},
    )
    result = apply_chat_confirm_action(store, action, actor=_actor())
    task = store.get_task(board="dev10", task_id=result["task_id"])
    assert task.title == "ship export"
    assert task.status == "staged"  # stored field applied verbatim
    audits = store.list_audit_events(board="dev10", action="chat.confirm.apply")
    assert len(audits) == 1


def test_apply_denies_non_operator_actor(tmp_path: Path) -> None:
    store = SQLiteBoardStore(tmp_path / "b.db")
    action = ChatConfirmAction(
        kind="create", board="dev10", target_task_id=None, fields={"title": "x"},
    )
    try:
        apply_chat_confirm_action(store, action, actor=_actor(role="viewer"))
        raise AssertionError("expected ChatActionDenied")
    except ChatActionDenied:
        pass
```

- [ ] **Step 2: Run test to verify it fails** — FAIL (`apply_chat_confirm_action`/`ChatActionDenied` missing).

- [ ] **Step 3: Write minimal implementation** (append to `chat_actions.py`)

```python
from grove_bridge.auth_status import redact_secret_text

_ALLOWED_ROLES = frozenset({"operator", "admin"})


class ChatActionDenied(Exception):
    """The confirming actor is not authorized, or the action failed its CAS guard.
    Callers surface a denial; they MUST NOT fall back to applying anything."""


def _require_role(actor: Mapping[str, object]) -> None:
    if str(actor.get("role")) not in _ALLOWED_ROLES:
        raise ChatActionDenied("confirm requires operator/admin")


def _field_str(fields: Mapping[str, object], key: str, default: str = "") -> str:
    value = fields.get(key)
    return value if isinstance(value, str) else default


def apply_chat_confirm_action(
    store: SQLiteBoardStore,
    action: ChatConfirmAction,
    *,
    actor: Mapping[str, object],
) -> dict[str, object]:
    """Apply exactly the stored action (no LLM re-interpretation). Role-gated,
    scope-exact, audited. Raises ChatActionDenied on auth/CAS failure (never a
    partial/fabricated apply)."""
    _require_role(actor)
    if action.kind == "create":
        result = _apply_create(store, action)
    else:  # other kinds added in later tasks
        raise ChatActionDenied(f"unsupported action kind: {action.kind}")
    store.add_audit_event(
        board=action.board,
        kind="audit.chat.confirm.apply",
        actor=dict(actor),
        action="chat.confirm.apply",
        target={"type": "task", "id": str(result.get("task_id"))},
        payload={"kind": action.kind},
    )
    return result


def _apply_create(store: SQLiteBoardStore, action: ChatConfirmAction) -> dict[str, object]:
    title = _field_str(action.fields, "title")
    if not title.strip():
        raise ChatActionDenied("create requires a title")
    task = store.create_task(
        board=action.board,
        title=redact_secret_text(title),
        body=redact_secret_text(_field_str(action.fields, "body")) or None,
        assignee=_field_str(action.fields, "assignee") or None,
        status=_field_str(action.fields, "status", "ready"),  # caller passes 'staged' (dark-gated, Task 6)
    )
    return {"task_id": task.id}
```

- [ ] **Step 4: Run test to verify it passes** — PASS.
- [ ] **Step 5: Commit** — `git commit -am "feat(chat): dispatcher create case (role-gated, staged-aware, redacted)"`

> Note: confirm `store.add_audit_event` signature (`grep -n "def add_audit_event" src/grove_bridge/store.py`) and `list_audit_events` filter shape; mirror an existing call site (e.g. `web_app.py` master-turn audit) verbatim.

---

## Task 3: Dispatcher — `transition`, `comment`, `dispatch` (CAS, staged→ready)

**Files:**

- Modify: `bridge/src/grove_bridge/chat_actions.py`
- Test: `bridge/tests/test_chat_actions.py`

- [ ] **Step 1: Write the failing tests**

```python
def test_transition_uses_cas_expected_status(tmp_path: Path) -> None:
    store = SQLiteBoardStore(tmp_path / "b.db")
    t = store.create_task(board="dev10", title="x", body=None, assignee=None, status="staged")
    action = ChatConfirmAction(
        kind="transition", board="dev10", target_task_id=t.id,
        fields={"to_status": "ready", "from_status": "staged"},
    )
    apply_chat_confirm_action(store, action, actor=_actor())
    assert store.get_task(board="dev10", task_id=t.id).status == "ready"


def test_transition_denied_on_cas_mismatch(tmp_path: Path) -> None:
    store = SQLiteBoardStore(tmp_path / "b.db")
    t = store.create_task(board="dev10", title="x", body=None, assignee=None, status="ready")
    action = ChatConfirmAction(
        kind="transition", board="dev10", target_task_id=t.id,
        fields={"to_status": "done", "from_status": "staged"},  # wrong expected
    )
    try:
        apply_chat_confirm_action(store, action, actor=_actor())
        raise AssertionError("expected ChatActionDenied (CAS)")
    except ChatActionDenied:
        pass


def test_comment_appends_redacted(tmp_path: Path) -> None:
    store = SQLiteBoardStore(tmp_path / "b.db")
    t = store.create_task(board="dev10", title="x", body=None, assignee=None, status="staged")
    secret = "xoxb-" + ("m" * 44)
    action = ChatConfirmAction(
        kind="comment", board="dev10", target_task_id=t.id,
        fields={"comment": f"see {secret}"},
    )
    apply_chat_confirm_action(store, action, actor=_actor())
    comments = store.list_comments_for_task(task_id=t.id)
    assert comments and secret not in comments[-1].body


def test_dispatch_sets_assignee_comment_and_staged_to_ready(tmp_path: Path) -> None:
    store = SQLiteBoardStore(tmp_path / "b.db")
    t = store.create_task(board="dev10", title="x", body=None, assignee=None, status="staged")
    action = ChatConfirmAction(
        kind="dispatch", board="dev10", target_task_id=t.id,
        fields={"assignee": "worker", "comment": "go"},
    )
    apply_chat_confirm_action(store, action, actor=_actor())
    task = store.get_task(board="dev10", task_id=t.id)
    assert task.status == "ready" and task.assignee == "worker"
```

- [ ] **Step 2: Run to verify fail** — FAIL (unsupported kinds raise/wrong).

- [ ] **Step 3: Implement** (extend `apply_chat_confirm_action`'s dispatch + add helpers; replace the `else: raise` branch)

```python
    if action.kind == "create":
        result = _apply_create(store, action)
    elif action.kind == "transition":
        result = _apply_transition(store, action)
    elif action.kind == "comment":
        result = _apply_comment(store, action)
    elif action.kind == "dispatch":
        result = _apply_dispatch(store, action)
    else:
        raise ChatActionDenied(f"unsupported action kind: {action.kind}")
```

```python
def _require_target(action: ChatConfirmAction) -> str:
    if not action.target_task_id:
        raise ChatActionDenied(f"{action.kind} requires a target task")
    return action.target_task_id


def _apply_transition(store: SQLiteBoardStore, action: ChatConfirmAction) -> dict[str, object]:
    task_id = _require_target(action)
    to_status = _field_str(action.fields, "to_status")
    expected = _field_str(action.fields, "from_status") or None
    try:
        store.set_task_status(
            board=action.board, task_id=task_id, status=to_status, expected_status=expected
        )
    except Exception as exc:  # CAS / invalid transition -> deny (never force)
        raise ChatActionDenied(f"transition failed: {exc}") from exc
    return {"task_id": task_id}


def _apply_comment(store: SQLiteBoardStore, action: ChatConfirmAction) -> dict[str, object]:
    task_id = _require_target(action)
    store.add_comment_to_task(
        task_id=task_id, body=redact_secret_text(_field_str(action.fields, "comment"))
    )
    return {"task_id": task_id}


def _apply_dispatch(store: SQLiteBoardStore, action: ChatConfirmAction) -> dict[str, object]:
    # Mirror web POST /api/tasks/{id}/dispatch: assignee -> comment -> staged->ready CAS.
    task_id = _require_target(action)
    assignee = _field_str(action.fields, "assignee") or None
    comment = _field_str(action.fields, "comment")
    try:
        if assignee:
            store.assign_task(board=action.board, task_id=task_id, assignee=assignee)
        if comment.strip():
            store.add_comment_to_task(task_id=task_id, body=redact_secret_text(comment))
        store.set_task_status(
            board=action.board, task_id=task_id, status="ready", expected_status="staged"
        )
    except Exception as exc:
        raise ChatActionDenied(f"dispatch failed: {exc}") from exc
    return {"task_id": task_id}
```

> Verify exact signatures before coding: `add_comment_to_task`, `set_task_status`, and the assign method (`grep -n "def assign_task\|def set_task_assignee" src/grove_bridge/store.py` — mirror the web `/dispatch` handler's assignee call). Confirm `list_comments_for_task` returns objects with `.body`.

- [ ] **Step 4: Run to verify pass** — PASS.
- [ ] **Step 5: Commit** — `git commit -am "feat(chat): dispatcher transition/comment/dispatch (CAS, staged->ready, redacted)"`

---

## Task 4: Dispatcher — `classify` (pending lead confirmation of semantics)

**Files:** `bridge/src/grove_bridge/chat_actions.py`, `bridge/tests/test_chat_actions.py`

> **Blocked on the Open Question above.** Recommended: `classify` = re-bucket a staged item's status to an allowlisted target (`todo`/`feedback`/`ask_human`/`staged`) via `set_task_status` (no `expected_status`). After lead confirms:

- [ ] **Step 1: failing test** — classify a staged item to `feedback`, assert status; classify to a non-allowlisted target → `ChatActionDenied`.
- [ ] **Step 2: run → FAIL.**
- [ ] **Step 3: implement** `_apply_classify` with an allowlist `frozenset({"todo","feedback","ask_human","staged"})`; reject others.
- [ ] **Step 4: run → PASS.** **Step 5: commit.**

---

## Task 5: Slack — carry `ChatConfirmAction` on the pending confirm + route confirm→dispatcher

**Files:** Modify `bridge/src/grove_bridge/slack.py`; Test `bridge/tests/test_chat_runtime_slack_hook.py`

- [ ] **Step 1: Write the failing integration test** (reuse the hook harness; inject a `_ProposalAdapter`-style adapter whose turn yields a non-create action proposal; confirm applies it via the typed dispatcher)

```python
def test_confirm_applies_typed_transition_action(tmp_path, monkeypatch):
    monkeypatch.setenv("HOME", str(tmp_path))  # belt-and-suspenders w/ conftest
    store = SQLiteBoardStore(tmp_path / "b.db")
    store.set_gui_feature_enabled(board="dev10", feature="chat_bridge_runtime", enabled=True)
    t = store.create_task(board="dev10", title="x", body=None, assignee=None, status="staged")
    # ... build connector with an operator command_config (see test_flag_on_runtime_task_proposal_uses_confirm_without_intake_flag),
    # inject an adapter whose proposal is a transition(target=t.id, to=ready, from=staged),
    # poll -> confirm card posted (no write yet), then handle_interaction(confirm) ->
    assert store.get_task(board="dev10", task_id=t.id).status == "ready"
    # and DB is unchanged BEFORE the confirm interaction (assert pre-confirm status == staged).
```

- [ ] **Step 2: run → FAIL** (confirm only knows create today).

- [ ] **Step 3: implement** — extend the pending model to carry the action and route on confirm:
  - Add an optional `action: ChatConfirmAction | None = None` field to the pending command path **or** a parallel `register_action(...)` on `SlackConfirmationStore` that stores a `ChatConfirmAction` keyed by the one-shot `confirmation_id` (prefer the latter — keeps `SlackPendingCommand` for slash-commands; the chat path stores actions). Reuse `token_factory()` + `consume_for_owner(...)` for the one-shot + owner gate.
  - In `_chat_bridge_runtime_task_preview` (`slack.py:2649`) and the proposal-build path: when the chat-master turn is a non-create proposal (or create), build a `ChatConfirmAction`, register it, and render the confirm card (chat-master-authored copy) referencing the `confirmation_id`.
  - In the confirm handler (`_handle_command_confirm`/`_handle_assistant_confirm`, `slack.py:1560/1621`): on consume, if a `ChatConfirmAction` is bound, call `apply_chat_confirm_action(self.store, action, actor=_slack_member_actor(...))`; on `ChatActionDenied`, post a chat-master-authored denial (no fabricated success); audit.
  - **Apply uses the stored action only** — never the LLM text at confirm time.

- [ ] **Step 4: run → PASS** (+ assert no LLM tool can mutate: keep `_chat_bridge_tools()` read-only; add a test asserting `[t.name for t in conn._chat_bridge_tools()]` contains no write verbs).
- [ ] **Step 5: commit.**

---

## Task 6: Chat-create → `status="staged"` (dark-gated, decision 1)

**Files:** Modify `bridge/src/grove_bridge/slack.py`; Test `bridge/tests/test_chat_runtime_slack_hook.py`

- [ ] **Step 1: failing test** — with a new dark flag `chat_create_staged` **enabled**, a chat create-proposal confirmed → task `status == "staged"`; with the flag **OFF (default)** → existing status (`ready`/explicit), proving zero live change by default.

```python
def test_chat_create_defaults_to_staged_only_when_flag_on(tmp_path, monkeypatch):
    # flag OFF (default): confirmed chat create -> status == "ready" (unchanged)
    # flag ON: confirmed chat create -> status == "staged"
    ...
```

- [ ] **Step 2: run → FAIL.**
- [ ] **Step 3: implement** — when building a _create_ `ChatConfirmAction` in `slack.py`, set `fields["status"]="staged"` iff `gui_feature_flags(board, ("chat_create_staged",))["chat_create_staged"]["enabled"] is True` (fail-closed, mirror `chat_bridge_runtime_enabled`); else leave unset (dispatcher default `ready`). ask-human proposals keep their explicit status (decision 2).
- [ ] **Step 4: run → PASS.** **Step 5: commit.**

> Confirm the gui-flag read pattern by mirroring `chat_runtime.chat_bridge_runtime_enabled` (fail-closed default OFF). The flag is **dark** — register it default-OFF; document it is not enabled until operator turns it on.

---

## Task 7: Full-gate verification + docs

- [ ] **Step 1:** `cd bridge && uv run ruff check . && uv run ruff format --check . && uv run mypy src tests && uv run pytest` → all green (full gate, per the adopted `mypy src tests` baseline; HOME-isolation conftest keeps chat tests off the live API).
- [ ] **Step 2:** Update `docs/design/HUMAN_LIST_REDESIGN.md` / `SLACK_BOT_LIST_PERMISSION_MODEL.md` with a one-line "implemented: typed confirm-action dispatcher (Slack), chat-create-staged dark-gated" pointer.
- [ ] **Step 3: commit.**

---

## Self-review

- **Spec coverage:** typed dispatcher (Tasks 1–4), dispatch integration (Task 3 `_apply_dispatch` mirrors web `/dispatch`), chat-create→staged dark-gated (Task 6), read-only-tools/write-not-LLM-tool (Task 5 Step 4 assertion), apply-verbatim (frozen action + dispatcher reads stored fields only), [R] (redact on create/comment/dispatch), staged-aware (CAS), confirm-before-create + one-shot + role gate (Task 5 reuse `SlackConfirmationStore`). ✓
- **Gaps / flagged for review:** (1) `classify` semantics (Open Question) — Task 4 blocked until confirmed; (2) exact store signatures (`add_audit_event`, `assign_task`/`set_task_assignee`, `add_comment_to_task`, `list_comments_for_task`, `set_task_status`) must be verified against `store.py` before each impl step (notes added inline) — these are mechanical confirmations, not design changes; (3) whether to store the `ChatConfirmAction` on `SlackPendingCommand` vs a parallel `SlackConfirmationStore.register_action` (Task 5 recommends the parallel store to avoid disturbing slash-commands).
- **Type consistency:** `ChatConfirmAction(kind, board, target_task_id, fields)`, `apply_chat_confirm_action(store, action, *, actor) -> dict`, `ChatActionDenied` used consistently across Tasks 1–6. ✓
- **Safety:** every mutation path raises `ChatActionDenied` (never partial/forced) on auth/CAS failure; nothing applies without the one-shot human confirm; flag-OFF default = zero live change.
