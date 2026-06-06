from __future__ import annotations

import asyncio
from collections.abc import Callable

import pytest

from grove_bridge.pane_stream import (
    PaneStreamManager,
    PipeUnavailableError,
    StreamCapacityError,
)


class FakeHandle:
    def __init__(self) -> None:
        self.stopped = 0

    async def stop(self) -> None:
        self.stopped += 1


class FakeIO:
    """Injectable IO double for the manager state machine."""

    def __init__(self, *, fail_start: bool = False) -> None:
        self.started: list[str] = []
        self.handles: dict[str, FakeHandle] = {}
        self.on_chunk: dict[str, Callable[[bytes], None]] = {}
        self.on_close: dict[str, Callable[[], None]] = {}
        self._fail_start = fail_start

    async def start_pipe(
        self,
        pane_id: str,
        on_chunk: Callable[[bytes], None],
        on_close: Callable[[], None],
    ) -> FakeHandle:
        if self._fail_start:
            raise OSError("pipe-pane unavailable")
        self.started.append(pane_id)
        handle = FakeHandle()
        self.handles[pane_id] = handle
        self.on_chunk[pane_id] = on_chunk
        self.on_close[pane_id] = on_close
        return handle

    async def capture(self, pane_id: str) -> bytes:
        return f"SNAP:{pane_id}".encode()


def _drain_to_close(queue: asyncio.Queue[bytes | None]) -> list[bytes | None]:
    items: list[bytes | None] = []
    while True:
        item = queue.get_nowait()
        items.append(item)
        if item is None:
            break
    return items


def test_first_subscriber_starts_pipe_and_seeds_snapshot() -> None:
    async def scenario() -> None:
        io = FakeIO()
        manager = PaneStreamManager(capture=io.capture, start_pipe=io.start_pipe)

        snapshot, _queue = await manager.subscribe("dev10:0.0")

        assert snapshot == b"SNAP:dev10:0.0"
        assert io.started == ["dev10:0.0"]
        assert manager.active_pane_count == 1

    asyncio.run(scenario())


def test_second_subscriber_to_same_pane_dedups_pipe() -> None:
    async def scenario() -> None:
        io = FakeIO()
        manager = PaneStreamManager(capture=io.capture, start_pipe=io.start_pipe)

        await manager.subscribe("dev10:0.0")
        await manager.subscribe("dev10:0.0")

        assert io.started == ["dev10:0.0"]  # pipe started once, fanned out
        assert manager.active_pane_count == 1

    asyncio.run(scenario())


def test_chunk_fans_out_to_all_subscribers() -> None:
    async def scenario() -> None:
        io = FakeIO()
        manager = PaneStreamManager(capture=io.capture, start_pipe=io.start_pipe)

        _snap1, q1 = await manager.subscribe("p")
        _snap2, q2 = await manager.subscribe("p")
        io.on_chunk["p"](b"hello")

        assert q1.get_nowait() == b"hello"
        assert q2.get_nowait() == b"hello"

    asyncio.run(scenario())


def test_last_unsubscribe_stops_pipe_and_removes_stream() -> None:
    async def scenario() -> None:
        io = FakeIO()
        manager = PaneStreamManager(capture=io.capture, start_pipe=io.start_pipe)

        _s1, q1 = await manager.subscribe("p")
        _s2, q2 = await manager.subscribe("p")

        await manager.unsubscribe("p", q1)
        assert io.handles["p"].stopped == 0  # still one subscriber
        assert manager.active_pane_count == 1

        await manager.unsubscribe("p", q2)
        assert io.handles["p"].stopped == 1  # last release tears down the pipe
        assert manager.active_pane_count == 0

    asyncio.run(scenario())


def test_capacity_exceeded_raises() -> None:
    async def scenario() -> None:
        io = FakeIO()
        manager = PaneStreamManager(capture=io.capture, start_pipe=io.start_pipe, max_panes=1)

        await manager.subscribe("a")
        with pytest.raises(StreamCapacityError):
            await manager.subscribe("b")
        assert manager.active_pane_count == 1

    asyncio.run(scenario())


def test_pipe_unavailable_raises_and_leaves_no_stream() -> None:
    async def scenario() -> None:
        io = FakeIO(fail_start=True)
        manager = PaneStreamManager(capture=io.capture, start_pipe=io.start_pipe)

        with pytest.raises(PipeUnavailableError):
            await manager.subscribe("p")
        assert manager.active_pane_count == 0

    asyncio.run(scenario())


def test_backpressure_drains_and_closes_slow_subscriber() -> None:
    async def scenario() -> None:
        io = FakeIO()
        manager = PaneStreamManager(capture=io.capture, start_pipe=io.start_pipe, queue_maxsize=2)

        _snap, queue = await manager.subscribe("p")
        io.on_chunk["p"](b"1")
        io.on_chunk["p"](b"2")
        io.on_chunk["p"](b"3")  # overflow -> drain + close sentinel

        assert _drain_to_close(queue)[-1] is None
        # the slow subscriber was dropped; further chunks are not delivered to it
        io.on_chunk["p"](b"4")
        assert queue.empty()

    asyncio.run(scenario())


def test_pipe_close_signals_all_subscribers() -> None:
    async def scenario() -> None:
        io = FakeIO()
        manager = PaneStreamManager(capture=io.capture, start_pipe=io.start_pipe)

        _s1, q1 = await manager.subscribe("p")
        _s2, q2 = await manager.subscribe("p")
        io.on_close["p"]()  # pipe ended / pane gone

        assert _drain_to_close(q1)[-1] is None
        assert _drain_to_close(q2)[-1] is None
        assert manager.active_pane_count == 0

    asyncio.run(scenario())


def test_aclose_drains_and_stops_every_stream() -> None:
    async def scenario() -> None:
        io = FakeIO()
        manager = PaneStreamManager(capture=io.capture, start_pipe=io.start_pipe)

        _sa, _qa = await manager.subscribe("a")
        _sb, _qb = await manager.subscribe("b")

        await manager.aclose()

        assert io.handles["a"].stopped == 1
        assert io.handles["b"].stopped == 1
        assert manager.active_pane_count == 0

    asyncio.run(scenario())
