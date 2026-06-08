"""Typed confirm-action model + dispatcher for the bridge-native chat runtime.

A chat turn may PROPOSE a human-list mutation; nothing is applied until a human
confirms. :class:`ChatConfirmAction` captures the exact proposed mutation as an
immutable value object; :func:`apply_chat_confirm_action` applies it **verbatim**
— it never re-interprets LLM text at apply time. This module has no Slack/LLM
imports (pure store-facing), so it is unit-testable in isolation and reusable by
the web surface later.

Invariants: role-gated (operator/admin), scope-exact (target id pinned), CAS for
state transitions, secrets redacted before persistence ([R]), every apply audited,
and **never a partial/forced apply** — any auth/validation/CAS failure raises
:class:`ChatActionDenied` and the caller surfaces a denial.
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from typing import Literal

from grove_bridge.auth_status import redact_secret_text
from grove_bridge.store import SQLiteBoardStore

ChatActionKind = Literal["create", "classify", "transition", "comment", "dispatch"]

# Roles permitted to confirm a mutation.
_ALLOWED_ROLES = frozenset({"operator", "admin"})

# Allowlisted ``classify`` targets: human-list **triage buckets only** — never
# execution statuses (ready/running/done/blocked/claimed). Extend deliberately;
# the store itself does not constrain the target, so this allowlist is the guard.
_CLASSIFY_TARGET_ALLOWLIST = frozenset({"staged", "ask_human"})


@dataclass(frozen=True)
class ChatConfirmAction:
    """The exact, human-confirmable mutation captured at proposal time.

    ``fields`` holds only the stored proposed values (title/body/status/assignee/
    comment/to_status/from_status/…). ``target_task_id`` is ``None`` for ``create``
    and pinned (scope-exact) for every other kind.
    """

    kind: ChatActionKind
    board: str
    target_task_id: str | None
    fields: Mapping[str, object]


class ChatActionDenied(Exception):
    """The confirming actor is unauthorized, or the action failed its guard
    (validation / CAS). Callers surface a denial and MUST NOT fall back to
    applying anything."""


def _field_str(fields: Mapping[str, object], key: str, default: str = "") -> str:
    value = fields.get(key)
    return value if isinstance(value, str) else default


def _require_role(actor: Mapping[str, object]) -> None:
    if str(actor.get("role")) not in _ALLOWED_ROLES:
        raise ChatActionDenied("confirm requires operator/admin")


def _require_target(action: ChatConfirmAction) -> str:
    if not action.target_task_id:
        raise ChatActionDenied(f"{action.kind} requires a target task")
    return action.target_task_id


def _author(actor: Mapping[str, object]) -> str:
    return str(actor.get("name") or actor.get("member_id") or "chat")


def apply_chat_confirm_action(
    store: SQLiteBoardStore,
    action: ChatConfirmAction,
    *,
    actor: Mapping[str, object],
) -> dict[str, object]:
    """Apply exactly the stored action (no LLM re-interpretation). Role-gated,
    scope-exact, audited. Raises :class:`ChatActionDenied` on auth/validation/CAS
    failure (never a partial/fabricated apply)."""
    _require_role(actor)
    # Board-ownership guard (scope-exact): a target action MUST operate on a task
    # that belongs to action.board. This closes an IDOR — add_comment_to_task takes
    # only task_id (no board), so without this a comment could land on another
    # board's task — and is defense-in-depth for every target action.
    if action.target_task_id is not None:
        try:
            store.get_task(board=action.board, task_id=action.target_task_id)
        except KeyError as exc:
            raise ChatActionDenied(
                f"target task {action.target_task_id!r} not on board {action.board!r}"
            ) from exc
    if action.kind == "create":
        result = _apply_create(store, action, actor)
    elif action.kind == "transition":
        result = _apply_transition(store, action, actor)
    elif action.kind == "classify":
        result = _apply_classify(store, action, actor)
    elif action.kind == "comment":
        result = _apply_comment(store, action, actor)
    elif action.kind == "dispatch":
        result = _apply_dispatch(store, action, actor)
    else:  # pragma: no cover - exhaustive over ChatActionKind
        raise ChatActionDenied(f"unsupported action kind: {action.kind}")
    store.add_audit_event(
        board=action.board,
        kind="audit.chat.confirm.apply",
        actor=dict(actor),
        action="chat.confirm.apply",
        target={"type": "task", "id": str(result.get("task_id")), "action_kind": action.kind},
    )
    return result


def _apply_create(
    store: SQLiteBoardStore, action: ChatConfirmAction, actor: Mapping[str, object]
) -> dict[str, object]:
    _ = actor
    title = _field_str(action.fields, "title")
    if not title.strip():
        raise ChatActionDenied("create requires a title")
    body = redact_secret_text(_field_str(action.fields, "body")) or None
    task = store.create_task(
        board=action.board,
        title=redact_secret_text(title),
        body=body,
        assignee=_field_str(action.fields, "assignee") or None,
        # Caller decides 'staged' (dark-gated, Slack layer); store default is 'ready'.
        status=_field_str(action.fields, "status", "ready"),
    )
    return {"task_id": task.id}


def _apply_transition(
    store: SQLiteBoardStore, action: ChatConfirmAction, actor: Mapping[str, object]
) -> dict[str, object]:
    task_id = _require_target(action)
    to_status = _field_str(action.fields, "to_status")
    if not to_status.strip():
        raise ChatActionDenied("transition requires to_status")
    expected = _field_str(action.fields, "from_status") or None
    try:
        store.set_task_status(
            board=action.board,
            task_id=task_id,
            status=to_status,
            actor=dict(actor),
            expected_status=expected,
        )
    except Exception as exc:  # CAS conflict / invalid transition -> deny (never force)
        raise ChatActionDenied(f"transition failed: {exc}") from exc
    return {"task_id": task_id}


def _apply_classify(
    store: SQLiteBoardStore, action: ChatConfirmAction, actor: Mapping[str, object]
) -> dict[str, object]:
    task_id = _require_target(action)
    to_status = _field_str(action.fields, "to_status")
    if to_status not in _CLASSIFY_TARGET_ALLOWLIST:
        raise ChatActionDenied(f"classify target not allowlisted: {to_status!r}")
    try:
        store.set_task_status(
            board=action.board, task_id=task_id, status=to_status, actor=dict(actor)
        )
    except Exception as exc:
        raise ChatActionDenied(f"classify failed: {exc}") from exc
    return {"task_id": task_id}


def _apply_comment(
    store: SQLiteBoardStore, action: ChatConfirmAction, actor: Mapping[str, object]
) -> dict[str, object]:
    task_id = _require_target(action)
    store.add_comment_to_task(
        task_id=task_id,
        author=_author(actor),
        body=redact_secret_text(_field_str(action.fields, "comment")),
    )
    return {"task_id": task_id}


def _apply_dispatch(
    store: SQLiteBoardStore, action: ChatConfirmAction, actor: Mapping[str, object]
) -> dict[str, object]:
    # Mirror web POST /api/tasks/{id}/dispatch: assignee -> comment -> staged->ready CAS.
    task_id = _require_target(action)
    assignee = _field_str(action.fields, "assignee") or None
    comment = _field_str(action.fields, "comment")
    try:
        if assignee:
            store.set_task_assignee(
                board=action.board, task_id=task_id, assignee=assignee, actor=dict(actor)
            )
        if comment.strip():
            store.add_comment_to_task(
                task_id=task_id, author=_author(actor), body=redact_secret_text(comment)
            )
        store.set_task_status(
            board=action.board,
            task_id=task_id,
            status="ready",
            actor=dict(actor),
            expected_status="staged",
        )
    except Exception as exc:
        raise ChatActionDenied(f"dispatch failed: {exc}") from exc
    return {"task_id": task_id}
