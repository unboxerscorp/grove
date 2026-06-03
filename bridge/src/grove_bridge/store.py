"""Grove-native sqlite board store."""

from __future__ import annotations

import json
import re
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
SQLITE_BUSY_TIMEOUT_MS = 5_000
ABSOLUTE_PATH_RE = re.compile(r"(?<![A-Za-z0-9_./-])/(?!/)[^\s'\"()<>]+")


@dataclass(frozen=True)
class Task:
    id: str
    board_id: str
    title: str
    body: str | None
    assignee: str | None
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
class BoardEvent:
    cursor: int
    id: str
    board_id: str
    task_id: str | None
    run_id: str | None
    kind: str
    payload: dict[str, object]
    created_at: int


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
                    id, board_id, title, body, assignee, status, priority,
                    workspace_kind, workspace_path, branch_name, metadata_json,
                    created_by, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    task_id,
                    board_id,
                    title,
                    body,
                    assignee,
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
                (_clean(result), _json(metadata), now, board_id, task_id, run_id, claim_lock),
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
                (now, _clean(summary), _json(metadata), board_id, run_id, task_id, claim_lock),
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
                WHERE board_id = ? AND id = ? AND status = 'blocked'
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

    def list_events_after(self, *, cursor: int = 0, limit: int = 100) -> list[BoardEvent]:
        with self._connect() as conn:
            rows = conn.execute(
                """
                SELECT rowid AS cursor, * FROM events
                WHERE rowid > ?
                ORDER BY rowid ASC
                LIMIT ?
                """,
                (cursor, limit),
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
            SELECT id, current_run_id, claim_lock FROM tasks
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
                conn.execute(
                    """
                    UPDATE tasks
                    SET status = 'ready',
                        claim_lock = NULL,
                        claim_expires = NULL,
                        current_run_id = NULL,
                        updated_at = ?
                    WHERE board_id = ? AND id = ?
                    """,
                    (ts, board_id, task_id),
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
            """
        )

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


def _new_id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex}"


def _now() -> int:
    return int(time.time())


def _clean(value: str) -> str:
    return value


def _node_actor(node_id: str) -> dict[str, object]:
    return {"kind": "node", "id": node_id, "login": node_id, "role": "none"}


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
    return ABSOLUTE_PATH_RE.sub("[path]", redacted)


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
