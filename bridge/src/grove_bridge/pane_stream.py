"""Per-pane tmux ``pipe-pane`` fan-out stream manager (read-only).

The first websocket subscriber to a pane starts ``tmux pipe-pane`` writing the
pane's output into a private FIFO; a reader fans every chunk out to all
subscribers of that pane. The last subscriber (or an error / pipe close / server
shutdown) tears the pipe down and removes the FIFO — ref-counted and leak-free.

Read-only by construction: ``pipe-pane`` taps a pane's *output*; it does not
attach, resize, or send input, so the operator's tmux is never affected. Cleanup
only ever touches our own pipe + FIFO, never an operator pane.

The manager state machine (subscribe/fan-out/lifecycle/backpressure) is pure and
unit-tested with injected IO; ``make_tmux_pipe_io`` is the real tmux/FIFO backend
exercised by a live smoke.
"""

from __future__ import annotations

import asyncio
import contextlib
import os
import select
import shlex
import subprocess
import threading
import uuid
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Protocol

OnChunk = Callable[[bytes], None]
OnClose = Callable[[], None]
CaptureFn = Callable[[str], Awaitable[bytes]]


class PipeHandle(Protocol):
    async def stop(self) -> None: ...


StartPipeFn = Callable[[str, OnChunk, OnClose], Awaitable[PipeHandle]]


class StreamCapacityError(RuntimeError):
    """Raised when the concurrent-pane cap is reached."""


class PipeUnavailableError(RuntimeError):
    """Raised when ``pipe-pane`` cannot be started; caller should fall back."""


def _drain(queue: asyncio.Queue[bytes | None]) -> None:
    while True:
        try:
            queue.get_nowait()
        except asyncio.QueueEmpty:
            break


@dataclass
class _PaneStream:
    subscribers: set[asyncio.Queue[bytes | None]] = field(default_factory=set)
    handle: PipeHandle | None = None


class PaneStreamManager:
    """Ref-counted fan-out of tmux pane output to websocket subscribers."""

    def __init__(
        self,
        *,
        capture: CaptureFn,
        start_pipe: StartPipeFn,
        max_panes: int = 64,
        queue_maxsize: int = 256,
    ) -> None:
        self._capture = capture
        self._start_pipe = start_pipe
        self._max_panes = max_panes
        self._queue_maxsize = queue_maxsize
        self._streams: dict[str, _PaneStream] = {}
        self._lock = asyncio.Lock()

    @property
    def active_pane_count(self) -> int:
        return len(self._streams)

    async def subscribe(self, pane_id: str) -> tuple[bytes, asyncio.Queue[bytes | None]]:
        """Register a subscriber. Starts the pipe on first subscribe; returns a
        capture snapshot seed plus the per-subscriber chunk queue."""
        queue: asyncio.Queue[bytes | None] = asyncio.Queue(maxsize=self._queue_maxsize)
        async with self._lock:
            stream = self._streams.get(pane_id)
            if stream is None:
                if len(self._streams) >= self._max_panes:
                    raise StreamCapacityError(f"pane stream cap {self._max_panes} reached")
                stream = _PaneStream()
                self._streams[pane_id] = stream
                try:
                    stream.handle = await self._start_pipe(
                        pane_id,
                        self._make_on_chunk(pane_id),
                        self._make_on_close(pane_id),
                    )
                except Exception as exc:
                    self._streams.pop(pane_id, None)
                    raise PipeUnavailableError(str(exc)) from exc
            stream.subscribers.add(queue)
        try:
            snapshot = await self._capture(pane_id)
        except Exception:
            await self.unsubscribe(pane_id, queue)
            raise
        return snapshot, queue

    async def unsubscribe(self, pane_id: str, queue: asyncio.Queue[bytes | None]) -> None:
        handle: PipeHandle | None = None
        async with self._lock:
            stream = self._streams.get(pane_id)
            if stream is None:
                return
            stream.subscribers.discard(queue)
            if not stream.subscribers:
                handle = stream.handle
                self._streams.pop(pane_id, None)
        if handle is not None:
            await handle.stop()

    async def aclose(self) -> None:
        """Drain and tear down every stream (graceful shutdown)."""
        async with self._lock:
            streams = list(self._streams.values())
            self._streams.clear()
        for stream in streams:
            for queue in list(stream.subscribers):
                _drain(queue)
                with contextlib.suppress(asyncio.QueueFull):
                    queue.put_nowait(None)
            stream.subscribers.clear()
            if stream.handle is not None:
                with contextlib.suppress(Exception):
                    await stream.handle.stop()

    def _make_on_chunk(self, pane_id: str) -> OnChunk:
        def on_chunk(data: bytes) -> None:
            self._dispatch(pane_id, data)

        return on_chunk

    def _make_on_close(self, pane_id: str) -> OnClose:
        def on_close() -> None:
            self._close_stream(pane_id)

        return on_close

    def _dispatch(self, pane_id: str, data: bytes) -> None:
        stream = self._streams.get(pane_id)
        if stream is None:
            return
        for queue in list(stream.subscribers):
            try:
                queue.put_nowait(data)
            except asyncio.QueueFull:
                # Backpressure: a slow subscriber would desync an incremental
                # terminal. Drain it and signal close (None) so only that
                # connection drops and reconnects to re-seed — other subscribers
                # and the operator's tmux are untouched.
                _drain(queue)
                with contextlib.suppress(asyncio.QueueFull):
                    queue.put_nowait(None)
                stream.subscribers.discard(queue)

    def _close_stream(self, pane_id: str) -> None:
        stream = self._streams.pop(pane_id, None)
        if stream is None:
            return
        for queue in list(stream.subscribers):
            _drain(queue)
            with contextlib.suppress(asyncio.QueueFull):
                queue.put_nowait(None)
        stream.subscribers.clear()


def make_tmux_pipe_io(
    *,
    tmux_argv: Callable[..., list[str]],
    capture: Callable[[str], bytes],
    fifo_dir: Path,
    timeout: float = 5.0,
    read_size: int = 65536,
) -> tuple[CaptureFn, StartPipeFn]:
    """Build the real (capture, start_pipe) IO backend for the manager.

    ``pipe-pane`` writes the pane's output into a private FIFO; a daemon reader
    opens the FIFO ``O_RDWR | O_NONBLOCK`` (holding a writer ref avoids the
    no-writer EOF race) and forwards chunks. ``stop`` sets a flag, toggles the
    pipe off, joins the reader, and unlinks the FIFO — idempotent and leak-free.
    """

    async def capture_async(pane_id: str) -> bytes:
        return await asyncio.to_thread(capture, pane_id)

    async def start_pipe(pane_id: str, on_chunk: OnChunk, on_close: OnClose) -> PipeHandle:
        loop = asyncio.get_running_loop()
        fifo_dir.mkdir(parents=True, exist_ok=True)
        fifo_path = fifo_dir / f"grove-pane-{uuid.uuid4().hex}.fifo"
        os.mkfifo(fifo_path, 0o600)

        def _unlink() -> None:
            with contextlib.suppress(OSError):
                os.unlink(fifo_path)

        started = await asyncio.to_thread(
            subprocess.run,
            tmux_argv(pane_id, "pipe-pane", "-t", pane_id, f"cat > {shlex.quote(str(fifo_path))}"),
            capture_output=True,
            timeout=timeout,
            check=False,
        )
        if started.returncode != 0:
            _unlink()
            raise PipeUnavailableError(started.stderr.decode("utf-8", errors="replace").strip())

        stop_event = threading.Event()
        try:
            fd = os.open(fifo_path, os.O_RDWR | os.O_NONBLOCK)
        except OSError as exc:
            await asyncio.to_thread(_pipe_off, tmux_argv, pane_id, timeout)
            _unlink()
            raise PipeUnavailableError(str(exc)) from exc

        def reader() -> None:
            try:
                while not stop_event.is_set():
                    ready, _, _ = select.select([fd], [], [], 0.25)
                    if not ready:
                        continue
                    try:
                        data = os.read(fd, read_size)
                    except BlockingIOError:
                        continue
                    except OSError:
                        break
                    if data:
                        loop.call_soon_threadsafe(on_chunk, data)
            finally:
                with contextlib.suppress(OSError):
                    os.close(fd)
                loop.call_soon_threadsafe(on_close)
                _unlink()

        thread = threading.Thread(target=reader, name=f"grove-pane-{pane_id}", daemon=True)
        thread.start()

        class _Handle:
            _stopped = False

            async def stop(self) -> None:
                if self._stopped:
                    return
                self._stopped = True
                stop_event.set()
                with contextlib.suppress(Exception):
                    await asyncio.to_thread(_pipe_off, tmux_argv, pane_id, timeout)
                await asyncio.to_thread(thread.join, 2.0)
                _unlink()

        return _Handle()

    return capture_async, start_pipe


def _pipe_off(tmux_argv: Callable[..., list[str]], pane_id: str, timeout: float) -> None:
    # `pipe-pane` with no shell-command closes the current pipe for the pane.
    subprocess.run(
        tmux_argv(pane_id, "pipe-pane", "-t", pane_id),
        capture_output=True,
        timeout=timeout,
        check=False,
    )
