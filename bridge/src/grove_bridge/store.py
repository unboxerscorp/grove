"""Grove-native sqlite board store."""

from __future__ import annotations

import hashlib
import json
import re
import secrets
import sqlite3
import time
import uuid
from collections.abc import Generator, Mapping
from contextlib import contextmanager
from dataclasses import dataclass, replace
from pathlib import Path
from typing import cast

from grove_bridge.auth_status import redact_secret_text

DONE_STATUSES = ("done", "archived")
DECISION_VOTERS = ("codex", "claude", "agy")
DECISION_QUORUM = 2
NODE_HEALTH_STATUSES = frozenset(
    {"healthy", "rate_limited", "login_required", "crashed", "cooldown", "hung"}
)
SQLITE_BUSY_TIMEOUT_MS = 5_000
ABSOLUTE_PATH_RE = re.compile(r"(?<![A-Za-z0-9_./-])/(?!/)[^\s'\"()<>]+")
EMAIL_RE = re.compile(r"\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b")
EXECUTION_TERMINAL_STATES = frozenset({"complete", "abort", "rollback"})
EXECUTION_DISPATCH_LEASE_TTL_SECONDS = 30


@dataclass(frozen=True)
class Task:
    id: str
    board_id: str
    title: str
    body: str | None
    assignee: str | None
    reviewer: str | None
    status: str
    priority: int
    workspace_kind: str
    workspace_path: str | None
    branch_name: str | None
    claim_lock: str | None
    claim_expires: int | None
    current_run_id: str | None
    last_heartbeat_at: int | None
    result: str | None
    metadata: dict[str, object]
    created_by: str | None
    created_at: int
    updated_at: int

    def with_claim(
        self,
        *,
        status: str,
        claim_lock: str,
        claim_expires: int,
        current_run_id: str,
    ) -> Task:
        return replace(
            self,
            status=status,
            claim_lock=claim_lock,
            claim_expires=claim_expires,
            current_run_id=current_run_id,
        )


@dataclass(frozen=True)
class ClaimedTask:
    task: Task
    run_id: str
    claim_lock: str


@dataclass(frozen=True)
class Run:
    id: str
    board_id: str
    task_id: str
    node_id: str
    status: str
    claim_lock: str
    claim_expires: int
    started_at: int
    last_heartbeat_at: int | None
    ended_at: int | None
    outcome: str | None
    summary: str | None
    metadata: dict[str, object]
    error: str | None


@dataclass(frozen=True)
class Comment:
    id: str
    board_id: str
    task_id: str
    author: str
    body: str
    metadata: dict[str, object]
    created_at: int


@dataclass(frozen=True)
class NotifySub:
    board_id: str
    task_id: str
    channel_kind: str
    room_id: str
    thread_id: str
    user_id: str | None
    last_event_id: str | None
    created_at: int


@dataclass(frozen=True)
class NodeHealth:
    project: str
    session: str
    node: str
    status: str
    reason: str | None
    message: str | None
    detected_at: int
    reset_at: int | None
    source: str
    updated_at: int


@dataclass(frozen=True)
class SlackThread:
    board_id: str
    task_id: str | None
    team_id: str
    channel_id: str
    thread_ts: str
    mode: str
    node: str | None
    created_at: int
    updated_at: int


@dataclass(frozen=True)
class Board:
    id: str
    slug: str
    title: str
    state: str
    settings: dict[str, object]
    created_at: int
    updated_at: int
    task_count: int


@dataclass(frozen=True)
class DecisionProposal:
    id: str
    board_id: str
    proposer: str
    title: str
    body: str | None
    target_assignee: str | None
    reviewer: str | None
    status: str
    metadata: dict[str, object]
    created_at: int
    updated_at: int


@dataclass(frozen=True)
class DecisionVote:
    proposal_id: str
    voter: str
    approve: bool
    reason: str | None
    created_at: int
    updated_at: int


@dataclass(frozen=True)
class DecisionDispatchLock:
    proposal_id: str
    idempotency_key_hash: str
    task_id: str
    created_at: int


@dataclass(frozen=True)
class DecisionDispatchResult:
    proposal: DecisionProposal
    dispatch: DecisionDispatchLock
    task: Task
    created: bool


@dataclass(frozen=True)
class BoardEvent:
    cursor: int
    id: str
    board_id: str
    task_id: str | None
    run_id: str | None
    kind: str
    payload: dict[str, object]
    created_at: int


class TaskTransitionConflict(RuntimeError):
    """Raised when a manual task transition CAS guard does not match."""


class DecisionConflict(RuntimeError):
    """Raised when a decision-ledger CAS guard does not match."""


class SQLiteBoardStore:
    """SQLite implementation of grove board task and run operations."""

    def __init__(self, path: str | Path) -> None:
        self._path = Path(path).expanduser()
        self._path.parent.mkdir(parents=True, exist_ok=True)
        with self._connect() as conn:
            self._init_schema(conn)

    def db_path(self) -> Path:
        return self._path

    def board_slug_for_id(self, board_id: str) -> str:
        return self._board_slug(board_id)

    def list_boards(self) -> list[Board]:
        with self._connect() as conn:
            rows = conn.execute(
                """
                SELECT boards.*, COUNT(tasks.id) AS task_count
                FROM boards
                LEFT JOIN tasks ON tasks.board_id = boards.id
                GROUP BY boards.id
                ORDER BY boards.slug ASC
                """
            ).fetchall()
        return [_board_from_row(row) for row in rows]

    def create_task(
        self,
        *,
        board: str,
        title: str,
        body: str | None,
        assignee: str | None,
        reviewer: str | None = None,
        status: str = "ready",
        priority: int = 0,
        workspace_kind: str = "scratch",
        workspace_path: str | None = None,
        branch_name: str | None = None,
        created_by: str | None = None,
        metadata: Mapping[str, object] | None = None,
    ) -> Task:
        now = _now()
        board_id = self._ensure_board(board)
        task_id = _new_id("task")
        with self._connect() as conn:
            conn.execute(
                """
                INSERT INTO tasks (
                    id, board_id, title, body, assignee, reviewer, status, priority,
                    workspace_kind, workspace_path, branch_name, metadata_json,
                    created_by, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    task_id,
                    board_id,
                    title,
                    body,
                    assignee,
                    reviewer,
                    status,
                    priority,
                    workspace_kind,
                    workspace_path,
                    branch_name,
                    _json(metadata or {}),
                    created_by,
                    now,
                    now,
                ),
            )
            self._add_event(
                conn,
                board_id=board_id,
                task_id=task_id,
                run_id=None,
                kind="task.created",
                payload={"status": status},
                now=now,
            )
        return self.get_task(board=board, task_id=task_id)

    def set_task_status(
        self,
        *,
        board: str,
        task_id: str,
        status: str,
        actor: Mapping[str, object],
        expected_status: str | None = None,
        run_id: str | None = None,
        idempotency_key: str | None = None,
        comment: str | None = None,
        comment_author: str | None = None,
        reviewer: str | None = None,
        reviewer_supplied: bool = False,
    ) -> Task:
        now = _now()
        board_id = self._ensure_board(board)
        clean_key = idempotency_key.strip() if idempotency_key else None
        clean_key_hash = _idempotency_key_hash(clean_key) if clean_key is not None else None
        with self._connect(immediate=True) as conn:
            row = conn.execute(
                "SELECT * FROM tasks WHERE board_id = ? AND id = ?",
                (board_id, task_id),
            ).fetchone()
            if row is None:
                raise KeyError(task_id)
            previous_status = _row_str(row, "status")
            metadata = _json_dict(_row_optional_str(row, "metadata_json") or "{}")
            manual_transitions = _manual_transition_history(metadata)
            manual_transition = metadata.get("manual_transition")
            if clean_key_hash is not None and clean_key_hash in manual_transitions:
                manual_transition = manual_transitions[clean_key_hash]
            if (
                clean_key is not None
                and isinstance(manual_transition, Mapping)
                and (
                    manual_transition.get("idempotency_key_hash") == clean_key_hash
                    or manual_transition.get("idempotency_key") == clean_key
                )
            ):
                if (
                    manual_transition.get("to_status") != status
                    or (
                        expected_status is not None
                        and manual_transition.get("from_status") != expected_status
                    )
                    or (run_id is not None and manual_transition.get("run_id") != run_id)
                    or ((manual_transition.get("reviewer_supplied") is True) != reviewer_supplied)
                    or (reviewer_supplied and (manual_transition.get("reviewer") != reviewer))
                ):
                    raise TaskTransitionConflict(
                        "idempotency key was already used for a different transition",
                    )
                return _task_from_row(row)
            if expected_status is not None and previous_status != expected_status:
                raise TaskTransitionConflict(
                    f"expected status {expected_status!r}, found {previous_status!r}",
                )
            current_run_id = _row_optional_str(row, "current_run_id")
            if run_id is not None and current_run_id != run_id:
                raise TaskTransitionConflict(
                    f"expected current run {run_id!r}, found {current_run_id!r}",
                )
            if clean_key is not None:
                transition = {
                    "idempotency_key_hash": clean_key_hash,
                    "from_status": previous_status,
                    "to_status": status,
                    "run_id": run_id,
                    "reviewer": reviewer,
                    "reviewer_supplied": reviewer_supplied,
                    "at": now,
                }
                metadata["manual_transition"] = transition
                if clean_key_hash is not None:
                    manual_transitions[clean_key_hash] = transition
                    metadata["manual_transitions"] = manual_transitions
            if status == "running":
                conn.execute(
                    """
                    UPDATE tasks
                    SET status = ?, metadata_json = ?, updated_at = ?
                    WHERE board_id = ? AND id = ?
                    """,
                    (status, _json(metadata), now, board_id, task_id),
                )
            else:
                conn.execute(
                    """
                    UPDATE tasks
                    SET status = ?,
                        claim_lock = NULL,
                        claim_expires = NULL,
                        current_run_id = NULL,
                        metadata_json = ?,
                        updated_at = ?
                    WHERE board_id = ? AND id = ?
                    """,
                    (status, _json(metadata), now, board_id, task_id),
                )
            if comment is not None and comment.strip():
                author = comment_author or str(actor.get("login") or actor.get("id") or "system")
                self._add_comment_row(
                    conn,
                    board_id=board_id,
                    task_id=task_id,
                    author=author,
                    body=comment,
                    metadata={"kind": "manual_status_transition"},
                    now=now,
                )
            self._add_event(
                conn,
                board_id=board_id,
                task_id=task_id,
                run_id=run_id,
                kind="task.updated",
                payload={"status": status, "previous_status": previous_status},
                now=now,
            )
            self._add_event(
                conn,
                board_id=board_id,
                task_id=task_id,
                run_id=run_id,
                kind="audit.task.status",
                payload=_audit_payload(
                    actor=actor,
                    action="status-transition",
                    target={"type": "task", "id": task_id},
                    board=board,
                    status="ok",
                    summary=_row_str(row, "title"),
                    ts=now,
                    extra={
                        "from_status": previous_status,
                        "to_status": status,
                        "run_id": run_id,
                        "idempotency_key_present": clean_key is not None,
                    },
                ),
                now=now,
            )
            updated = conn.execute(
                "SELECT * FROM tasks WHERE board_id = ? AND id = ?",
                (board_id, task_id),
            ).fetchone()
        if updated is None:
            raise KeyError(task_id)
        return _task_from_row(updated)

    def set_task_reviewer(
        self,
        *,
        board: str,
        task_id: str,
        reviewer: str | None,
        actor: Mapping[str, object],
    ) -> Task:
        now = _now()
        board_id = self._ensure_board(board)
        with self._connect(immediate=True) as conn:
            row = conn.execute(
                "SELECT * FROM tasks WHERE board_id = ? AND id = ?",
                (board_id, task_id),
            ).fetchone()
            if row is None:
                raise KeyError(task_id)
            previous_reviewer = _row_optional_str(row, "reviewer")
            conn.execute(
                """
                UPDATE tasks
                SET reviewer = ?, updated_at = ?
                WHERE board_id = ? AND id = ?
                """,
                (reviewer, now, board_id, task_id),
            )
            action = "reviewer-clear" if reviewer is None else "reviewer-set"
            if previous_reviewer is not None and reviewer is not None:
                action = "reviewer-change"
            self._add_event(
                conn,
                board_id=board_id,
                task_id=task_id,
                run_id=None,
                kind="task.updated",
                payload={"reviewer": reviewer, "previous_reviewer": previous_reviewer},
                now=now,
            )
            self._add_event(
                conn,
                board_id=board_id,
                task_id=task_id,
                run_id=None,
                kind="audit.task.reviewer",
                payload=_audit_payload(
                    actor=actor,
                    action=action,
                    target={"type": "task", "id": task_id, "reviewer": reviewer or ""},
                    board=board,
                    status="ok",
                    summary=_row_str(row, "title"),
                    ts=now,
                    extra={"from_reviewer": previous_reviewer, "to_reviewer": reviewer},
                ),
                now=now,
            )
            updated = conn.execute(
                "SELECT * FROM tasks WHERE board_id = ? AND id = ?",
                (board_id, task_id),
            ).fetchone()
        if updated is None:
            raise KeyError(task_id)
        return _task_from_row(updated)

    def accept_handoff_task(
        self,
        *,
        board: str,
        handoff_id: str,
        title: str,
        body: str | None,
        priority: int,
        labels: list[str],
        metadata: Mapping[str, object],
        created_by: str | None,
        actor: Mapping[str, object],
    ) -> tuple[Task, bool]:
        now = _now()
        board_id = self._ensure_board(board)
        with self._connect(immediate=True) as conn:
            existing = conn.execute(
                """
                SELECT * FROM tasks
                WHERE board_id = ?
                  AND json_extract(metadata_json, '$.handoff.id') = ?
                ORDER BY created_at ASC, id ASC
                LIMIT 1
                """,
                (board_id, handoff_id),
            ).fetchone()
            if existing is not None:
                return _task_from_row(existing), False
            task_id = _new_id("task")
            final_metadata = dict(metadata)
            raw_handoff = final_metadata.get("handoff")
            handoff_metadata = dict(raw_handoff) if isinstance(raw_handoff, Mapping) else {}
            handoff_metadata.update(
                {
                    "id": handoff_id,
                    "accepted_at": now,
                }
            )
            final_metadata["handoff"] = {
                key: value for key, value in handoff_metadata.items() if isinstance(key, str)
            }
            if labels:
                final_metadata["labels"] = labels
            conn.execute(
                """
                INSERT INTO tasks (
                    id, board_id, title, body, assignee, status, priority,
                    workspace_kind, workspace_path, branch_name, metadata_json,
                    created_by, created_at, updated_at
                ) VALUES (?, ?, ?, ?, NULL, 'ready', ?, 'scratch', NULL, NULL, ?, ?, ?, ?)
                """,
                (
                    task_id,
                    board_id,
                    title,
                    body,
                    priority,
                    _json(final_metadata),
                    created_by,
                    now,
                    now,
                ),
            )
            self._add_event(
                conn,
                board_id=board_id,
                task_id=task_id,
                run_id=None,
                kind="task.created",
                payload={"status": "ready", "source": "handoff"},
                now=now,
            )
            self._add_event(
                conn,
                board_id=board_id,
                task_id=task_id,
                run_id=None,
                kind="audit.handoff.accept",
                payload=_audit_payload(
                    actor=actor,
                    action="accept",
                    target={"type": "handoff", "id": handoff_id, "task_id": task_id},
                    board=board,
                    status="ok",
                    summary=title,
                    ts=now,
                    extra={"handoff_id": handoff_id},
                ),
                now=now,
            )
            row = conn.execute("SELECT * FROM tasks WHERE id = ?", (task_id,)).fetchone()
            if row is None:
                raise RuntimeError("accepted handoff task disappeared")
            return _task_from_row(row), True

    def list_tasks(
        self,
        *,
        board: str,
        status: str | None = None,
        assignee: str | None = None,
        limit: int | None = None,
    ) -> list[Task]:
        board_id = self._ensure_board(board)
        clauses = ["board_id = ?"]
        params: list[object] = [board_id]
        if status is not None:
            clauses.append("status = ?")
            params.append(status)
        if assignee is not None:
            clauses.append("assignee = ?")
            params.append(assignee)
        sql = (
            "SELECT * FROM tasks WHERE "
            + " AND ".join(clauses)
            + " ORDER BY priority DESC, created_at ASC, id ASC"
        )
        if limit is not None:
            sql += " LIMIT ?"
            params.append(limit)
        with self._connect() as conn:
            rows = conn.execute(sql, params).fetchall()
        return [_task_from_row(row) for row in rows]

    def query_tasks(
        self,
        *,
        board: str,
        status: str | None = None,
        assignee: str | None = None,
        label: str | None = None,
        text: str | None = None,
        cursor: int = 0,
        limit: int = 50,
    ) -> tuple[list[Task], int | None, int]:
        board_id = self._board_id_for_slug(board)
        if board_id is None:
            return [], None, 0
        offset = max(0, cursor)
        page_size = max(1, min(limit, 100))
        clauses = ["board_id = ?"]
        params: list[object] = [board_id]
        if status is not None:
            clauses.append("status = ?")
            params.append(status)
        if assignee is not None:
            clauses.append("assignee = ?")
            params.append(assignee)
        if label is not None:
            clauses.append(
                """
                EXISTS (
                    SELECT 1
                    FROM json_each(tasks.metadata_json, '$.labels')
                    WHERE json_each.value = ?
                )
                """
            )
            params.append(label)
        if text is not None:
            clauses.append("(title LIKE ? ESCAPE '\\' OR body LIKE ? ESCAPE '\\')")
            pattern = f"%{_escape_like(text)}%"
            params.extend([pattern, pattern])
        where = " AND ".join(clauses)
        count_sql = f"SELECT COUNT(*) AS count FROM tasks WHERE {where}"
        page_sql = f"""
            SELECT * FROM tasks
            WHERE {where}
            ORDER BY priority DESC, created_at ASC, id ASC
            LIMIT ? OFFSET ?
        """
        with self._connect() as conn:
            count_row = conn.execute(count_sql, params).fetchone()
            total = _row_int(count_row, "count") if count_row is not None else 0
            rows = conn.execute(page_sql, [*params, page_size, offset]).fetchall()
        next_cursor = offset + page_size if offset + page_size < total else None
        return [_task_from_row(row) for row in rows], next_cursor, total

    def saved_views(self, *, board: str) -> dict[str, dict[str, object]]:
        settings = self._board_settings(board) or {}
        return _saved_views_from_settings(settings)

    def set_saved_view(
        self,
        *,
        board: str,
        name: str,
        filters: Mapping[str, object],
    ) -> dict[str, object]:
        now = _now()
        board_id = self._ensure_board(board)
        clean = _saved_view_from_mapping(filters, updated_at=now)
        with self._connect(immediate=True) as conn:
            settings = self._settings_for_update(conn, board_id=board_id)
            views = _mutable_saved_views(settings)
            views[name] = clean
            self._write_board_settings(conn, board_id=board_id, settings=settings, now=now)
        return clean

    def delete_saved_view(self, *, board: str, name: str) -> bool:
        now = _now()
        board_id = self._ensure_board(board)
        with self._connect(immediate=True) as conn:
            settings = self._settings_for_update(conn, board_id=board_id)
            views = _mutable_saved_views(settings)
            existed = name in views
            views.pop(name, None)
            self._write_board_settings(conn, board_id=board_id, settings=settings, now=now)
        return existed

    def get_task(self, *, board: str, task_id: str) -> Task:
        board_id = self._ensure_board(board)
        with self._connect() as conn:
            row = conn.execute(
                "SELECT * FROM tasks WHERE board_id = ? AND id = ?",
                (board_id, task_id),
            ).fetchone()
        if row is None:
            raise KeyError(task_id)
        return _task_from_row(row)

    def get_task_by_id(self, task_id: str) -> Task:
        with self._connect() as conn:
            row = conn.execute("SELECT * FROM tasks WHERE id = ?", (task_id,)).fetchone()
        if row is None:
            raise KeyError(task_id)
        return _task_from_row(row)

    def record_node_health(
        self,
        *,
        project: str,
        session: str,
        node: str,
        status: str,
        reason: str | None = None,
        message: str | None = None,
        detected_at: int | None = None,
        reset_at: int | None = None,
        source: str = "watchdog",
    ) -> NodeHealth:
        clean_project = _required_public_text(project, field="project")
        clean_session = _required_public_text(session, field="session")
        clean_node = _required_public_text(node, field="node")
        clean_status = status.strip().lower()
        if clean_status not in NODE_HEALTH_STATUSES:
            raise ValueError("node health status is invalid")
        clean_source = _required_public_text(source, field="source")
        now = _now()
        detected = now if detected_at is None else int(detected_at)
        if detected < 0:
            raise ValueError("detected_at must be non-negative")
        if reset_at is not None and reset_at < 0:
            raise ValueError("reset_at must be non-negative")
        clean_reason = _optional_public_text(reason)
        clean_message = _optional_public_text(message)
        with self._connect(immediate=True) as conn:
            conn.execute(
                """
                INSERT INTO node_health (
                    project, session, node, status, reason, message,
                    detected_at, reset_at, source, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(project, session, node)
                DO UPDATE SET
                    status = excluded.status,
                    reason = excluded.reason,
                    message = excluded.message,
                    detected_at = excluded.detected_at,
                    reset_at = excluded.reset_at,
                    source = excluded.source,
                    updated_at = excluded.updated_at
                """,
                (
                    clean_project,
                    clean_session,
                    clean_node,
                    clean_status,
                    clean_reason,
                    clean_message,
                    detected,
                    reset_at,
                    clean_source,
                    now,
                ),
            )
        return self.list_node_health(
            project=clean_project,
            session=clean_session,
            node=clean_node,
        )[0]

    def list_node_health(
        self,
        *,
        project: str | None = None,
        session: str | None = None,
        node: str | None = None,
    ) -> list[NodeHealth]:
        clauses: list[str] = []
        params: list[object] = []
        if project is not None:
            clauses.append("project = ?")
            params.append(_required_public_text(project, field="project"))
        if session is not None:
            clauses.append("session = ?")
            params.append(_required_public_text(session, field="session"))
        if node is not None:
            clauses.append("node = ?")
            params.append(_required_public_text(node, field="node"))
        sql = "SELECT * FROM node_health"
        if clauses:
            sql += " WHERE " + " AND ".join(clauses)
        sql += " ORDER BY project ASC, session ASC, node ASC"
        with self._connect() as conn:
            rows = conn.execute(sql, params).fetchall()
        return [_node_health_from_row(row) for row in rows]

    def create_decision_proposal(
        self,
        *,
        board: str,
        proposer: str,
        title: str,
        body: str | None = None,
        target_assignee: str | None = None,
        reviewer: str | None = None,
        metadata: Mapping[str, object] | None = None,
    ) -> DecisionProposal:
        now = _now()
        board_id = self._ensure_board(board)
        proposal_id = _new_id("decision")
        clean_proposer = _decision_voter(proposer)
        clean_title = _required_public_text(title, field="title")
        clean_body = _optional_public_text(body)
        clean_assignee = _optional_public_text(target_assignee)
        clean_reviewer = _optional_public_text(reviewer)
        clean_metadata = _sanitize_audit_mapping(metadata or {})
        with self._connect(immediate=True) as conn:
            conn.execute(
                """
                INSERT INTO decision_proposals (
                    id, board_id, proposer, title, body, target_assignee,
                    reviewer, status, metadata_json, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)
                """,
                (
                    proposal_id,
                    board_id,
                    clean_proposer,
                    clean_title,
                    clean_body,
                    clean_assignee,
                    clean_reviewer,
                    _json(clean_metadata),
                    now,
                    now,
                ),
            )
            self._add_event(
                conn,
                board_id=board_id,
                task_id=None,
                run_id=None,
                kind="decision.proposed",
                payload={"proposal_id": proposal_id, "proposer": clean_proposer},
                now=now,
            )
        return self.get_decision_proposal(board=board, proposal_id=proposal_id)

    def get_decision_proposal(self, *, board: str, proposal_id: str) -> DecisionProposal:
        board_id = self._ensure_board(board)
        with self._connect() as conn:
            row = conn.execute(
                "SELECT * FROM decision_proposals WHERE board_id = ? AND id = ?",
                (board_id, proposal_id),
            ).fetchone()
        if row is None:
            raise KeyError(proposal_id)
        return _decision_proposal_from_row(row)

    def list_decision_proposals(
        self,
        *,
        board: str,
        status: str | None = None,
        limit: int | None = None,
    ) -> list[DecisionProposal]:
        board_id = self._board_id_for_slug(board)
        if board_id is None:
            return []
        clauses = ["board_id = ?"]
        params: list[object] = [board_id]
        if status is not None:
            clauses.append("status = ?")
            params.append(status.strip().lower())
        sql = (
            "SELECT * FROM decision_proposals WHERE "
            + " AND ".join(clauses)
            + " ORDER BY created_at DESC, id DESC"
        )
        if limit is not None:
            sql += " LIMIT ?"
            params.append(max(1, min(limit, 500)))
        with self._connect() as conn:
            rows = conn.execute(sql, params).fetchall()
        return [_decision_proposal_from_row(row) for row in rows]

    def record_decision_vote(
        self,
        *,
        board: str,
        proposal_id: str,
        voter: str,
        approve: bool,
        reason: str | None = None,
    ) -> DecisionProposal:
        now = _now()
        board_id = self._ensure_board(board)
        clean_voter = _decision_voter(voter)
        clean_reason = _optional_public_text(reason)
        with self._connect(immediate=True) as conn:
            proposal = conn.execute(
                "SELECT * FROM decision_proposals WHERE board_id = ? AND id = ?",
                (board_id, proposal_id),
            ).fetchone()
            if proposal is None:
                raise KeyError(proposal_id)
            if _row_str(proposal, "status") == "dispatched":
                raise DecisionConflict("decision already dispatched")
            existing = conn.execute(
                "SELECT created_at FROM decision_votes WHERE proposal_id = ? AND voter = ?",
                (proposal_id, clean_voter),
            ).fetchone()
            if existing is not None:
                raise DecisionConflict("decision voter already voted")
            conn.execute(
                """
                INSERT INTO decision_votes (
                    proposal_id, voter, approve, reason, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?)
                """,
                (proposal_id, clean_voter, 1 if approve else 0, clean_reason, now, now),
            )
            votes = conn.execute(
                "SELECT * FROM decision_votes WHERE proposal_id = ?",
                (proposal_id,),
            ).fetchall()
            next_status = _decision_status_for_votes(
                [_decision_vote_from_row(row) for row in votes]
            )
            conn.execute(
                """
                UPDATE decision_proposals
                SET status = ?, updated_at = ?
                WHERE board_id = ? AND id = ?
                """,
                (next_status, now, board_id, proposal_id),
            )
            self._add_event(
                conn,
                board_id=board_id,
                task_id=None,
                run_id=None,
                kind="decision.voted",
                payload={
                    "proposal_id": proposal_id,
                    "voter": clean_voter,
                    "approve": approve,
                    "status": next_status,
                },
                now=now,
            )
            updated = conn.execute(
                "SELECT * FROM decision_proposals WHERE board_id = ? AND id = ?",
                (board_id, proposal_id),
            ).fetchone()
        if updated is None:
            raise KeyError(proposal_id)
        return _decision_proposal_from_row(updated)

    def list_decision_votes(self, *, proposal_id: str) -> list[DecisionVote]:
        with self._connect() as conn:
            rows = conn.execute(
                """
                SELECT * FROM decision_votes
                WHERE proposal_id = ?
                ORDER BY voter ASC
                """,
                (proposal_id,),
            ).fetchall()
        return [_decision_vote_from_row(row) for row in rows]

    def decision_dispatch_lock(self, *, proposal_id: str) -> DecisionDispatchLock | None:
        with self._connect() as conn:
            row = conn.execute(
                "SELECT * FROM decision_dispatch_locks WHERE proposal_id = ?",
                (proposal_id,),
            ).fetchone()
        return None if row is None else _decision_dispatch_from_row(row)

    def dispatch_decision(
        self,
        *,
        board: str,
        proposal_id: str,
        idempotency_key: str,
        actor: Mapping[str, object],
    ) -> DecisionDispatchResult:
        now = _now()
        board_id = self._ensure_board(board)
        clean_key = idempotency_key.strip()
        if not clean_key:
            raise ValueError("idempotency_key is required")
        key_hash = _idempotency_key_hash(clean_key)
        created = False
        with self._connect(immediate=True) as conn:
            proposal_row = conn.execute(
                "SELECT * FROM decision_proposals WHERE board_id = ? AND id = ?",
                (board_id, proposal_id),
            ).fetchone()
            if proposal_row is None:
                raise KeyError(proposal_id)
            proposal = _decision_proposal_from_row(proposal_row)
            existing = conn.execute(
                "SELECT * FROM decision_dispatch_locks WHERE proposal_id = ?",
                (proposal_id,),
            ).fetchone()
            if existing is not None:
                dispatch = _decision_dispatch_from_row(existing)
                if dispatch.idempotency_key_hash != key_hash:
                    raise DecisionConflict("decision already dispatched with a different key")
                task_row = conn.execute(
                    "SELECT * FROM tasks WHERE board_id = ? AND id = ?",
                    (board_id, dispatch.task_id),
                ).fetchone()
                if task_row is None:
                    raise RuntimeError("dispatch task disappeared")
                return DecisionDispatchResult(
                    proposal=proposal,
                    dispatch=dispatch,
                    task=_task_from_row(task_row),
                    created=False,
                )
            if proposal.status != "approved":
                raise DecisionConflict("decision is not approved")
            task_id = _new_id("task")
            metadata = dict(proposal.metadata)
            metadata["decision"] = {
                "proposal_id": proposal.id,
                "idempotency_key_hash": key_hash,
                "dispatched_at": now,
            }
            actor_id = str(actor.get("login") or actor.get("id") or "operator")
            conn.execute(
                """
                INSERT INTO tasks (
                    id, board_id, title, body, assignee, reviewer, status, priority,
                    workspace_kind, workspace_path, branch_name, metadata_json,
                    created_by, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, 'ready', 0, 'scratch', NULL, NULL, ?, ?, ?, ?)
                """,
                (
                    task_id,
                    board_id,
                    proposal.title,
                    proposal.body,
                    proposal.target_assignee,
                    proposal.reviewer,
                    _json(metadata),
                    actor_id,
                    now,
                    now,
                ),
            )
            conn.execute(
                """
                INSERT INTO decision_dispatch_locks (
                    proposal_id, idempotency_key_hash, task_id, created_at
                ) VALUES (?, ?, ?, ?)
                """,
                (proposal_id, key_hash, task_id, now),
            )
            conn.execute(
                """
                UPDATE decision_proposals
                SET status = 'dispatched', updated_at = ?
                WHERE board_id = ? AND id = ?
                """,
                (now, board_id, proposal_id),
            )
            self._add_event(
                conn,
                board_id=board_id,
                task_id=task_id,
                run_id=None,
                kind="task.created",
                payload={"status": "ready", "decision_id": proposal_id},
                now=now,
            )
            self._add_event(
                conn,
                board_id=board_id,
                task_id=task_id,
                run_id=None,
                kind="decision.dispatched",
                payload={"proposal_id": proposal_id, "task_id": task_id},
                now=now,
            )
            self._add_event(
                conn,
                board_id=board_id,
                task_id=task_id,
                run_id=None,
                kind="audit.decision.dispatch",
                payload=_audit_payload(
                    actor=actor,
                    action="decision-dispatch",
                    target={"type": "decision", "id": proposal_id},
                    board=board,
                    status="ok",
                    summary=proposal.title,
                    ts=now,
                    extra={"task_id": task_id},
                ),
                now=now,
            )
            dispatch_row = conn.execute(
                "SELECT * FROM decision_dispatch_locks WHERE proposal_id = ?",
                (proposal_id,),
            ).fetchone()
            task_row = conn.execute(
                "SELECT * FROM tasks WHERE board_id = ? AND id = ?",
                (board_id, task_id),
            ).fetchone()
            proposal_row = conn.execute(
                "SELECT * FROM decision_proposals WHERE board_id = ? AND id = ?",
                (board_id, proposal_id),
            ).fetchone()
            created = True
        if dispatch_row is None or task_row is None or proposal_row is None:
            raise RuntimeError("dispatch rows disappeared")
        return DecisionDispatchResult(
            proposal=_decision_proposal_from_row(proposal_row),
            dispatch=_decision_dispatch_from_row(dispatch_row),
            task=_task_from_row(task_row),
            created=created,
        )

    def claim_next(
        self,
        *,
        board: str,
        assignee: str | None,
        node_id: str,
        ttl_seconds: int,
        task_id: str | None = None,
    ) -> ClaimedTask | None:
        now = _now()
        expires = now + ttl_seconds
        board_id = self._ensure_board(board)
        claim_lock = _new_id("claim")
        run_id = _new_id("run")
        clauses = [
            "board_id = ?",
            "status = 'ready'",
            "claim_lock IS NULL",
            "assignee IS NULL" if assignee is None else "assignee = ?",
        ]
        params: list[object] = [board_id]
        if assignee is not None:
            params.append(assignee)
        if task_id is not None:
            clauses.append("id = ?")
            params.append(task_id)
        with self._connect(immediate=True) as conn:
            active_wip = conn.execute(
                """
                SELECT 1
                FROM tasks
                LEFT JOIN runs
                  ON runs.board_id = tasks.board_id
                 AND runs.id = tasks.current_run_id
                WHERE tasks.board_id = ?
                  AND tasks.status = 'running'
                  AND (tasks.claim_expires IS NULL OR tasks.claim_expires >= ?)
                  AND (tasks.assignee = ? OR runs.node_id = ?)
                LIMIT 1
                """,
                (board_id, now, node_id, node_id),
            ).fetchone()
            if active_wip is not None:
                return None
            candidate = conn.execute(
                f"""
                SELECT id FROM tasks
                WHERE {" AND ".join(clauses)}
                ORDER BY priority DESC, created_at ASC, id ASC
                LIMIT 1
                """,
                params,
            ).fetchone()
            if candidate is None:
                return None
            task_id = _row_str(candidate, "id")
            updated = conn.execute(
                """
                UPDATE tasks
                SET status = 'running',
                    assignee = COALESCE(assignee, ?),
                    claim_lock = ?,
                    claim_expires = ?,
                    current_run_id = ?,
                    last_heartbeat_at = ?,
                    updated_at = ?
                WHERE id = ?
                  AND board_id = ?
                  AND status = 'ready'
                  AND claim_lock IS NULL
                """,
                (node_id, claim_lock, expires, run_id, now, now, task_id, board_id),
            )
            if updated.rowcount != 1:
                return None
            conn.execute(
                """
                INSERT INTO runs (
                    id, board_id, task_id, node_id, status, claim_lock,
                    claim_expires, started_at, last_heartbeat_at, metadata_json
                ) VALUES (?, ?, ?, ?, 'running', ?, ?, ?, ?, ?)
                """,
                (run_id, board_id, task_id, node_id, claim_lock, expires, now, now, _json({})),
            )
            self._add_event(
                conn,
                board_id=board_id,
                task_id=task_id,
                run_id=run_id,
                kind="task.claimed",
                payload={"node_id": node_id},
                now=now,
            )
            self._add_event(
                conn,
                board_id=board_id,
                task_id=task_id,
                run_id=run_id,
                kind="audit.task.claim",
                payload=_audit_payload(
                    actor=_node_actor(node_id),
                    action="claim",
                    target={"type": "task", "id": task_id, "node": assignee or node_id},
                    board=board,
                    status="ok",
                    ts=now,
                ),
                now=now,
            )
            row = conn.execute("SELECT * FROM tasks WHERE id = ?", (task_id,)).fetchone()
            if row is None:
                raise RuntimeError("claimed task disappeared")
            task = _task_from_row(row)
        return ClaimedTask(task=task, run_id=run_id, claim_lock=claim_lock)

    def heartbeat(
        self,
        *,
        board: str,
        task_id: str,
        run_id: str,
        claim_lock: str,
        ttl_seconds: int,
    ) -> bool:
        now = _now()
        expires = now + ttl_seconds
        board_id = self._ensure_board(board)
        with self._connect(immediate=True) as conn:
            task_update = conn.execute(
                """
                UPDATE tasks
                SET claim_expires = ?, last_heartbeat_at = ?, updated_at = ?
                WHERE board_id = ?
                  AND id = ?
                  AND status = 'running'
                  AND current_run_id = ?
                  AND claim_lock = ?
                """,
                (expires, now, now, board_id, task_id, run_id, claim_lock),
            )
            if task_update.rowcount != 1:
                return False
            run_update = conn.execute(
                """
                UPDATE runs
                SET claim_expires = ?, last_heartbeat_at = ?
                WHERE board_id = ?
                  AND id = ?
                  AND task_id = ?
                  AND claim_lock = ?
                  AND status = 'running'
                """,
                (expires, now, board_id, run_id, task_id, claim_lock),
            )
            return run_update.rowcount == 1

    def complete(
        self,
        *,
        board: str,
        task_id: str,
        run_id: str,
        claim_lock: str,
        result: str,
        summary: str,
        metadata: Mapping[str, object],
    ) -> bool:
        now = _now()
        board_id = self._ensure_board(board)
        with self._connect(immediate=True) as conn:
            task_row = conn.execute(
                """
                SELECT metadata_json FROM tasks
                WHERE board_id = ?
                  AND id = ?
                  AND status = 'running'
                  AND current_run_id = ?
                  AND claim_lock = ?
                """,
                (board_id, task_id, run_id, claim_lock),
            ).fetchone()
            if task_row is None:
                return False
            final_metadata = _metadata_preserving_execution(
                task_row,
                metadata,
                state="complete",
                now=now,
            )
            updated = conn.execute(
                """
                UPDATE tasks
                SET status = 'done',
                    claim_lock = NULL,
                    claim_expires = NULL,
                    current_run_id = NULL,
                    result = ?,
                    metadata_json = ?,
                    updated_at = ?
                WHERE board_id = ?
                  AND id = ?
                  AND status = 'running'
                  AND current_run_id = ?
                  AND claim_lock = ?
                """,
                (
                    _clean(result),
                    _json(final_metadata),
                    now,
                    board_id,
                    task_id,
                    run_id,
                    claim_lock,
                ),
            )
            if updated.rowcount != 1:
                return False
            conn.execute(
                """
                UPDATE runs
                SET status = 'completed',
                    ended_at = ?,
                    outcome = 'complete',
                    summary = ?,
                metadata_json = ?
                WHERE board_id = ? AND id = ? AND task_id = ? AND claim_lock = ?
                """,
                (
                    now,
                    _clean(summary),
                    _json(final_metadata),
                    board_id,
                    run_id,
                    task_id,
                    claim_lock,
                ),
            )
            run_row = conn.execute(
                "SELECT node_id FROM runs WHERE board_id = ? AND id = ?",
                (board_id, run_id),
            ).fetchone()
            node_id = _row_str(run_row, "node_id") if run_row is not None else "unknown"
            self._add_event(
                conn,
                board_id=board_id,
                task_id=task_id,
                run_id=run_id,
                kind="task.completed",
                payload={"summary": summary},
                now=now,
            )
            self._add_event(
                conn,
                board_id=board_id,
                task_id=task_id,
                run_id=run_id,
                kind="audit.task.complete",
                payload=_audit_payload(
                    actor=_node_actor(node_id),
                    action="complete",
                    target={"type": "task", "id": task_id, "node": node_id},
                    board=board,
                    status="ok",
                    summary=summary,
                    ts=now,
                ),
                now=now,
            )
            self._promote_ready_children(conn, board_id=board_id, parent_id=task_id, now=now)
        return True

    def block(
        self,
        *,
        board: str,
        task_id: str,
        run_id: str,
        claim_lock: str,
        reason: str,
        metadata: Mapping[str, object] | None = None,
        needs_human: bool = False,
    ) -> bool:
        now = _now()
        board_id = self._ensure_board(board)
        run_metadata = dict(metadata or {})
        if needs_human:
            run_metadata["needs_human"] = True
        with self._connect(immediate=True) as conn:
            task_row = conn.execute(
                """
                SELECT metadata_json FROM tasks
                WHERE board_id = ?
                  AND id = ?
                  AND status = 'running'
                  AND current_run_id = ?
                  AND claim_lock = ?
                """,
                (board_id, task_id, run_id, claim_lock),
            ).fetchone()
            if task_row is None:
                return False
            run_metadata = _metadata_preserving_execution(
                task_row,
                run_metadata,
                state=None,
                now=now,
            )
            updated = conn.execute(
                """
                UPDATE tasks
                SET status = 'blocked',
                    claim_lock = NULL,
                    claim_expires = NULL,
                    current_run_id = NULL,
                    metadata_json = ?,
                    updated_at = ?
                WHERE board_id = ?
                  AND id = ?
                  AND status = 'running'
                  AND current_run_id = ?
                  AND claim_lock = ?
                """,
                (_json(run_metadata), now, board_id, task_id, run_id, claim_lock),
            )
            if updated.rowcount != 1:
                return False
            conn.execute(
                """
                UPDATE runs
                SET status = 'blocked',
                    ended_at = ?,
                    outcome = 'blocked',
                    metadata_json = ?,
                    error = ?
                WHERE board_id = ? AND id = ? AND task_id = ? AND claim_lock = ?
                """,
                (now, _json(run_metadata), reason, board_id, run_id, task_id, claim_lock),
            )
            run_row = conn.execute(
                "SELECT node_id FROM runs WHERE board_id = ? AND id = ?",
                (board_id, run_id),
            ).fetchone()
            node_id = _row_str(run_row, "node_id") if run_row is not None else "unknown"
            self._add_event(
                conn,
                board_id=board_id,
                task_id=task_id,
                run_id=run_id,
                kind="task.blocked",
                payload={"reason": reason, "needs_human": needs_human},
                now=now,
            )
            self._add_event(
                conn,
                board_id=board_id,
                task_id=task_id,
                run_id=run_id,
                kind="audit.task.block",
                payload=_audit_payload(
                    actor=_node_actor(node_id),
                    action="block",
                    target={"type": "task", "id": task_id, "node": node_id},
                    board=board,
                    status="ok",
                    summary=reason,
                    ts=now,
                    extra={"needs_human": needs_human},
                ),
                now=now,
            )
        return True

    def unblock(
        self,
        *,
        board: str,
        task_id: str,
        actor: str,
        comment: str | None = None,
        force: bool = False,
    ) -> bool:
        now = _now()
        board_id = self._ensure_board(board)
        with self._connect(immediate=True) as conn:
            if not force and not self._parents_satisfied(conn, board_id=board_id, child_id=task_id):
                return False
            updated = conn.execute(
                """
                UPDATE tasks
                SET status = 'ready', updated_at = ?
                WHERE board_id = ? AND id = ? AND status IN ('blocked', 'ask_human')
                """,
                (now, board_id, task_id),
            )
            if updated.rowcount != 1:
                return False
            if comment is not None:
                self._add_comment_row(
                    conn,
                    board_id=board_id,
                    task_id=task_id,
                    author=actor,
                    body=comment,
                    metadata={},
                    now=now,
                )
            self._add_event(
                conn,
                board_id=board_id,
                task_id=task_id,
                run_id=None,
                kind="task.unblocked",
                payload={"actor": actor, "force": force},
                now=now,
            )
        return True

    def add_comment(
        self,
        *,
        board: str,
        task_id: str,
        author: str,
        body: str,
        metadata: Mapping[str, object] | None = None,
    ) -> Comment:
        now = _now()
        board_id = self._ensure_board(board)
        with self._connect() as conn:
            comment_id = self._add_comment_row(
                conn,
                board_id=board_id,
                task_id=task_id,
                author=author,
                body=body,
                metadata=metadata or {},
                now=now,
            )
            row = conn.execute(
                "SELECT * FROM comments WHERE board_id = ? AND id = ?",
                (board_id, comment_id),
            ).fetchone()
        if row is None:
            raise RuntimeError("created comment disappeared")
        return _comment_from_row(row)

    def list_comments(self, *, board: str, task_id: str) -> list[Comment]:
        board_id = self._ensure_board(board)
        with self._connect() as conn:
            rows = conn.execute(
                """
                SELECT * FROM comments
                WHERE board_id = ? AND task_id = ?
                ORDER BY ts ASC, id ASC
                """,
                (board_id, task_id),
            ).fetchall()
        return [_comment_from_row(row) for row in rows]

    def list_comments_for_task(self, *, task_id: str) -> list[Comment]:
        with self._connect() as conn:
            rows = conn.execute(
                """
                SELECT * FROM comments
                WHERE task_id = ?
                ORDER BY ts ASC, id ASC
                """,
                (task_id,),
            ).fetchall()
        return [_comment_from_row(row) for row in rows]

    def add_comment_to_task(
        self,
        *,
        task_id: str,
        author: str,
        body: str,
        metadata: Mapping[str, object] | None = None,
    ) -> Comment:
        task = self.get_task_by_id(task_id)
        board_slug = self._board_slug(task.board_id)
        return self.add_comment(
            board=board_slug,
            task_id=task_id,
            author=author,
            body=body,
            metadata=metadata,
        )

    def unblock_task_by_id(
        self,
        *,
        task_id: str,
        actor: str,
        comment: str | None = None,
        force: bool = False,
    ) -> bool:
        task = self.get_task_by_id(task_id)
        board_slug = self._board_slug(task.board_id)
        return self.unblock(
            board=board_slug,
            task_id=task_id,
            actor=actor,
            comment=comment,
            force=force,
        )

    def add_dependency(self, *, board: str, parent_id: str, child_id: str) -> None:
        board_id = self._ensure_board(board)
        with self._connect() as conn:
            conn.execute(
                """
                INSERT OR IGNORE INTO deps (board_id, parent_id, child_id)
                VALUES (?, ?, ?)
                """,
                (board_id, parent_id, child_id),
            )

    def add_notify_sub(
        self,
        *,
        board: str,
        task_id: str,
        channel_kind: str,
        room_id: str,
        thread_id: str = "",
        user_id: str | None = None,
    ) -> NotifySub:
        now = _now()
        board_id = self._ensure_board(board)
        clean_thread = thread_id or ""
        with self._connect() as conn:
            conn.execute(
                """
                INSERT INTO notify_subs (
                    board_id, task_id, channel_kind, room_id, thread_id, user_id, ts
                ) VALUES (?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(board_id, task_id, channel_kind, room_id, thread_id)
                DO UPDATE SET user_id = excluded.user_id, ts = excluded.ts
                """,
                (board_id, task_id, channel_kind, room_id, clean_thread, user_id, now),
            )
        return self.list_notify_subs(board=board, task_id=task_id)[-1]

    def list_notify_subs(self, *, board: str, task_id: str) -> list[NotifySub]:
        board_id = self._ensure_board(board)
        with self._connect() as conn:
            rows = conn.execute(
                """
                SELECT * FROM notify_subs
                WHERE board_id = ? AND task_id = ?
                ORDER BY ts ASC, channel_kind ASC, room_id ASC, thread_id ASC
                """,
                (board_id, task_id),
            ).fetchall()
        return [_notify_sub_from_row(row) for row in rows]

    def find_notify_sub(
        self,
        *,
        channel_kind: str,
        room_id: str,
        thread_id: str,
    ) -> NotifySub | None:
        with self._connect() as conn:
            row = conn.execute(
                """
                SELECT * FROM notify_subs
                WHERE channel_kind = ? AND room_id = ? AND thread_id = ?
                ORDER BY ts ASC
                LIMIT 1
                """,
                (channel_kind, room_id, thread_id or ""),
            ).fetchone()
        return None if row is None else _notify_sub_from_row(row)

    def upsert_slack_thread(
        self,
        *,
        board: str,
        task_id: str | None,
        team_id: str,
        channel_id: str,
        thread_ts: str,
        mode: str,
        node: str | None = None,
    ) -> SlackThread:
        now = _now()
        board_id = self._ensure_board(board)
        clean_team = team_id.strip()
        clean_channel = channel_id.strip()
        clean_thread = thread_ts.strip()
        clean_mode = mode.strip()
        if not clean_channel or not clean_thread or not clean_mode:
            raise ValueError("channel_id, thread_ts, and mode are required")
        with self._connect() as conn:
            conn.execute(
                """
                INSERT INTO slack_threads (
                    id, board_id, task_id, team_id, channel_id, thread_ts, mode,
                    node, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(team_id, channel_id, thread_ts, mode)
                DO UPDATE SET
                    board_id = excluded.board_id,
                    task_id = excluded.task_id,
                    node = excluded.node,
                    updated_at = excluded.updated_at
                """,
                (
                    _new_id("slack_thread"),
                    board_id,
                    task_id,
                    clean_team,
                    clean_channel,
                    clean_thread,
                    clean_mode,
                    node,
                    now,
                    now,
                ),
            )
            row = conn.execute(
                """
                SELECT * FROM slack_threads
                WHERE team_id = ? AND channel_id = ? AND thread_ts = ? AND mode = ?
                """,
                (clean_team, clean_channel, clean_thread, clean_mode),
            ).fetchone()
        if row is None:
            raise RuntimeError("created slack thread disappeared")
        return _slack_thread_from_row(row)

    def delete_slack_thread(
        self,
        *,
        board: str,
        task_id: str | None,
        team_id: str,
        channel_id: str,
        thread_ts: str,
        mode: str,
    ) -> bool:
        board_id = self._ensure_board(board)
        with self._connect() as conn:
            deleted = conn.execute(
                """
                DELETE FROM slack_threads
                WHERE board_id = ?
                  AND team_id = ?
                  AND channel_id = ?
                  AND thread_ts = ?
                  AND mode = ?
                  AND (task_id = ? OR (task_id IS NULL AND ? IS NULL))
                """,
                (board_id, team_id, channel_id, thread_ts, mode, task_id, task_id),
            )
        return deleted.rowcount > 0

    def list_slack_threads(
        self,
        *,
        task_id: str | None = None,
        mode: str | None = None,
    ) -> list[SlackThread]:
        clauses: list[str] = []
        params: list[object] = []
        if task_id is not None:
            clauses.append("task_id = ?")
            params.append(task_id)
        if mode is not None:
            clauses.append("mode = ?")
            params.append(mode)
        sql = "SELECT * FROM slack_threads"
        if clauses:
            sql += " WHERE " + " AND ".join(clauses)
        sql += " ORDER BY created_at ASC, id ASC"
        with self._connect() as conn:
            rows = conn.execute(sql, params).fetchall()
        return [_slack_thread_from_row(row) for row in rows]

    def list_runs(self, *, board: str, task_id: str) -> list[Run]:
        board_id = self._ensure_board(board)
        with self._connect() as conn:
            rows = conn.execute(
                """
                SELECT * FROM runs
                WHERE board_id = ? AND task_id = ?
                ORDER BY started_at ASC, id ASC
                """,
                (board_id, task_id),
            ).fetchall()
        return [_run_from_row(row) for row in rows]

    def list_runs_for_board(self, *, board: str, since: int | None = None) -> list[Run]:
        board_id = self._board_id_for_slug(board)
        if board_id is None:
            return []
        clauses = ["board_id = ?"]
        params: list[object] = [board_id]
        if since is not None:
            clauses.append("started_at >= ?")
            params.append(since)
        with self._connect() as conn:
            rows = conn.execute(
                f"""
                SELECT * FROM runs
                WHERE {" AND ".join(clauses)}
                ORDER BY started_at ASC, id ASC
                """,
                params,
            ).fetchall()
        return [_run_from_row(row) for row in rows]

    def list_runs_for_task(self, *, task_id: str) -> list[Run]:
        with self._connect() as conn:
            rows = conn.execute(
                """
                SELECT * FROM runs
                WHERE task_id = ?
                ORDER BY started_at ASC, id ASC
                """,
                (task_id,),
            ).fetchall()
        return [_run_from_row(row) for row in rows]

    def list_events_after(
        self,
        *,
        cursor: int = 0,
        limit: int = 100,
        board: str | None = None,
    ) -> list[BoardEvent]:
        clauses = ["rowid > ?"]
        params: list[object] = [cursor]
        if board is not None:
            board_id = self._board_id_for_slug(board)
            if board_id is None:
                return []
            clauses.append("board_id = ?")
            params.append(board_id)
        params.append(limit)
        with self._connect() as conn:
            rows = conn.execute(
                f"""
                SELECT rowid AS cursor, * FROM events
                WHERE {" AND ".join(clauses)}
                ORDER BY rowid ASC
                LIMIT ?
                """,
                params,
            ).fetchall()
        return [_event_from_row(row) for row in rows]

    def list_audit_events(
        self,
        *,
        board: str,
        cursor: int = 0,
        limit: int = 100,
        action: str | None = None,
        node: str | None = None,
        task_id: str | None = None,
    ) -> list[BoardEvent]:
        board_id = self._board_id_for_slug(board)
        if board_id is None:
            return []
        clauses = ["rowid > ?", "board_id = ?", "kind LIKE 'audit.%'"]
        params: list[object] = [cursor, board_id]
        if task_id is not None:
            clauses.append("task_id = ?")
            params.append(task_id)
        if action is not None:
            clauses.append("json_extract(payload_json, '$.action') = ?")
            params.append(action)
        if node is not None:
            clauses.append(
                """
                (
                    json_extract(payload_json, '$.actor.id') = ?
                    OR json_extract(payload_json, '$.target.node') = ?
                    OR json_extract(payload_json, '$.from_node') = ?
                    OR json_extract(payload_json, '$.to_node') = ?
                )
                """
            )
            params.extend([node, node, node, node])
        sql = (
            "SELECT rowid AS cursor, * FROM events WHERE "
            + " AND ".join(clauses)
            + " ORDER BY rowid ASC LIMIT ?"
        )
        params.append(max(1, min(limit, 500)))
        with self._connect() as conn:
            rows = conn.execute(sql, params).fetchall()
        return [_event_from_row(row) for row in rows]

    def last_autopickup_at(self, *, board: str, node: str) -> int | None:
        board_id = self._board_id_for_slug(board)
        if board_id is None:
            return None
        with self._connect() as conn:
            row = conn.execute(
                """
                SELECT ts FROM events
                WHERE board_id = ?
                  AND kind = 'audit.task.autopickup'
                  AND json_extract(payload_json, '$.action') = 'autopickup'
                  AND (
                      json_extract(payload_json, '$.actor.id') = ?
                      OR json_extract(payload_json, '$.target.node') = ?
                  )
                ORDER BY ts DESC, rowid DESC
                LIMIT 1
                """,
                (board_id, node, node),
            ).fetchone()
        if row is None:
            return None
        return _row_int(row, "ts")

    def node_autopickup_enabled(self, *, board: str, node: str) -> bool | None:
        settings = self._board_settings(board)
        if settings is None:
            return None
        nodes = _autopickup_nodes(settings)
        raw = nodes.get(node)
        if not isinstance(raw, Mapping):
            return None
        value = raw.get("enabled")
        return value if isinstance(value, bool) else None

    def autopickup_global_state(self, *, board: str) -> dict[str, bool]:
        settings = self._board_settings(board) or {}
        raw = _autopickup_settings(settings)
        return {
            "enabled": _setting_bool(raw.get("enabled"), default=True),
            "kill_switch": _setting_bool(raw.get("kill_switch"), default=False),
        }

    def set_autopickup_global(
        self,
        *,
        board: str,
        enabled: bool | None = None,
        kill_switch: bool | None = None,
    ) -> dict[str, bool]:
        now = _now()
        board_id = self._ensure_board(board)
        with self._connect(immediate=True) as conn:
            settings = self._settings_for_update(conn, board_id=board_id)
            raw = _mutable_autopickup_settings(settings)
            if enabled is not None:
                raw["enabled"] = enabled
            if kill_switch is not None:
                raw["kill_switch"] = kill_switch
            self._write_board_settings(conn, board_id=board_id, settings=settings, now=now)
        return self.autopickup_global_state(board=board)

    def set_node_autopickup_enabled(
        self,
        *,
        board: str,
        node: str,
        enabled: bool,
    ) -> dict[str, object]:
        now = _now()
        board_id = self._ensure_board(board)
        with self._connect(immediate=True) as conn:
            settings = self._settings_for_update(conn, board_id=board_id)
            nodes = _mutable_autopickup_nodes(settings)
            nodes[node] = {"enabled": enabled, "updated_at": now}
            self._write_board_settings(conn, board_id=board_id, settings=settings, now=now)
        return self.node_autopickup_state(board=board, node=node)

    def node_autopickup_state(self, *, board: str, node: str) -> dict[str, object]:
        global_state = self.autopickup_global_state(board=board)
        enabled = self.node_autopickup_enabled(board=board, node=node)
        return {
            "enabled": bool(enabled) if enabled is not None else False,
            "configured": enabled is not None,
            "global_enabled": global_state["enabled"],
            "global_kill_switch": global_state["kill_switch"],
        }

    def member_quota_state(self, *, board: str, member_id: str) -> dict[str, object]:
        settings = self._board_settings(board) or {}
        members = _quota_members(settings)
        raw = members.get(member_id)
        if not isinstance(raw, Mapping):
            return {"configured": False, "enabled": False}
        return _quota_state_from_mapping(raw, configured=True)

    def quota_members(self, *, board: str) -> dict[str, dict[str, object]]:
        settings = self._board_settings(board) or {}
        members = _quota_members(settings)
        return {
            member_id: _quota_state_from_mapping(raw, configured=True)
            for member_id, raw in members.items()
            if isinstance(member_id, str) and isinstance(raw, Mapping)
        }

    def gui_feature_flags(
        self,
        *,
        board: str,
        features: tuple[str, ...],
    ) -> dict[str, dict[str, object]]:
        settings = self._board_settings(board) or {}
        raw = _gui_feature_settings(settings)
        out: dict[str, dict[str, object]] = {}
        for feature in features:
            state = raw.get(feature)
            if not isinstance(state, Mapping) or not isinstance(state.get("enabled"), bool):
                out[feature] = {"enabled": False, "configured": False}
                continue
            payload: dict[str, object] = {
                "enabled": state["enabled"],
                "configured": True,
            }
            updated_at = state.get("updated_at")
            if isinstance(updated_at, int) and not isinstance(updated_at, bool):
                payload["updated_at"] = updated_at
            out[feature] = payload
        return out

    def set_gui_feature_enabled(
        self,
        *,
        board: str,
        feature: str,
        enabled: bool,
    ) -> dict[str, object]:
        now = _now()
        board_id = self._ensure_board(board)
        with self._connect(immediate=True) as conn:
            settings = self._settings_for_update(conn, board_id=board_id)
            features = _mutable_gui_feature_settings(settings)
            raw = features.get(feature)
            state = dict(raw) if isinstance(raw, Mapping) else {}
            state["enabled"] = enabled
            state["updated_at"] = now
            features[feature] = state
            self._write_board_settings(conn, board_id=board_id, settings=settings, now=now)
        return self.gui_feature_flags(board=board, features=(feature,))[feature]

    def set_member_quota(
        self,
        *,
        board: str,
        member_id: str,
        enabled: bool,
        soft_run_limit: int | None,
        soft_token_limit: int | None,
        soft_cost_usd: float | None,
    ) -> dict[str, object]:
        now = _now()
        board_id = self._ensure_board(board)
        with self._connect(immediate=True) as conn:
            settings = self._settings_for_update(conn, board_id=board_id)
            members = _mutable_quota_members(settings)
            state: dict[str, object] = {
                "enabled": enabled,
                "updated_at": now,
            }
            if soft_run_limit is not None:
                state["soft_run_limit"] = soft_run_limit
            if soft_token_limit is not None:
                state["soft_token_limit"] = soft_token_limit
            if soft_cost_usd is not None:
                state["soft_cost_usd"] = soft_cost_usd
            members[member_id] = state
            self._write_board_settings(conn, board_id=board_id, settings=settings, now=now)
        return self.member_quota_state(board=board, member_id=member_id)

    def notification_routing_state(self, *, board: str) -> dict[str, object]:
        settings = self._board_settings(board) or {}
        raw = settings.get("notification_routing")
        return _notification_routing_state_from_mapping(
            raw if isinstance(raw, Mapping) else {},
            configured=isinstance(raw, Mapping),
        )

    def set_notification_routing(
        self,
        *,
        board: str,
        state: Mapping[str, object],
    ) -> dict[str, object]:
        now = _now()
        board_id = self._ensure_board(board)
        clean = _notification_routing_state_from_mapping(state, configured=True)
        with self._connect(immediate=True) as conn:
            settings = self._settings_for_update(conn, board_id=board_id)
            settings["notification_routing"] = clean
            self._write_board_settings(conn, board_id=board_id, settings=settings, now=now)
        return self.notification_routing_state(board=board)

    def execution_global_state(self, *, board: str) -> dict[str, bool]:
        settings = self._board_settings(board) or {}
        raw = _execution_settings(settings)
        return {
            "enabled": _setting_bool(raw.get("enabled"), default=False),
            "kill_switch": _setting_bool(raw.get("kill_switch"), default=False),
            "board_enabled": _setting_bool(raw.get("board_enabled"), default=True),
            "board_kill_switch": _setting_bool(raw.get("board_kill_switch"), default=False),
        }

    def set_execution_global(
        self,
        *,
        board: str,
        enabled: bool | None = None,
        kill_switch: bool | None = None,
        board_enabled: bool | None = None,
        board_kill_switch: bool | None = None,
    ) -> dict[str, bool]:
        now = _now()
        board_id = self._ensure_board(board)
        with self._connect(immediate=True) as conn:
            settings = self._settings_for_update(conn, board_id=board_id)
            raw = _mutable_execution_settings(settings)
            if enabled is not None:
                raw["enabled"] = enabled
            if kill_switch is not None:
                raw["kill_switch"] = kill_switch
            if board_enabled is not None:
                raw["board_enabled"] = board_enabled
            if board_kill_switch is not None:
                raw["board_kill_switch"] = board_kill_switch
            self._write_board_settings(conn, board_id=board_id, settings=settings, now=now)
        return self.execution_global_state(board=board)

    def node_execution_enabled(self, *, board: str, node: str) -> bool | None:
        settings = self._board_settings(board)
        if settings is None:
            return None
        raw = _execution_nodes(settings).get(node)
        if not isinstance(raw, Mapping):
            return None
        value = raw.get("enabled")
        return value if isinstance(value, bool) else None

    def set_node_execution_enabled(
        self,
        *,
        board: str,
        node: str,
        enabled: bool,
    ) -> dict[str, object]:
        now = _now()
        board_id = self._ensure_board(board)
        with self._connect(immediate=True) as conn:
            settings = self._settings_for_update(conn, board_id=board_id)
            nodes = _mutable_execution_nodes(settings)
            raw = nodes.get(node)
            node_state = dict(raw) if isinstance(raw, Mapping) else {}
            node_state["enabled"] = enabled
            node_state["updated_at"] = now
            nodes[node] = node_state
            self._write_board_settings(conn, board_id=board_id, settings=settings, now=now)
        return self.node_execution_state(board=board, node=node)

    def set_execution_kill_switch(
        self,
        *,
        board: str,
        level: str,
        enabled: bool,
        node: str | None = None,
        task_id: str | None = None,
    ) -> dict[str, object]:
        now = _now()
        board_id = self._ensure_board(board)
        with self._connect(immediate=True) as conn:
            settings = self._settings_for_update(conn, board_id=board_id)
            raw = _mutable_execution_settings(settings)
            if level == "global":
                raw["kill_switch"] = enabled
            elif level == "board":
                raw["board_kill_switch"] = enabled
            elif level == "node":
                if node is None:
                    raise ValueError("node is required for node execution kill switch")
                nodes = _mutable_execution_nodes(settings)
                node_raw = nodes.get(node)
                node_state = dict(node_raw) if isinstance(node_raw, Mapping) else {}
                node_state["kill_switch"] = enabled
                node_state["updated_at"] = now
                nodes[node] = node_state
            elif level == "task":
                if task_id is None:
                    raise ValueError("task_id is required for task execution kill switch")
                tasks = _mutable_execution_tasks(settings)
                task_raw = tasks.get(task_id)
                task_state = dict(task_raw) if isinstance(task_raw, Mapping) else {}
                task_state["kill_switch"] = enabled
                task_state["updated_at"] = now
                tasks[task_id] = task_state
            else:
                raise ValueError("execution kill switch level must be global, board, node, or task")
            self._write_board_settings(conn, board_id=board_id, settings=settings, now=now)
        return self.execution_gate_state(board=board, node=node or "", task_id=task_id)

    def node_execution_state(self, *, board: str, node: str) -> dict[str, object]:
        settings = self._board_settings(board) or {}
        raw = _execution_nodes(settings).get(node)
        node_state = raw if isinstance(raw, Mapping) else {}
        global_state = self.execution_global_state(board=board)
        return {
            "enabled": _setting_bool(node_state.get("enabled"), default=False),
            "configured": isinstance(raw, Mapping) and isinstance(raw.get("enabled"), bool),
            "kill_switch": _setting_bool(node_state.get("kill_switch"), default=False),
            "global_enabled": global_state["enabled"],
            "global_kill_switch": global_state["kill_switch"],
            "board_enabled": global_state["board_enabled"],
            "board_kill_switch": global_state["board_kill_switch"],
        }

    def execution_gate_state(
        self,
        *,
        board: str,
        node: str,
        task_id: str | None,
    ) -> dict[str, object]:
        settings = self._board_settings(board) or {}
        raw = _execution_settings(settings)
        node_raw = _execution_nodes(settings).get(node)
        node_state = node_raw if isinstance(node_raw, Mapping) else {}
        task_raw = _execution_tasks(settings).get(task_id or "")
        task_setting = task_raw if isinstance(task_raw, Mapping) else {}
        task_execution: Mapping[str, object] = {}
        if task_id is not None:
            try:
                task = self.get_task(board=board, task_id=task_id)
                task_execution = _task_execution(task.metadata)
            except KeyError:
                task_execution = {}
        task_kill = _setting_bool(task_setting.get("kill_switch"), default=False) or _setting_bool(
            task_execution.get("kill_switch"),
            default=False,
        )
        global_enabled = _setting_bool(raw.get("enabled"), default=False)
        global_kill = _setting_bool(raw.get("kill_switch"), default=False)
        board_enabled = _setting_bool(raw.get("board_enabled"), default=True)
        board_kill = _setting_bool(raw.get("board_kill_switch"), default=False)
        node_enabled = _setting_bool(node_state.get("enabled"), default=False)
        node_kill = _setting_bool(node_state.get("kill_switch"), default=False)
        blocked_by: list[str] = []
        if not global_enabled:
            blocked_by.append("global-disabled")
        if global_kill:
            blocked_by.append("global-kill-switch")
        if not board_enabled:
            blocked_by.append("board-disabled")
        if board_kill:
            blocked_by.append("board-kill-switch")
        if not node_enabled:
            blocked_by.append("node-disabled")
        if node_kill:
            blocked_by.append("node-kill-switch")
        if task_kill:
            blocked_by.append("task-kill-switch")
        return {
            "allowed": not blocked_by,
            "blocked_by": blocked_by,
            "global_enabled": global_enabled,
            "global_kill_switch": global_kill,
            "board_enabled": board_enabled,
            "board_kill_switch": board_kill,
            "node_enabled": node_enabled,
            "node_kill_switch": node_kill,
            "task_kill_switch": task_kill,
        }

    def autopickup_gate_state(self, *, board: str, node: str) -> dict[str, object]:
        global_state = self.autopickup_global_state(board=board)
        node_enabled = self.node_autopickup_enabled(board=board, node=node)
        blocked_by: list[str] = []
        if not global_state["enabled"]:
            blocked_by.append("autopickup-global-disabled")
        if global_state["kill_switch"]:
            blocked_by.append("autopickup-global-kill-switch")
        if node_enabled is not True:
            blocked_by.append("autopickup-node-disabled")
        return {
            "allowed": not blocked_by,
            "blocked_by": blocked_by,
            "global_enabled": global_state["enabled"],
            "global_kill_switch": global_state["kill_switch"],
            "node_enabled": node_enabled is True,
        }

    def guarded_dispatch_gate_state(
        self,
        *,
        board: str,
        node: str,
        task_id: str | None,
    ) -> dict[str, object]:
        execution = self.execution_gate_state(board=board, node=node, task_id=task_id)
        autopickup = self.autopickup_gate_state(board=board, node=node)
        blocked_by = [
            *cast(list[str], execution["blocked_by"]),
            *cast(list[str], autopickup["blocked_by"]),
        ]
        return {
            "allowed": not blocked_by,
            "blocked_by": blocked_by,
            "execution": execution,
            "autopickup": autopickup,
        }

    def task_execution_state(self, *, board: str, task_id: str) -> dict[str, object]:
        task = self.get_task(board=board, task_id=task_id)
        execution = dict(_task_execution(task.metadata))
        state = execution.get("state")
        if not isinstance(state, str):
            execution["state"] = "none"
        return execution

    def begin_guarded_execution(
        self,
        *,
        board: str,
        task_id: str,
        run_id: str,
        node: str,
    ) -> dict[str, object]:
        now = _now()
        board_id = self._ensure_board(board)
        with self._connect(immediate=True) as conn:
            row = conn.execute(
                """
                SELECT * FROM tasks
                WHERE board_id = ? AND id = ? AND status = 'running' AND current_run_id = ?
                """,
                (board_id, task_id, run_id),
            ).fetchone()
            if row is None:
                raise KeyError(task_id)
            metadata = _json_dict(row["metadata_json"])
            execution = _mutable_task_execution(metadata)
            state = execution.get("state")
            if not isinstance(state, str) or state == "none":
                execution.update(
                    {
                        "state": "claimed",
                        "node": node,
                        "run_id": run_id,
                        "approved": False,
                        "updated_at": now,
                    }
                )
                self._add_execution_audit(
                    conn,
                    board_id=board_id,
                    board=board,
                    task_id=task_id,
                    run_id=run_id,
                    node=node,
                    action="claim",
                    state="claimed",
                    now=now,
                )
                execution["state"] = "preflight"
                execution["updated_at"] = now
                self._add_execution_audit(
                    conn,
                    board_id=board_id,
                    board=board,
                    task_id=task_id,
                    run_id=run_id,
                    node=node,
                    action="preflight",
                    state="preflight",
                    now=now,
                )
                execution["state"] = "approval-pending"
                execution["updated_at"] = now
                self._add_execution_audit(
                    conn,
                    board_id=board_id,
                    board=board,
                    task_id=task_id,
                    run_id=run_id,
                    node=node,
                    action="approval-pending",
                    state="approval-pending",
                    now=now,
                )
                conn.execute(
                    """
                    UPDATE tasks
                    SET metadata_json = ?, updated_at = ?
                    WHERE board_id = ? AND id = ?
                    """,
                    (_json(metadata), now, board_id, task_id),
                )
            return dict(execution)

    def approve_execution(
        self,
        *,
        board: str,
        task_id: str,
        actor: Mapping[str, object],
    ) -> bool:
        now = _now()
        board_id = self._ensure_board(board)
        with self._connect(immediate=True) as conn:
            row = conn.execute(
                "SELECT * FROM tasks WHERE board_id = ? AND id = ?",
                (board_id, task_id),
            ).fetchone()
            if row is None:
                raise KeyError(task_id)
            metadata = _json_dict(row["metadata_json"])
            execution = _mutable_task_execution(metadata)
            if execution.get("state") != "approval-pending":
                return False
            node = _execution_node_from_metadata(
                execution,
                fallback=_row_optional_str(row, "assignee"),
            )
            run_id = _row_optional_str(row, "current_run_id")
            execution["state"] = "approved"
            execution["approved"] = True
            execution["approved_at"] = now
            execution["approved_by"] = _safe_text(
                str(actor.get("login") or actor.get("id") or "actor")
            )
            execution["updated_at"] = now
            conn.execute(
                "UPDATE tasks SET metadata_json = ?, updated_at = ? WHERE board_id = ? AND id = ?",
                (_json(metadata), now, board_id, task_id),
            )
            self._add_execution_audit(
                conn,
                board_id=board_id,
                board=board,
                task_id=task_id,
                run_id=run_id,
                node=node,
                action="approve",
                state="approved",
                now=now,
                actor=actor,
            )
        return True

    def abort_execution(
        self,
        *,
        board: str,
        task_id: str,
        actor: Mapping[str, object],
        reason: str,
    ) -> bool:
        now = _now()
        board_id = self._ensure_board(board)
        with self._connect(immediate=True) as conn:
            row = conn.execute(
                "SELECT * FROM tasks WHERE board_id = ? AND id = ?",
                (board_id, task_id),
            ).fetchone()
            if row is None:
                raise KeyError(task_id)
            metadata = _json_dict(row["metadata_json"])
            execution = _mutable_task_execution(metadata)
            state = execution.get("state")
            if isinstance(state, str) and state in EXECUTION_TERMINAL_STATES:
                return False
            node = _execution_node_from_metadata(
                execution,
                fallback=_row_optional_str(row, "assignee"),
            )
            run_id = _row_optional_str(row, "current_run_id")
            execution["state"] = "abort"
            execution["abort_reason"] = _safe_text(reason)
            execution["updated_at"] = now
            conn.execute(
                "UPDATE tasks SET metadata_json = ?, updated_at = ? WHERE board_id = ? AND id = ?",
                (_json(metadata), now, board_id, task_id),
            )
            self._add_execution_audit(
                conn,
                board_id=board_id,
                board=board,
                task_id=task_id,
                run_id=run_id,
                node=node,
                action="abort",
                state="abort",
                now=now,
                actor=actor,
                summary=reason,
            )
        return True

    def hold_execution_for_gate(
        self,
        *,
        board: str,
        task_id: str,
        actor: Mapping[str, object],
        reason: str,
    ) -> bool:
        now = _now()
        board_id = self._ensure_board(board)
        with self._connect(immediate=True) as conn:
            row = conn.execute(
                "SELECT * FROM tasks WHERE board_id = ? AND id = ?",
                (board_id, task_id),
            ).fetchone()
            if row is None:
                raise KeyError(task_id)
            metadata = _json_dict(row["metadata_json"])
            execution = _mutable_task_execution(metadata)
            state = execution.get("state")
            if isinstance(state, str) and state in EXECUTION_TERMINAL_STATES:
                return False
            node = _execution_node_from_metadata(
                execution,
                fallback=_row_optional_str(row, "assignee"),
            )
            run_id = _row_optional_str(row, "current_run_id")
            execution["state"] = "approval-pending"
            execution["approved"] = False
            execution.pop("approved_at", None)
            execution.pop("approved_by", None)
            execution["hold_reason"] = _safe_text(reason)
            execution["updated_at"] = now
            conn.execute(
                "UPDATE tasks SET metadata_json = ?, updated_at = ? WHERE board_id = ? AND id = ?",
                (_json(metadata), now, board_id, task_id),
            )
            self._add_execution_audit(
                conn,
                board_id=board_id,
                board=board,
                task_id=task_id,
                run_id=run_id,
                node=node,
                action="approval-pending",
                state="approval-pending",
                now=now,
                actor=actor,
                status="blocked",
                summary=reason,
            )
        return True

    def try_mark_execution_executing(
        self,
        *,
        board: str,
        task_id: str,
        run_id: str,
        node: str,
    ) -> bool:
        return (
            self.issue_execution_dispatch_lease(
                board=board,
                task_id=task_id,
                run_id=run_id,
                node=node,
            )
            is not None
        )

    def issue_execution_dispatch_lease(
        self,
        *,
        board: str,
        task_id: str,
        run_id: str,
        node: str,
        ttl_seconds: int = EXECUTION_DISPATCH_LEASE_TTL_SECONDS,
    ) -> str | None:
        now = _now()
        board_id = self._ensure_board(board)
        gate = self.guarded_dispatch_gate_state(board=board, node=node, task_id=task_id)
        if not bool(gate["allowed"]):
            blocked_by = cast(list[str], gate["blocked_by"])
            reason = "dispatch gate blocked: " + ",".join(blocked_by)
            if not _gate_blocked_by_kill_switch(blocked_by):
                self.hold_execution_for_gate(
                    board=board,
                    task_id=task_id,
                    actor=_node_actor(node),
                    reason=reason,
                )
                return None
            self.abort_execution(
                board=board,
                task_id=task_id,
                actor=_node_actor(node),
                reason=reason,
            )
            return None
        with self._connect(immediate=True) as conn:
            concurrent = conn.execute(
                """
                SELECT id FROM tasks
                WHERE board_id = ?
                  AND assignee = ?
                  AND status = 'running'
                  AND id != ?
                  AND json_extract(metadata_json, '$.execution.state') = 'executing'
                LIMIT 1
                """,
                (board_id, node, task_id),
            ).fetchone()
            if concurrent is not None:
                return None
            row = conn.execute(
                """
                SELECT * FROM tasks
                WHERE board_id = ? AND id = ? AND status = 'running' AND current_run_id = ?
                """,
                (board_id, task_id, run_id),
            ).fetchone()
            if row is None:
                return None
            metadata = _json_dict(row["metadata_json"])
            execution = _mutable_task_execution(metadata)
            if execution.get("state") != "approved" or execution.get("approved") is not True:
                return None
            token = f"{run_id}:{secrets.token_urlsafe(18)}"
            execution["state"] = "executing"
            execution["dispatch_lease"] = {
                "token": token,
                "run_id": run_id,
                "node": node,
                "expires_at": now + max(0, ttl_seconds),
                "issued_at": now,
            }
            execution["updated_at"] = now
            conn.execute(
                "UPDATE tasks SET metadata_json = ?, updated_at = ? WHERE board_id = ? AND id = ?",
                (_json(metadata), now, board_id, task_id),
            )
            self._add_execution_audit(
                conn,
                board_id=board_id,
                board=board,
                task_id=task_id,
                run_id=run_id,
                node=node,
                action="execute",
                state="executing",
                now=now,
            )
        return token

    def consume_execution_dispatch_lease(
        self,
        *,
        board: str,
        task_id: str,
        run_id: str,
        node: str,
        token: str,
    ) -> bool:
        now = _now()
        board_id = self._ensure_board(board)
        with self._connect(immediate=True) as conn:
            settings = self._settings_for_update(conn, board_id=board_id)
            row = conn.execute(
                """
                SELECT * FROM tasks
                WHERE board_id = ? AND id = ? AND status = 'running' AND current_run_id = ?
                """,
                (board_id, task_id, run_id),
            ).fetchone()
            if row is None:
                return False
            metadata = _json_dict(row["metadata_json"])
            execution = _mutable_task_execution(metadata)
            blocked_by = _guarded_dispatch_blockers_from_settings(
                settings=settings,
                node=node,
                task_id=task_id,
                task_execution=execution,
            )
            lease = execution.get("dispatch_lease")
            lease_map = lease if isinstance(lease, Mapping) else {}
            state = execution.get("state")
            if state != "executing":
                blocked_by.append("dispatch-state-not-executing")
            if execution.get("approved") is not True:
                blocked_by.append("dispatch-not-approved")
            if execution.get("run_id") != run_id:
                blocked_by.append("dispatch-run-mismatch")
            if lease_map.get("token") != token:
                blocked_by.append("dispatch-lease-token-mismatch")
            if lease_map.get("run_id") != run_id:
                blocked_by.append("dispatch-lease-run-mismatch")
            if lease_map.get("node") != node:
                blocked_by.append("dispatch-lease-node-mismatch")
            expires_at = lease_map.get("expires_at")
            if not isinstance(expires_at, int) or expires_at <= now:
                blocked_by.append("dispatch-lease-expired")
            if lease_map.get("consumed_at") is not None:
                blocked_by.append("dispatch-lease-consumed")
            if not blocked_by:
                next_lease = dict(lease_map)
                next_lease["consumed_at"] = now
                execution["dispatch_lease"] = next_lease
                execution["updated_at"] = now
                conn.execute(
                    """
                    UPDATE tasks
                    SET metadata_json = ?, updated_at = ?
                    WHERE board_id = ? AND id = ?
                    """,
                    (_json(metadata), now, board_id, task_id),
                )
                return True
            reason = "prepared dispatch blocked: " + ",".join(blocked_by)
            if isinstance(state, str) and state in EXECUTION_TERMINAL_STATES:
                return False
            execution["state"] = "abort"
            execution["abort_reason"] = _safe_text(reason)
            execution["updated_at"] = now
            conn.execute(
                "UPDATE tasks SET metadata_json = ?, updated_at = ? WHERE board_id = ? AND id = ?",
                (_json(metadata), now, board_id, task_id),
            )
            self._add_execution_audit(
                conn,
                board_id=board_id,
                board=board,
                task_id=task_id,
                run_id=run_id,
                node=node,
                action="abort",
                state="abort",
                now=now,
                actor=_node_actor(node),
                summary=reason,
            )
        return False

    def mark_execution_verify(
        self,
        *,
        board: str,
        task_id: str,
        run_id: str,
        node: str,
        passed: bool,
        summary: str | None = None,
    ) -> bool:
        now = _now()
        board_id = self._ensure_board(board)
        with self._connect(immediate=True) as conn:
            row = conn.execute(
                """
                SELECT * FROM tasks
                WHERE board_id = ? AND id = ? AND current_run_id = ?
                """,
                (board_id, task_id, run_id),
            ).fetchone()
            if row is None:
                return False
            metadata = _json_dict(row["metadata_json"])
            execution = _mutable_task_execution(metadata)
            if execution.get("state") != "executing":
                return False
            execution["state"] = "verify"
            execution["verify_passed"] = passed
            execution["updated_at"] = now
            conn.execute(
                "UPDATE tasks SET metadata_json = ?, updated_at = ? WHERE board_id = ? AND id = ?",
                (_json(metadata), now, board_id, task_id),
            )
            self._add_execution_audit(
                conn,
                board_id=board_id,
                board=board,
                task_id=task_id,
                run_id=run_id,
                node=node,
                action="verify",
                state="verify",
                now=now,
                status="ok" if passed else "failed",
                summary=summary,
            )
            if not passed:
                execution["state"] = "rollback"
                execution["rollback_reason"] = _safe_text(summary or "verify failed")
                execution["updated_at"] = now
                conn.execute(
                    """
                    UPDATE tasks
                    SET metadata_json = ?, updated_at = ?
                    WHERE board_id = ? AND id = ?
                    """,
                    (_json(metadata), now, board_id, task_id),
                )
                self._add_execution_audit(
                    conn,
                    board_id=board_id,
                    board=board,
                    task_id=task_id,
                    run_id=run_id,
                    node=node,
                    action="rollback",
                    state="rollback",
                    now=now,
                    status="failed",
                    summary=summary,
                )
        return True

    def add_audit_event(
        self,
        *,
        board: str,
        kind: str,
        actor: Mapping[str, object],
        action: str,
        target: Mapping[str, object],
        task_id: str | None = None,
        run_id: str | None = None,
        status: str = "ok",
        summary: str | None = None,
        payload: Mapping[str, object] | None = None,
    ) -> BoardEvent:
        now = _now()
        board_id = self._ensure_board(board)
        event_payload = _audit_payload(
            actor=actor,
            action=action,
            target=target,
            board=board,
            status=status,
            summary=summary,
            ts=now,
            extra=payload,
        )
        with self._connect() as conn:
            event_id = self._add_event(
                conn,
                board_id=board_id,
                task_id=task_id,
                run_id=run_id,
                kind=kind,
                payload=event_payload,
                now=now,
            )
            row = conn.execute(
                "SELECT rowid AS cursor, * FROM events WHERE id = ?",
                (event_id,),
            ).fetchone()
        if row is None:
            raise RuntimeError("created audit event disappeared")
        return _event_from_row(row)

    def release_stale(
        self,
        *,
        board: str,
        now: int | None = None,
        limit: int | None = None,
    ) -> int:
        ts = _now() if now is None else now
        board_id = self._ensure_board(board)
        sql = """
            SELECT id, assignee, current_run_id, claim_lock, metadata_json FROM tasks
            WHERE board_id = ?
              AND status = 'running'
              AND claim_expires IS NOT NULL
              AND claim_expires < ?
            ORDER BY claim_expires ASC, id ASC
        """
        params: list[object] = [board_id, ts]
        if limit is not None:
            sql += " LIMIT ?"
            params.append(limit)
        released = 0
        with self._connect(immediate=True) as conn:
            rows = conn.execute(sql, params).fetchall()
            for row in rows:
                task_id = _row_str(row, "id")
                run_id = _row_optional_str(row, "current_run_id")
                claim_lock = _row_optional_str(row, "claim_lock")
                assignee = _row_optional_str(row, "assignee")
                metadata = _released_execution_metadata(row, run_id=run_id, now=ts)
                conn.execute(
                    """
                    UPDATE tasks
                    SET status = 'ready',
                        claim_lock = NULL,
                        claim_expires = NULL,
                        current_run_id = NULL,
                        metadata_json = ?,
                        updated_at = ?
                    WHERE board_id = ? AND id = ?
                    """,
                    (_json(metadata), ts, board_id, task_id),
                )
                if run_id is not None and claim_lock is not None:
                    conn.execute(
                        """
                        UPDATE runs
                        SET status = 'released',
                            ended_at = ?,
                            outcome = 'released',
                            error = 'claim expired'
                        WHERE board_id = ? AND id = ? AND task_id = ? AND claim_lock = ?
                        """,
                        (ts, board_id, run_id, task_id, claim_lock),
                    )
                self._add_event(
                    conn,
                    board_id=board_id,
                    task_id=task_id,
                    run_id=run_id,
                    kind="task.released",
                    payload={"reason": "claim expired"},
                    now=ts,
                )
                execution = _task_execution(_json_dict(row["metadata_json"]))
                if execution:
                    node = _execution_node_from_metadata(execution, fallback=assignee)
                    self._add_execution_audit(
                        conn,
                        board_id=board_id,
                        board=board,
                        task_id=task_id,
                        run_id=run_id,
                        node=node,
                        action="release-stale",
                        state="none",
                        now=ts,
                        status="released",
                        summary="claim expired",
                    )
                released += 1
        return released

    def resolve_workspace(self, *, board: str, task: Task) -> Path:
        if task.workspace_path is not None:
            return Path(task.workspace_path)
        return self._path.parent / "workspaces" / board / task.id

    @contextmanager
    def _connect(self, *, immediate: bool = False) -> Generator[sqlite3.Connection, None, None]:
        conn = sqlite3.connect(self._path, timeout=30)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys = ON")
        conn.execute(f"PRAGMA busy_timeout = {SQLITE_BUSY_TIMEOUT_MS}")
        conn.execute("PRAGMA journal_mode = WAL")
        conn.execute("PRAGMA synchronous = NORMAL")
        if immediate:
            conn.execute("BEGIN IMMEDIATE")
        try:
            yield conn
            conn.commit()
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.close()

    def _ensure_board(self, slug: str) -> str:
        clean = slug.strip()
        if not clean:
            raise ValueError("board slug is required")
        now = _now()
        with self._connect(immediate=True) as conn:
            row = conn.execute("SELECT id FROM boards WHERE slug = ?", (clean,)).fetchone()
            if row is not None:
                return _row_str(row, "id")
            board_id = _new_id("board")
            conn.execute(
                """
                INSERT OR IGNORE INTO boards (
                    id, slug, title, state, settings_json, created_at, updated_at
                )
                VALUES (?, ?, ?, 'active', ?, ?, ?)
                """,
                (board_id, clean, clean, _json({}), now, now),
            )
            row = conn.execute("SELECT id FROM boards WHERE slug = ?", (clean,)).fetchone()
        if row is None:
            raise RuntimeError("created board disappeared")
        return _row_str(row, "id")

    def _board_slug(self, board_id: str) -> str:
        with self._connect() as conn:
            row = conn.execute("SELECT slug FROM boards WHERE id = ?", (board_id,)).fetchone()
        if row is None:
            raise KeyError(board_id)
        return _row_str(row, "slug")

    def _board_id_for_slug(self, slug: str) -> str | None:
        clean = slug.strip()
        if not clean:
            return None
        with self._connect() as conn:
            row = conn.execute("SELECT id FROM boards WHERE slug = ?", (clean,)).fetchone()
        if row is None:
            return None
        return _row_str(row, "id")

    def _board_settings(self, slug: str) -> dict[str, object] | None:
        board_id = self._board_id_for_slug(slug)
        if board_id is None:
            return None
        with self._connect() as conn:
            row = conn.execute(
                "SELECT settings_json FROM boards WHERE id = ?",
                (board_id,),
            ).fetchone()
        if row is None:
            return None
        return _json_dict(row["settings_json"])

    def _settings_for_update(
        self,
        conn: sqlite3.Connection,
        *,
        board_id: str,
    ) -> dict[str, object]:
        row = conn.execute(
            "SELECT settings_json FROM boards WHERE id = ?",
            (board_id,),
        ).fetchone()
        if row is None:
            raise KeyError(board_id)
        return _json_dict(row["settings_json"])

    def _write_board_settings(
        self,
        conn: sqlite3.Connection,
        *,
        board_id: str,
        settings: Mapping[str, object],
        now: int,
    ) -> None:
        conn.execute(
            "UPDATE boards SET settings_json = ?, updated_at = ? WHERE id = ?",
            (_json(settings), now, board_id),
        )

    def _init_schema(self, conn: sqlite3.Connection) -> None:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS boards (
                id TEXT PRIMARY KEY,
                slug TEXT NOT NULL UNIQUE,
                title TEXT NOT NULL,
                state TEXT NOT NULL,
                settings_json TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS tasks (
                id TEXT PRIMARY KEY,
                board_id TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
                title TEXT NOT NULL,
                body TEXT,
                assignee TEXT,
                reviewer TEXT,
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
            );

            CREATE INDEX IF NOT EXISTS idx_tasks_ready
                ON tasks(board_id, assignee, status, priority, created_at);
            CREATE INDEX IF NOT EXISTS idx_tasks_stale
                ON tasks(board_id, status, claim_expires);

            CREATE TABLE IF NOT EXISTS runs (
                id TEXT PRIMARY KEY,
                board_id TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
                task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
                node_id TEXT NOT NULL,
                status TEXT NOT NULL,
                claim_lock TEXT NOT NULL,
                claim_expires INTEGER NOT NULL,
                started_at INTEGER NOT NULL,
                last_heartbeat_at INTEGER,
                ended_at INTEGER,
                outcome TEXT,
                summary TEXT,
                metadata_json TEXT NOT NULL DEFAULT '{}',
                error TEXT
            );

            CREATE INDEX IF NOT EXISTS idx_runs_task ON runs(board_id, task_id, started_at);

            CREATE TABLE IF NOT EXISTS comments (
                id TEXT PRIMARY KEY,
                board_id TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
                task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
                author TEXT NOT NULL,
                body TEXT NOT NULL,
                metadata_json TEXT NOT NULL DEFAULT '{}',
                ts INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS deps (
                board_id TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
                parent_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
                child_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
                PRIMARY KEY(board_id, parent_id, child_id)
            );

            CREATE TABLE IF NOT EXISTS events (
                id TEXT PRIMARY KEY,
                board_id TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
                task_id TEXT,
                run_id TEXT,
                kind TEXT NOT NULL,
                payload_json TEXT NOT NULL,
                ts INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS notify_subs (
                board_id TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
                task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
                channel_kind TEXT NOT NULL,
                room_id TEXT NOT NULL,
                thread_id TEXT NOT NULL DEFAULT '',
                user_id TEXT,
                ts INTEGER NOT NULL,
                last_event_id TEXT,
                PRIMARY KEY(board_id, task_id, channel_kind, room_id, thread_id)
            );

            CREATE TABLE IF NOT EXISTS slack_threads (
                id TEXT PRIMARY KEY,
                board_id TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
                task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE,
                team_id TEXT NOT NULL,
                channel_id TEXT NOT NULL,
                thread_ts TEXT NOT NULL,
                mode TEXT NOT NULL,
                node TEXT,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                UNIQUE(team_id, channel_id, thread_ts, mode)
            );

            CREATE INDEX IF NOT EXISTS idx_slack_threads_task
                ON slack_threads(task_id, mode);

            CREATE TABLE IF NOT EXISTS node_health (
                project TEXT NOT NULL,
                session TEXT NOT NULL,
                node TEXT NOT NULL,
                status TEXT NOT NULL,
                reason TEXT,
                message TEXT,
                detected_at INTEGER NOT NULL,
                reset_at INTEGER,
                source TEXT NOT NULL,
                updated_at INTEGER NOT NULL,
                PRIMARY KEY(project, session, node)
            );

            CREATE INDEX IF NOT EXISTS idx_node_health_project
                ON node_health(project, session, status, detected_at);

            CREATE TABLE IF NOT EXISTS decision_proposals (
                id TEXT PRIMARY KEY,
                board_id TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
                proposer TEXT NOT NULL,
                title TEXT NOT NULL,
                body TEXT,
                target_assignee TEXT,
                reviewer TEXT,
                status TEXT NOT NULL,
                metadata_json TEXT NOT NULL DEFAULT '{}',
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_decision_proposals_board
                ON decision_proposals(board_id, status, created_at);

            CREATE TABLE IF NOT EXISTS decision_votes (
                proposal_id TEXT NOT NULL REFERENCES decision_proposals(id) ON DELETE CASCADE,
                voter TEXT NOT NULL,
                approve INTEGER NOT NULL,
                reason TEXT,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                PRIMARY KEY(proposal_id, voter)
            );

            CREATE TABLE IF NOT EXISTS decision_dispatch_locks (
                proposal_id TEXT PRIMARY KEY
                    REFERENCES decision_proposals(id) ON DELETE CASCADE,
                idempotency_key_hash TEXT NOT NULL,
                task_id TEXT NOT NULL REFERENCES tasks(id),
                created_at INTEGER NOT NULL
            );
            """
        )
        self._ensure_task_reviewer_column(conn)

    def _ensure_task_reviewer_column(self, conn: sqlite3.Connection) -> None:
        columns = {
            str(row["name"])
            for row in conn.execute("PRAGMA table_info(tasks)").fetchall()
            if row["name"] is not None
        }
        if "reviewer" not in columns:
            conn.execute("ALTER TABLE tasks ADD COLUMN reviewer TEXT")

    def _parents_satisfied(
        self,
        conn: sqlite3.Connection,
        *,
        board_id: str,
        child_id: str,
    ) -> bool:
        row = conn.execute(
            """
            SELECT COUNT(*) AS open_count
            FROM deps
            JOIN tasks ON tasks.id = deps.parent_id AND tasks.board_id = deps.board_id
            WHERE deps.board_id = ?
              AND deps.child_id = ?
              AND tasks.status NOT IN ('done', 'archived')
            """,
            (board_id, child_id),
        ).fetchone()
        return row is not None and _row_int(row, "open_count") == 0

    def _promote_ready_children(
        self,
        conn: sqlite3.Connection,
        *,
        board_id: str,
        parent_id: str,
        now: int,
    ) -> None:
        child_rows = conn.execute(
            "SELECT child_id FROM deps WHERE board_id = ? AND parent_id = ?",
            (board_id, parent_id),
        ).fetchall()
        for row in child_rows:
            child_id = _row_str(row, "child_id")
            if self._parents_satisfied(conn, board_id=board_id, child_id=child_id):
                updated = conn.execute(
                    """
                    UPDATE tasks
                    SET status = 'ready', updated_at = ?
                    WHERE board_id = ? AND id = ? AND status = 'blocked'
                    """,
                    (now, board_id, child_id),
                )
                if updated.rowcount == 1:
                    self._add_event(
                        conn,
                        board_id=board_id,
                        task_id=child_id,
                        run_id=None,
                        kind="task.deps_ready",
                        payload={"parent_id": parent_id},
                        now=now,
                    )

    def _add_comment_row(
        self,
        conn: sqlite3.Connection,
        *,
        board_id: str,
        task_id: str,
        author: str,
        body: str,
        metadata: Mapping[str, object],
        now: int,
    ) -> str:
        comment_id = _new_id("comment")
        conn.execute(
            """
            INSERT INTO comments (id, board_id, task_id, author, body, metadata_json, ts)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (comment_id, board_id, task_id, author, body, _json(metadata), now),
        )
        self._add_event(
            conn,
            board_id=board_id,
            task_id=task_id,
            run_id=None,
            kind="comment.added",
            payload={"author": author},
            now=now,
        )
        return comment_id

    def _add_event(
        self,
        conn: sqlite3.Connection,
        *,
        board_id: str,
        task_id: str | None,
        run_id: str | None,
        kind: str,
        payload: Mapping[str, object],
        now: int,
    ) -> str:
        event_id = _new_id("event")
        conn.execute(
            """
            INSERT INTO events (id, board_id, task_id, run_id, kind, payload_json, ts)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (event_id, board_id, task_id, run_id, kind, _json(payload), now),
        )
        return event_id

    def _add_execution_audit(
        self,
        conn: sqlite3.Connection,
        *,
        board_id: str,
        board: str,
        task_id: str,
        run_id: str | None,
        node: str,
        action: str,
        state: str,
        now: int,
        actor: Mapping[str, object] | None = None,
        status: str = "ok",
        summary: str | None = None,
    ) -> None:
        self._add_event(
            conn,
            board_id=board_id,
            task_id=task_id,
            run_id=run_id,
            kind=f"audit.execution.{action}",
            payload=_audit_payload(
                actor=actor or _node_actor(node),
                action=action,
                target={"type": "task", "id": task_id, "node": node},
                board=board,
                status=status,
                summary=summary,
                ts=now,
                extra={"state": state},
            ),
            now=now,
        )


def _new_id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex}"


def _now() -> int:
    return int(time.time())


def _clean(value: str) -> str:
    return value


def _node_actor(node_id: str) -> dict[str, object]:
    return {"kind": "node", "id": node_id, "login": node_id, "role": "none"}


def _autopickup_settings(settings: Mapping[str, object]) -> Mapping[str, object]:
    raw = settings.get("autopickup")
    return raw if isinstance(raw, Mapping) else {}


def _autopickup_nodes(settings: Mapping[str, object]) -> Mapping[str, object]:
    raw = _autopickup_settings(settings).get("nodes")
    return raw if isinstance(raw, Mapping) else {}


def _execution_settings(settings: Mapping[str, object]) -> Mapping[str, object]:
    raw = settings.get("execution")
    return raw if isinstance(raw, Mapping) else {}


def _execution_nodes(settings: Mapping[str, object]) -> Mapping[str, object]:
    raw = _execution_settings(settings).get("nodes")
    return raw if isinstance(raw, Mapping) else {}


def _execution_tasks(settings: Mapping[str, object]) -> Mapping[str, object]:
    raw = _execution_settings(settings).get("tasks")
    return raw if isinstance(raw, Mapping) else {}


def _quota_settings(settings: Mapping[str, object]) -> Mapping[str, object]:
    raw = settings.get("quota")
    return raw if isinstance(raw, Mapping) else {}


def _gui_feature_settings(settings: Mapping[str, object]) -> Mapping[str, object]:
    raw = settings.get("gui_features")
    return raw if isinstance(raw, Mapping) else {}


def _saved_views_from_settings(settings: Mapping[str, object]) -> dict[str, dict[str, object]]:
    raw = settings.get("saved_views")
    if not isinstance(raw, Mapping):
        return {}
    views: dict[str, dict[str, object]] = {}
    for name, value in raw.items():
        if isinstance(name, str) and isinstance(value, Mapping):
            views[name] = _saved_view_from_mapping(value)
    return views


def _mutable_saved_views(settings: dict[str, object]) -> dict[str, object]:
    raw = settings.get("saved_views")
    if not isinstance(raw, dict):
        raw = {}
        settings["saved_views"] = raw
    return cast(dict[str, object], raw)


def _saved_view_from_mapping(
    raw: Mapping[str, object],
    *,
    updated_at: int | None = None,
) -> dict[str, object]:
    sanitized = _sanitize_audit_mapping(raw)
    view: dict[str, object] = {}
    for key in ("status", "assignee", "label", "q"):
        value = sanitized.get(key)
        if isinstance(value, str) and value.strip():
            view[key] = value.strip()[:500]
    limit = sanitized.get("limit")
    if isinstance(limit, int) and not isinstance(limit, bool):
        view["limit"] = max(1, min(limit, 100))
    if updated_at is not None:
        view["updated_at"] = updated_at
    elif isinstance(sanitized.get("updated_at"), int) and not isinstance(
        sanitized.get("updated_at"), bool
    ):
        view["updated_at"] = sanitized["updated_at"]
    return view


def _escape_like(value: str) -> str:
    return value.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


def _quota_members(settings: Mapping[str, object]) -> Mapping[str, object]:
    raw = _quota_settings(settings).get("members")
    return raw if isinstance(raw, Mapping) else {}


def _mutable_quota_settings(settings: dict[str, object]) -> dict[str, object]:
    raw = settings.get("quota")
    if not isinstance(raw, dict):
        raw = {}
        settings["quota"] = raw
    return cast(dict[str, object], raw)


def _mutable_gui_feature_settings(settings: dict[str, object]) -> dict[str, object]:
    raw = settings.get("gui_features")
    if not isinstance(raw, dict):
        raw = {}
        settings["gui_features"] = raw
    return cast(dict[str, object], raw)


def _mutable_quota_members(settings: dict[str, object]) -> dict[str, object]:
    raw = _mutable_quota_settings(settings)
    members = raw.get("members")
    if not isinstance(members, dict):
        members = {}
        raw["members"] = members
    return cast(dict[str, object], members)


def _quota_state_from_mapping(
    raw: Mapping[str, object],
    *,
    configured: bool,
) -> dict[str, object]:
    state: dict[str, object] = {
        "configured": configured,
        "enabled": _setting_bool(raw.get("enabled"), default=True),
    }
    for key in ("soft_run_limit", "soft_token_limit"):
        value = raw.get(key)
        if isinstance(value, int) and not isinstance(value, bool) and value >= 0:
            state[key] = value
    cost = raw.get("soft_cost_usd")
    if isinstance(cost, int | float) and not isinstance(cost, bool) and cost >= 0:
        state["soft_cost_usd"] = float(cost)
    updated_at = raw.get("updated_at")
    if isinstance(updated_at, int) and not isinstance(updated_at, bool):
        state["updated_at"] = updated_at
    return state


def _notification_routing_state_from_mapping(
    raw: Mapping[str, object],
    *,
    configured: bool,
) -> dict[str, object]:
    sanitized = _sanitize_audit_mapping(raw)
    state: dict[str, object] = {
        "configured": configured,
        "enabled": _setting_bool(sanitized.get("enabled"), default=False),
        "dry_run": _setting_bool(sanitized.get("dry_run"), default=True),
        "rules": [],
    }
    rules = sanitized.get("rules")
    if isinstance(rules, list):
        state["rules"] = [rule for rule in rules if isinstance(rule, Mapping)]
    return state


def _mutable_autopickup_settings(settings: dict[str, object]) -> dict[str, object]:
    raw = settings.get("autopickup")
    if not isinstance(raw, dict):
        raw = {}
        settings["autopickup"] = raw
    return cast(dict[str, object], raw)


def _mutable_autopickup_nodes(settings: dict[str, object]) -> dict[str, object]:
    raw = _mutable_autopickup_settings(settings)
    nodes = raw.get("nodes")
    if not isinstance(nodes, dict):
        nodes = {}
        raw["nodes"] = nodes
    return cast(dict[str, object], nodes)


def _mutable_execution_settings(settings: dict[str, object]) -> dict[str, object]:
    raw = settings.get("execution")
    if not isinstance(raw, dict):
        raw = {}
        settings["execution"] = raw
    return cast(dict[str, object], raw)


def _mutable_execution_nodes(settings: dict[str, object]) -> dict[str, object]:
    raw = _mutable_execution_settings(settings)
    nodes = raw.get("nodes")
    if not isinstance(nodes, dict):
        nodes = {}
        raw["nodes"] = nodes
    return cast(dict[str, object], nodes)


def _mutable_execution_tasks(settings: dict[str, object]) -> dict[str, object]:
    raw = _mutable_execution_settings(settings)
    tasks = raw.get("tasks")
    if not isinstance(tasks, dict):
        tasks = {}
        raw["tasks"] = tasks
    return cast(dict[str, object], tasks)


def _guarded_dispatch_blockers_from_settings(
    *,
    settings: Mapping[str, object],
    node: str,
    task_id: str,
    task_execution: Mapping[str, object],
) -> list[str]:
    return [
        *_execution_blockers_from_settings(
            settings=settings,
            node=node,
            task_id=task_id,
            task_execution=task_execution,
        ),
        *_autopickup_blockers_from_settings(settings=settings, node=node),
    ]


def _execution_blockers_from_settings(
    *,
    settings: Mapping[str, object],
    node: str,
    task_id: str,
    task_execution: Mapping[str, object],
) -> list[str]:
    raw = _execution_settings(settings)
    node_raw = _execution_nodes(settings).get(node)
    node_state = node_raw if isinstance(node_raw, Mapping) else {}
    task_raw = _execution_tasks(settings).get(task_id)
    task_setting = task_raw if isinstance(task_raw, Mapping) else {}
    blocked_by: list[str] = []
    if not _setting_bool(raw.get("enabled"), default=False):
        blocked_by.append("global-disabled")
    if _setting_bool(raw.get("kill_switch"), default=False):
        blocked_by.append("global-kill-switch")
    if not _setting_bool(raw.get("board_enabled"), default=True):
        blocked_by.append("board-disabled")
    if _setting_bool(raw.get("board_kill_switch"), default=False):
        blocked_by.append("board-kill-switch")
    if not _setting_bool(node_state.get("enabled"), default=False):
        blocked_by.append("node-disabled")
    if _setting_bool(node_state.get("kill_switch"), default=False):
        blocked_by.append("node-kill-switch")
    task_kill = _setting_bool(task_setting.get("kill_switch"), default=False) or _setting_bool(
        task_execution.get("kill_switch"),
        default=False,
    )
    if task_kill:
        blocked_by.append("task-kill-switch")
    return blocked_by


def _autopickup_blockers_from_settings(
    *,
    settings: Mapping[str, object],
    node: str,
) -> list[str]:
    raw = _autopickup_settings(settings)
    nodes = _autopickup_nodes(settings)
    node_raw = nodes.get(node)
    node_state = node_raw if isinstance(node_raw, Mapping) else {}
    blocked_by: list[str] = []
    if not _setting_bool(raw.get("enabled"), default=True):
        blocked_by.append("autopickup-global-disabled")
    if _setting_bool(raw.get("kill_switch"), default=False):
        blocked_by.append("autopickup-global-kill-switch")
    if node_state.get("enabled") is not True:
        blocked_by.append("autopickup-node-disabled")
    return blocked_by


def _task_execution(metadata: Mapping[str, object]) -> Mapping[str, object]:
    raw = metadata.get("execution")
    return raw if isinstance(raw, Mapping) else {}


def _mutable_task_execution(metadata: dict[str, object]) -> dict[str, object]:
    raw = metadata.get("execution")
    if not isinstance(raw, dict):
        raw = {}
        metadata["execution"] = raw
    return cast(dict[str, object], raw)


def _metadata_preserving_execution(
    row: sqlite3.Row,
    metadata: Mapping[str, object],
    *,
    state: str | None,
    now: int,
) -> dict[str, object]:
    final_metadata = dict(metadata)
    existing = _json_dict(row["metadata_json"])
    execution = _task_execution(existing)
    if execution and "execution" not in final_metadata:
        execution_copy = dict(execution)
        if state is not None:
            execution_copy["state"] = state
        execution_copy["updated_at"] = now
        final_metadata["execution"] = execution_copy
    return final_metadata


def _released_execution_metadata(
    row: sqlite3.Row,
    *,
    run_id: str | None,
    now: int,
) -> dict[str, object]:
    metadata = _json_dict(row["metadata_json"])
    execution = _task_execution(metadata)
    if execution:
        reset = {
            "state": "none",
            "approved": False,
            "run_id": None,
            "released_run_id": run_id,
            "updated_at": now,
        }
        metadata["execution"] = reset
    return metadata


def _gate_blocked_by_kill_switch(blocked_by: list[str]) -> bool:
    return any("kill-switch" in item for item in blocked_by)


def _execution_node_from_metadata(
    execution: Mapping[str, object],
    *,
    fallback: str | None,
) -> str:
    node = execution.get("node")
    if isinstance(node, str) and node.strip():
        return node.strip()
    if fallback is not None and fallback.strip():
        return fallback.strip()
    return "unknown"


def _setting_bool(value: object, *, default: bool) -> bool:
    return value if isinstance(value, bool) else default


def _audit_payload(
    *,
    actor: Mapping[str, object],
    action: str,
    target: Mapping[str, object],
    board: str,
    status: str,
    ts: int,
    summary: str | None = None,
    extra: Mapping[str, object] | None = None,
) -> dict[str, object]:
    payload: dict[str, object] = {
        "actor": _sanitize_audit_mapping(actor),
        "action": action,
        "target": _sanitize_audit_mapping(target),
        "board": board,
        "status": status,
        "ts": ts,
    }
    if summary is not None:
        payload["summary"] = _safe_summary(summary)
    if extra is not None:
        payload.update(_sanitize_audit_mapping(extra))
    return payload


def _safe_summary(value: str) -> str:
    redacted = _safe_text(value.replace("\r", "\n"))
    first_line = next((line.strip() for line in redacted.splitlines() if line.strip()), "")
    return first_line[:500]


def _safe_text(value: str) -> str:
    redacted = redact_secret_text(value)
    without_paths = ABSOLUTE_PATH_RE.sub("[path]", redacted)
    return EMAIL_RE.sub("[pii]", without_paths)


def _required_public_text(value: object, *, field: str) -> str:
    clean = _safe_text(str(value).strip())
    if not clean:
        raise ValueError(f"{field} is required")
    return clean[:500]


def _optional_public_text(value: object | None) -> str | None:
    if value is None:
        return None
    clean = _safe_text(str(value).strip())
    return clean[:2000] if clean else None


def _decision_voter(value: str) -> str:
    clean = value.strip().lower()
    if clean not in DECISION_VOTERS:
        raise ValueError("decision voter is invalid")
    return clean


def _decision_status_for_votes(votes: list[DecisionVote]) -> str:
    approvals = sum(1 for vote in votes if vote.approve)
    rejections = sum(1 for vote in votes if not vote.approve)
    if approvals >= DECISION_QUORUM:
        return "approved"
    if rejections >= DECISION_QUORUM:
        return "rejected"
    return "pending"


def _idempotency_key_hash(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def _manual_transition_history(metadata: Mapping[str, object]) -> dict[str, Mapping[str, object]]:
    raw = metadata.get("manual_transitions")
    if not isinstance(raw, Mapping):
        return {}
    return {
        key: value
        for key, value in raw.items()
        if isinstance(key, str) and isinstance(value, Mapping)
    }


def _sanitize_audit_mapping(value: Mapping[str, object]) -> dict[str, object]:
    sanitized = _sanitize_audit_value(dict(value))
    return cast(dict[str, object], sanitized)


def _sanitize_audit_value(value: object) -> object:
    if isinstance(value, str):
        return _safe_text(value)
    if isinstance(value, Mapping):
        return {
            _safe_text(key) if isinstance(key, str) else str(key): _sanitize_audit_value(item)
            for key, item in value.items()
        }
    if isinstance(value, (list, tuple)):
        return [_sanitize_audit_value(item) for item in value]
    if value is None or isinstance(value, (bool, int, float)):
        return value
    return _safe_text(str(value))


def _json(value: Mapping[str, object]) -> str:
    return json.dumps(dict(value), sort_keys=True, separators=(",", ":"))


def _json_dict(value: object) -> dict[str, object]:
    if not isinstance(value, str) or not value:
        return {}
    parsed = json.loads(value)
    if not isinstance(parsed, dict):
        return {}
    return cast(dict[str, object], parsed)


def _row_str(row: sqlite3.Row, key: str) -> str:
    value = row[key]
    if not isinstance(value, str):
        raise TypeError(f"{key} must be a string")
    return value


def _row_optional_str(row: sqlite3.Row, key: str) -> str | None:
    value = row[key]
    if value is None or isinstance(value, str):
        return value
    raise TypeError(f"{key} must be a string or null")


def _row_int(row: sqlite3.Row, key: str) -> int:
    value = row[key]
    if not isinstance(value, int):
        raise TypeError(f"{key} must be an integer")
    return value


def _row_optional_int(row: sqlite3.Row, key: str) -> int | None:
    value = row[key]
    if value is None or isinstance(value, int):
        return value
    raise TypeError(f"{key} must be an integer or null")


def _task_from_row(row: sqlite3.Row) -> Task:
    return Task(
        id=_row_str(row, "id"),
        board_id=_row_str(row, "board_id"),
        title=_row_str(row, "title"),
        body=_row_optional_str(row, "body"),
        assignee=_row_optional_str(row, "assignee"),
        reviewer=_row_optional_str(row, "reviewer"),
        status=_row_str(row, "status"),
        priority=_row_int(row, "priority"),
        workspace_kind=_row_str(row, "workspace_kind"),
        workspace_path=_row_optional_str(row, "workspace_path"),
        branch_name=_row_optional_str(row, "branch_name"),
        claim_lock=_row_optional_str(row, "claim_lock"),
        claim_expires=_row_optional_int(row, "claim_expires"),
        current_run_id=_row_optional_str(row, "current_run_id"),
        last_heartbeat_at=_row_optional_int(row, "last_heartbeat_at"),
        result=_row_optional_str(row, "result"),
        metadata=_json_dict(row["metadata_json"]),
        created_by=_row_optional_str(row, "created_by"),
        created_at=_row_int(row, "created_at"),
        updated_at=_row_int(row, "updated_at"),
    )


def _board_from_row(row: sqlite3.Row) -> Board:
    return Board(
        id=_row_str(row, "slug"),
        slug=_row_str(row, "slug"),
        title=_row_str(row, "title"),
        state=_row_str(row, "state"),
        settings=_json_dict(row["settings_json"]),
        created_at=_row_int(row, "created_at"),
        updated_at=_row_int(row, "updated_at"),
        task_count=_row_int(row, "task_count"),
    )


def _run_from_row(row: sqlite3.Row) -> Run:
    return Run(
        id=_row_str(row, "id"),
        board_id=_row_str(row, "board_id"),
        task_id=_row_str(row, "task_id"),
        node_id=_row_str(row, "node_id"),
        status=_row_str(row, "status"),
        claim_lock=_row_str(row, "claim_lock"),
        claim_expires=_row_int(row, "claim_expires"),
        started_at=_row_int(row, "started_at"),
        last_heartbeat_at=_row_optional_int(row, "last_heartbeat_at"),
        ended_at=_row_optional_int(row, "ended_at"),
        outcome=_row_optional_str(row, "outcome"),
        summary=_row_optional_str(row, "summary"),
        metadata=_json_dict(row["metadata_json"]),
        error=_row_optional_str(row, "error"),
    )


def _event_from_row(row: sqlite3.Row) -> BoardEvent:
    return BoardEvent(
        cursor=_row_int(row, "cursor"),
        id=_row_str(row, "id"),
        board_id=_row_str(row, "board_id"),
        task_id=_row_optional_str(row, "task_id"),
        run_id=_row_optional_str(row, "run_id"),
        kind=_row_str(row, "kind"),
        payload=_json_dict(row["payload_json"]),
        created_at=_row_int(row, "ts"),
    )


def _comment_from_row(row: sqlite3.Row) -> Comment:
    return Comment(
        id=_row_str(row, "id"),
        board_id=_row_str(row, "board_id"),
        task_id=_row_str(row, "task_id"),
        author=_row_str(row, "author"),
        body=_row_str(row, "body"),
        metadata=_json_dict(row["metadata_json"]),
        created_at=_row_int(row, "ts"),
    )


def _notify_sub_from_row(row: sqlite3.Row) -> NotifySub:
    return NotifySub(
        board_id=_row_str(row, "board_id"),
        task_id=_row_str(row, "task_id"),
        channel_kind=_row_str(row, "channel_kind"),
        room_id=_row_str(row, "room_id"),
        thread_id=_row_str(row, "thread_id"),
        user_id=_row_optional_str(row, "user_id"),
        last_event_id=_row_optional_str(row, "last_event_id"),
        created_at=_row_int(row, "ts"),
    )


def _node_health_from_row(row: sqlite3.Row) -> NodeHealth:
    return NodeHealth(
        project=_row_str(row, "project"),
        session=_row_str(row, "session"),
        node=_row_str(row, "node"),
        status=_row_str(row, "status"),
        reason=_row_optional_str(row, "reason"),
        message=_row_optional_str(row, "message"),
        detected_at=_row_int(row, "detected_at"),
        reset_at=_row_optional_int(row, "reset_at"),
        source=_row_str(row, "source"),
        updated_at=_row_int(row, "updated_at"),
    )


def _decision_proposal_from_row(row: sqlite3.Row) -> DecisionProposal:
    return DecisionProposal(
        id=_row_str(row, "id"),
        board_id=_row_str(row, "board_id"),
        proposer=_row_str(row, "proposer"),
        title=_row_str(row, "title"),
        body=_row_optional_str(row, "body"),
        target_assignee=_row_optional_str(row, "target_assignee"),
        reviewer=_row_optional_str(row, "reviewer"),
        status=_row_str(row, "status"),
        metadata=_json_dict(row["metadata_json"]),
        created_at=_row_int(row, "created_at"),
        updated_at=_row_int(row, "updated_at"),
    )


def _decision_vote_from_row(row: sqlite3.Row) -> DecisionVote:
    return DecisionVote(
        proposal_id=_row_str(row, "proposal_id"),
        voter=_row_str(row, "voter"),
        approve=bool(_row_int(row, "approve")),
        reason=_row_optional_str(row, "reason"),
        created_at=_row_int(row, "created_at"),
        updated_at=_row_int(row, "updated_at"),
    )


def _decision_dispatch_from_row(row: sqlite3.Row) -> DecisionDispatchLock:
    return DecisionDispatchLock(
        proposal_id=_row_str(row, "proposal_id"),
        idempotency_key_hash=_row_str(row, "idempotency_key_hash"),
        task_id=_row_str(row, "task_id"),
        created_at=_row_int(row, "created_at"),
    )


def _slack_thread_from_row(row: sqlite3.Row) -> SlackThread:
    return SlackThread(
        board_id=_row_str(row, "board_id"),
        task_id=_row_optional_str(row, "task_id"),
        team_id=_row_str(row, "team_id"),
        channel_id=_row_str(row, "channel_id"),
        thread_ts=_row_str(row, "thread_ts"),
        mode=_row_str(row, "mode"),
        node=_row_optional_str(row, "node"),
        created_at=_row_int(row, "created_at"),
        updated_at=_row_int(row, "updated_at"),
    )
