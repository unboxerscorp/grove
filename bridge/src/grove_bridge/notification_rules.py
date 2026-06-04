"""Notification rules for board decisions that need human attention."""

from __future__ import annotations

import re
import time
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, replace
from typing import Literal

from grove_bridge.auth_status import redact_secret_text
from grove_bridge.notifier import NotifierProtocol
from grove_bridge.slack import HUMAN_GATE_PENDING_MODE
from grove_bridge.store import NotifySub, SlackThread, SQLiteBoardStore, Task

ABSOLUTE_PATH_RE = re.compile(r"(?<![A-Za-z0-9_./-])/(?!/)[^\s'\"()<>]+")
EMAIL_RE = re.compile(r"\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b")
RuleKind = Literal["blocked", "ask_human_pending", "anomaly"]


@dataclass(frozen=True)
class NotificationTarget:
    channel_kind: str
    room_id: str


@dataclass(frozen=True)
class NotificationRouteRule:
    name: str
    event_type: RuleKind | Literal["*"]
    target: NotificationTarget
    node: str | None = None
    severity: str | None = None
    escalate_after_seconds: int | None = None
    escalation_targets: tuple[NotificationTarget, ...] = ()
    max_escalations: int = 0


@dataclass(frozen=True)
class NotificationRoutingConfig:
    enabled: bool = False
    dry_run: bool = True
    rules: tuple[NotificationRouteRule, ...] = ()


@dataclass(frozen=True)
class NotificationEvent:
    event_type: RuleKind
    node: str | None
    severity: str
    task: Task


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

    def poll_board(
        self,
        board: str,
        *,
        routing: NotificationRoutingConfig | None = None,
        now: int | None = None,
    ) -> int:
        if routing is not None:
            return self._poll_board_routed(board=board, routing=routing, now=now)
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

    def _poll_board_routed(
        self,
        *,
        board: str,
        routing: NotificationRoutingConfig,
        now: int | None,
    ) -> int:
        if not routing.enabled or routing.dry_run or not self.notifier.enabled:
            return 0
        sent = 0
        current_time = int(time.time()) if now is None else now
        for task in self.store.list_tasks(board=board, status="blocked"):
            event = self._event_for_task(task)
            rule = _matching_rule(event, routing.rules)
            if rule is None:
                continue
            sent += self._send_target(
                board=board,
                task=task,
                rule=rule,
                target=rule.target,
                step=0,
                event=event,
            )
            sent += self._maybe_escalate(
                board=board,
                task=task,
                rule=rule,
                event=event,
                now=current_time,
            )
        return sent

    def _send_target(
        self,
        *,
        board: str,
        task: Task,
        rule: NotificationRouteRule,
        target: NotificationTarget,
        step: int,
        event: NotificationEvent,
    ) -> int:
        thread_id = _route_thread_id(rule=rule, task=task, event=event, step=step)
        if _notify_sub_for_thread(self.store, board=board, task=task, thread_id=thread_id):
            return 0
        self.store.add_notify_sub(
            board=board,
            task_id=task.id,
            channel_kind=target.channel_kind,
            room_id=target.room_id,
            thread_id=thread_id,
        )
        sub = _notify_sub_for_thread(self.store, board=board, task=task, thread_id=thread_id)
        if sub is None:
            return 0
        self.notifier.notify_blocked(task=_redacted_task(task), sub=sub)
        return 1

    def _maybe_escalate(
        self,
        *,
        board: str,
        task: Task,
        rule: NotificationRouteRule,
        event: NotificationEvent,
        now: int,
    ) -> int:
        if (
            rule.escalate_after_seconds is None
            or rule.escalate_after_seconds < 0
            or not rule.escalation_targets
            or _acknowledged(self.store, board=board, task=task, rule=rule)
        ):
            return 0
        limit = min(rule.max_escalations, len(rule.escalation_targets))
        if limit <= 0:
            return 0
        for step in range(1, limit + 1):
            previous = _notify_sub_for_thread(
                self.store,
                board=board,
                task=task,
                thread_id=_route_thread_id(rule=rule, task=task, event=event, step=step - 1),
            )
            if previous is None or now - previous.created_at < rule.escalate_after_seconds:
                return 0
            target = rule.escalation_targets[step - 1]
            sent = self._send_target(
                board=board,
                task=task,
                rule=rule,
                target=target,
                step=step,
                event=event,
            )
            if sent:
                return sent
        return 0

    def _event_for_task(self, task: Task) -> NotificationEvent:
        event_type = self._rule_kind(task)
        severity = task.metadata.get("severity")
        return NotificationEvent(
            event_type=event_type,
            node=task.assignee,
            severity=severity.strip().lower() if isinstance(severity, str) else "normal",
            task=task,
        )

    def _already_notified(self, *, board: str, task: Task) -> bool:
        for sub in self.store.list_notify_subs(board=board, task_id=task.id):
            if (
                sub.channel_kind == self.notifier.channel_kind
                and sub.room_id == self.notifier.room_id
            ):
                return True
        return False

    def _rule_kind(self, task: Task) -> RuleKind:
        raw_event = task.metadata.get("notification_event")
        if raw_event == "anomaly":
            return "anomaly"
        if bool(task.metadata.get("needs_human")) or _has_pending_human_gate(self.store, task):
            return "ask_human_pending"
        return "blocked"


def notification_routing_config_from_mapping(
    value: Mapping[str, object],
) -> NotificationRoutingConfig:
    raw_rules = value.get("rules")
    rules: list[NotificationRouteRule] = []
    if isinstance(raw_rules, Sequence) and not isinstance(raw_rules, str | bytes):
        for raw_rule in raw_rules:
            if isinstance(raw_rule, Mapping):
                rules.append(_route_rule_from_mapping(raw_rule))
    return NotificationRoutingConfig(
        enabled=bool(value.get("enabled")),
        dry_run=bool(value.get("dry_run", True)),
        rules=tuple(rules),
    )


def _route_rule_from_mapping(value: Mapping[str, object]) -> NotificationRouteRule:
    raw_escalations = value.get("escalation_targets")
    escalation_targets: list[NotificationTarget] = []
    if isinstance(raw_escalations, Sequence) and not isinstance(raw_escalations, str | bytes):
        for raw_target in raw_escalations:
            if isinstance(raw_target, Mapping):
                escalation_targets.append(_target_from_mapping(raw_target))
    return NotificationRouteRule(
        name=_mapping_text(value, "name", "default"),
        event_type=_event_type(_mapping_text(value, "event_type", "*")),
        node=_optional_mapping_text(value, "node"),
        severity=_optional_mapping_text(value, "severity"),
        target=_target_from_mapping(_mapping_value(value, "target")),
        escalate_after_seconds=_optional_mapping_int(value, "escalate_after_seconds"),
        escalation_targets=tuple(escalation_targets),
        max_escalations=max(0, _optional_mapping_int(value, "max_escalations") or 0),
    )


def _target_from_mapping(value: Mapping[str, object]) -> NotificationTarget:
    return NotificationTarget(
        channel_kind=_mapping_text(value, "channel_kind", "inbox"),
        room_id=_mapping_text(value, "room_id", "ops"),
    )


def _mapping_value(value: Mapping[str, object], key: str) -> Mapping[str, object]:
    raw = value.get(key)
    return raw if isinstance(raw, Mapping) else {}


def _mapping_text(value: Mapping[str, object], key: str, default: str) -> str:
    raw = value.get(key)
    return raw.strip() if isinstance(raw, str) and raw.strip() else default


def _optional_mapping_text(value: Mapping[str, object], key: str) -> str | None:
    raw = value.get(key)
    return raw.strip() if isinstance(raw, str) and raw.strip() else None


def _optional_mapping_int(value: Mapping[str, object], key: str) -> int | None:
    raw = value.get(key)
    if isinstance(raw, int) and not isinstance(raw, bool):
        return raw
    return None


def _event_type(value: str) -> RuleKind | Literal["*"]:
    if value == "blocked":
        return "blocked"
    if value == "ask_human_pending":
        return "ask_human_pending"
    if value == "anomaly":
        return "anomaly"
    return "*"


def _matching_rule(
    event: NotificationEvent,
    rules: Sequence[NotificationRouteRule],
) -> NotificationRouteRule | None:
    return next((rule for rule in rules if _rule_matches(rule, event)), None)


def _rule_matches(rule: NotificationRouteRule, event: NotificationEvent) -> bool:
    if rule.event_type not in {"*", event.event_type}:
        return False
    if rule.node is not None and rule.node != event.node:
        return False
    if rule.severity is not None and rule.severity.lower() != event.severity:
        return False
    return True


def _route_thread_id(
    *,
    rule: NotificationRouteRule,
    task: Task,
    event: NotificationEvent,
    step: int,
) -> str:
    return f"route:{rule.name}:{event.event_type}:{task.id}:{step}"


def _acknowledged(
    store: SQLiteBoardStore,
    *,
    board: str,
    task: Task,
    rule: NotificationRouteRule,
) -> bool:
    return (
        _notify_sub_for_thread(
            store,
            board=board,
            task=task,
            thread_id=f"ack:{rule.name}:{task.id}",
        )
        is not None
    )


def _notify_sub_for_thread(
    store: SQLiteBoardStore,
    *,
    board: str,
    task: Task,
    thread_id: str,
) -> NotifySub | None:
    return next(
        (
            sub
            for sub in store.list_notify_subs(board=board, task_id=task.id)
            if sub.thread_id == thread_id
        ),
        None,
    )


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
    without_pii = EMAIL_RE.sub("[pii]", without_secrets)
    return " ".join(without_pii.split())[:500]
