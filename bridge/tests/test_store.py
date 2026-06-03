from __future__ import annotations

import sqlite3
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from grove_bridge.store import SQLITE_BUSY_TIMEOUT_MS, SQLiteBoardStore


def test_connections_enable_wal_busy_timeout_and_normal_sync(tmp_path: Path) -> None:
    db_path = tmp_path / "board.db"
    store = SQLiteBoardStore(db_path)

    with store._connect() as conn:
        journal_mode = conn.execute("PRAGMA journal_mode").fetchone()[0]
        busy_timeout = conn.execute("PRAGMA busy_timeout").fetchone()[0]
        synchronous = conn.execute("PRAGMA synchronous").fetchone()[0]

    assert str(journal_mode).lower() == "wal"
    assert busy_timeout == SQLITE_BUSY_TIMEOUT_MS
    assert synchronous == 1


def test_claim_next_has_one_cas_winner_for_concurrent_claims(tmp_path: Path) -> None:
    db_path = tmp_path / "board.db"
    store = SQLiteBoardStore(db_path)
    task = store.create_task(
        board="main",
        title="Race",
        body="Only one worker may claim this.",
        assignee="grove:codex",
    )

    def claim(node_id: str) -> str | None:
        claimed = SQLiteBoardStore(db_path).claim_next(
            board="main",
            assignee="grove:codex",
            node_id=node_id,
            ttl_seconds=60,
        )
        return claimed.run_id if claimed is not None else None

    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(claim, ["codex-a", "codex-b"]))

    run_ids = [run_id for run_id in results if run_id is not None]
    assert len(run_ids) == 1
    assert store.get_task(board="main", task_id=task.id).status == "running"
    assert len(store.list_runs(board="main", task_id=task.id)) == 1
    assert (
        store.claim_next(
            board="main",
            assignee="grove:codex",
            node_id="codex-c",
            ttl_seconds=60,
        )
        is None
    )


def test_busy_timeout_serializes_many_concurrent_claim_attempts_without_busy(
    tmp_path: Path,
) -> None:
    db_path = tmp_path / "board.db"
    store = SQLiteBoardStore(db_path)
    task = store.create_task(
        board="main",
        title="Busy race",
        body=None,
        assignee="grove:codex",
    )

    def claim(index: int) -> tuple[str | None, str | None]:
        try:
            claimed = SQLiteBoardStore(db_path).claim_next(
                board="main",
                assignee="grove:codex",
                node_id=f"codex-{index}",
                ttl_seconds=60,
            )
        except sqlite3.OperationalError as exc:
            return None, str(exc)
        return (claimed.run_id if claimed is not None else None), None

    with ThreadPoolExecutor(max_workers=8) as pool:
        results = list(pool.map(claim, range(16)))

    errors = [error for _run_id, error in results if error is not None]
    run_ids = [run_id for run_id, error in results if error is None and run_id is not None]
    assert errors == []
    assert len(run_ids) == 1
    assert store.get_task(board="main", task_id=task.id).status == "running"
    assert len(store.list_runs(board="main", task_id=task.id)) == 1


def test_heartbeat_complete_and_block_require_current_run_and_claim(
    tmp_path: Path,
) -> None:
    store = SQLiteBoardStore(tmp_path / "board.db")
    complete_task = store.create_task(
        board="main",
        title="Complete",
        body=None,
        assignee="grove:codex",
    )
    complete_claim = store.claim_next(
        board="main",
        assignee="grove:codex",
        node_id="codex-a",
        ttl_seconds=30,
    )
    assert complete_claim is not None

    assert not store.heartbeat(
        board="main",
        task_id=complete_task.id,
        run_id="wrong",
        claim_lock=complete_claim.claim_lock,
        ttl_seconds=30,
    )
    assert store.heartbeat(
        board="main",
        task_id=complete_task.id,
        run_id=complete_claim.run_id,
        claim_lock=complete_claim.claim_lock,
        ttl_seconds=30,
    )
    assert not store.complete(
        board="main",
        task_id=complete_task.id,
        run_id="wrong",
        claim_lock=complete_claim.claim_lock,
        result="ignored",
        summary="ignored",
        metadata={},
    )
    assert store.complete(
        board="main",
        task_id=complete_task.id,
        run_id=complete_claim.run_id,
        claim_lock=complete_claim.claim_lock,
        result="done output",
        summary="done summary",
        metadata={"node": "codex-a"},
    )
    completed = store.get_task(board="main", task_id=complete_task.id)
    assert completed.status == "done"
    assert completed.result == "done output"
    assert completed.metadata == {"node": "codex-a"}

    block_task = store.create_task(
        board="main",
        title="Block",
        body=None,
        assignee="grove:codex",
    )
    block_claim = store.claim_next(
        board="main",
        assignee="grove:codex",
        node_id="codex-b",
        ttl_seconds=30,
    )
    assert block_claim is not None
    assert not store.block(
        board="main",
        task_id=block_task.id,
        run_id=block_claim.run_id,
        claim_lock="wrong",
        reason="ignored",
    )
    assert store.block(
        board="main",
        task_id=block_task.id,
        run_id=block_claim.run_id,
        claim_lock=block_claim.claim_lock,
        reason="needs input",
        metadata={"node": "codex-b"},
        needs_human=True,
    )
    blocked = store.get_task(board="main", task_id=block_task.id)
    assert blocked.status == "blocked"
    run = store.list_runs(board="main", task_id=block_task.id)[0]
    assert run.status == "blocked"
    assert run.error == "needs input"
    assert run.metadata == {"needs_human": True, "node": "codex-b"}


def test_release_stale_returns_running_tasks_to_ready(tmp_path: Path) -> None:
    store = SQLiteBoardStore(tmp_path / "board.db")
    task = store.create_task(
        board="main",
        title="Stale",
        body=None,
        assignee="grove:codex",
    )
    claimed = store.claim_next(
        board="main",
        assignee="grove:codex",
        node_id="codex-a",
        ttl_seconds=1,
    )
    assert claimed is not None
    assert claimed.task.claim_expires is not None

    released = store.release_stale(board="main", now=claimed.task.claim_expires + 1)

    assert released == 1
    ready = store.get_task(board="main", task_id=task.id)
    assert ready.status == "ready"
    assert ready.claim_lock is None
    assert ready.current_run_id is None
    run = store.list_runs(board="main", task_id=task.id)[0]
    assert run.status == "released"
    assert run.outcome == "released"


def test_dependencies_promote_children_only_after_parents_done_or_force_unblock(
    tmp_path: Path,
) -> None:
    store = SQLiteBoardStore(tmp_path / "board.db")
    parent_a = store.create_task(board="main", title="A", body=None, assignee="grove:codex")
    parent_b = store.create_task(board="main", title="B", body=None, assignee="grove:codex")
    child = store.create_task(
        board="main",
        title="Child",
        body=None,
        assignee="grove:codex",
        status="blocked",
    )
    store.add_dependency(board="main", parent_id=parent_a.id, child_id=child.id)
    store.add_dependency(board="main", parent_id=parent_b.id, child_id=child.id)

    claim_a = store.claim_next(
        board="main",
        assignee="grove:codex",
        node_id="codex-a",
        ttl_seconds=30,
    )
    assert claim_a is not None
    assert store.complete(
        board="main",
        task_id=claim_a.task.id,
        run_id=claim_a.run_id,
        claim_lock=claim_a.claim_lock,
        result="a",
        summary="a",
        metadata={},
    )
    assert store.get_task(board="main", task_id=child.id).status == "blocked"

    claim_b = store.claim_next(
        board="main",
        assignee="grove:codex",
        node_id="codex-b",
        ttl_seconds=30,
    )
    assert claim_b is not None
    assert store.complete(
        board="main",
        task_id=claim_b.task.id,
        run_id=claim_b.run_id,
        claim_lock=claim_b.claim_lock,
        result="b",
        summary="b",
        metadata={},
    )
    assert store.get_task(board="main", task_id=child.id).status == "ready"

    gated_parent = store.create_task(board="main", title="Gate", body=None, assignee=None)
    gated_child = store.create_task(
        board="main",
        title="Gated child",
        body=None,
        assignee="grove:codex",
        status="blocked",
    )
    store.add_dependency(board="main", parent_id=gated_parent.id, child_id=gated_child.id)
    assert not store.unblock(board="main", task_id=gated_child.id, actor="tester")
    assert store.get_task(board="main", task_id=gated_child.id).status == "blocked"
    assert store.unblock(
        board="main",
        task_id=gated_child.id,
        actor="tester",
        comment="manual override",
        force=True,
    )
    assert store.get_task(board="main", task_id=gated_child.id).status == "ready"
    assert store.list_comments(board="main", task_id=gated_child.id)[0].body == "manual override"


def test_notify_subscriptions_are_stored_and_upserted(tmp_path: Path) -> None:
    store = SQLiteBoardStore(tmp_path / "board.db")
    task = store.create_task(board="main", title="Notify", body=None, assignee="grove:codex")

    store.add_notify_sub(
        board="main",
        task_id=task.id,
        channel_kind="inbox",
        room_id="ops",
        thread_id="thread-1",
        user_id="user-a",
    )
    store.add_notify_sub(
        board="main",
        task_id=task.id,
        channel_kind="inbox",
        room_id="ops",
        thread_id="thread-1",
        user_id="user-b",
    )

    subs = store.list_notify_subs(board="main", task_id=task.id)
    assert len(subs) == 1
    assert subs[0].channel_kind == "inbox"
    assert subs[0].room_id == "ops"
    assert subs[0].thread_id == "thread-1"
    assert subs[0].user_id == "user-b"
