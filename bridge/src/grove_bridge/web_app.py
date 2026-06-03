"""Grove dev-room web server."""

from __future__ import annotations

import argparse
import asyncio
import base64
import json
import os
import re
import secrets
import subprocess
import time
from collections.abc import Mapping
from dataclasses import dataclass, field
from pathlib import Path
from typing import cast
from urllib.parse import unquote

from fastapi import FastAPI, HTTPException, Query, Request, WebSocket, status
from fastapi.responses import FileResponse, HTMLResponse, Response
from pydantic import BaseModel, Field

from grove_bridge.config import default_board_db_path
from grove_bridge.store import Board, BoardEvent, Comment, Run, SQLiteBoardStore, Task

SESSION_HEADER = "X-Grove-Session-Token"
DEFAULT_SESSION = "dev10"
TICKET_TTL_SECONDS = 30
POLL_INTERVAL_SECONDS = 1.0
TMUX_TIMEOUT_SECONDS = 5.0
TMUX_PANE_RE = re.compile(r"^(?P<session>[A-Za-z0-9_.-]+):(?P<window>[0-9]+)\.(?P<pane>[0-9]+)$")
STATIC_SUFFIXES = {
    ".css",
    ".gif",
    ".ico",
    ".js",
    ".jpg",
    ".jpeg",
    ".map",
    ".png",
    ".svg",
    ".wasm",
    ".woff",
    ".woff2",
}


@dataclass(frozen=True)
class WebAppConfig:
    dist_dir: Path = field(default_factory=lambda: _repo_root() / "web" / "dist")
    grove_home: Path = field(default_factory=lambda: Path("~/.grove").expanduser())
    registry_session: str = DEFAULT_SESSION
    board_db_path: Path = field(default_factory=default_board_db_path)
    token: str = field(default_factory=lambda: secrets.token_urlsafe(32))
    auth_required: bool = True
    host: str = "127.0.0.1"
    port: int = 8765

    def __post_init__(self) -> None:
        object.__setattr__(self, "dist_dir", self.dist_dir.expanduser())
        object.__setattr__(self, "grove_home", self.grove_home.expanduser())
        object.__setattr__(self, "board_db_path", self.board_db_path.expanduser())
        session = self.registry_session.strip() or DEFAULT_SESSION
        object.__setattr__(self, "registry_session", session)
        if not self.token:
            raise ValueError("session token is required")
        if self.port <= 0:
            raise ValueError("port must be positive")


class CommentPayload(BaseModel):
    author: str = Field(default="dev-room", min_length=1, max_length=200)
    body: str = Field(min_length=1, max_length=20_000)


class TicketStore:
    def __init__(self) -> None:
        self._tickets: dict[str, float] = {}

    def issue(self, *, ttl_seconds: int = TICKET_TTL_SECONDS) -> str:
        ticket = secrets.token_urlsafe(24)
        self._tickets[ticket] = time.time() + ttl_seconds
        return ticket

    def consume(self, ticket: str) -> bool:
        expires_at = self._tickets.pop(ticket, None)
        return expires_at is not None and expires_at >= time.time()


def create_app(
    *,
    config: WebAppConfig | None = None,
    store: SQLiteBoardStore | None = None,
) -> FastAPI:
    app_config = config or WebAppConfig(
        grove_home=Path(os.environ.get("GROVE_HOME", "~/.grove")).expanduser(),
        registry_session=os.environ.get("GROVE_VIEWER_SESSION", DEFAULT_SESSION),
    )
    board_store = store or SQLiteBoardStore(app_config.board_db_path)
    app = FastAPI(title="grove dev room")
    app.state.config = app_config
    app.state.store = board_store
    app.state.ticket_store = TicketStore()

    @app.get("/api/status")
    def status_endpoint() -> dict[str, bool]:
        return {"ok": True}

    @app.get("/api/boards")
    def boards_endpoint(request: Request) -> list[dict[str, object]]:
        _require_token(request)
        return [_board_payload(board) for board in _store(request).list_boards()]

    @app.get("/api/boards/{board_id}/tasks")
    def board_tasks_endpoint(
        request: Request,
        board_id: str,
        status_filter: str | None = Query(default=None, alias="status"),
        assignee: str | None = Query(default=None),
    ) -> list[dict[str, object]]:
        _require_token(request)
        try:
            tasks = _store(request).list_tasks(
                board=board_id,
                status=status_filter,
                assignee=assignee,
            )
        except KeyError as exc:
            raise HTTPException(status_code=404, detail="board not found") from exc
        return [_task_payload(task) for task in tasks]

    @app.get("/api/tasks/{task_id}")
    def task_endpoint(request: Request, task_id: str) -> dict[str, object]:
        _require_token(request)
        try:
            return _task_payload(_store(request).get_task_by_id(task_id))
        except KeyError as exc:
            raise HTTPException(status_code=404, detail="task not found") from exc

    @app.get("/api/tasks/{task_id}/comments")
    def comments_endpoint(request: Request, task_id: str) -> list[dict[str, object]]:
        _require_token(request)
        return [
            _comment_payload(comment)
            for comment in _store(request).list_comments_for_task(task_id=task_id)
        ]

    @app.get("/api/tasks/{task_id}/runs")
    def runs_endpoint(request: Request, task_id: str) -> list[dict[str, object]]:
        _require_token(request)
        return [_run_payload(run) for run in _store(request).list_runs_for_task(task_id=task_id)]

    @app.post("/api/tasks/{task_id}/comments")
    def create_comment_endpoint(
        request: Request,
        task_id: str,
        payload: CommentPayload,
    ) -> dict[str, object]:
        _require_token(request)
        try:
            comment = _store(request).add_comment_to_task(
                task_id=task_id,
                author=payload.author,
                body=payload.body,
            )
        except KeyError as exc:
            raise HTTPException(status_code=404, detail="task not found") from exc
        return _comment_payload(comment)

    @app.get("/api/nodes")
    def nodes_endpoint(request: Request) -> list[dict[str, str]]:
        _require_token(request)
        return [_node_payload(node) for node in _registry_nodes(_config(request))]

    @app.post("/api/ws-ticket")
    def ws_ticket_endpoint(request: Request) -> dict[str, object]:
        _require_token(request)
        ticket = _ticket_store(request).issue()
        return {"ticket": ticket, "ttl_seconds": TICKET_TTL_SECONDS}

    @app.websocket("/ws/terminal")
    async def terminal_ws(
        websocket: WebSocket,
        ticket: str = Query(...),
        pane_id: str = Query(...),
    ) -> None:
        if not _consume_ticket(_ticket_store(websocket), ticket):
            await websocket.close(code=4401)
            return
        app_config = _config(websocket)
        if not _pane_allowed(pane_id, config=app_config):
            await websocket.close(code=status.WS_1008_POLICY_VIOLATION)
            return
        await websocket.accept()
        seq = 0
        try:
            while True:
                seq += 1
                payload = await asyncio.to_thread(_tmux_capture, pane_id)
                await websocket.send_json(
                    {
                        "seq": seq,
                        "pane_id": pane_id,
                        "bytes_base64": base64.b64encode(payload).decode("ascii"),
                        "ts": int(time.time()),
                    }
                )
                await asyncio.sleep(POLL_INTERVAL_SECONDS)
        except Exception:
            return

    @app.websocket("/ws/board")
    async def board_ws(
        websocket: WebSocket,
        ticket: str = Query(...),
        cursor: int = Query(0),
    ) -> None:
        if not _consume_ticket(_ticket_store(websocket), ticket):
            await websocket.close(code=4401)
            return
        await websocket.accept()
        current = cursor
        try:
            while True:
                events = _store(websocket).list_events_after(cursor=current, limit=100)
                for event in events:
                    current = event.cursor
                    await websocket.send_json(_event_payload(event))
                await asyncio.sleep(POLL_INTERVAL_SECONDS)
        except Exception:
            return

    @app.get("/", response_model=None)
    def index_endpoint(request: Request) -> HTMLResponse:
        return _index_response(_config(request))

    @app.get("/{path:path}", response_model=None)
    def spa_or_asset_endpoint(request: Request, path: str) -> Response:
        config_value = _config(request)
        if _is_static_asset_path(path):
            asset = _safe_dist_path(config_value.dist_dir, path)
            if asset is not None and asset.is_file():
                return FileResponse(asset)
        return _index_response(config_value)

    return app


def _repo_root() -> Path:
    return Path(__file__).resolve().parents[3]


def _require_token(request: Request) -> None:
    config = _config(request)
    supplied = request.headers.get(SESSION_HEADER)
    if supplied != config.token:
        raise HTTPException(status_code=401, detail="missing or invalid session token")


def _config(source: Request | WebSocket) -> WebAppConfig:
    return cast(WebAppConfig, source.app.state.config)


def _store(source: Request | WebSocket) -> SQLiteBoardStore:
    return cast(SQLiteBoardStore, source.app.state.store)


def _ticket_store(source: Request | WebSocket) -> TicketStore:
    return cast(TicketStore, source.app.state.ticket_store)


def _consume_ticket(ticket_store: TicketStore, ticket: str) -> bool:
    return ticket_store.consume(ticket)


def _index_response(config: WebAppConfig) -> HTMLResponse:
    index_path = config.dist_dir / "index.html"
    if not index_path.is_file():
        raise HTTPException(status_code=500, detail="web distribution not found")
    html = index_path.read_text(encoding="utf-8")
    injected = (
        "<script>"
        f"window.__GROVE_SESSION_TOKEN__ = {json.dumps(config.token)};"
        f"window.__GROVE_AUTH_REQUIRED__ = {json.dumps(config.auth_required)};"
        "</script>"
    )
    if "<head>" in html:
        html = html.replace("<head>", f"<head>{injected}", 1)
    else:
        html = f"{injected}{html}"
    return HTMLResponse(html)


def _is_static_asset_path(path: str) -> bool:
    suffix = Path(path).suffix.lower()
    return suffix in STATIC_SUFFIXES


def _safe_dist_path(dist_dir: Path, raw_path: str) -> Path | None:
    decoded = unquote(raw_path).lstrip("/")
    candidate = (dist_dir / decoded).resolve()
    root = dist_dir.resolve()
    if root == candidate or root in candidate.parents:
        return candidate
    return None


def _registry_path(config: WebAppConfig) -> Path:
    return config.grove_home / config.registry_session / "registry.json"


def _load_registry(config: WebAppConfig) -> dict[str, object]:
    path = _registry_path(config)
    if not path.is_file():
        return {"nodes": {}}
    loaded = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(loaded, dict):
        raise HTTPException(status_code=500, detail="invalid grove registry")
    return loaded


def _registry_nodes(config: WebAppConfig) -> list[dict[str, str]]:
    raw_nodes = _load_registry(config).get("nodes")
    if not isinstance(raw_nodes, dict):
        return []
    nodes: list[dict[str, str]] = []
    for key, raw_node in raw_nodes.items():
        if not isinstance(key, str) or not isinstance(raw_node, dict):
            continue
        node = _string_mapping(raw_node)
        pane = _mapping_string(node, "tmux_pane")
        name = _mapping_string(node, "name") or key
        if pane is None or not _valid_exposed_tmux_pane(pane, config=config):
            continue
        nodes.append(
            {
                "name": name,
                "agent": _mapping_string(node, "agent") or "unknown",
                "tmux_pane": pane,
                "session_id": _mapping_string(node, "session_id")
                or _mapping_string(node, "sessionId")
                or "",
                "status": _node_status(node),
            }
        )
    return sorted(nodes, key=lambda node: node["name"])


def _node_status(node: Mapping[str, object]) -> str:
    explicit = _mapping_string(node, "status")
    if explicit is not None:
        return explicit
    if node.get("error") is not None:
        return "error"
    if isinstance(node.get("pending"), Mapping):
        return "running"
    return "idle"


def _allowed_panes(config: WebAppConfig) -> set[str]:
    return {node["tmux_pane"] for node in _registry_nodes(config)}


def _pane_allowed(pane: str, *, config: WebAppConfig) -> bool:
    return _valid_exposed_tmux_pane(pane, config=config) and pane in _allowed_panes(config)


def _valid_exposed_tmux_pane(pane: str, *, config: WebAppConfig) -> bool:
    parts = _tmux_pane_parts(pane, config=config)
    return parts is not None and parts != (0, 0)


def _tmux_pane_parts(pane: str, *, config: WebAppConfig) -> tuple[int, int] | None:
    match = TMUX_PANE_RE.fullmatch(pane)
    if match is None or match.group("session") != config.registry_session:
        return None
    return int(match.group("window")), int(match.group("pane"))


def _tmux_capture(pane: str) -> bytes:
    proc = subprocess.run(
        ["tmux", "capture-pane", "-t", pane, "-p"],
        capture_output=True,
        timeout=TMUX_TIMEOUT_SECONDS,
        check=False,
    )
    if proc.returncode != 0:
        raise RuntimeError(proc.stderr.decode("utf-8", errors="replace").strip())
    return proc.stdout


def _string_mapping(value: Mapping[object, object]) -> Mapping[str, object]:
    clean: dict[str, object] = {}
    for key, item in value.items():
        if isinstance(key, str):
            clean[key] = item
    return clean


def _mapping_string(mapping: Mapping[str, object], key: str) -> str | None:
    value = mapping.get(key)
    if not isinstance(value, str):
        return None
    stripped = value.strip()
    return stripped or None


def _board_payload(board: Board) -> dict[str, object]:
    return {"id": board.id, "name": board.title, "task_count": board.task_count}


def _task_payload(task: Task) -> dict[str, object]:
    payload: dict[str, object] = {
        "id": task.id,
        "title": task.title,
        "status": task.status,
        "body": task.body,
        "updated": task.updated_at,
    }
    if task.assignee is not None:
        payload["assignee"] = task.assignee
    if task.result is not None:
        payload["latest_summary"] = task.result
    return payload


def _comment_payload(comment: Comment) -> dict[str, object]:
    return {
        "id": comment.id,
        "author": comment.author,
        "body": comment.body,
        "ts": comment.created_at,
    }


def _run_payload(run: Run) -> dict[str, object]:
    payload: dict[str, object] = {
        "id": run.id,
        "status": run.status,
        "started": run.started_at,
    }
    if run.ended_at is not None:
        payload["ended"] = run.ended_at
    if run.summary is not None:
        payload["summary"] = run.summary
    payload["node"] = run.node_id
    return payload


def _node_payload(node: dict[str, str]) -> dict[str, str]:
    return node


def _event_payload(event: BoardEvent) -> dict[str, object]:
    payload: dict[str, object] = {
        "cursor": event.cursor,
        "type": event.kind,
    }
    if event.task_id is not None:
        payload["task_id"] = event.task_id
    return payload


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Run the grove dev-room web server.")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--dist-dir", type=Path, default=_repo_root() / "web" / "dist")
    parser.add_argument("--board-db-path", type=Path, default=default_board_db_path())
    parser.add_argument(
        "--session",
        default=os.environ.get("GROVE_VIEWER_SESSION", DEFAULT_SESSION),
    )
    args = parser.parse_args(argv)

    import uvicorn

    config = WebAppConfig(
        dist_dir=args.dist_dir,
        board_db_path=args.board_db_path,
        grove_home=Path(os.environ.get("GROVE_HOME", "~/.grove")).expanduser(),
        registry_session=args.session,
        host=args.host,
        port=args.port,
    )
    app = create_app(config=config)
    uvicorn.run(app, host=config.host, port=config.port)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
