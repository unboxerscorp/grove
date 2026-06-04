from __future__ import annotations

import json
import sqlite3
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from grove_bridge.store import (
    SQLITE_BUSY_TIMEOUT_MS,
    DecisionConflict,
    SQLiteBoardStore,
    TaskTransitionConflict,
)


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


def test_task_reviewer_column_migrates_and_status_reviewer_updates_audit(
    tmp_path: Path,
) -> None:
    db_path = tmp_path / "board.db"
    with sqlite3.connect(db_path) as conn:
        conn.execute(
            """
            CREATE TABLE tasks (
                id TEXT PRIMARY KEY,
                board_id TEXT NOT NULL,
                title TEXT NOT NULL,
                body TEXT,
                assignee TEXT,
                status TEXT NOT NULL,
                priority INTEGER NOT NULL DEFAULT 0,
                workspace_kind TEXT NOT NULL DEFAULT 'scratch',
                workspace_path TEXT,
                branch_name TEXT,
                claim_lock TEXT,
                claim_expires INTEGER,
                current_run_id TEXT,
                last_heartbeat_at INTEGER,
                result TEXT,
                metadata_json TEXT NOT NULL DEFAULT '{}',
                created_by TEXT,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            )
            """
        )
    store = SQLiteBoardStore(db_path)
    with store._connect() as conn:
        columns = {row["name"] for row in conn.execute("PRAGMA table_info(tasks)").fetchall()}
    task = store.create_task(
        board="main",
        title="Needs review",
        body=None,
        assignee="maker",
        reviewer="reviewer",
    )
    transitioned = store.set_task_status(
        board="main",
        task_id=task.id,
        status="review",
        actor={"kind": "local", "id": "lead", "login": "lead", "role": "none"},
    )
    changed = store.set_task_reviewer(
        board="main",
        task_id=task.id,
        reviewer="qa",
        actor={"kind": "local", "id": "lead", "login": "lead", "role": "none"},
    )

    assert "reviewer" in columns
    assert task.reviewer == "reviewer"
    assert transitioned.status == "review"
    assert changed.reviewer == "qa"
    assert store.list_audit_events(board="main", action="status-transition")
    assert store.list_audit_events(board="main", action="reviewer-change")


def test_legacy_running_statuses_normalize_filter_and_count_as_wip(tmp_path: Path) -> None:
    db_path = tmp_path / "board.db"
    store = SQLiteBoardStore(db_path)
    legacy_in_progress = store.create_task(
        board="main",
        title="Legacy in-progress",
        body=None,
        assignee="codex-a",
        status="in_progress",
    )
    legacy_claimed = store.create_task(
        board="main",
        title="Legacy claimed",
        body=None,
        assignee="codex-b",
        status="claimed",
    )
    legacy_executing = store.create_task(
        board="main",
        title="Legacy executing",
        body=None,
        assignee="codex-c",
        status="executing",
    )

    reopened = SQLiteBoardStore(db_path)

    assert reopened.get_task(board="main", task_id=legacy_in_progress.id).status == "running"
    assert reopened.get_task(board="main", task_id=legacy_claimed.id).status == "running"
    assert reopened.get_task(board="main", task_id=legacy_executing.id).status == "running"

    raw_legacy = reopened.create_task(
        board="main",
        title="Raw legacy after migration",
        body=None,
        assignee="codex-a",
    )
    queued = reopened.create_task(board="main", title="Queued", body=None, assignee="codex-a")
    with reopened._connect(immediate=True) as conn:
        conn.execute("UPDATE tasks SET status = 'in_progress' WHERE id = ?", (raw_legacy.id,))

    running_ids = {task.id for task in reopened.list_tasks(board="main", status="running")}
    alias_ids = {task.id for task in reopened.list_tasks(board="main", status="in_progress")}
    queried, _, total = reopened.query_tasks(board="main", status="running")
    reopened.set_saved_view(board="main", name="active", filters={"status": "in_progress"})

    assert raw_legacy.id in running_ids
    assert raw_legacy.id in alias_ids
    assert raw_legacy.id in {task.id for task in queried}
    assert total == len(running_ids)
    assert reopened.saved_views(board="main")["active"]["status"] == "running"
    assert (
        reopened.claim_next(
            board="main",
            assignee="codex-a",
            node_id="codex-a",
            ttl_seconds=60,
            task_id=queued.id,
        )
        is None
    )


def test_node_health_persists_upserts_and_redacts_display_text(tmp_path: Path) -> None:
    store = SQLiteBoardStore(tmp_path / "board.db")
    secret = "xoxb-" + ("a" * 44)

    first = store.record_node_health(
        project="dev10",
        session="dev10",
        node="worker",
        status="rate_limited",
        reason="429",
        message=f"reset after /Users/chopin/project {secret}",
        detected_at=100,
        reset_at=160,
        source="grove-ts-watchdog",
    )
    second = store.record_node_health(
        project="dev10",
        session="dev10",
        node="worker",
        status="healthy",
        reason=None,
        message=None,
        detected_at=200,
        reset_at=None,
        source="watchdog",
    )
    listed = store.list_node_health(project="dev10", session="dev10")

    assert first.status == "rate_limited"
    assert first.reset_at == 160
    assert secret not in str(first.message)
    assert "/Users/chopin" not in str(first.message)
    assert second.status == "healthy"
    assert second.reason is None
    assert len(listed) == 1
    assert listed[0].detected_at == 200


def test_decision_ledger_quorum_and_dispatch_lock_are_idempotent(tmp_path: Path) -> None:
    store = SQLiteBoardStore(tmp_path / "board.db")
    proposal = store.create_decision_proposal(
        board="main",
        proposer="codex",
        title="Implement child task",
        body="Do the work.",
        target_assignee="maker",
        reviewer="reviewer",
        metadata={"labels": ["triage"]},
    )

    first_vote = store.record_decision_vote(
        board="main",
        proposal_id=proposal.id,
        voter="codex",
        approve=True,
    )
    try:
        store.record_decision_vote(
            board="main",
            proposal_id=proposal.id,
            voter="codex",
            approve=False,
        )
    except DecisionConflict as exc:
        assert "already voted" in str(exc)
    else:
        raise AssertionError("expected duplicate vote conflict")
    approved = store.record_decision_vote(
        board="main",
        proposal_id=proposal.id,
        voter="claude",
        approve=True,
        reason="looks good",
    )
    dispatch = store.dispatch_decision(
        board="main",
        proposal_id=proposal.id,
        idempotency_key="dispatch-once",
        actor={"kind": "local", "id": "lead", "login": "lead", "role": "none"},
    )
    retry = store.dispatch_decision(
        board="main",
        proposal_id=proposal.id,
        idempotency_key="dispatch-once",
        actor={"kind": "local", "id": "lead", "login": "lead", "role": "none"},
    )

    assert proposal.status == "pending"
    assert first_vote.status == "pending"
    assert approved.status == "approved"
    assert dispatch.created is True
    assert retry.created is False
    assert retry.task.id == dispatch.task.id
    assert dispatch.task.status == "ready"
    assert dispatch.task.title == "Implement child task"
    assert dispatch.task.assignee == "maker"
    assert dispatch.task.reviewer == "reviewer"
    decision_metadata = dispatch.task.metadata["decision"]
    assert isinstance(decision_metadata, dict)
    assert decision_metadata["proposal_id"] == proposal.id
    assert store.get_decision_proposal(board="main", proposal_id=proposal.id).status == "dispatched"
    assert len(store.list_tasks(board="main")) == 1
    try:
        store.dispatch_decision(
            board="main",
            proposal_id=proposal.id,
            idempotency_key="different",
            actor={"kind": "local", "id": "lead", "login": "lead", "role": "none"},
        )
    except DecisionConflict as exc:
        assert "different key" in str(exc)
    else:
        raise AssertionError("expected dispatch key conflict")


def test_manual_status_transition_requires_expected_status_and_run_id(
    tmp_path: Path,
) -> None:
    store = SQLiteBoardStore(tmp_path / "board.db")
    task = store.create_task(board="main", title="CAS", body=None, assignee="maker")

    try:
        store.set_task_status(
            board="main",
            task_id=task.id,
            status="review",
            actor={"kind": "local", "id": "lead", "login": "lead", "role": "none"},
            expected_status="running",
        )
    except TaskTransitionConflict as exc:
        assert "expected status" in str(exc)
    else:
        raise AssertionError("expected status conflict")

    claimed = store.claim_next(board="main", assignee="maker", node_id="maker", ttl_seconds=60)
    assert claimed is not None
    try:
        store.set_task_status(
            board="main",
            task_id=task.id,
            status="review",
            actor={"kind": "local", "id": "lead", "login": "lead", "role": "none"},
            run_id="wrong-run",
        )
    except TaskTransitionConflict as exc:
        assert "current run" in str(exc)
    else:
        raise AssertionError("expected run conflict")


def test_manual_status_transition_idempotency_key_deduplicates_events_and_comment(
    tmp_path: Path,
) -> None:
    store = SQLiteBoardStore(tmp_path / "board.db")
    task = store.create_task(board="main", title="Retryable", body=None, assignee=None)
    actor = {"kind": "local", "id": "lead", "login": "lead", "role": "none"}

    first = store.set_task_status(
        board="main",
        task_id=task.id,
        status="review",
        actor=actor,
        expected_status="ready",
        idempotency_key="transition-1",
        comment="ready for review",
        comment_author="lead",
    )
    audit_count = len(store.list_audit_events(board="main", action="status-transition"))
    comment_count = len(store.list_comments(board="main", task_id=task.id))
    event_count = len(store.list_events_after(cursor=0, limit=100))

    second = store.set_task_status(
        board="main",
        task_id=task.id,
        status="review",
        actor=actor,
        expected_status="ready",
        idempotency_key="transition-1",
        comment="ready for review",
        comment_author="lead",
    )

    assert first.status == "review"
    assert second.status == "review"
    assert len(store.list_audit_events(board="main", action="status-transition")) == audit_count
    assert len(store.list_comments(board="main", task_id=task.id)) == comment_count
    assert len(store.list_events_after(cursor=0, limit=100)) == event_count
    done = store.set_task_status(
        board="main",
        task_id=task.id,
        status="done",
        actor=actor,
        expected_status="review",
        idempotency_key="transition-2",
    )
    after_done_event_count = len(store.list_events_after(cursor=0, limit=100))
    delayed_retry = store.set_task_status(
        board="main",
        task_id=task.id,
        status="review",
        actor=actor,
        idempotency_key="transition-1",
    )

    assert done.status == "done"
    assert delayed_retry.status == "done"
    assert len(store.list_events_after(cursor=0, limit=100)) == after_done_event_count
    try:
        store.set_task_status(
            board="main",
            task_id=task.id,
            status="done",
            actor=actor,
            idempotency_key="transition-1",
        )
    except TaskTransitionConflict as exc:
        assert "idempotency key" in str(exc)
    else:
        raise AssertionError("expected idempotency key conflict")


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


def test_claim_next_limits_one_active_wip_per_node(tmp_path: Path) -> None:
    store = SQLiteBoardStore(tmp_path / "board.db")
    first = store.create_task(board="main", title="First", body=None, assignee="grove:codex")
    second = store.create_task(board="main", title="Second", body=None, assignee="grove:codex")

    claimed = store.claim_next(
        board="main",
        assignee="grove:codex",
        node_id="codex-a",
        ttl_seconds=60,
        task_id=first.id,
    )

    assert claimed is not None
    assert (
        store.claim_next(
            board="main",
            assignee="grove:codex",
            node_id="codex-a",
            ttl_seconds=60,
            task_id=second.id,
        )
        is None
    )
    assert (
        store.claim_next(
            board="main",
            assignee="grove:codex",
            node_id="codex-b",
            ttl_seconds=60,
            task_id=second.id,
        )
        is not None
    )


def test_claim_next_counts_manual_running_task_as_node_wip(tmp_path: Path) -> None:
    store = SQLiteBoardStore(tmp_path / "board.db")
    running = store.create_task(board="main", title="Manual", body=None, assignee="codex-a")
    ready = store.create_task(board="main", title="Queued", body=None, assignee="codex-a")
    store.set_task_status(
        board="main",
        task_id=running.id,
        status="running",
        actor={"kind": "local", "id": "lead", "login": "lead", "role": "none"},
    )

    assert (
        store.claim_next(
            board="main",
            assignee="codex-a",
            node_id="codex-a",
            ttl_seconds=60,
            task_id=ready.id,
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
    audit_events = store.list_audit_events(board="main")
    assert [event.kind for event in audit_events] == [
        "audit.task.claim",
        "audit.task.complete",
        "audit.task.claim",
        "audit.task.block",
    ]
    assert audit_events[0].payload["actor"] == {
        "kind": "node",
        "id": "codex-a",
        "login": "codex-a",
        "role": "none",
    }
    assert audit_events[1].payload["summary"] == "done summary"
    assert audit_events[3].payload["target"] == {
        "type": "task",
        "id": block_task.id,
        "node": "codex-b",
    }


def test_audit_filters_apply_before_limit_for_pagination(tmp_path: Path) -> None:
    store = SQLiteBoardStore(tmp_path / "board.db")
    local_actor = {"kind": "local", "id": "lead", "login": "lead", "role": "none"}
    store.add_audit_event(
        board="main",
        kind="audit.task.block",
        actor=local_actor,
        action="block",
        target={"type": "task", "id": "task-a", "node": "qa"},
    )
    first_assign = store.add_audit_event(
        board="main",
        kind="audit.task.assign",
        actor=local_actor,
        action="assign",
        target={"type": "task", "id": "task-b", "node": "worker"},
    )
    store.add_audit_event(
        board="main",
        kind="audit.node.spawn",
        actor={"kind": "node", "id": "qa", "login": "qa", "role": "none"},
        action="spawn",
        target={"type": "node", "id": "qa", "node": "qa"},
    )
    second_assign = store.add_audit_event(
        board="main",
        kind="audit.task.assign",
        actor=local_actor,
        action="assign",
        target={"type": "task", "id": "task-c", "node": "worker"},
    )

    first_page = store.list_audit_events(board="main", limit=1, action="assign")
    second_page = store.list_audit_events(
        board="main",
        cursor=first_page[-1].cursor,
        limit=1,
        action="assign",
    )
    done_page = store.list_audit_events(
        board="main",
        cursor=second_page[-1].cursor,
        limit=1,
        action="assign",
    )
    node_page = store.list_audit_events(board="main", limit=1, node="worker")

    assert [event.id for event in first_page] == [first_assign.id]
    assert [event.id for event in second_page] == [second_assign.id]
    assert done_page == []
    assert [event.id for event in node_page] == [first_assign.id]
    assert first_page[0].cursor < second_page[0].cursor


def test_audit_event_sanitizes_extra_payload_strings(tmp_path: Path) -> None:
    store = SQLiteBoardStore(tmp_path / "board.db")
    secret = "xoxb-" + ("a" * 44)
    event = store.add_audit_event(
        board="main",
        kind="audit.task.retro",
        actor={"kind": "node", "id": f"/Users/chopin/{secret}", "login": "maker"},
        action="retro",
        target={"type": "task", "id": "task-a", "node": f"/etc/{secret}"},
        payload={"node": f"/Applications/{secret}", "nested": {"path": "/usr/local/bin"}},
        summary=f"retro from /Users/chopin/project {secret}",
    )

    encoded = json.dumps(event.payload)
    assert secret not in encoded
    assert "/Users/chopin" not in encoded
    assert "/Applications" not in encoded
    assert "/usr/local/bin" not in encoded
    assert event.payload["summary"] == "retro from [path] [redacted]"
    assert event.payload["node"] == "[path]"


def test_gui_feature_flags_default_off_and_persist(tmp_path: Path) -> None:
    db_path = tmp_path / "board.db"
    store = SQLiteBoardStore(db_path)

    initial = store.gui_feature_flags(
        board="main",
        features=("quota", "intake", "node-input", "digest"),
    )

    assert initial == {
        "quota": {"enabled": False, "configured": False},
        "intake": {"enabled": False, "configured": False},
        "node-input": {"enabled": False, "configured": False},
        "digest": {"enabled": False, "configured": False},
    }

    updated = store.set_gui_feature_enabled(board="main", feature="node-input", enabled=True)

    assert updated["enabled"] is True
    assert updated["configured"] is True
    assert isinstance(updated["updated_at"], int)

    reopened = SQLiteBoardStore(db_path)
    persisted = reopened.gui_feature_flags(
        board="main",
        features=("quota", "node-input"),
    )

    assert persisted["quota"] == {"enabled": False, "configured": False}
    assert persisted["node-input"]["enabled"] is True
    assert persisted["node-input"]["configured"] is True


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
    store.begin_guarded_execution(
        board="main",
        task_id=task.id,
        run_id=claimed.run_id,
        node="codex-a",
    )
    assert store.approve_execution(
        board="main",
        task_id=task.id,
        actor={"kind": "member", "id": "lead", "login": "lead", "role": "admin"},
    )

    released = store.release_stale(board="main", now=claimed.task.claim_expires + 1)

    assert released == 1
    ready = store.get_task(board="main", task_id=task.id)
    assert ready.status == "ready"
    assert ready.claim_lock is None
    assert ready.current_run_id is None
    execution = store.task_execution_state(board="main", task_id=task.id)
    assert execution["state"] == "none"
    assert execution["approved"] is False
    assert execution["run_id"] is None
    assert execution["released_run_id"] == claimed.run_id
    audits = store.list_audit_events(board="main", action="release-stale", task_id=task.id)
    assert len(audits) == 1
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
