from __future__ import annotations

from pathlib import Path

from grove_bridge.store import SlackChatQueueItem, SQLiteBoardStore


def _enqueue(store: SQLiteBoardStore, *, msg_ts: str, board: str = "sample") -> SlackChatQueueItem:
    return store.enqueue_slack_chat_message(
        board=board,
        team_id="T1",
        channel_id="C1",
        thread_ts="th1",
        message_ts=msg_ts,
        user_id="U1",
        node="chat-master",
        text="hi",
    )


def test_upsert_and_get_chat_session(tmp_path: Path) -> None:
    store = SQLiteBoardStore(tmp_path / "b.db")
    row = store.upsert_chat_session(board="sample", conversation_id="conv1", surface="slack")
    assert row.conversation_id == "conv1"
    assert row.surface == "slack"
    assert row.status == "active"

    got = store.get_chat_session(board="sample", conversation_id="conv1", surface="slack")
    assert got is not None and got.id == row.id

    # Idempotent on the unique (board, conversation, surface) key.
    again = store.upsert_chat_session(board="sample", conversation_id="conv1", surface="slack")
    assert again.id == row.id

    assert (
        store.get_chat_session(board="sample", conversation_id="missing", surface="slack") is None
    )


def test_claim_slack_chat_message_is_idempotent(tmp_path: Path) -> None:
    store = SQLiteBoardStore(tmp_path / "b.db")
    item = _enqueue(store, msg_ts="111.1")
    now = item.created_at + 10
    stale = now - 1000

    first = store.claim_slack_chat_message(item.id, now=now, running_stale_before=stale)
    assert first is not None
    assert first.status == "running"

    # The same (now-running, not stale) item cannot be claimed twice → per-item claim.
    second = store.claim_slack_chat_message(item.id, now=now, running_stale_before=stale)
    assert second is None


def test_claim_due_bounded_drain_claims_each_once(tmp_path: Path) -> None:
    store = SQLiteBoardStore(tmp_path / "b.db")
    items = [_enqueue(store, msg_ts=f"11{i}.1") for i in range(3)]
    now = max(i.created_at for i in items) + 10
    stale = now - 1000

    first = store.claim_due_slack_chat_messages(
        board="sample", now=now, running_stale_before=stale, limit=2
    )
    assert len(first) == 2

    # Already-claimed (running, not stale) items are not re-claimed; only the remaining one.
    second = store.claim_due_slack_chat_messages(
        board="sample", now=now, running_stale_before=stale, limit=10
    )
    assert len(second) == 1
    assert {i.id for i in first}.isdisjoint({i.id for i in second})


def test_chat_queue_metrics_reports_depth_running_oldest(tmp_path: Path) -> None:
    store = SQLiteBoardStore(tmp_path / "b.db")
    items = [_enqueue(store, msg_ts=f"22{i}.1") for i in range(2)]
    now = max(i.created_at for i in items) + 5

    m = store.chat_queue_metrics(board="sample", now=now)
    assert m["depth"] == 2
    assert m["running"] == 0
    assert m["oldest_age_seconds"] is not None and m["oldest_age_seconds"] >= 0

    store.claim_slack_chat_message(items[0].id, now=now, running_stale_before=now - 1000)
    m2 = store.chat_queue_metrics(board="sample", now=now)
    assert m2["depth"] == 1
    assert m2["running"] == 1
