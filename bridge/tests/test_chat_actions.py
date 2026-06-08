from __future__ import annotations

import dataclasses
from pathlib import Path

import pytest

from grove_bridge.chat_actions import (
    ChatActionDenied,
    ChatConfirmAction,
    apply_chat_confirm_action,
)
from grove_bridge.store import SQLiteBoardStore


def _actor(role: str = "operator") -> dict[str, str]:
    return {"member_id": "lead", "name": "lead", "role": role}


# --- Task 1: frozen value object ------------------------------------------- #
def test_action_is_frozen_value_object() -> None:
    action = ChatConfirmAction(
        kind="create", board="dev10", target_task_id=None, fields={"title": "ship"}
    )
    assert action.kind == "create"
    assert action.fields["title"] == "ship"
    with pytest.raises(dataclasses.FrozenInstanceError):
        action.kind = "transition"  # type: ignore[misc]


# --- Task 2: create (role-gated, staged-aware, audited) -------------------- #
def test_create_applies_stored_fields_and_audits(tmp_path: Path) -> None:
    store = SQLiteBoardStore(tmp_path / "b.db")
    action = ChatConfirmAction(
        kind="create",
        board="dev10",
        target_task_id=None,
        fields={"title": "ship export", "body": "details", "status": "staged"},
    )
    result = apply_chat_confirm_action(store, action, actor=_actor())
    task = store.get_task(board="dev10", task_id=str(result["task_id"]))
    assert task.title == "ship export"
    assert task.status == "staged"  # stored field applied verbatim
    audits = store.list_audit_events(board="dev10", action="chat.confirm.apply")
    assert len(audits) == 1


def test_apply_denies_non_operator_actor(tmp_path: Path) -> None:
    store = SQLiteBoardStore(tmp_path / "b.db")
    action = ChatConfirmAction(
        kind="create", board="dev10", target_task_id=None, fields={"title": "x"}
    )
    with pytest.raises(ChatActionDenied):
        apply_chat_confirm_action(store, action, actor=_actor(role="viewer"))


def test_create_requires_title(tmp_path: Path) -> None:
    store = SQLiteBoardStore(tmp_path / "b.db")
    action = ChatConfirmAction(
        kind="create", board="dev10", target_task_id=None, fields={"title": "   "}
    )
    with pytest.raises(ChatActionDenied):
        apply_chat_confirm_action(store, action, actor=_actor())


# --- Task 3: transition / comment / dispatch ------------------------------ #
def test_transition_uses_cas_expected_status(tmp_path: Path) -> None:
    store = SQLiteBoardStore(tmp_path / "b.db")
    t = store.create_task(board="dev10", title="x", body=None, assignee=None, status="staged")
    action = ChatConfirmAction(
        kind="transition",
        board="dev10",
        target_task_id=t.id,
        fields={"to_status": "ready", "from_status": "staged"},
    )
    apply_chat_confirm_action(store, action, actor=_actor())
    assert store.get_task(board="dev10", task_id=t.id).status == "ready"


def test_transition_denied_on_cas_mismatch(tmp_path: Path) -> None:
    store = SQLiteBoardStore(tmp_path / "b.db")
    t = store.create_task(board="dev10", title="x", body=None, assignee=None, status="ready")
    action = ChatConfirmAction(
        kind="transition",
        board="dev10",
        target_task_id=t.id,
        fields={"to_status": "done", "from_status": "staged"},  # wrong expected
    )
    with pytest.raises(ChatActionDenied):
        apply_chat_confirm_action(store, action, actor=_actor())


def test_comment_appends_redacted(tmp_path: Path) -> None:
    store = SQLiteBoardStore(tmp_path / "b.db")
    t = store.create_task(board="dev10", title="x", body=None, assignee=None, status="staged")
    secret = "xoxb-" + ("m" * 44)
    action = ChatConfirmAction(
        kind="comment", board="dev10", target_task_id=t.id, fields={"comment": f"see {secret}"}
    )
    apply_chat_confirm_action(store, action, actor=_actor())
    comments = store.list_comments_for_task(task_id=t.id)
    assert comments and secret not in comments[-1].body


def test_dispatch_sets_assignee_comment_and_staged_to_ready(tmp_path: Path) -> None:
    store = SQLiteBoardStore(tmp_path / "b.db")
    t = store.create_task(board="dev10", title="x", body=None, assignee=None, status="staged")
    action = ChatConfirmAction(
        kind="dispatch",
        board="dev10",
        target_task_id=t.id,
        fields={"assignee": "worker", "comment": "go"},
    )
    apply_chat_confirm_action(store, action, actor=_actor())
    task = store.get_task(board="dev10", task_id=t.id)
    assert task.status == "ready"
    assert task.assignee == "worker"


# --- Task 4: classify = status re-bucket within an allowlist --------------- #
def test_classify_rebuckets_status_within_allowlist(tmp_path: Path) -> None:
    store = SQLiteBoardStore(tmp_path / "b.db")
    t = store.create_task(board="dev10", title="x", body=None, assignee=None, status="staged")
    action = ChatConfirmAction(
        kind="classify", board="dev10", target_task_id=t.id, fields={"to_status": "ask_human"}
    )
    apply_chat_confirm_action(store, action, actor=_actor())
    assert store.get_task(board="dev10", task_id=t.id).status == "ask_human"


def test_classify_rejects_non_allowlisted_target(tmp_path: Path) -> None:
    store = SQLiteBoardStore(tmp_path / "b.db")
    t = store.create_task(board="dev10", title="x", body=None, assignee=None, status="staged")
    action = ChatConfirmAction(
        kind="classify", board="dev10", target_task_id=t.id, fields={"to_status": "done"}
    )
    with pytest.raises(ChatActionDenied):
        apply_chat_confirm_action(store, action, actor=_actor())


# --- Security: board-ownership guard (scope-exact; closes comment IDOR) ----- #
def test_target_action_denied_across_boards(tmp_path: Path) -> None:
    store = SQLiteBoardStore(tmp_path / "b.db")
    # A task that actually lives on a DIFFERENT board.
    t = store.create_task(board="other", title="x", body=None, assignee=None, status="staged")
    # An action declaring board 'dev10' but targeting the 'other'-board task.
    # (comment is the IDOR-prone case: add_comment_to_task has no board param.)
    action = ChatConfirmAction(
        kind="comment", board="dev10", target_task_id=t.id, fields={"comment": "leak"}
    )
    with pytest.raises(ChatActionDenied):
        apply_chat_confirm_action(store, action, actor=_actor())
    # Defense-in-depth: nothing was applied — the cross-board comment never lands.
    assert store.list_comments_for_task(task_id=t.id) == []


# --- V2: role-gated write tools (LLM-first agent, via the dispatcher) -------- #
def test_write_tools_execute_via_dispatcher_and_return_denial_as_result(tmp_path: Path) -> None:
    from grove_bridge.chat_runtime import build_chat_write_tools

    store = SQLiteBoardStore(tmp_path / "b.db")
    tools = build_chat_write_tools(store, board="dev10", actor=_actor())
    names = {t.name for t in tools}
    assert {"create_task", "add_task_comment", "set_task_status", "dispatch_task"} <= names

    create = next(t for t in tools if t.name == "create_task")
    result = create.handler({"title": "ship export", "body": "do it"})
    assert result["ok"] is True
    task = store.get_task(board="dev10", task_id=str(result["task_id"]))
    assert task.title == "ship export"

    # Non-operator -> denial returned as a tool RESULT (not raised; LLM tells user).
    viewer_tools = build_chat_write_tools(store, board="dev10", actor=_actor(role="viewer"))
    vcreate = next(t for t in viewer_tools if t.name == "create_task")
    denied = vcreate.handler({"title": "x"})
    assert denied["ok"] is False and "error" in denied
