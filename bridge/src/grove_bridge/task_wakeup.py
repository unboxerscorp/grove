"""Event-driven task-master wakeup.

The 10-minute task-master poll reacts slowly. This watcher tails the board event
log and, on a *meaningful* task change (create / assignee change / status change
incl. needs_human·blocked·ask_human / confirm-created), nudges the task-master to
sweep immediately — coalesced (debounce), rate-limited, and deduped so rapid
edits collapse into one nudge instead of a storm. The 10-minute poll remains the
fallback.

Strictly observe-and-nudge: it never mutates task status or claims work (that
stays with the assignee/lead/operator). The filter/coalesce/dedup logic is pure
and unit-tested; the real event source + ``grove send`` delivery are injected.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable

from grove_bridge.store import BoardEvent

# A "staged" item is filed but not yet dispatched (human-list stack-then-gate);
# it must not nudge task-master until a human dispatches it (staged -> ready).
_STAGED_STATUS = "staged"


def is_meaningful_event(event: BoardEvent) -> bool:
    payload = event.payload
    if event.kind == "task.created":
        # New items default to staged (accumulate); only a non-staged create nudges.
        return payload.get("status") != _STAGED_STATUS
    if event.kind == "task.updated":
        # A status change is actionable unless it lands in staged; an assignee
        # change (no status key) is actionable. reviewer/title-body edits are not.
        # (audit.task.* events duplicate these and are ignored.)
        if "status" in payload:
            return payload.get("status") != _STAGED_STATUS
        return "assignee" in payload
    return False


def summarize_event(event: BoardEvent, *, project: str | None = None) -> str:
    # Prefix with the project so a cross-project nudge says WHICH board changed.
    prefix = f"{project}/" if project else ""
    task = event.task_id or "?"
    payload = event.payload
    if event.kind == "task.created":
        return f"{prefix}{task} created"
    if "status" in payload:
        previous = payload.get("previous_status") or "?"
        return f"{prefix}{task} {previous}->{payload.get('status')}"
    if "assignee" in payload:
        previous = payload.get("previous_assignee") or "none"
        current = payload.get("assignee") or "none"
        return f"{prefix}{task} assignee {previous}->{current}"
    return f"{prefix}{task} updated"


class WakeupCoalescer:
    """Decides when accumulated changes warrant a single wakeup.

    Windowed debounce (a burst within ``debounce_seconds`` of the first change
    coalesces into one message), ``min_interval_seconds`` rate-limit between
    sends, and recent-digest dedup. Pure + clock-injected (``now`` passed in)."""

    def __init__(
        self,
        *,
        debounce_seconds: float = 5.0,
        min_interval_seconds: float = 30.0,
        max_summaries: int = 20,
    ) -> None:
        self._debounce = debounce_seconds
        self._min_interval = min_interval_seconds
        self._max_summaries = max_summaries
        self._pending: list[str] = []
        self._first_dirty_at: float | None = None
        self._last_sent_at: float | None = None
        self._last_digest: str | None = None

    def note(self, summary: str, *, now: float) -> None:
        self._pending.append(summary)
        if self._first_dirty_at is None:
            self._first_dirty_at = now

    def due(self, *, now: float) -> str | None:
        if not self._pending or self._first_dirty_at is None:
            return None
        if now - self._first_dirty_at < self._debounce:
            return None
        if self._last_sent_at is not None and now - self._last_sent_at < self._min_interval:
            return None
        digest = self._digest()
        if digest == self._last_digest:
            self._reset()  # identical to the last nudge -> skip the redundant send
            return None
        message = self._message()
        self._last_sent_at = now
        self._last_digest = digest
        self._reset()
        return message

    def _unique(self) -> list[str]:
        seen: set[str] = set()
        unique: list[str] = []
        for summary in self._pending:
            if summary not in seen:
                seen.add(summary)
                unique.append(summary)
        return unique

    def _digest(self) -> str:
        return "|".join(self._unique())

    def _message(self) -> str:
        items = self._unique()
        shown = items[: self._max_summaries]
        body = "; ".join(shown)
        more = len(items) - len(shown)
        if more > 0:
            body += f"; (+{more} more)"
        return (
            f"task board changed ({len(items)}): {body}. "
            "Sweep your cross-project view (grove task list --all-projects --json) "
            "and nudge/escalate as needed."
        )

    def _reset(self) -> None:
        self._pending = []
        self._first_dirty_at = None


ListEventsAfter = Callable[[int], list[BoardEvent]]
LatestCursor = Callable[[], int]
SendFn = Callable[[str], Awaitable[None]]
NowFn = Callable[[], float]
SleepFn = Callable[[float], Awaitable[None]]
BoardLabel = Callable[[str], str]


class TaskWakeupWatcher:
    """Tails the board event log and nudges task-master when changes are due.

    The event source should be cross-project (all boards); each nudge is tagged
    with its project via ``board_label``. A periodic ``sweep_interval_seconds``
    backstop nudges task-master to sweep even when no events arrive (so missed
    events / quiet periods still surface ready items); any real nudge resets the
    backstop timer so the two paths never double-fire."""

    def __init__(
        self,
        *,
        list_events_after: ListEventsAfter,
        latest_cursor: LatestCursor,
        send: SendFn,
        now: NowFn,
        sleep: SleepFn | None = None,
        coalescer: WakeupCoalescer | None = None,
        board_label: BoardLabel | None = None,
        sweep_interval_seconds: float | None = None,
        tick_seconds: float = 2.0,
    ) -> None:
        self._list_events_after = list_events_after
        self._latest_cursor = latest_cursor
        self._send = send
        self._now = now
        self._sleep = sleep
        self._coalescer = coalescer or WakeupCoalescer()
        self._board_label = board_label
        self._sweep_interval = sweep_interval_seconds
        self._tick_seconds = tick_seconds
        self.cursor = 0
        self._last_nudge_at: float | None = None
        self._stopped = False

    def _project_for(self, event: BoardEvent) -> str | None:
        if self._board_label is None:
            return None
        try:
            return self._board_label(event.board_id)
        except Exception:  # noqa: BLE001 - a missing board label must not crash the loop
            return None

    async def run_once(self) -> str | None:
        now = self._now()
        if self._last_nudge_at is None:
            self._last_nudge_at = now  # baseline the backstop from the first tick
        for event in self._list_events_after(self.cursor):
            self.cursor = event.cursor
            if is_meaningful_event(event):
                self._coalescer.note(
                    summarize_event(event, project=self._project_for(event)), now=now
                )
        message = self._coalescer.due(now=now)
        if message is None and self._sweep_interval is not None:
            if now - self._last_nudge_at >= self._sweep_interval:
                message = (
                    "periodic cross-project sweep: run "
                    "grove task list --all-projects --json and surface/nudge any "
                    "ready or stale items."
                )
        if message is not None:
            await self._send(message)
            self._last_nudge_at = now
        return message

    async def run(self) -> None:
        # Seed from the current tip so only NEW changes nudge (no history storm).
        self.cursor = self._latest_cursor()
        if self._sleep is None:  # pragma: no cover - defensive
            raise RuntimeError("TaskWakeupWatcher.run requires a sleep function")
        while not self._stopped:
            try:
                await self.run_once()
            except Exception:  # noqa: BLE001 - watcher must never crash the loop
                pass
            await self._sleep(self._tick_seconds)

    def stop(self) -> None:
        self._stopped = True
