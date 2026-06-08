from __future__ import annotations

import time
from pathlib import Path

from grove_bridge.notification_rules import (
    NotificationRouteRule,
    NotificationRoutingConfig,
    NotificationRuleRunner,
    NotificationTarget,
)
from grove_bridge.notifier import NotifierConfig, build_notifier
from grove_bridge.store import NotifySub, SQLiteBoardStore, Task


class RecordingNotifier:
    enabled = True
    channel_kind = "inbox"
    room_id = "ops"

    def __init__(self) -> None:
        self.calls: list[tuple[Task, NotifySub]] = []

    def notify_blocked(self, *, task: Task, sub: NotifySub) -> None:
        self.calls.append((task, sub))


def test_notification_rules_notify_blocked_once_and_redact_payload(tmp_path: Path) -> None:
    store = SQLiteBoardStore(tmp_path / "board.db")
    secret = "xoxb-" + ("a" * 44)
    task = store.create_task(
        board="sample",
        title=f"Blocked at /Users/chopin/dev/{secret}",
        body=f"Need answer for /etc/passwd {secret}",
        assignee="maker",
        status="blocked",
        metadata={"reason": f"failed in /Applications/Grove.app {secret}"},
    )
    notifier = RecordingNotifier()
    rules = NotificationRuleRunner(store=store, notifier=notifier)

    first = rules.poll_board("sample")
    second = rules.poll_board("sample")

    assert first == 1
    assert second == 0
    assert len(notifier.calls) == 1
    notified_task, sub = notifier.calls[0]
    assert notified_task.id == task.id
    assert notified_task.title == "Blocked at [path]"
    assert notified_task.body == "Need answer for [path] [redacted]"
    assert notified_task.metadata["reason"] == "failed in [path] [redacted]"
    assert sub.channel_kind == "inbox"
    assert sub.room_id == "ops"
    assert sub.thread_id == f"blocked:{task.id}"
    assert len(store.list_notify_subs(board="sample", task_id=task.id)) == 1


def test_notification_rules_notify_ask_human_pending_once(tmp_path: Path) -> None:
    store = SQLiteBoardStore(tmp_path / "board.db")
    task = store.create_task(
        board="sample",
        title="Human needed",
        body=None,
        assignee="maker",
        status="blocked",
        metadata={"needs_human": True},
    )
    store.upsert_slack_thread(
        board="sample",
        task_id=task.id,
        team_id="",
        channel_id="C123",
        thread_ts=f"pending:{task.id}",
        mode="human_gate_pending",
        node="maker",
    )
    notifier = RecordingNotifier()

    sent = NotificationRuleRunner(store=store, notifier=notifier).poll_board("sample")

    assert sent == 1
    assert notifier.calls[0][1].thread_id == f"ask_human_pending:{task.id}"
    assert NotificationRuleRunner(store=store, notifier=notifier).poll_board("sample") == 0


def test_notification_rules_respect_dry_run_noop(tmp_path: Path) -> None:
    store = SQLiteBoardStore(tmp_path / "board.db")
    task = store.create_task(
        board="sample",
        title="Dry run",
        body=None,
        assignee="maker",
        status="blocked",
    )
    notifier = build_notifier(
        NotifierConfig(enabled=True, dry_run=True, channel_kind="inbox", room_id="ops")
    )

    sent = NotificationRuleRunner(store=store, notifier=notifier).poll_board("sample")

    assert sent == 0
    assert store.list_notify_subs(board="sample", task_id=task.id) == []


def test_notification_routing_v2_matches_conditions_escalates_and_redacts(
    tmp_path: Path,
) -> None:
    store = SQLiteBoardStore(tmp_path / "board.db")
    secret = "xoxb-" + ("a" * 44)
    task = store.create_task(
        board="sample",
        title=f"Spike for alice@example.com in /Users/chopin/{secret}",
        body=f"Cost anomaly in /etc/private {secret}",
        assignee="maker",
        status="blocked",
        metadata={
            "notification_event": "anomaly",
            "severity": "high",
            "note": f"/Applications/Grove.app {secret} alice@example.com",
        },
    )
    routing = NotificationRoutingConfig(
        enabled=True,
        dry_run=False,
        rules=(
            NotificationRouteRule(
                name="wrong-node",
                event_type="anomaly",
                node="other",
                severity="high",
                target=NotificationTarget(channel_kind="inbox", room_id="wrong"),
            ),
            NotificationRouteRule(
                name="anomaly-high",
                event_type="anomaly",
                node="maker",
                severity="high",
                target=NotificationTarget(channel_kind="inbox", room_id="ops"),
                escalate_after_seconds=10,
                escalation_targets=(
                    NotificationTarget(channel_kind="inbox", room_id="lead"),
                    NotificationTarget(channel_kind="inbox", room_id="director"),
                ),
                max_escalations=1,
            ),
        ),
    )
    notifier = RecordingNotifier()
    runner = NotificationRuleRunner(store=store, notifier=notifier)
    now = int(time.time())

    first = runner.poll_board("sample", routing=routing, now=now)
    early = runner.poll_board("sample", routing=routing, now=now + 5)
    escalated = runner.poll_board("sample", routing=routing, now=now + 11)
    bounded = runner.poll_board("sample", routing=routing, now=now + 200)

    assert first == 1
    assert early == 0
    assert escalated == 1
    assert bounded == 0
    assert [sub.room_id for _, sub in notifier.calls] == ["ops", "lead"]
    assert notifier.calls[0][1].thread_id == f"route:anomaly-high:anomaly:{task.id}:0"
    assert notifier.calls[1][1].thread_id == f"route:anomaly-high:anomaly:{task.id}:1"
    notified_task = notifier.calls[0][0]
    rendered = f"{notified_task.title} {notified_task.body} {notified_task.metadata}"
    assert secret not in rendered
    assert "/Users/chopin" not in rendered
    assert "alice@example.com" not in rendered
    assert "[pii]" in rendered


def test_notification_routing_v2_dry_run_default_sends_nothing(tmp_path: Path) -> None:
    store = SQLiteBoardStore(tmp_path / "board.db")
    task = store.create_task(
        board="sample",
        title="Dry routed",
        body=None,
        assignee="maker",
        status="blocked",
        metadata={"severity": "high"},
    )
    routing = NotificationRoutingConfig(
        enabled=True,
        rules=(
            NotificationRouteRule(
                name="blocked-high",
                event_type="blocked",
                severity="high",
                target=NotificationTarget(channel_kind="inbox", room_id="ops"),
            ),
        ),
    )
    notifier = RecordingNotifier()

    sent = NotificationRuleRunner(store=store, notifier=notifier).poll_board(
        "sample",
        routing=routing,
    )

    assert sent == 0
    assert notifier.calls == []
    assert store.list_notify_subs(board="sample", task_id=task.id) == []
