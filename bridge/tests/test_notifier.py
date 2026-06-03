from __future__ import annotations

from collections.abc import Callable

import pytest

from grove_bridge.notifier import LocalNotifier, NoopNotifier, NotifierConfig, build_notifier
from grove_bridge.store import NotifySub, Task


def test_notifier_factory_defaults_to_noop_dry_run() -> None:
    notifier = build_notifier(NotifierConfig())

    assert isinstance(notifier, NoopNotifier)
    assert notifier.enabled is False


def test_notifier_factory_uses_noop_when_dry_run_enabled() -> None:
    notifier = build_notifier(
        NotifierConfig(enabled=True, dry_run=True, channel_kind="inbox", room_id="ops")
    )

    assert isinstance(notifier, NoopNotifier)
    assert notifier.enabled is False


def test_notifier_factory_builds_live_local_notifier_and_trims_config() -> None:
    notifier = build_notifier(
        NotifierConfig(enabled=True, dry_run=False, channel_kind=" slack ", room_id=" ops ")
    )

    assert isinstance(notifier, LocalNotifier)
    assert notifier.enabled is True
    assert notifier.channel_kind == "slack"
    assert notifier.room_id == "ops"
    notifier.notify_blocked(
        task=Task(
            id="task-1",
            board_id="board-1",
            title="Blocked",
            body=None,
            assignee="worker",
            status="blocked",
            priority=0,
            workspace_kind="scratch",
            workspace_path=None,
            branch_name=None,
            claim_lock=None,
            claim_expires=None,
            current_run_id=None,
            last_heartbeat_at=None,
            result=None,
            metadata={},
            created_by=None,
            created_at=1,
            updated_at=1,
        ),
        sub=NotifySub(
            board_id="board-1",
            task_id="task-1",
            channel_kind="slack",
            room_id="ops",
            thread_id="thread-1",
            user_id=None,
            last_event_id=None,
            created_at=1,
        ),
    )


@pytest.mark.parametrize(
    ("config_factory", "message"),
    [
        (lambda: NotifierConfig(channel_kind=" "), "channel_kind"),
        (lambda: NotifierConfig(room_id=" "), "room_id"),
        (lambda: NotifierConfig(enabled=True, dry_run=False), "room_id is required"),
    ],
)
def test_notifier_config_rejects_invalid_live_settings(
    config_factory: Callable[[], NotifierConfig],
    message: str,
) -> None:
    with pytest.raises(ValueError, match=message):
        config_factory()
