from __future__ import annotations

from pathlib import Path

from grove_bridge.notification_rules import NotificationRuleRunner
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
        board="dev10",
        title=f"Blocked at /Users/chopin/dev/{secret}",
        body=f"Need answer for /etc/passwd {secret}",
        assignee="maker",
        status="blocked",
        metadata={"reason": f"failed in /Applications/Grove.app {secret}"},
    )
    notifier = RecordingNotifier()
    rules = NotificationRuleRunner(store=store, notifier=notifier)

    first = rules.poll_board("dev10")
    second = rules.poll_board("dev10")

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
    assert len(store.list_notify_subs(board="dev10", task_id=task.id)) == 1


def test_notification_rules_notify_ask_human_pending_once(tmp_path: Path) -> None:
    store = SQLiteBoardStore(tmp_path / "board.db")
    task = store.create_task(
        board="dev10",
        title="Human needed",
        body=None,
        assignee="maker",
        status="blocked",
        metadata={"needs_human": True},
    )
    store.upsert_slack_thread(
        board="dev10",
        task_id=task.id,
        team_id="",
        channel_id="C123",
        thread_ts=f"pending:{task.id}",
        mode="human_gate_pending",
        node="maker",
    )
    notifier = RecordingNotifier()

    sent = NotificationRuleRunner(store=store, notifier=notifier).poll_board("dev10")

    assert sent == 1
    assert notifier.calls[0][1].thread_id == f"ask_human_pending:{task.id}"
    assert NotificationRuleRunner(store=store, notifier=notifier).poll_board("dev10") == 0


def test_notification_rules_respect_dry_run_noop(tmp_path: Path) -> None:
    store = SQLiteBoardStore(tmp_path / "board.db")
    task = store.create_task(
        board="dev10",
        title="Dry run",
        body=None,
        assignee="maker",
        status="blocked",
    )
    notifier = build_notifier(
        NotifierConfig(enabled=True, dry_run=True, channel_kind="inbox", room_id="ops")
    )

    sent = NotificationRuleRunner(store=store, notifier=notifier).poll_board("dev10")

    assert sent == 0
    assert store.list_notify_subs(board="dev10", task_id=task.id) == []
