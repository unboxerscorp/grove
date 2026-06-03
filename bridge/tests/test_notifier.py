from __future__ import annotations

from grove_bridge.notifier import NoopNotifier, NotifierConfig, build_notifier


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
