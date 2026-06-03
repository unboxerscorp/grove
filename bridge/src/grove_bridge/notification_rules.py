"""Notification rules for board decisions that need human attention."""

from __future__ import annotations

import re
from dataclasses import replace
from typing import Literal

from grove_bridge.auth_status import redact_secret_text
from grove_bridge.notifier import NotifierProtocol
from grove_bridge.slack import HUMAN_GATE_PENDING_MODE
from grove_bridge.store import SlackThread, SQLiteBoardStore, Task

ABSOLUTE_PATH_RE = re.compile(r"(?<![A-Za-z0-9_./-])/(?!/)[^\s'\"()<>]+")
RuleKind = Literal["blocked", "ask_human_pending"]


class NotificationRuleRunner:
    """Poll board state and notify once per blocked decision item."""

    def __init__(
        self,
        *,
        store: SQLiteBoardStore,
        notifier: NotifierProtocol,
    ) -> None:
        self.store = store
        self.notifier = notifier

    def poll_board(self, board: str) -> int:
        if not self.notifier.enabled:
            return 0
        sent = 0
        for task in self.store.list_tasks(board=board, status="blocked"):
            if self._already_notified(board=board, task=task):
                continue
            rule = self._rule_kind(task)
            sub = self.store.add_notify_sub(
                board=board,
                task_id=task.id,
                channel_kind=self.notifier.channel_kind,
                room_id=self.notifier.room_id,
                thread_id=f"{rule}:{task.id}",
            )
            self.notifier.notify_blocked(task=_redacted_task(task), sub=sub)
            sent += 1
        return sent

    def _already_notified(self, *, board: str, task: Task) -> bool:
        for sub in self.store.list_notify_subs(board=board, task_id=task.id):
            if (
                sub.channel_kind == self.notifier.channel_kind
                and sub.room_id == self.notifier.room_id
            ):
                return True
        return False

    def _rule_kind(self, task: Task) -> RuleKind:
        if bool(task.metadata.get("needs_human")) or _has_pending_human_gate(self.store, task):
            return "ask_human_pending"
        return "blocked"


def _has_pending_human_gate(store: SQLiteBoardStore, task: Task) -> bool:
    return any(_is_pending_thread(thread) for thread in store.list_slack_threads(task_id=task.id))


def _is_pending_thread(thread: SlackThread) -> bool:
    return thread.mode == HUMAN_GATE_PENDING_MODE


def _redacted_task(task: Task) -> Task:
    return replace(
        task,
        title=_safe_text(task.title),
        body=_optional_safe_text(task.body),
        assignee=_optional_safe_text(task.assignee),
        workspace_path=_optional_safe_text(task.workspace_path),
        branch_name=_optional_safe_text(task.branch_name),
        result=_optional_safe_text(task.result),
        metadata={key: _safe_value(value) for key, value in task.metadata.items()},
    )


def _safe_value(value: object) -> object:
    if isinstance(value, str):
        return _safe_text(value)
    if isinstance(value, dict):
        return {str(key): _safe_value(item) for key, item in value.items()}
    if isinstance(value, list):
        return [_safe_value(item) for item in value]
    return value


def _optional_safe_text(value: str | None) -> str | None:
    return None if value is None else _safe_text(value)


def _safe_text(value: str) -> str:
    without_paths = ABSOLUTE_PATH_RE.sub("[path]", value.replace("\r", "\n"))
    without_secrets = redact_secret_text(without_paths)
    return " ".join(without_secrets.split())[:500]
