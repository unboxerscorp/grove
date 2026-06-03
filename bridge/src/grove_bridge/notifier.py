"""Channel-neutral notification seam for blocked grove tasks."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol

from grove_bridge.store import NotifySub, Task


@dataclass(frozen=True)
class NotifierConfig:
    enabled: bool = False
    dry_run: bool = True
    channel_kind: str = "inbox"
    room_id: str | None = None

    def __post_init__(self) -> None:
        if not self.channel_kind.strip():
            raise ValueError("notifier.channel_kind must be a non-empty string")
        object.__setattr__(self, "channel_kind", self.channel_kind.strip())
        if self.room_id is not None:
            room_id = self.room_id.strip()
            if not room_id:
                raise ValueError("notifier.room_id must be a non-empty string")
            object.__setattr__(self, "room_id", room_id)
        if self.enabled and not self.dry_run and self.room_id is None:
            raise ValueError("notifier.room_id is required when notifier is live")


class NotifierProtocol(Protocol):
    enabled: bool
    channel_kind: str
    room_id: str

    def notify_blocked(self, *, task: Task, sub: NotifySub) -> None: ...


class NoopNotifier:
    enabled = False
    channel_kind = "noop"
    room_id = "noop"

    def notify_blocked(self, *, task: Task, sub: NotifySub) -> None:
        return None


class LocalNotifier:
    """Configured no-network notifier placeholder for future channel adapters."""

    def __init__(self, config: NotifierConfig) -> None:
        if config.room_id is None:
            raise ValueError("notifier.room_id is required")
        self.enabled = True
        self.channel_kind = config.channel_kind
        self.room_id = config.room_id

    def notify_blocked(self, *, task: Task, sub: NotifySub) -> None:
        return None


def build_notifier(config: NotifierConfig) -> NotifierProtocol:
    if not config.enabled or config.dry_run:
        return NoopNotifier()
    return LocalNotifier(config)
