"""Legacy kanban import and typing boundary."""

from __future__ import annotations

import importlib
import sys
from collections.abc import Iterable
from pathlib import Path
from typing import Protocol


class KanbanTask(Protocol):
    id: str
    title: str
    body: str | None
    assignee: str | None
    status: str
    workspace_kind: str
    workspace_path: str | None
    claim_lock: str | None
    claim_expires: int | None
    current_run_id: int | None


class KanbanDbProtocol(Protocol):
    def connect(self, *, board: str | None = None) -> object: ...

    def list_tasks(
        self,
        conn: object,
        *,
        assignee: str | None = None,
        status: str | None = None,
        limit: int | None = None,
    ) -> list[KanbanTask]: ...

    def claim_task(
        self,
        conn: object,
        task_id: str,
        *,
        ttl_seconds: int | None = None,
        claimer: str | None = None,
    ) -> KanbanTask | None: ...

    def heartbeat_claim(
        self,
        conn: object,
        task_id: str,
        *,
        ttl_seconds: int | None = None,
        claimer: str | None = None,
    ) -> bool: ...

    def heartbeat_worker(
        self,
        conn: object,
        task_id: str,
        *,
        note: str | None = None,
        expected_run_id: int | None = None,
    ) -> bool: ...

    def complete_task(
        self,
        conn: object,
        task_id: str,
        *,
        result: str | None = None,
        summary: str | None = None,
        metadata: dict[str, object] | None = None,
        created_cards: Iterable[str] | None = None,
        expected_run_id: int | None = None,
    ) -> bool: ...

    def add_comment(self, conn: object, task_id: str, author: str, body: str) -> int: ...

    def block_task(
        self,
        conn: object,
        task_id: str,
        *,
        reason: str | None = None,
        expected_run_id: int | None = None,
    ) -> bool: ...

    def release_stale_claims(self, conn: object) -> int: ...


def load_kanban_db(extra_path: str | Path | None = None) -> KanbanDbProtocol:
    """Import ``legacy_cli.kanban_db``, falling back to ``~/.legacy/legacy-agent``."""

    try:
        return _import_kanban_db()
    except ModuleNotFoundError as first_error:
        fallback = (
            Path(extra_path).expanduser() if extra_path is not None else _default_agent_path()
        )
        if fallback.exists():
            sys.path.insert(0, str(fallback))
            try:
                return _import_kanban_db()
            except ModuleNotFoundError:
                pass
        raise ModuleNotFoundError(
            "could not import legacy_cli.kanban_db; set PYTHONPATH or install Legacy agent"
        ) from first_error


def _import_kanban_db() -> KanbanDbProtocol:
    return importlib.import_module("legacy_cli.kanban_db")


def _default_agent_path() -> Path:
    return Path.home() / ".legacy" / "legacy-agent"
