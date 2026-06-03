"""Legacy pre_gateway_dispatch hook for Slack ask-human replies."""

from __future__ import annotations

from collections.abc import Callable
from typing import Protocol, cast, runtime_checkable

from grove_bridge.legacy import load_kanban_db

HookResult = dict[str, str]


class AskHumanReplyKanbanDbProtocol(Protocol):
    def connect(self, *, board: str | None = None) -> object: ...

    def list_notify_subs(
        self,
        conn: object,
        task_id: str | None = None,
    ) -> list[dict[str, object]]: ...

    def add_comment(self, conn: object, task_id: str, author: str, body: str) -> int: ...

    def unblock_task(self, conn: object, task_id: str) -> bool: ...


class PluginContextProtocol(Protocol):
    def register_hook(self, name: str, callback: Callable[..., HookResult]) -> None: ...


@runtime_checkable
class Closeable(Protocol):
    def close(self) -> None: ...


def register(ctx: PluginContextProtocol) -> None:
    """Register the ask-human Slack reply hook with Legacy."""

    ctx.register_hook("pre_gateway_dispatch", handle_pre_gateway_dispatch)


def handle_pre_gateway_dispatch(
    event: object,
    gateway: object | None = None,
    session_store: object | None = None,
    kanban_db: object | None = None,
    board: str | None = None,
) -> HookResult:
    """Capture Slack thread replies that answer grove ask-human blocks."""

    source = getattr(event, "source", None)
    if source is None or not _is_slack_source(source):
        return {"action": "allow"}

    chat_id = _string_attr(source, "chat_id")
    thread_id = _string_attr(source, "thread_id")
    if chat_id is None or thread_id is None:
        return {"action": "allow"}

    db = cast(
        AskHumanReplyKanbanDbProtocol,
        load_kanban_db() if kanban_db is None else kanban_db,
    )
    conn = _connect(db, board=board)
    try:
        matches = [
            sub
            for sub in db.list_notify_subs(conn)
            if _sub_matches_slack_thread(sub, chat_id=chat_id, thread_id=thread_id)
        ]
        if not matches:
            return {"action": "allow"}

        body = _reply_body(event)
        author = _reply_author(source)
        for sub in matches:
            task_id = _sub_string(sub, "task_id")
            if task_id is None:
                continue
            db.add_comment(conn, task_id, author, body)
            db.unblock_task(conn, task_id)
        return {"action": "skip", "reason": "ask-human-reply"}
    finally:
        if isinstance(conn, Closeable):
            conn.close()


def _connect(db: AskHumanReplyKanbanDbProtocol, *, board: str | None) -> object:
    if board is None:
        return db.connect()
    try:
        return db.connect(board=board)
    except TypeError:
        return db.connect()


def _is_slack_source(source: object) -> bool:
    platform = _string_attr(source, "platform")
    return platform is not None and platform.lower().endswith("slack")


def _reply_body(event: object) -> str:
    body = _string_attr(event, "text") or _string_attr(event, "body")
    if body is None or not body.strip():
        return "(empty Slack reply)"
    return body.strip()


def _reply_author(source: object) -> str:
    return _string_attr(source, "user_name") or _string_attr(source, "user_id") or "slack-human"


def _sub_matches_slack_thread(
    sub: dict[str, object],
    *,
    chat_id: str,
    thread_id: str,
) -> bool:
    platform = _sub_string(sub, "platform")
    return (
        platform is not None
        and platform.lower() == "slack"
        and _sub_string(sub, "chat_id") == chat_id
        and _sub_string(sub, "thread_id") == thread_id
    )


def _string_attr(value: object, name: str) -> str | None:
    raw = getattr(value, name, None)
    if raw is None:
        return None
    enum_value = getattr(raw, "value", raw)
    if isinstance(enum_value, str):
        stripped = enum_value.strip()
        return stripped or None
    text = str(enum_value).strip()
    return text or None


def _sub_string(sub: dict[str, object], key: str) -> str | None:
    value = sub.get(key)
    if not isinstance(value, str):
        return None
    stripped = value.strip()
    return stripped or None
