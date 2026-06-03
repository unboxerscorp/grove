"""grove-viewer dashboard plugin backend API.

Mounted by Legacy under ``/api/plugins/grove-viewer``. HTTP routes inherit the
dashboard plugin auth middleware. The WebSocket route explicitly delegates to
Legacy' ticket-aware ``_ws_auth_ok`` helper because browser WS upgrades do not
carry the HTTP bearer header.
"""

from __future__ import annotations

import asyncio
import importlib
import json
import os
import re
import subprocess
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol, cast, runtime_checkable
from urllib.parse import quote

from fastapi import APIRouter, HTTPException, Query, WebSocket, WebSocketDisconnect, status
from pydantic import BaseModel, Field

router = APIRouter()

DEFAULT_GROVE_SESSION = "dev10"
DEFAULT_BOARD = "default"
POLL_INTERVAL_SECONDS = 1.0
TMUX_TIMEOUT_SECONDS = 5.0
TMUX_PANE_RE = re.compile(r"^[A-Za-z0-9_.-]+:[A-Za-z0-9_.-]+(?:\.[0-9]+)?$")
LEAD_LIKE_PANE_RE = re.compile(r"^[A-Za-z0-9_.-]+:(?:0|[A-Za-z0-9_.-]+\.0)$")
BOARD_COLUMNS = (
    "triage",
    "todo",
    "scheduled",
    "ready",
    "running",
    "blocked",
    "review",
    "done",
)
BOARD_LABELS = {
    "triage": "Triage",
    "todo": "Todo",
    "scheduled": "Scheduled",
    "ready": "Ready",
    "running": "Running",
    "blocked": "Blocked",
    "review": "Review",
    "done": "Done",
}


class KanbanTask(Protocol):
    id: str
    title: str
    status: str


class KanbanDb(Protocol):
    def init_db(self, *, board: str | None = None) -> None: ...

    def connect(self, *, board: str | None = None) -> object: ...

    def list_tasks(
        self,
        conn: object,
        *,
        include_archived: bool = False,
        limit: int | None = None,
        order_by: str | None = None,
    ) -> list[KanbanTask]: ...


@runtime_checkable
class Closeable(Protocol):
    def close(self) -> None: ...


@dataclass(frozen=True)
class GroveNode:
    name: str
    agent: str
    tmux_pane: str
    session_id: str
    status: str

    def as_payload(self) -> dict[str, str]:
        return {
            "name": self.name,
            "agent": self.agent,
            "tmux_pane": self.tmux_pane,
            "session_id": self.session_id,
            "status": self.status,
        }


class SendPayload(BaseModel):
    pane: str = Field(min_length=1, max_length=128)
    data: str = Field(max_length=20_000)


@router.get("/nodes")
def list_nodes() -> list[dict[str, str]]:
    """Return the exposed grove node roster from the configured registry."""

    return [node.as_payload() for node in _registry_nodes()]


@router.get("/board-summary")
def board_summary() -> dict[str, object]:
    """Return a compact Legacy kanban summary for the configured board."""

    board = _configured_board()
    db = _kanban_db_module()
    try:
        db.init_db(board=board)
        conn = db.connect(board=board)
    except Exception as exc:
        raise HTTPException(status_code=500, detail="failed to open kanban board") from exc

    try:
        tasks = db.list_tasks(conn, include_archived=False)
        recent_tasks = db.list_tasks(
            conn,
            include_archived=False,
            limit=6,
            order_by="updated",
        )
    finally:
        if isinstance(conn, Closeable):
            conn.close()

    counts = {key: 0 for key in BOARD_COLUMNS}
    for task in tasks:
        if task.status in counts:
            counts[task.status] += 1

    return {
        "board": board,
        "url": f"/kanban?board={quote(board)}",
        "columns": [
            {"key": key, "label": BOARD_LABELS[key], "count": counts[key]} for key in BOARD_COLUMNS
        ],
        "recent": [
            {"id": task.id, "title": task.title, "status": task.status} for task in recent_tasks
        ],
    }


@router.websocket("/term")
async def term(
    websocket: WebSocket,
    pane: str = Query(...),
    ticket: str | None = Query(None),
) -> None:
    """Stream captured tmux pane text as raw text WebSocket frames."""

    _ = ticket
    if not _ws_auth_ok(websocket):
        await websocket.close(code=4401)
        return
    if not _pane_allowed(pane):
        await websocket.close(code=status.WS_1008_POLICY_VIOLATION)
        return

    await websocket.accept()
    try:
        while True:
            frame = await asyncio.to_thread(_tmux_capture, pane)
            await websocket.send_text(frame)
            await asyncio.sleep(POLL_INTERVAL_SECONDS)
    except WebSocketDisconnect:
        return
    except Exception:
        await websocket.close(code=status.WS_1011_INTERNAL_ERROR)


@router.post("/send")
async def send(payload: SendPayload) -> dict[str, bool]:
    """Forward literal input to an allowlisted tmux pane."""

    if not _pane_allowed(payload.pane):
        raise HTTPException(status_code=403, detail="pane is not exposed by grove-viewer")
    await asyncio.to_thread(_tmux_send, payload.pane, payload.data)
    return {"ok": True}


def _configured_session() -> str:
    configured = os.environ.get("GROVE_VIEWER_SESSION", DEFAULT_GROVE_SESSION).strip()
    return configured or DEFAULT_GROVE_SESSION


def _configured_board() -> str:
    return os.environ.get("GROVE_VIEWER_BOARD", DEFAULT_BOARD).strip() or DEFAULT_BOARD


def _grove_home() -> Path:
    return Path(os.environ.get("GROVE_HOME", "~/.grove")).expanduser()


def _registry_path() -> Path:
    return _grove_home() / _configured_session() / "registry.json"


def _load_registry() -> Mapping[str, object]:
    path = _registry_path()
    if not path.exists():
        return {"session": _configured_session(), "nodes": {}}
    try:
        loaded = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise HTTPException(status_code=500, detail="invalid grove registry") from exc
    if not isinstance(loaded, dict):
        raise HTTPException(status_code=500, detail="invalid grove registry")
    return cast(Mapping[str, object], loaded)


def _registry_nodes() -> list[GroveNode]:
    registry = _load_registry()
    raw_nodes = registry.get("nodes")
    if not isinstance(raw_nodes, dict):
        return []

    nodes: list[GroveNode] = []
    for key, raw_node in raw_nodes.items():
        if not isinstance(key, str) or not isinstance(raw_node, dict):
            continue
        node = cast(Mapping[str, object], raw_node)
        name = _node_name(key, node)
        if name is None:
            continue
        pane = _explicit_node_pane(node)
        if pane is None or not _valid_exposed_tmux_pane(pane):
            continue
        nodes.append(
            GroveNode(
                name=name,
                agent=_mapping_string(node, "agent") or "unknown",
                tmux_pane=pane,
                session_id=_node_session_id(node),
                status=_node_status(node),
            )
        )
    return sorted(nodes, key=lambda node: node.name)


def _node_name(key: str, node: Mapping[str, object]) -> str | None:
    name = _mapping_string(node, "name") or key
    return name if re.fullmatch(r"[A-Za-z0-9_.-]+", name) else None


def _explicit_node_pane(node: Mapping[str, object]) -> str | None:
    return _mapping_string(node, "tmux_pane")


def _node_session_id(node: Mapping[str, object]) -> str:
    return _mapping_string(node, "session_id") or _mapping_string(node, "sessionId") or ""


def _node_status(node: Mapping[str, object]) -> str:
    explicit = _mapping_string(node, "status")
    if explicit is not None:
        return explicit
    if node.get("error") is not None:
        return "error"
    if isinstance(node.get("pending"), Mapping):
        return "running"
    return "idle"


def _mapping_string(mapping: Mapping[str, object], key: str) -> str | None:
    value = mapping.get(key)
    if not isinstance(value, str):
        return None
    stripped = value.strip()
    return stripped or None


def _valid_tmux_pane(pane: str) -> bool:
    return bool(TMUX_PANE_RE.fullmatch(pane))


def _valid_exposed_tmux_pane(pane: str) -> bool:
    return _valid_tmux_pane(pane) and not LEAD_LIKE_PANE_RE.fullmatch(pane)


def _allowed_panes() -> set[str]:
    return {node.tmux_pane for node in _registry_nodes()}


def _pane_allowed(pane: str) -> bool:
    return _valid_exposed_tmux_pane(pane) and pane in _allowed_panes()


def _ws_auth_ok(websocket: WebSocket) -> bool:
    """Delegate WS ticket validation to the Legacy dashboard runtime."""

    try:
        web_server = importlib.import_module("legacy_cli.web_server")
    except Exception:
        return False
    checker = getattr(web_server, "_ws_auth_ok", None)
    return bool(checker(websocket)) if callable(checker) else False


def _kanban_db_module() -> KanbanDb:
    return cast(KanbanDb, importlib.import_module("legacy_cli.kanban_db"))


def _tmux_capture(pane: str) -> str:
    proc = subprocess.run(
        ["tmux", "capture-pane", "-t", pane, "-p"],
        capture_output=True,
        text=True,
        timeout=TMUX_TIMEOUT_SECONDS,
        check=False,
    )
    if proc.returncode != 0:
        raise RuntimeError(proc.stderr.strip() or "tmux capture-pane failed")
    return proc.stdout


def _tmux_send(pane: str, data: str) -> None:
    proc = subprocess.run(
        ["tmux", "send-keys", "-t", pane, "-l", "--", data],
        capture_output=True,
        text=True,
        timeout=TMUX_TIMEOUT_SECONDS,
        check=False,
    )
    if proc.returncode != 0:
        raise RuntimeError(proc.stderr.strip() or "tmux send-keys failed")
