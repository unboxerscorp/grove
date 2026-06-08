from __future__ import annotations

import asyncio

from grove_bridge.store import BoardEvent
from grove_bridge.task_wakeup import (
    TaskWakeupWatcher,
    WakeupCoalescer,
    is_meaningful_event,
    summarize_event,
)


def _event(
    kind: str, payload: dict[str, object], *, cursor: int = 1, task_id: str = "t1"
) -> BoardEvent:
    return BoardEvent(
        cursor=cursor,
        id=f"e{cursor}",
        board_id="b",
        task_id=task_id,
        run_id=None,
        kind=kind,
        payload=payload,
        created_at=0,
    )


def test_is_meaningful_event_filters_to_create_status_assignee() -> None:
    assert is_meaningful_event(_event("task.created", {"status": "ready"})) is True
    assert is_meaningful_event(_event("task.updated", {"status": "running"})) is True
    assert is_meaningful_event(_event("task.updated", {"assignee": "lead"})) is True
    # status -> ask_human / blocked still flow through the status key
    assert is_meaningful_event(_event("task.updated", {"status": "ask_human"})) is True
    # non-actionable updates and audit duplicates are ignored
    assert is_meaningful_event(_event("task.updated", {"fields": ["title"]})) is False
    assert is_meaningful_event(_event("task.updated", {"reviewer": "qa"})) is False
    assert is_meaningful_event(_event("audit.task.status", {"action": "x"})) is False


def test_is_meaningful_event_excludes_staged() -> None:
    # staged items just accumulate for human review; they must NOT nudge task-master.
    assert is_meaningful_event(_event("task.created", {"status": "staged"})) is False
    assert is_meaningful_event(_event("task.updated", {"status": "staged"})) is False
    # the dispatch transition staged -> ready DOES nudge.
    assert (
        is_meaningful_event(
            _event("task.updated", {"status": "ready", "previous_status": "staged"})
        )
        is True
    )


def test_summarize_event_renders_compact_lines() -> None:
    assert summarize_event(_event("task.created", {"status": "ready"})) == "t1 created"
    assert (
        summarize_event(_event("task.updated", {"status": "running", "previous_status": "ready"}))
        == "t1 ready->running"
    )
    assert (
        summarize_event(_event("task.updated", {"assignee": "lead", "previous_assignee": None}))
        == "t1 assignee none->lead"
    )


def test_coalescer_debounces_then_emits_one_message() -> None:
    coalescer = WakeupCoalescer(debounce_seconds=5.0, min_interval_seconds=30.0)
    coalescer.note("t1 ready->running", now=0.0)
    coalescer.note("t2 created", now=1.0)

    assert coalescer.due(now=2.0) is None  # still within debounce window
    message = coalescer.due(now=5.0)
    assert message is not None
    assert "t1 ready->running" in message
    assert "t2 created" in message


def test_coalescer_dedups_repeated_summaries_within_a_window() -> None:
    coalescer = WakeupCoalescer(debounce_seconds=5.0, min_interval_seconds=30.0)
    coalescer.note("t1 ready->running", now=0.0)
    coalescer.note("t1 ready->running", now=1.0)

    message = coalescer.due(now=5.0)
    assert message is not None
    assert message.count("t1 ready->running") == 1


def test_coalescer_rate_limits_consecutive_wakeups() -> None:
    coalescer = WakeupCoalescer(debounce_seconds=5.0, min_interval_seconds=30.0)
    coalescer.note("t1 ready->running", now=0.0)
    assert coalescer.due(now=5.0) is not None  # first send at t=5

    coalescer.note("t2 created", now=6.0)
    assert coalescer.due(now=12.0) is None  # min-interval (30s) not elapsed -> keep coalescing
    later = coalescer.due(now=36.0)
    assert later is not None
    assert "t2 created" in later


def test_coalescer_dedup_skips_identical_consecutive_batch() -> None:
    coalescer = WakeupCoalescer(debounce_seconds=5.0, min_interval_seconds=30.0)
    coalescer.note("t1 ready->running", now=0.0)
    assert coalescer.due(now=5.0) is not None

    coalescer.note("t1 ready->running", now=40.0)
    # identical digest to the last sent batch -> no redundant wakeup
    assert coalescer.due(now=46.0) is None


def test_coalescer_empty_is_never_due() -> None:
    coalescer = WakeupCoalescer(debounce_seconds=5.0, min_interval_seconds=30.0)
    assert coalescer.due(now=100.0) is None


class _FakeStore:
    def __init__(self, batches: list[list[BoardEvent]]) -> None:
        self._batches = batches
        self._call = 0

    def latest_event_cursor(self, *, board: str | None = None) -> int:
        return 0

    def list_events_after(
        self, *, cursor: int = 0, limit: int = 100, board: str | None = None
    ) -> list[BoardEvent]:
        if self._call < len(self._batches):
            batch = self._batches[self._call]
            self._call += 1
            return batch
        return []


def test_watcher_run_once_notes_meaningful_events_and_sends_when_due() -> None:
    async def scenario() -> None:
        sent: list[str] = []
        clock = {"t": 0.0}

        async def fake_send(message: str) -> None:
            sent.append(message)

        store = _FakeStore(
            [
                [
                    _event(
                        "task.updated",
                        {"status": "running", "previous_status": "ready"},
                        cursor=7,
                    ),
                    _event("audit.task.status", {"action": "x"}, cursor=8),  # ignored
                ]
            ]
        )
        watcher = TaskWakeupWatcher(
            list_events_after=lambda cursor: store.list_events_after(cursor=cursor),
            latest_cursor=lambda: 0,
            send=fake_send,
            now=lambda: clock["t"],
            coalescer=WakeupCoalescer(debounce_seconds=5.0, min_interval_seconds=30.0),
        )

        # first tick notes the change but debounce not elapsed -> no send
        clock["t"] = 0.0
        assert await watcher.run_once() is None
        assert sent == []
        # later tick past the debounce window -> one coalesced send
        clock["t"] = 6.0
        message = await watcher.run_once()
        assert message is not None
        assert sent == [message]
        assert "ready->running" in message
        assert watcher.cursor == 8  # cursor advanced past every scanned event

    asyncio.run(scenario())
