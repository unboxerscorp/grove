"""Grove dev-room web server."""

from __future__ import annotations

import argparse
import asyncio
import base64
import importlib.metadata
import json
import logging
import os
import re
import secrets
import subprocess
import time
from collections.abc import Awaitable, Callable, Mapping, Sequence
from dataclasses import dataclass, field, replace
from enum import StrEnum
from pathlib import Path
from typing import Annotated, cast
from urllib.parse import unquote, urlparse

from fastapi import Body, FastAPI, HTTPException, Query, Request, WebSocket, status
from fastapi.responses import FileResponse, HTMLResponse, Response
from pydantic import BaseModel, Field

from grove_bridge.auth_status import collect_auth_status, redact_secret_text
from grove_bridge.config import default_board_db_path
from grove_bridge.slack import (
    HUMAN_GATE_MODE,
    HUMAN_GATE_PENDING_MODE,
    SlackConfig,
    SlackConfigStore,
    config_status,
    slack_manifest,
)
from grove_bridge.store import (
    Board,
    BoardEvent,
    Comment,
    NotifySub,
    Run,
    SlackThread,
    SQLiteBoardStore,
    Task,
)
from grove_bridge.team_auth import (
    CSRF_HEADER,
    TEAM_SESSION_COOKIE,
    TEAM_SESSION_TTL_SECONDS,
    IssuedSession,
    MemberRegistry,
    SessionSigner,
    TeamMember,
    TeamSessionStore,
    bootstrap_hint,
    members_path,
    session_secret_path,
)

SESSION_HEADER = "X-Grove-Session-Token"
PROJECT_HEADER = "X-Grove-Project"
DEFAULT_SESSION = "dev10"
LOGGER = logging.getLogger(__name__)
try:
    APP_VERSION = importlib.metadata.version("grove-bridge")
except importlib.metadata.PackageNotFoundError:
    APP_VERSION = "0.0.0"
TICKET_TTL_SECONDS = 30
POLL_INTERVAL_SECONDS = 1.0
TMUX_TIMEOUT_SECONDS = 5.0
GROVE_SPAWN_TIMEOUT_SECONDS = 30.0
GROVE_PROJECT_TIMEOUT_SECONDS = 30.0
TRANSCRIPT_MAX_BYTES = 2_000_000
MAX_TIMESTAMP_SECONDS = 4_102_444_800
TMUX_PANE_RE = re.compile(r"^(?P<session>[A-Za-z0-9_.-]+):(?P<window>[0-9]+)\.(?P<pane>[0-9]+)$")
NODE_NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]*$")
PROJECT_NAME_RE = NODE_NAME_RE
ABSOLUTE_PATH_RE = re.compile(r"(?<![A-Za-z0-9_./-])/(?!/)[^\s'\"()<>]+")
STACK_TRACE_RE = re.compile(r"(?i)(traceback|\bfile \"|\bat .+\(.+:\d+:\d+\))")
NODE_AGENTS = frozenset({"codex", "claude", "antigravity"})
COST_AGENTS = ("codex", "claude", "agy")
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
LOOPBACK_HOSTS = frozenset({"127.0.0.1", "localhost", "::1"})
WILDCARD_BIND_HOSTS = frozenset({"0.0.0.0", "::"})
TICKET_KINDS = frozenset({"board", "terminal"})


class AuthMode(StrEnum):
    LOCAL_TOKEN = "local-token"
    TEAM_COOKIE = "team-cookie"


@dataclass(frozen=True)
class WebAppConfig:
    dist_dir: Path = field(default_factory=lambda: _repo_root() / "web" / "dist")
    grove_home: Path = field(default_factory=lambda: Path("~/.grove").expanduser())
    registry_session: str = DEFAULT_SESSION
    board_db_path: Path = field(default_factory=default_board_db_path)
    token: str = ""
    auth_required: bool = True
    host: str = "127.0.0.1"
    port: int = 8765
    unsafe_bind_token_bootstrap: bool = False
    allowed_hosts: tuple[str, ...] = ()
    auth_mode: AuthMode = AuthMode.LOCAL_TOKEN

    def __post_init__(self) -> None:
        object.__setattr__(self, "dist_dir", self.dist_dir.expanduser())
        object.__setattr__(self, "grove_home", self.grove_home.expanduser())
        object.__setattr__(self, "board_db_path", self.board_db_path.expanduser())
        session = self.registry_session.strip() or DEFAULT_SESSION
        object.__setattr__(self, "registry_session", session)
        token = self.token.strip()
        if not token:
            token = _load_or_create_dashboard_token(self.grove_home, session)
        object.__setattr__(self, "token", token)
        if self.port <= 0:
            raise ValueError("port must be positive")
        object.__setattr__(
            self,
            "allowed_hosts",
            _normalize_allowed_hosts(self.allowed_hosts),
        )
        object.__setattr__(self, "auth_mode", AuthMode(self.auth_mode))


@dataclass(frozen=True)
class ProjectContext:
    config: WebAppConfig
    name: str
    board: str
    from_header: bool


@dataclass(frozen=True)
class AuthContext:
    mode: AuthMode
    sid: str | None = None
    member: TeamMember | None = None
    csrf_token: str | None = None
    expires_at: int | None = None


@dataclass(frozen=True)
class TicketGrant:
    ticket: str
    expires_at: float
    project: ProjectContext
    kind: str
    pane_id: str | None


@dataclass(frozen=True)
class CostUsage:
    input_tokens: int | None
    output_tokens: int | None
    total_tokens: int | None
    cost_usd: float | None
    source: str
    confidence: str
    warnings: tuple[str, ...] = ()


@dataclass(frozen=True)
class CostNodeSnapshot:
    name: str
    agent: str
    turns: int
    usage: CostUsage
    payload: dict[str, object]


class CommentPayload(BaseModel):
    author: str = Field(default="dev-room", min_length=1, max_length=200)
    body: str = Field(min_length=1, max_length=20_000)


class AnswerPayload(BaseModel):
    text: str = Field(min_length=1, max_length=20_000)


class TaskCreatePayload(BaseModel):
    title: str = Field(max_length=500)
    body: str | None = Field(default=None, max_length=20_000)
    assignee: str | None = Field(default=None, max_length=500)
    status: str = Field(default="ready", min_length=1, max_length=100)
    priority: int = 0


class NodeCreatePayload(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    agent: str = Field(min_length=1, max_length=50)
    role: str | None = Field(default=None, max_length=200)
    description: str | None = Field(default=None, max_length=1000)
    parent: str | None = Field(default=None, max_length=100)
    group: str | None = Field(default=None, max_length=100)
    window: int | None = Field(default=None, ge=0)


class NodeUpdatePayload(BaseModel):
    parent: str | None = Field(default=None, max_length=100)
    group: str | None = Field(default=None, max_length=100)
    description: str | None = Field(default=None, max_length=1000)


class ProjectCreatePayload(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    template: str | None = Field(default=None, max_length=200)
    clone: str | None = Field(default=None, max_length=2000)


class ProjectLoadPayload(BaseModel):
    path: str = Field(min_length=1, max_length=5000)


class SlackConfigPayload(BaseModel):
    app_token: str = Field(min_length=1, max_length=5000)
    bot_token: str = Field(min_length=1, max_length=5000)
    default_channel: str | None = Field(default=None, max_length=200)
    default_node: str | None = Field(default=None, max_length=200)


class WsTicketPayload(BaseModel):
    kind: str | None = Field(default=None, max_length=50)
    pane_id: str | None = Field(default=None, max_length=200)


class LoginPayload(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    secret: str = Field(min_length=1, max_length=5000)


class TicketStore:
    def __init__(self) -> None:
        self._tickets: dict[str, TicketGrant] = {}

    def issue(
        self,
        *,
        project: ProjectContext,
        kind: str,
        pane_id: str | None = None,
        ttl_seconds: int = TICKET_TTL_SECONDS,
    ) -> TicketGrant:
        ticket = secrets.token_urlsafe(24)
        grant = TicketGrant(
            ticket=ticket,
            expires_at=time.time() + ttl_seconds,
            project=project,
            kind=kind,
            pane_id=pane_id,
        )
        self._tickets[ticket] = grant
        return grant

    def consume(self, ticket: str) -> TicketGrant | None:
        grant = self._tickets.pop(ticket, None)
        if grant is None or grant.expires_at < time.time():
            return None
        return grant


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
    app.state.team_session_store = TeamSessionStore()
    app.state.started_at = int(time.time())
    _write_web_companion(app_config, started_at=cast(int, app.state.started_at))

    @app.middleware("http")
    async def request_log_middleware(
        request: Request,
        call_next: Callable[[Request], Awaitable[Response]],
    ) -> Response:
        started = time.monotonic()
        try:
            response = await call_next(request)
        except Exception as exc:
            _log_web_request(
                request=request,
                status_code=500,
                started=started,
                error=exc,
            )
            raise
        _log_web_request(request=request, status_code=response.status_code, started=started)
        return response

    @app.get("/api/health")
    def health_endpoint() -> dict[str, object]:
        return _health_payload(app)

    @app.get("/api/me")
    def me_endpoint(request: Request) -> dict[str, object]:
        config_value = _config(request)
        if config_value.auth_mode == AuthMode.LOCAL_TOKEN:
            return {"auth_mode": config_value.auth_mode.value, "member": None}
        auth = _require_auth(request)
        return _me_payload(config_value, auth)

    @app.post("/api/login")
    def login_endpoint(
        request: Request,
        response: Response,
        payload: LoginPayload,
    ) -> dict[str, object]:
        config_value = _config(request)
        if config_value.auth_mode != AuthMode.TEAM_COOKIE:
            raise HTTPException(status_code=404, detail="team auth is not enabled")
        _require_allowed_origin(request)
        registry = _member_registry(config_value)
        member = registry.authenticate(payload.name, payload.secret)
        if member is None:
            raise HTTPException(
                status_code=401,
                detail=_team_auth_unauthorized_detail(config_value),
            )
        issued = _session_signer(config_value).issue(member)
        _team_session_store(request).add(issued)
        _set_team_session_cookie(response, request=request, issued=issued)
        return {
            "auth_mode": config_value.auth_mode.value,
            "member": member.to_payload(),
            "csrf": issued.csrf_token,
            "expires_at": issued.expires_at,
        }

    @app.post("/api/logout")
    def logout_endpoint(request: Request, response: Response) -> dict[str, object]:
        auth = _require_state_change(request)
        if auth.sid is not None:
            _team_session_store(request).revoke(auth.sid)
        response.delete_cookie(TEAM_SESSION_COOKIE)
        return {"ok": True}

    @app.get("/api/csrf")
    def csrf_endpoint(request: Request) -> dict[str, object]:
        config_value = _config(request)
        if config_value.auth_mode == AuthMode.LOCAL_TOKEN:
            return {"auth_mode": config_value.auth_mode.value, "csrf": None}
        auth = _require_auth(request)
        return {"auth_mode": config_value.auth_mode.value, "csrf": auth.csrf_token}

    @app.get("/api/status")
    def status_endpoint(
        request: Request,
        detail: int = Query(default=0),
    ) -> dict[str, object]:
        _require_auth(request)
        project = resolve_project(request)
        payload: dict[str, object] = {
            "ok": True,
            "project": project.name,
            "nodes": _node_liveness_summary(project.config),
        }
        if detail:
            payload["node_details"] = _node_status_details(project.config)
        return payload

    @app.get("/api/audit")
    def audit_endpoint(
        request: Request,
        cursor: int = Query(default=0, ge=0),
        limit: int = Query(default=100, ge=1, le=500),
        action: str | None = Query(default=None),
        node: str | None = Query(default=None),
        task_id: str | None = Query(default=None),
    ) -> dict[str, object]:
        auth = _require_auth(request)
        _require_audit_access(auth)
        project = resolve_project(request)
        events = _store(request).list_audit_events(
            board=project.board,
            cursor=cursor,
            limit=limit,
            action=action,
            node=node,
            task_id=task_id,
        )
        return {
            "items": [
                _audit_event_payload(_store(request), event, project=project) for event in events
            ],
            "next_cursor": events[-1].cursor if events else cursor,
        }

    @app.get("/api/inbox")
    def inbox_endpoint(
        request: Request,
        cursor: int = Query(default=0, ge=0),
        limit: int = Query(default=50, ge=1, le=200),
    ) -> dict[str, object]:
        _require_auth(request)
        project = resolve_project(request)
        return _inbox_payload(_store(request), project=project, cursor=cursor, limit=limit)

    @app.get("/api/cost")
    def cost_endpoint(
        request: Request,
        window: str = Query(default="24h"),
        project_name: str | None = Query(default=None, alias="project"),
        node: str | None = Query(default=None),
        agent: str | None = Query(default=None),
        include: str | None = Query(default=None),
    ) -> dict[str, object]:
        auth = _require_auth(request)
        _require_cost_access(auth)
        project = _cost_project_context(request, project_name)
        return _cost_payload(
            _store(request),
            project=project,
            window=window,
            node_filter=node,
            agent_filter=agent,
            include=include,
        )

    @app.get("/api/auth-status")
    def auth_status_endpoint(request: Request) -> list[dict[str, object]]:
        _require_auth(request)
        return [tool_status.to_payload() for tool_status in collect_auth_status()]

    @app.get("/api/projects")
    def projects_endpoint(request: Request) -> list[dict[str, object]]:
        _require_auth(request)
        return _project_payloads(_config(request))

    @app.post("/api/projects")
    def create_project_endpoint(
        request: Request,
        payload: ProjectCreatePayload,
    ) -> dict[str, object]:
        _require_state_change(request)
        return _create_project(payload)

    @app.post("/api/projects/load")
    def load_project_endpoint(
        request: Request,
        payload: ProjectLoadPayload,
    ) -> dict[str, object]:
        _require_state_change(request)
        return _load_project(payload)

    @app.get("/api/boards")
    def boards_endpoint(request: Request) -> list[dict[str, object]]:
        _require_auth(request)
        project = resolve_project(request)
        boards = _store(request).list_boards()
        if project.from_header:
            boards = [board for board in boards if board.id == project.board]
        return [_board_payload(board) for board in boards]

    @app.get("/api/boards/{board_id}/tasks")
    def board_tasks_endpoint(
        request: Request,
        board_id: str,
        status_filter: str | None = Query(default=None, alias="status"),
        assignee: str | None = Query(default=None),
    ) -> list[dict[str, object]]:
        _require_auth(request)
        project = resolve_project(request)
        resolved_board = _resolve_board_id(board_id, project=project)
        try:
            tasks = _store(request).list_tasks(
                board=resolved_board,
                status=status_filter,
                assignee=assignee,
            )
        except KeyError as exc:
            raise HTTPException(status_code=404, detail="board not found") from exc
        return [_task_payload(task) for task in tasks]

    @app.post("/api/boards/{board_id}/tasks")
    def create_task_endpoint(
        request: Request,
        board_id: str,
        payload: TaskCreatePayload,
    ) -> dict[str, object]:
        auth = _require_state_change(request)
        title = payload.title.strip()
        if not title:
            raise HTTPException(status_code=400, detail="title is required")
        project = resolve_project(request)
        actor = _actor_payload(auth)
        task = _store(request).create_task(
            board=_resolve_board_id(board_id, project=project),
            title=title,
            body=payload.body,
            assignee=payload.assignee,
            status=payload.status,
            priority=payload.priority,
            created_by=_actor_id(actor),
        )
        if task.assignee:
            _store(request).add_audit_event(
                board=_resolve_board_id(board_id, project=project),
                kind="audit.task.assign",
                actor=actor,
                action="assign",
                target={"type": "task", "id": task.id, "node": task.assignee},
                task_id=task.id,
                payload={"project": project.name, "to_node": task.assignee},
                summary=task.title,
            )
        return _task_payload(task)

    @app.get("/api/tasks/{task_id}")
    def task_endpoint(request: Request, task_id: str) -> dict[str, object]:
        _require_auth(request)
        project = resolve_project(request)
        return _task_payload(_task_for_project(_store(request), task_id, project=project))

    @app.get("/api/tasks/{task_id}/comments")
    def comments_endpoint(request: Request, task_id: str) -> list[dict[str, object]]:
        _require_auth(request)
        project = resolve_project(request)
        _task_for_project(_store(request), task_id, project=project)
        return [
            _comment_payload(comment)
            for comment in _store(request).list_comments_for_task(task_id=task_id)
        ]

    @app.get("/api/tasks/{task_id}/runs")
    def runs_endpoint(request: Request, task_id: str) -> list[dict[str, object]]:
        _require_auth(request)
        project = resolve_project(request)
        _task_for_project(_store(request), task_id, project=project)
        return [_run_payload(run) for run in _store(request).list_runs_for_task(task_id=task_id)]

    @app.post("/api/tasks/{task_id}/comments")
    def create_comment_endpoint(
        request: Request,
        task_id: str,
        payload: CommentPayload,
    ) -> dict[str, object]:
        _require_state_change(request)
        project = resolve_project(request)
        _task_for_project(_store(request), task_id, project=project)
        try:
            comment = _store(request).add_comment_to_task(
                task_id=task_id,
                author=payload.author,
                body=payload.body,
            )
        except KeyError as exc:
            raise HTTPException(status_code=404, detail="task not found") from exc
        return _comment_payload(comment)

    @app.post("/api/tasks/{task_id}/answer")
    def answer_task_endpoint(
        request: Request,
        task_id: str,
        payload: AnswerPayload,
    ) -> dict[str, object]:
        auth = _require_state_change(request)
        _require_answer_access(auth)
        project = resolve_project(request)
        task = _task_for_project(_store(request), task_id, project=project)
        if task.status != "blocked":
            raise HTTPException(status_code=409, detail="task is not blocked")
        actor = _actor_payload(auth)
        author = _answer_author(actor)
        try:
            comment = _store(request).add_comment_to_task(
                task_id=task_id,
                author=author,
                body=payload.text,
            )
            unblocked = _store(request).unblock_task_by_id(task_id=task_id, actor=author)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail="task not found") from exc
        if not unblocked:
            raise HTTPException(status_code=409, detail="task could not be unblocked")
        return {
            "ok": True,
            "task": _task_payload(_store(request).get_task_by_id(task_id)),
            "comment": _comment_payload(comment),
        }

    @app.get("/api/nodes")
    def nodes_endpoint(request: Request) -> list[dict[str, str]]:
        _require_auth(request)
        return [_node_payload(node) for node in _registry_nodes(resolve_project(request).config)]

    @app.post("/api/nodes")
    def create_node_endpoint(
        request: Request,
        payload: NodeCreatePayload,
    ) -> dict[str, object]:
        auth = _require_state_change(request)
        project = resolve_project(request)
        node = _spawn_node(payload, config=project.config)
        node_name = _node_name_from_spawn_result(node, fallback=payload.name)
        _store(request).add_audit_event(
            board=project.board,
            kind="audit.node.spawn",
            actor=_actor_payload(auth),
            action="spawn",
            target={"type": "node", "id": node_name, "node": node_name},
            payload={"project": project.name, "agent": payload.agent},
            summary=node_name,
        )
        return node

    @app.patch("/api/nodes/{name}")
    def update_node_endpoint(
        request: Request,
        name: str,
        payload: NodeUpdatePayload,
    ) -> dict[str, object]:
        auth = _require_state_change(request)
        project = resolve_project(request)
        org = _update_node_relationships(name, payload, config=project.config)
        _store(request).add_audit_event(
            board=project.board,
            kind="audit.node.update",
            actor=_actor_payload(auth),
            action="update",
            target={"type": "node", "id": name, "node": name},
            payload={"project": project.name},
            summary=name,
        )
        return org

    @app.get("/api/org")
    def org_endpoint(request: Request) -> dict[str, object]:
        _require_auth(request)
        return _org_payload(resolve_project(request).config)

    @app.get("/api/slack/manifest")
    def slack_manifest_endpoint(request: Request) -> dict[str, object]:
        _require_auth(request)
        return slack_manifest()

    @app.get("/api/slack/config/status")
    def slack_config_status_endpoint(request: Request) -> dict[str, object]:
        _require_auth(request)
        return config_status(_slack_config_path(_config(request)))

    @app.post("/api/slack/config")
    def slack_config_endpoint(
        request: Request,
        payload: SlackConfigPayload,
    ) -> dict[str, object]:
        _require_state_change(request)
        try:
            config_value = SlackConfig(
                app_token=payload.app_token.strip(),
                bot_token=payload.bot_token.strip(),
                default_channel=_optional_config_text(payload.default_channel),
                default_node=_optional_config_text(payload.default_node),
            )
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        SlackConfigStore(_slack_config_path(_config(request))).save(config_value)
        return {"status": "tokens_saved", "tokens": config_value.masked()}

    @app.post("/api/slack/test")
    def slack_test_endpoint(request: Request) -> dict[str, object]:
        _require_state_change(request)
        configured = SlackConfigStore(_slack_config_path(_config(request))).load() is not None
        return {
            "ok": configured,
            "status": "tokens_saved" if configured else "not_configured",
        }

    @app.get("/api/slack/threads")
    def slack_threads_endpoint(
        request: Request,
        task_id: str = Query(...),
    ) -> list[dict[str, object]]:
        _require_auth(request)
        project = resolve_project(request)
        _task_for_project(_store(request), task_id, project=project)
        return [
            _slack_thread_payload(thread)
            for thread in _store(request).list_slack_threads(task_id=task_id)
        ]

    @app.post("/api/ws-ticket")
    def ws_ticket_endpoint(
        request: Request,
        payload: Annotated[WsTicketPayload | None, Body()] = None,
        kind: str = Query(default="board"),
        pane_id: str | None = Query(default=None),
    ) -> dict[str, object]:
        _require_state_change(request)
        project = resolve_project(request)
        requested_kind, requested_pane = _ws_ticket_request_scope(
            payload,
            query_kind=kind,
            query_pane_id=pane_id,
        )
        clean_kind, clean_pane = _validated_ticket_scope(
            requested_kind,
            requested_pane,
            project=project,
        )
        grant = _ticket_store(request).issue(
            project=project,
            kind=clean_kind,
            pane_id=clean_pane,
        )
        return {
            "ticket": grant.ticket,
            "ttl_seconds": TICKET_TTL_SECONDS,
            "project": project.name,
            "kind": grant.kind,
            "pane_id": grant.pane_id,
        }

    @app.websocket("/ws/terminal")
    async def terminal_ws(
        websocket: WebSocket,
        ticket: str = Query(...),
        pane_id: str = Query(...),
    ) -> None:
        grant = _consume_ticket(_ticket_store(websocket), ticket)
        if grant is None:
            await websocket.close(code=4401)
            return
        project = grant.project
        if grant.kind != "terminal" or grant.pane_id != pane_id:
            await websocket.close(code=status.WS_1008_POLICY_VIOLATION)
            return
        if not _pane_allowed(pane_id, config=project.config):
            await websocket.close(code=status.WS_1008_POLICY_VIOLATION)
            return
        await websocket.accept()
        seq = 0
        last_payload: bytes | None = None
        try:
            while True:
                if not _pane_allowed(pane_id, config=project.config):
                    await websocket.close(code=status.WS_1008_POLICY_VIOLATION)
                    return
                payload = await asyncio.to_thread(_tmux_capture, pane_id)
                if seq == 0 or payload != last_payload:
                    seq += 1
                    last_payload = payload
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
        grant = _consume_ticket(_ticket_store(websocket), ticket)
        if grant is None:
            await websocket.close(code=4401)
            return
        if grant.kind != "board":
            await websocket.close(code=status.WS_1008_POLICY_VIOLATION)
            return
        project = grant.project
        await websocket.accept()
        current = cursor
        try:
            while True:
                events = _store(websocket).list_events_after(cursor=current, limit=100)
                for event in events:
                    current = event.cursor
                    if not _event_in_project(_store(websocket), event, project=project):
                        continue
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


def _load_or_create_dashboard_token(grove_home: Path, session: str) -> str:
    path = _dashboard_token_path(grove_home, session)
    token = secrets.token_urlsafe(32)
    try:
        _create_secret_file_exclusive(path, token + "\n")
    except FileExistsError:
        return _read_dashboard_token(path)
    return _read_dashboard_token(path)


def _dashboard_token_path(grove_home: Path, session: str) -> Path:
    return grove_home / session / "dashboard-token"


def _web_companion_path(grove_home: Path, session: str) -> Path:
    return grove_home / session / "web.json"


def _write_web_companion(config: WebAppConfig, *, started_at: int) -> None:
    payload = {
        "url": _web_companion_url(config),
        "host": config.host,
        "port": config.port,
        "pid": os.getpid(),
        "started_at": started_at,
    }
    _write_secret_json_atomic(
        _web_companion_path(config.grove_home, config.registry_session),
        payload,
    )


def _remove_web_companion(config: WebAppConfig, *, started_at: int) -> None:
    path = _web_companion_path(config.grove_home, config.registry_session)
    try:
        loaded = json.loads(path.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        return
    if not isinstance(loaded, dict):
        return
    if loaded.get("pid") != os.getpid() or loaded.get("started_at") != started_at:
        return
    try:
        path.unlink()
    except FileNotFoundError:
        return


def _web_companion_url(config: WebAppConfig) -> str:
    host = _normalize_hostname(config.host)
    if host is None or host in LOOPBACK_HOSTS or _wildcard_bind_host(config.host):
        url_host = "127.0.0.1"
    else:
        url_host = host
    if ":" in url_host and not url_host.startswith("["):
        url_host = f"[{url_host}]"
    return f"http://{url_host}:{config.port}"


def _read_dashboard_token(path: Path) -> str:
    token = path.read_text(encoding="utf-8").strip()
    if not token:
        raise ValueError("dashboard token file is empty")
    path.chmod(0o600)
    return token


def _write_secret_json_atomic(path: Path, payload: Mapping[str, object]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = path.with_name(f".{path.name}.{os.getpid()}.{secrets.token_hex(6)}.tmp")
    try:
        _create_secret_file_exclusive(
            tmp_path,
            json.dumps(payload, sort_keys=True, separators=(",", ":")) + "\n",
        )
        os.replace(tmp_path, path)
        path.chmod(0o600)
    finally:
        try:
            tmp_path.unlink()
        except FileNotFoundError:
            pass


def _create_secret_file_exclusive(path: Path, value: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            fd = -1
            handle.write(value)
    except Exception:
        if fd >= 0:
            os.close(fd)
        raise


def _health_payload(app: FastAPI) -> dict[str, object]:
    started_at = cast(int, app.state.started_at)
    board_ok = _board_store_ok(cast(SQLiteBoardStore, app.state.store))
    return {
        "ok": board_ok,
        "version": APP_VERSION,
        "board_ok": board_ok,
        "started_at": started_at,
        "uptime": max(0, int(time.time()) - started_at),
    }


def _board_store_ok(store: SQLiteBoardStore) -> bool:
    try:
        store.list_boards()
    except Exception:
        return False
    return True


def _node_liveness_summary(config: WebAppConfig) -> dict[str, int]:
    nodes = _registry_node_records(config)
    counts = {"total": len(nodes), "running": 0, "stale": 0, "idle": 0, "error": 0}
    for node in nodes:
        status_value = node["status"]
        if status_value == "running":
            counts["running"] += 1
        elif status_value == "stale":
            counts["stale"] += 1
        elif status_value == "error":
            counts["error"] += 1
        else:
            counts["idle"] += 1
    return counts


def _node_status_details(config: WebAppConfig) -> list[dict[str, object]]:
    raw_nodes = _load_registry(config).get("nodes")
    if not isinstance(raw_nodes, dict):
        return []
    details: list[dict[str, object]] = []
    for key, raw_node in raw_nodes.items():
        if not isinstance(key, str) or not isinstance(raw_node, dict):
            continue
        node = _string_mapping(raw_node)
        pane = _mapping_string(node, "tmux_pane")
        if pane is None or not _valid_exposed_tmux_pane(pane, config=config):
            continue
        name = _mapping_string(node, "name") or key
        status_value, reason, confidence = _node_status_detail(node)
        details.append(
            {
                "name": name,
                "status": status_value,
                "last_seen": _node_last_seen(node),
                "status_reason": reason,
                "source": "registry",
                "confidence": confidence,
            }
        )
    return sorted(details, key=lambda item: str(item["name"]))


def _node_status_detail(node: Mapping[str, object]) -> tuple[str, str, str]:
    explicit = _mapping_string(node, "status")
    if explicit is not None:
        normalized = _normalized_node_detail_status(explicit)
        reason = _node_status_reason(node, fallback=f"registry status: {explicit}")
        return normalized, reason, "explicit"
    if node.get("error") is not None:
        return "error", _node_status_reason(node, fallback="registry error present"), "inferred"
    if isinstance(node.get("blocked"), bool) and node.get("blocked") is True:
        return "blocked", _node_status_reason(node, fallback="registry blocked flag"), "inferred"
    if isinstance(node.get("pending"), Mapping):
        return "running", _node_status_reason(node, fallback="pending turn in registry"), "inferred"
    return "idle", _node_status_reason(node, fallback="no active turn recorded"), "inferred"


def _normalized_node_detail_status(value: str) -> str:
    clean = value.strip().lower()
    if clean in {"running", "idle", "error", "blocked", "dead"}:
        return clean
    if clean == "stale":
        return "dead"
    return "idle"


def _node_status_reason(node: Mapping[str, object], *, fallback: str) -> str:
    for key in ("status_reason", "statusReason", "reason", "error"):
        value = _mapping_string(node, key)
        if value:
            return _safe_log_text(value)
    return fallback


def _node_last_seen(node: Mapping[str, object]) -> int | None:
    for key in ("last_seen", "lastSeen", "last_heartbeat_at", "updated_at"):
        timestamp = _valid_timestamp(node.get(key))
        if timestamp is not None:
            return timestamp
    return None


def _valid_timestamp(value: object) -> int | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, int) and 0 <= value <= MAX_TIMESTAMP_SECONDS:
        return value
    if isinstance(value, str):
        clean = value.strip()
        if clean.isdigit():
            parsed = int(clean)
            if 0 <= parsed <= MAX_TIMESTAMP_SECONDS:
                return parsed
    return None


def _inbox_payload(
    store: SQLiteBoardStore,
    *,
    project: ProjectContext,
    cursor: int,
    limit: int,
) -> dict[str, object]:
    now = int(time.time())
    tasks = store.list_tasks(board=project.board, status="blocked")
    items = [
        _inbox_item_payload(store, task, project=project, now=now)
        for task in tasks
        if task.status == "blocked"
    ]
    page = items[cursor : cursor + limit]
    next_cursor = cursor + len(page) if cursor + len(page) < len(items) else None
    return {
        "project": project.name,
        "items": page,
        "next_cursor": next_cursor,
        "total": len(items),
        "answer": {
            "endpoint": "/api/tasks/{task_id}/answer",
            "method": "POST",
            "body": {"text": "human answer"},
            "human_gate": "Slack thread replies use the same comment plus unblock flow",
            "audit": "unblock is recorded through board events with the answer actor",
        },
    }


def _inbox_item_payload(
    store: SQLiteBoardStore,
    task: Task,
    *,
    project: ProjectContext,
    now: int,
) -> dict[str, object]:
    runs = store.list_runs(board=project.board, task_id=task.id)
    blocked_run = _latest_blocked_run(runs)
    notify_subs = store.list_notify_subs(board=project.board, task_id=task.id)
    slack_threads = [
        thread
        for thread in store.list_slack_threads(task_id=task.id)
        if thread.board_id == task.board_id
    ]
    human_threads = [thread for thread in slack_threads if thread.mode == HUMAN_GATE_MODE]
    pending_threads = [thread for thread in slack_threads if thread.mode == HUMAN_GATE_PENDING_MODE]
    needs_human = bool(task.metadata.get("needs_human"))
    blocked_since = _inbox_blocked_since(task, blocked_run)
    sources = _inbox_sources(
        needs_human=needs_human,
        human_threads=human_threads,
        pending_threads=pending_threads,
        notify_subs=notify_subs,
    )
    return {
        "id": task.id,
        "type": "ask_human" if "ask_human" in sources else "blocked_task",
        "task_id": task.id,
        "title": _inbox_text(task.title),
        "body": _inbox_optional_text(task.body),
        "status": task.status,
        "assignee": _inbox_optional_text(task.assignee),
        "node": _inbox_optional_text(_inbox_node(task, blocked_run)),
        "blocked_reason": _inbox_optional_text(_inbox_blocked_reason(task, blocked_run)),
        "blocked_since": blocked_since,
        "waiting_seconds": max(0, now - blocked_since),
        "needs_human": needs_human,
        "sources": sources,
        "slack": {
            "threads": [_inbox_slack_thread_payload(thread) for thread in human_threads],
            "pending": [_inbox_slack_thread_payload(thread) for thread in pending_threads],
            "notify_subs": [_inbox_notify_sub_payload(sub) for sub in notify_subs],
        },
        "answer": {
            "endpoint": f"/api/tasks/{task.id}/answer",
            "method": "POST",
            "slack_thread_reply": bool(human_threads or notify_subs),
            "note": "answer adds a comment and unblocks the task",
        },
    }


def _latest_blocked_run(runs: Sequence[Run]) -> Run | None:
    blocked = [run for run in runs if run.status == "blocked" or run.outcome == "blocked"]
    if not blocked:
        return None
    return max(blocked, key=lambda run: (run.ended_at or run.started_at, run.id))


def _inbox_blocked_since(task: Task, run: Run | None) -> int:
    if run is not None:
        return run.ended_at or run.started_at
    return task.updated_at or task.created_at


def _inbox_node(task: Task, run: Run | None) -> str | None:
    metadata_node = _mapping_string(task.metadata, "node")
    if metadata_node is not None:
        return metadata_node
    if task.assignee is not None:
        return task.assignee
    return None if run is None else run.node_id


def _inbox_blocked_reason(task: Task, run: Run | None) -> str | None:
    if run is not None:
        if run.error is not None and run.error.strip():
            return run.error
        if run.summary is not None and run.summary.strip():
            return run.summary
    for key in ("reason", "question", "blocked_reason", "blockedReason"):
        value = _mapping_string(task.metadata, key)
        if value is not None:
            return value
    return task.result


def _inbox_sources(
    *,
    needs_human: bool,
    human_threads: Sequence[SlackThread],
    pending_threads: Sequence[SlackThread],
    notify_subs: Sequence[NotifySub],
) -> list[str]:
    sources = ["blocked_task"]
    if needs_human or human_threads or pending_threads or notify_subs:
        sources.append("ask_human")
    if needs_human:
        sources.append("needs_human")
    if pending_threads:
        sources.append(HUMAN_GATE_PENDING_MODE)
    if human_threads:
        sources.append(HUMAN_GATE_MODE)
    if notify_subs:
        sources.append("notify_sub")
    return sources


def _inbox_slack_thread_payload(thread: SlackThread) -> dict[str, object]:
    return {
        "channel": _inbox_text(thread.channel_id),
        "thread_id": _inbox_text(thread.thread_ts),
        "mode": _inbox_text(thread.mode),
        "created_at": thread.created_at,
        "updated_at": thread.updated_at,
    }


def _inbox_notify_sub_payload(sub: NotifySub) -> dict[str, object]:
    return {
        "channel_kind": _inbox_text(sub.channel_kind),
        "room_id": _inbox_text(sub.room_id),
        "thread_id": _inbox_text(sub.thread_id),
        "user_id": _inbox_optional_text(sub.user_id),
        "created_at": sub.created_at,
    }


def _inbox_text(value: str) -> str:
    return _safe_log_text(value)


def _inbox_optional_text(value: str | None) -> str | None:
    return None if value is None else _inbox_text(value)


def _cost_project_context(request: Request, project_name: str | None) -> ProjectContext:
    header_project = request.headers.get(PROJECT_HEADER)
    if header_project is not None and header_project.strip():
        return resolve_project(request)
    if project_name is None or not project_name.strip():
        return resolve_project(request)
    name = project_name.strip()
    if PROJECT_NAME_RE.fullmatch(name) is None:
        raise HTTPException(status_code=400, detail="invalid project")
    base_config = _config(request)
    project_config = replace(base_config, registry_session=name)
    if not _registry_path(project_config).is_file():
        raise HTTPException(status_code=404, detail="project not found")
    return ProjectContext(config=project_config, name=name, board=name, from_header=True)


def _cost_payload(
    store: SQLiteBoardStore,
    *,
    project: ProjectContext,
    window: str,
    node_filter: str | None,
    agent_filter: str | None,
    include: str | None,
) -> dict[str, object]:
    now = int(time.time())
    window_payload, since = _cost_window(window, now=now)
    clean_node = node_filter.strip() if node_filter is not None and node_filter.strip() else None
    clean_agent = _cost_agent_filter(agent_filter)
    runs = store.list_runs_for_board(board=project.board, since=since)
    snapshots = _cost_node_snapshots(
        project.config,
        runs=runs,
        node_filter=clean_node,
        agent_filter=clean_agent,
    )
    usages = [snapshot.usage for snapshot in snapshots]
    payload: dict[str, object] = {
        "project": project.name,
        "generated_at": _cost_metric(now, source="server", confidence="explicit"),
        "window": window_payload,
        "totals": _cost_totals(usages, turns=sum(snapshot.turns for snapshot in snapshots)),
        "by_agent": _cost_by_agent(snapshots),
        "nodes": [snapshot.payload for snapshot in snapshots],
        "limitations": _cost_limitations(usages),
    }
    includes = _cost_includes(include)
    if "runs" in includes:
        payload["runs"] = [
            _cost_run_payload(run)
            for run in runs
            if _cost_run_matches(run, node_filter=clean_node, agent_filter=clean_agent)
        ]
    if "sources" in includes:
        payload["sources"] = {
            "registry": "node agent, status, session, transcript hints",
            "run_metadata": "completed board run metadata fields",
            "transcript": "best-effort usage fields when a transcript is readable",
            "estimate": "unknown cost without an explicit price source",
        }
    return payload


def _cost_window(window: str, *, now: int) -> tuple[dict[str, object], int | None]:
    clean = window.strip().lower()
    if clean == "24h":
        since = now - 86_400
    elif clean == "7d":
        since = now - (7 * 86_400)
    elif clean == "all":
        since = None
    else:
        raise HTTPException(status_code=400, detail="invalid cost window")
    return (
        {
            "name": clean,
            "since": _cost_metric(since, source="server", confidence="explicit"),
            "until": _cost_metric(now, source="server", confidence="explicit"),
        },
        since,
    )


def _cost_agent_filter(agent_filter: str | None) -> str | None:
    if agent_filter is None or not agent_filter.strip():
        return None
    clean = _normalized_cost_agent(agent_filter)
    if clean not in COST_AGENTS:
        raise HTTPException(status_code=400, detail="invalid cost agent")
    return clean


def _cost_includes(include: str | None) -> set[str]:
    if include is None:
        return set()
    return {part.strip().lower() for part in include.split(",") if part.strip()}


def _cost_node_snapshots(
    config: WebAppConfig,
    *,
    runs: Sequence[Run],
    node_filter: str | None,
    agent_filter: str | None,
) -> list[CostNodeSnapshot]:
    runs_by_node = _runs_by_node(runs)
    snapshots: list[CostNodeSnapshot] = []
    for node in _cost_registry_node_records(config):
        name = _cost_node_name(node)
        agent = _cost_node_agent(node)
        if node_filter is not None and name != node_filter:
            continue
        if agent_filter is not None and agent != agent_filter:
            continue
        node_runs = runs_by_node.get(name, [])
        usage = _cost_usage_for_node(node, config=config, runs=node_runs)
        warnings = [_safe_log_text(warning) for warning in usage.warnings]
        last_seen = _node_last_seen(node)
        payload: dict[str, object] = {
            "node": name,
            "agent": agent,
            "status": _mapping_string(node, "_cost_status") or "idle",
            "last_seen": _cost_metric(
                last_seen,
                source="registry",
                confidence="explicit" if last_seen is not None else "unknown",
                status_value="unknown" if last_seen is None else None,
            ),
            "turns": _cost_metric(len(node_runs), source="run_metadata", confidence="explicit"),
            "input_tokens": _cost_metric(
                usage.input_tokens,
                source=usage.source,
                confidence=usage.confidence,
                status_value="unknown" if usage.input_tokens is None else None,
            ),
            "output_tokens": _cost_metric(
                usage.output_tokens,
                source=usage.source,
                confidence=usage.confidence,
                status_value="unknown" if usage.output_tokens is None else None,
            ),
            "total_tokens": _cost_metric(
                usage.total_tokens,
                source=usage.source,
                confidence=usage.confidence,
                status_value="unknown" if usage.total_tokens is None else None,
            ),
            "cost_usd_estimate": _cost_metric(
                usage.cost_usd,
                source=usage.source if usage.cost_usd is not None else "estimate",
                confidence=usage.confidence if usage.cost_usd is not None else "unknown",
                status_value="unknown" if usage.cost_usd is None else None,
            ),
            "source": usage.source,
            "confidence": usage.confidence,
            "warnings": warnings,
        }
        snapshots.append(
            CostNodeSnapshot(
                name=name,
                agent=agent,
                turns=len(node_runs),
                usage=usage,
                payload=payload,
            )
        )
    return sorted(snapshots, key=lambda snapshot: snapshot.name)


def _cost_registry_node_records(config: WebAppConfig) -> list[dict[str, object]]:
    raw_nodes = _load_registry(config).get("nodes")
    if not isinstance(raw_nodes, dict):
        return []
    nodes: list[dict[str, object]] = []
    for key, raw_node in raw_nodes.items():
        if not isinstance(key, str) or not isinstance(raw_node, dict):
            continue
        node = dict(_string_mapping(raw_node))
        pane = _mapping_string(node, "tmux_pane")
        if pane is None or not _valid_exposed_tmux_pane(pane, config=config):
            continue
        name = _mapping_string(node, "name") or key
        node["_cost_name"] = name
        node["_cost_agent"] = _normalized_cost_agent(_mapping_string(node, "agent") or "")
        node["_cost_status"] = _node_status(node)
        nodes.append(node)
    return nodes


def _cost_node_name(node: Mapping[str, object]) -> str:
    value = _mapping_string(node, "_cost_name")
    return value or "unknown"


def _cost_node_agent(node: Mapping[str, object]) -> str:
    value = _mapping_string(node, "_cost_agent")
    return value if value in COST_AGENTS else "unknown"


def _normalized_cost_agent(value: str) -> str:
    clean = value.strip().lower()
    if clean == "antigravity":
        return "agy"
    if clean in {"codex", "claude", "agy"}:
        return clean
    return "unknown"


def _runs_by_node(runs: Sequence[Run]) -> dict[str, list[Run]]:
    grouped: dict[str, list[Run]] = {}
    for run in runs:
        grouped.setdefault(_run_node_name(run), []).append(run)
    return grouped


def _run_node_name(run: Run) -> str:
    metadata_node = _mapping_string(run.metadata, "node")
    return metadata_node or run.node_id


def _cost_usage_for_node(
    node: Mapping[str, object],
    *,
    config: WebAppConfig,
    runs: Sequence[Run],
) -> CostUsage:
    transcript = _usage_from_transcript(node, config=config)
    if _usage_has_signal(transcript):
        return transcript
    run_usage = _usage_from_runs(runs)
    if _usage_has_signal(run_usage):
        return CostUsage(
            input_tokens=run_usage.input_tokens,
            output_tokens=run_usage.output_tokens,
            total_tokens=run_usage.total_tokens,
            cost_usd=run_usage.cost_usd,
            source=run_usage.source,
            confidence=run_usage.confidence,
            warnings=transcript.warnings + run_usage.warnings,
        )
    warnings = transcript.warnings + run_usage.warnings
    return CostUsage(
        input_tokens=None,
        output_tokens=None,
        total_tokens=None,
        cost_usd=None,
        source="none",
        confidence="unknown",
        warnings=warnings,
    )


def _usage_from_runs(runs: Sequence[Run]) -> CostUsage:
    totals = {"input_tokens": 0, "output_tokens": 0, "total_tokens": 0}
    cost_total = 0.0
    found = 0
    cost_found = 0
    for run in runs:
        usage = _usage_from_mapping(run.metadata, source="run_metadata")
        if not _usage_has_signal(usage):
            continue
        found += 1
        if usage.input_tokens is not None:
            totals["input_tokens"] += usage.input_tokens
        if usage.output_tokens is not None:
            totals["output_tokens"] += usage.output_tokens
        if usage.total_tokens is not None:
            totals["total_tokens"] += usage.total_tokens
        if usage.cost_usd is not None:
            cost_total += usage.cost_usd
            cost_found += 1
    if found == 0:
        warning = ("run metadata has no token usage fields",) if runs else ()
        return _unknown_usage(warnings=warning)
    confidence = "explicit" if found == len(runs) else "partial"
    return CostUsage(
        input_tokens=totals["input_tokens"] if totals["input_tokens"] else None,
        output_tokens=totals["output_tokens"] if totals["output_tokens"] else None,
        total_tokens=totals["total_tokens"] if totals["total_tokens"] else None,
        cost_usd=cost_total if cost_found else None,
        source="run_metadata",
        confidence=confidence,
    )


def _usage_from_transcript(
    node: Mapping[str, object],
    *,
    config: WebAppConfig,
) -> CostUsage:
    transcript_path = _transcript_path_for_node(node, config=config)
    if transcript_path is None:
        return _unknown_usage()
    try:
        stat = transcript_path.stat()
    except OSError:
        return _unknown_usage(warnings=("transcript is not readable",))
    if stat.st_size > TRANSCRIPT_MAX_BYTES:
        return _unknown_usage(warnings=("transcript is too large for best-effort parsing",))
    try:
        text = transcript_path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return _unknown_usage(warnings=("transcript is not readable",))
    totals = {"input_tokens": 0, "output_tokens": 0, "total_tokens": 0}
    cost_total = 0.0
    found = 0
    cost_found = 0
    try:
        mappings = _transcript_json_mappings(text)
        for mapping in mappings:
            usage = _usage_from_mapping(mapping, source="transcript")
            if not _usage_has_signal(usage):
                continue
            found += 1
            if usage.input_tokens is not None:
                totals["input_tokens"] += usage.input_tokens
            if usage.output_tokens is not None:
                totals["output_tokens"] += usage.output_tokens
            if usage.total_tokens is not None:
                totals["total_tokens"] += usage.total_tokens
            if usage.cost_usd is not None:
                cost_total += usage.cost_usd
                cost_found += 1
    except Exception:
        return _unknown_usage(warnings=("transcript parsing failed",))
    if found == 0:
        return _unknown_usage(warnings=("transcript has no token usage fields",))
    return CostUsage(
        input_tokens=totals["input_tokens"] if totals["input_tokens"] else None,
        output_tokens=totals["output_tokens"] if totals["output_tokens"] else None,
        total_tokens=totals["total_tokens"] if totals["total_tokens"] else None,
        cost_usd=cost_total if cost_found else None,
        source="transcript",
        confidence="explicit",
    )


def _transcript_path_for_node(
    node: Mapping[str, object],
    *,
    config: WebAppConfig,
) -> Path | None:
    for key in ("transcript_path", "transcriptPath", "transcript", "log_path", "logPath"):
        value = _mapping_string(node, key)
        if value is None:
            continue
        path = Path(value).expanduser()
        if not path.is_absolute():
            path = config.grove_home / config.registry_session / path
        return path
    return None


def _transcript_json_mappings(text: str) -> list[Mapping[str, object]]:
    stripped = text.strip()
    if not stripped:
        return []
    parsed_mappings = _parsed_json_mappings(stripped)
    if parsed_mappings:
        return parsed_mappings
    mappings: list[Mapping[str, object]] = []
    for line in stripped.splitlines():
        parsed = _parsed_json_mappings(line.strip())
        mappings.extend(parsed)
    return mappings


def _parsed_json_mappings(text: str) -> list[Mapping[str, object]]:
    if not text:
        return []
    try:
        parsed = json.loads(text)
    except json.JSONDecodeError:
        return []
    if isinstance(parsed, dict):
        return [_string_mapping(parsed)]
    if isinstance(parsed, list):
        return [_string_mapping(item) for item in parsed if isinstance(item, dict)]
    return []


def _usage_from_mapping(mapping: Mapping[str, object], *, source: str) -> CostUsage:
    candidates = _usage_candidate_mappings(mapping)
    input_tokens = _first_int(
        candidates,
        ("input_tokens", "inputTokens", "prompt_tokens", "promptTokens"),
    )
    output_tokens = _first_int(
        candidates,
        ("output_tokens", "outputTokens", "completion_tokens", "completionTokens"),
    )
    total_tokens = _first_int(candidates, ("total_tokens", "totalTokens", "tokens"))
    if total_tokens is None and input_tokens is not None and output_tokens is not None:
        total_tokens = input_tokens + output_tokens
    cost_usd = _first_float(candidates, ("cost_usd", "costUsd", "cost", "usd"))
    if input_tokens is None and output_tokens is None and total_tokens is None and cost_usd is None:
        return _unknown_usage(source=source)
    return CostUsage(
        input_tokens=input_tokens,
        output_tokens=output_tokens,
        total_tokens=total_tokens,
        cost_usd=cost_usd,
        source=source,
        confidence="explicit",
    )


def _usage_candidate_mappings(mapping: Mapping[str, object]) -> list[Mapping[str, object]]:
    candidates = [mapping]
    for key in ("usage", "token_usage", "tokenUsage", "metrics"):
        value = mapping.get(key)
        if isinstance(value, Mapping):
            candidates.append(_string_mapping(value))
    return candidates


def _first_int(mappings: Sequence[Mapping[str, object]], keys: Sequence[str]) -> int | None:
    for mapping in mappings:
        for key in keys:
            value = _numeric_int(mapping.get(key))
            if value is not None:
                return value
    return None


def _first_float(mappings: Sequence[Mapping[str, object]], keys: Sequence[str]) -> float | None:
    for mapping in mappings:
        for key in keys:
            value = _numeric_float(mapping.get(key))
            if value is not None:
                return value
    return None


def _numeric_int(value: object) -> int | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, float) and value.is_integer():
        return int(value)
    if isinstance(value, str):
        clean = value.strip()
        if clean.isdigit():
            return int(clean)
    return None


def _numeric_float(value: object) -> float | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, int | float):
        return float(value)
    if isinstance(value, str):
        clean = value.strip().removeprefix("$")
        try:
            return float(clean)
        except ValueError:
            return None
    return None


def _unknown_usage(
    *,
    source: str = "none",
    warnings: tuple[str, ...] = (),
) -> CostUsage:
    return CostUsage(
        input_tokens=None,
        output_tokens=None,
        total_tokens=None,
        cost_usd=None,
        source=source,
        confidence="unknown",
        warnings=warnings,
    )


def _usage_has_signal(usage: CostUsage) -> bool:
    return (
        usage.input_tokens is not None
        or usage.output_tokens is not None
        or usage.total_tokens is not None
        or usage.cost_usd is not None
    )


def _cost_totals(usages: Sequence[CostUsage], *, turns: int) -> dict[str, object]:
    return {
        "turns": _cost_metric(turns, source="run_metadata", confidence="explicit"),
        "input_tokens": _aggregate_int_metric(usages, "input_tokens"),
        "output_tokens": _aggregate_int_metric(usages, "output_tokens"),
        "total_tokens": _aggregate_int_metric(usages, "total_tokens"),
        "cost_usd_estimate": _aggregate_float_metric(usages, "cost_usd"),
        "confidence": _combined_confidence(usages),
    }


def _cost_by_agent(snapshots: Sequence[CostNodeSnapshot]) -> dict[str, object]:
    by_agent: dict[str, object] = {}
    for agent in COST_AGENTS:
        agent_snapshots = [snapshot for snapshot in snapshots if snapshot.agent == agent]
        usages = [snapshot.usage for snapshot in agent_snapshots]
        item: dict[str, object] = {
            "nodes": _cost_metric(len(agent_snapshots), source="registry", confidence="explicit"),
            "turns": _cost_metric(
                sum(snapshot.turns for snapshot in agent_snapshots),
                source="run_metadata",
                confidence="explicit",
            ),
            "input_tokens": _aggregate_int_metric(usages, "input_tokens"),
            "output_tokens": _aggregate_int_metric(usages, "output_tokens"),
            "total_tokens": _aggregate_int_metric(usages, "total_tokens"),
            "cost_usd_estimate": _aggregate_float_metric(usages, "cost_usd"),
            "confidence": _combined_confidence(usages),
        }
        if agent == "agy":
            item["credit_remaining"] = _cost_metric(
                None,
                source="none",
                confidence="unknown",
                status_value="unknown",
            )
            item["credit_status"] = "unknown"
            item["warnings"] = [
                "agy credit is unknown because no reliable local credit source is configured"
            ]
        by_agent[agent] = item
    return by_agent


def _aggregate_int_metric(usages: Sequence[CostUsage], field: str) -> dict[str, object]:
    values = [_usage_int_field(usage, field) for usage in usages]
    present = [value for value in values if value is not None]
    if not present:
        return _cost_metric(None, source="none", confidence="unknown", status_value="unknown")
    confidence = "explicit" if len(present) == len(values) else "partial"
    return _cost_metric(
        sum(present),
        source=_aggregate_source(usages, field),
        confidence=confidence,
    )


def _aggregate_float_metric(usages: Sequence[CostUsage], field: str) -> dict[str, object]:
    values = [_usage_float_field(usage, field) for usage in usages]
    present = [value for value in values if value is not None]
    if not present:
        return _cost_metric(None, source="estimate", confidence="unknown", status_value="unknown")
    confidence = "explicit" if len(present) == len(values) else "partial"
    return _cost_metric(
        round(sum(present), 6),
        source=_aggregate_source(usages, field),
        confidence=confidence,
    )


def _usage_int_field(usage: CostUsage, field: str) -> int | None:
    if field == "input_tokens":
        return usage.input_tokens
    if field == "output_tokens":
        return usage.output_tokens
    if field == "total_tokens":
        return usage.total_tokens
    raise ValueError(f"unknown usage int field: {field}")


def _usage_float_field(usage: CostUsage, field: str) -> float | None:
    if field == "cost_usd":
        return usage.cost_usd
    raise ValueError(f"unknown usage float field: {field}")


def _aggregate_source(usages: Sequence[CostUsage], field: str) -> str:
    sources: set[str] = set()
    for usage in usages:
        present = (
            _usage_float_field(usage, field) is not None
            if field == "cost_usd"
            else _usage_int_field(usage, field) is not None
        )
        if present:
            sources.add(usage.source)
    if len(sources) == 1:
        return next(iter(sources))
    if len(sources) > 1:
        return "mixed"
    return "none"


def _combined_confidence(usages: Sequence[CostUsage]) -> str:
    if not usages or not any(_usage_has_signal(usage) for usage in usages):
        return "unknown"
    if all(usage.confidence == "explicit" and _usage_has_signal(usage) for usage in usages):
        return "explicit"
    return "partial"


def _cost_metric(
    value: int | float | None,
    *,
    source: str,
    confidence: str,
    status_value: str | None = None,
) -> dict[str, object]:
    payload: dict[str, object] = {
        "value": value,
        "source": source,
        "confidence": confidence,
    }
    if status_value is not None:
        payload["status"] = status_value
    return payload


def _cost_run_matches(
    run: Run,
    *,
    node_filter: str | None,
    agent_filter: str | None,
) -> bool:
    if node_filter is not None and _run_node_name(run) != node_filter:
        return False
    return agent_filter is None


def _cost_run_payload(run: Run) -> dict[str, object]:
    return {
        "id": run.id,
        "task_id": run.task_id,
        "node": _run_node_name(run),
        "status": run.status,
        "started": _cost_metric(run.started_at, source="run_metadata", confidence="explicit"),
        "ended": _cost_metric(run.ended_at, source="run_metadata", confidence="explicit")
        if run.ended_at is not None
        else _cost_metric(
            None,
            source="run_metadata",
            confidence="unknown",
            status_value="unknown",
        ),
    }


def _cost_limitations(usages: Sequence[CostUsage]) -> list[str]:
    limitations = [
        "cost_usd_estimate is unknown unless a run or transcript records an explicit cost",
        "no hard-coded model prices are applied",
        "agy credit is unknown without a reliable local credit source",
        "transcript parsing is best-effort and ignores unreadable or oversized files",
    ]
    if not any(_usage_has_signal(usage) for usage in usages):
        limitations.append(
            "no token usage signals were found in registry transcripts or run metadata"
        )
    return limitations


def _log_web_request(
    *,
    request: Request,
    status_code: int,
    started: float,
    error: Exception | None = None,
) -> None:
    duration_ms = int((time.monotonic() - started) * 1000)
    path = _safe_log_path(request)
    if error is None:
        LOGGER.info(
            "event=web_request method=%s path=%s status=%s duration_ms=%s",
            request.method,
            path,
            status_code,
            duration_ms,
        )
        return
    LOGGER.error(
        "event=web_request_error method=%s path=%s status=%s duration_ms=%s error=%s",
        request.method,
        path,
        status_code,
        duration_ms,
        _safe_log_text(f"{error.__class__.__name__}: {error}"),
    )


def _safe_log_text(value: object) -> str:
    raw = str(value).replace("\r", "\n")
    without_paths = ABSOLUTE_PATH_RE.sub("[path]", raw)
    without_secrets = redact_secret_text(without_paths)
    return _summary_text(without_secrets)


def _safe_log_path(request: Request) -> str:
    route = request.scope.get("route")
    route_path = getattr(route, "path", None)
    if isinstance(route_path, str):
        return _summary_text(redact_secret_text(route_path))
    return _safe_log_text(request.url.path)


def _require_token(request: Request) -> None:
    config = _config(request)
    supplied = request.headers.get(SESSION_HEADER)
    if supplied != config.token:
        raise HTTPException(status_code=401, detail="missing or invalid session token")


def _require_auth(request: Request) -> AuthContext:
    config = _config(request)
    if config.auth_mode == AuthMode.LOCAL_TOKEN:
        _require_token(request)
        return AuthContext(mode=AuthMode.LOCAL_TOKEN)
    return _require_team_session(request, config=config)


def _require_team_session(request: Request, *, config: WebAppConfig) -> AuthContext:
    cookie_value = request.cookies.get(TEAM_SESSION_COOKIE)
    if cookie_value is None or not cookie_value.strip():
        raise HTTPException(status_code=401, detail=_team_auth_unauthorized_detail(config))
    verified = _session_signer(config).verify(cookie_value, _member_registry(config))
    if verified is None:
        raise HTTPException(status_code=401, detail=_team_auth_unauthorized_detail(config))
    if not _team_session_store(request).contains(
        sid=verified.sid,
        member_id=verified.member.id,
    ):
        raise HTTPException(status_code=401, detail=_team_auth_unauthorized_detail(config))
    return AuthContext(
        mode=AuthMode.TEAM_COOKIE,
        sid=verified.sid,
        member=verified.member,
        csrf_token=verified.csrf_token,
        expires_at=verified.expires_at,
    )


def _require_state_change(request: Request) -> AuthContext:
    auth = _require_auth(request)
    _require_allowed_origin(request)
    if auth.mode == AuthMode.TEAM_COOKIE:
        _require_team_csrf(request, auth=auth)
    return auth


def _require_team_csrf(request: Request, *, auth: AuthContext) -> None:
    supplied = request.headers.get(CSRF_HEADER)
    expected = auth.csrf_token
    if expected is None or supplied is None or not secrets.compare_digest(supplied, expected):
        raise HTTPException(status_code=403, detail="missing or invalid csrf token")


def _require_audit_access(auth: AuthContext) -> None:
    if auth.mode == AuthMode.TEAM_COOKIE and auth.member is not None:
        if auth.member.role == "viewer":
            raise HTTPException(status_code=403, detail="audit requires operator role")


def _require_cost_access(auth: AuthContext) -> None:
    if auth.mode == AuthMode.TEAM_COOKIE and auth.member is not None:
        if auth.member.role == "viewer":
            raise HTTPException(status_code=403, detail="cost requires operator role")


def _require_answer_access(auth: AuthContext) -> None:
    if auth.mode == AuthMode.TEAM_COOKIE and auth.member is not None:
        if auth.member.role == "viewer":
            raise HTTPException(status_code=403, detail="answer requires operator role")


def _actor_payload(auth: AuthContext) -> dict[str, object]:
    if auth.mode == AuthMode.TEAM_COOKIE and auth.member is not None:
        return {
            "kind": "member",
            "id": auth.member.id,
            "login": auth.member.name,
            "role": auth.member.role,
        }
    return {"kind": "local", "id": "lead", "login": "lead", "role": "none"}


def _actor_id(actor: Mapping[str, object]) -> str:
    actor_id = actor.get("id")
    return actor_id if isinstance(actor_id, str) else "system"


def _answer_author(actor: Mapping[str, object]) -> str:
    kind = actor.get("kind")
    login = actor.get("login")
    if isinstance(kind, str) and isinstance(login, str) and login.strip():
        return f"{kind}:{login.strip()}"
    actor_id = _actor_id(actor)
    return f"actor:{actor_id}"


def _member_registry(config: WebAppConfig) -> MemberRegistry:
    return MemberRegistry(members_path(config.grove_home, config.registry_session))


def _session_signer(config: WebAppConfig) -> SessionSigner:
    return SessionSigner(session_secret_path(config.grove_home, config.registry_session))


def _team_session_store(request: Request) -> TeamSessionStore:
    return cast(TeamSessionStore, request.app.state.team_session_store)


def _team_auth_unauthorized_detail(config: WebAppConfig) -> dict[str, object]:
    registry = _member_registry(config)
    detail: dict[str, object] = {"error": "not authenticated"}
    try:
        has_members = bool(registry.list_members())
    except ValueError:
        has_members = True
    if not has_members:
        detail["bootstrap_hint"] = bootstrap_hint(registry.path)
    return detail


def _set_team_session_cookie(
    response: Response,
    *,
    request: Request,
    issued: IssuedSession,
) -> None:
    response.set_cookie(
        TEAM_SESSION_COOKIE,
        issued.cookie_value,
        max_age=TEAM_SESSION_TTL_SECONDS,
        httponly=True,
        secure=request.url.scheme == "https",
        samesite="strict",
    )


def _me_payload(config: WebAppConfig, auth: AuthContext) -> dict[str, object]:
    return {
        "auth_mode": config.auth_mode.value,
        "member": auth.member.to_payload() if auth.member is not None else None,
        "csrf": auth.csrf_token,
        "expires_at": auth.expires_at,
    }


def _require_allowed_origin(request: Request) -> None:
    config = _config(request)
    request_host = _request_hostname(request.headers.get("host"))
    if request_host is None:
        raise HTTPException(status_code=400, detail="invalid host")
    allowed_hosts = _allowed_request_hosts(config)
    if request_host not in allowed_hosts:
        raise HTTPException(status_code=403, detail="host not allowed")
    origin = request.headers.get("origin")
    if origin is None or not origin.strip():
        if request_host not in LOOPBACK_HOSTS:
            raise HTTPException(status_code=403, detail="origin required")
        return
    origin_host = _origin_hostname(origin)
    if origin_host is None:
        raise HTTPException(status_code=403, detail="origin not allowed")
    if origin_host not in allowed_hosts:
        raise HTTPException(status_code=403, detail="origin not allowed")


def _allowed_request_hosts(config: WebAppConfig) -> set[str]:
    hosts = set(LOOPBACK_HOSTS)
    hosts.update(config.allowed_hosts)
    return hosts


def _normalize_allowed_hosts(values: Sequence[str]) -> tuple[str, ...]:
    hosts: dict[str, None] = {}
    for value in values:
        for raw_host in value.split(","):
            host = _origin_hostname(raw_host) if "://" in raw_host else _request_hostname(raw_host)
            if host is not None:
                hosts[host] = None
    return tuple(hosts)


def _request_hostname(value: str | None) -> str | None:
    if value is None or not value.strip():
        return None
    parsed = urlparse(f"//{value.strip()}")
    return _normalize_hostname(parsed.hostname)


def _origin_hostname(value: str) -> str | None:
    parsed = urlparse(value.strip())
    if parsed.scheme not in {"http", "https"}:
        return None
    return _normalize_hostname(parsed.hostname)


def _normalize_hostname(value: str | None) -> str | None:
    if value is None:
        return None
    host = value.strip().lower()
    if host.startswith("[") and host.endswith("]"):
        host = host[1:-1]
    host = host.rstrip(".")
    return host or None


def _wildcard_bind_host(host: str) -> bool:
    normalized = _normalize_hostname(host)
    return normalized in WILDCARD_BIND_HOSTS


def _config(source: Request | WebSocket) -> WebAppConfig:
    return cast(WebAppConfig, source.app.state.config)


def resolve_project(source: Request | WebSocket) -> ProjectContext:
    base_config = _config(source)
    raw_project = source.headers.get(PROJECT_HEADER)
    if raw_project is None or not raw_project.strip():
        name = base_config.registry_session
        return ProjectContext(
            config=base_config,
            name=name,
            board=name,
            from_header=False,
        )
    name = raw_project.strip()
    if PROJECT_NAME_RE.fullmatch(name) is None:
        raise HTTPException(status_code=400, detail="invalid project")
    project_config = replace(base_config, registry_session=name)
    if not _registry_path(project_config).is_file():
        raise HTTPException(status_code=404, detail="project not found")
    return ProjectContext(
        config=project_config,
        name=name,
        board=name,
        from_header=True,
    )


def _resolve_board_id(board_id: str, *, project: ProjectContext) -> str:
    if not project.from_header:
        return board_id
    if board_id in {project.board, "main", "default"}:
        return project.board
    raise HTTPException(status_code=404, detail="board not found")


def _validated_ticket_scope(
    kind: str,
    pane_id: str | None,
    *,
    project: ProjectContext,
) -> tuple[str, str | None]:
    clean_kind = kind.strip().lower()
    if clean_kind not in TICKET_KINDS:
        raise HTTPException(status_code=400, detail="invalid ticket kind")
    clean_pane = pane_id.strip() if pane_id is not None else None
    if clean_pane == "":
        clean_pane = None
    if clean_kind == "board":
        if clean_pane is not None:
            raise HTTPException(status_code=400, detail="board tickets cannot bind a pane")
        return clean_kind, None
    if clean_pane is None:
        raise HTTPException(status_code=400, detail="terminal pane_id is required")
    if not _pane_allowed(clean_pane, config=project.config):
        raise HTTPException(status_code=400, detail="pane not allowed")
    return clean_kind, clean_pane


def _ws_ticket_request_scope(
    payload: WsTicketPayload | None,
    *,
    query_kind: str,
    query_pane_id: str | None,
) -> tuple[str, str | None]:
    if payload is None or not payload.model_fields_set:
        return query_kind, query_pane_id
    return payload.kind or "board", payload.pane_id


def _store(source: Request | WebSocket) -> SQLiteBoardStore:
    return cast(SQLiteBoardStore, source.app.state.store)


def _ticket_store(source: Request | WebSocket) -> TicketStore:
    return cast(TicketStore, source.app.state.ticket_store)


def _slack_config_path(config: WebAppConfig) -> Path:
    return config.grove_home / "slack.json"


def _consume_ticket(ticket_store: TicketStore, ticket: str) -> TicketGrant | None:
    return ticket_store.consume(ticket)


def _event_in_project(
    store: SQLiteBoardStore,
    event: BoardEvent,
    *,
    project: ProjectContext,
) -> bool:
    try:
        return store.board_slug_for_id(event.board_id) == project.board
    except KeyError:
        return False


def _task_for_project(store: SQLiteBoardStore, task_id: str, *, project: ProjectContext) -> Task:
    try:
        task = store.get_task_by_id(task_id)
        board_slug = store.board_slug_for_id(task.board_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail="task not found") from exc
    if not _task_board_visible(board_slug, project=project):
        raise HTTPException(status_code=404, detail="task not found")
    return task


def _task_board_visible(board_slug: str, *, project: ProjectContext) -> bool:
    if board_slug == project.board:
        return True
    return not project.from_header and board_slug in {"main", "default"}


def _index_response(config: WebAppConfig) -> HTMLResponse:
    index_path = config.dist_dir / "index.html"
    if not index_path.is_file():
        raise HTTPException(status_code=500, detail="web distribution not found")
    html = index_path.read_text(encoding="utf-8")
    injected = _bootstrap_script(config)
    if "<head>" in html:
        html = html.replace("<head>", f"<head>{injected}", 1)
    else:
        html = f"{injected}{html}"
    return HTMLResponse(html)


def _bootstrap_script(config: WebAppConfig) -> str:
    assignments = [
        f"window.__GROVE_AUTH_REQUIRED__ = {json.dumps(config.auth_required)};",
        f"window.__GROVE_AUTH_MODE__ = {json.dumps(config.auth_mode.value)};",
    ]
    if _token_bootstrap_allowed(config):
        assignments.insert(0, f"window.__GROVE_SESSION_TOKEN__ = {json.dumps(config.token)};")
    return "<script>" + "".join(assignments) + "</script>"


def _token_bootstrap_allowed(config: WebAppConfig) -> bool:
    if config.auth_mode != AuthMode.LOCAL_TOKEN:
        return False
    host = _normalize_hostname(config.host)
    return host in LOOPBACK_HOSTS or config.unsafe_bind_token_bootstrap


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


def _project_payloads(config: WebAppConfig) -> list[dict[str, object]]:
    if not config.grove_home.is_dir():
        return []
    projects: list[dict[str, object]] = []
    for registry_path in sorted(config.grove_home.glob("*/registry.json")):
        session_dir = registry_path.parent
        loaded = _read_json_mapping(registry_path, error_detail="invalid grove registry")
        raw_nodes = loaded.get("nodes")
        projects.append(
            {
                "name": session_dir.name,
                "workspace": _project_workspace(session_dir, loaded),
                "node_count": len(raw_nodes) if isinstance(raw_nodes, dict) else 0,
                "status": _tmux_session_status(session_dir.name),
            }
        )
    return projects


def _project_workspace(session_dir: Path, registry: Mapping[str, object]) -> str:
    for key in ("workspace", "workspace_path", "cwd"):
        value = _mapping_string(registry, key)
        if value is not None:
            return value
    raw_project = registry.get("project")
    if isinstance(raw_project, Mapping):
        project = _string_mapping(raw_project)
        for key in ("workspace", "workspace_path", "cwd"):
            value = _mapping_string(project, key)
            if value is not None:
                return value
    project_file = session_dir / "project.json"
    if project_file.is_file():
        project = _read_json_mapping(project_file, error_detail="invalid grove project")
        for key in ("workspace", "workspace_path", "cwd"):
            value = _mapping_string(project, key)
            if value is not None:
                return value
    return ""


def _tmux_session_status(session: str) -> str:
    try:
        proc = subprocess.run(
            ["tmux", "has-session", "-t", session],
            capture_output=True,
            timeout=TMUX_TIMEOUT_SECONDS,
            check=False,
        )
    except (FileNotFoundError, subprocess.TimeoutExpired, OSError):
        return "stopped"
    return "running" if proc.returncode == 0 else "stopped"


def _create_project(payload: ProjectCreatePayload) -> dict[str, object]:
    name = _validated_node_ref(payload.name, field_name="project name")
    template = _optional_text(payload.template, field_name="template", max_length=200)
    clone = _optional_text(payload.clone, field_name="clone", max_length=2000)
    args = ["grove", "new-project", name]
    if template is not None:
        args.extend(["--template", template])
    if clone is not None:
        args.extend(["--clone", clone])
    args.append("--json")
    return _run_grove_json(args, failure_detail="grove new-project failed")


def _load_project(payload: ProjectLoadPayload) -> dict[str, object]:
    project_path = payload.path.strip()
    if not project_path:
        raise HTTPException(status_code=400, detail="path is required")
    return _run_grove_json(
        ["grove", "load-project", project_path, "--json"],
        failure_detail="grove load-project failed",
    )


def _run_grove_json(args: list[str], *, failure_detail: str) -> dict[str, object]:
    try:
        proc = subprocess.run(
            args,
            capture_output=True,
            text=True,
            timeout=GROVE_PROJECT_TIMEOUT_SECONDS,
            check=False,
        )
    except FileNotFoundError as exc:
        raise HTTPException(status_code=400, detail="grove CLI not found") from exc
    except subprocess.TimeoutExpired as exc:
        raise HTTPException(status_code=400, detail=f"{failure_detail}: timed out") from exc
    if proc.returncode != 0:
        raise HTTPException(
            status_code=400,
            detail=_safe_cli_error(proc.stdout, proc.stderr, fallback=failure_detail),
        )
    try:
        loaded: object = json.loads(proc.stdout)
    except json.JSONDecodeError as exc:
        raise HTTPException(status_code=400, detail=f"{failure_detail}: invalid json") from exc
    if not isinstance(loaded, dict):
        raise HTTPException(status_code=400, detail=f"{failure_detail}: invalid json")
    return {str(key): value for key, value in loaded.items()}


def _safe_cli_error(stdout: str, stderr: str, *, fallback: str) -> str:
    raw = "\n".join(part for part in (stderr, stdout) if part.strip())
    if not raw.strip():
        return fallback
    if STACK_TRACE_RE.search(raw) is not None:
        return fallback
    sanitized = ABSOLUTE_PATH_RE.sub("[path]", raw)
    if "[path]" in sanitized:
        return fallback
    return _summary_text(sanitized) or fallback


def _load_registry(config: WebAppConfig) -> dict[str, object]:
    path = _registry_path(config)
    if not path.is_file():
        return {"nodes": {}}
    return _read_json_mapping(path, error_detail="invalid grove registry")


def _read_json_mapping(path: Path, *, error_detail: str) -> dict[str, object]:
    try:
        loaded = json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError) as exc:
        raise HTTPException(status_code=500, detail=error_detail) from exc
    if not isinstance(loaded, dict):
        raise HTTPException(status_code=500, detail=error_detail)
    return cast(dict[str, object], loaded)


def _registry_nodes(config: WebAppConfig) -> list[dict[str, str]]:
    return [
        {
            "name": node["name"],
            "agent": node["agent"],
            "tmux_pane": node["tmux_pane"],
            "session_id": node["session_id"],
            "status": node["status"],
            "description": node["description"],
        }
        for node in _registry_node_records(config)
    ]


def _registry_node_records(config: WebAppConfig) -> list[dict[str, str]]:
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
                "role": _mapping_string(node, "role") or "",
                "parent": _mapping_string(node, "parent") or "",
                "group": _mapping_string(node, "group") or "",
                "description": _mapping_string(node, "description") or "",
            }
        )
    return sorted(nodes, key=lambda node: node["name"])


def _org_payload(config: WebAppConfig) -> dict[str, object]:
    nodes = _registry_node_records(config)
    names = {node["name"] for node in nodes}
    children_by_parent: dict[str, list[str]] = {name: [] for name in names}
    groups: dict[str, list[str]] = {}
    for node in nodes:
        parent = node["parent"]
        if parent in names:
            children_by_parent[parent].append(node["name"])
        group = node["group"]
        if group:
            groups.setdefault(group, []).append(node["name"])

    graph_nodes: list[dict[str, object]] = []
    for node in nodes:
        parent = node["parent"] if node["parent"] in names else ""
        graph_nodes.append(
            {
                "name": node["name"],
                "agent": node["agent"],
                "role": node["role"],
                "parent": parent,
                "children": sorted(children_by_parent[node["name"]]),
                "group": node["group"],
                "tmux_pane": node["tmux_pane"],
                "session_id": node["session_id"],
                "status": node["status"],
                "description": node["description"],
            }
        )

    return {
        "session": config.registry_session,
        "roots": sorted(
            node["name"] for node in nodes if not node["parent"] or node["parent"] not in names
        ),
        "groups": [
            {"name": group, "nodes": sorted(group_nodes)}
            for group, group_nodes in sorted(groups.items())
        ],
        "nodes": graph_nodes,
    }


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
        ["tmux", "capture-pane", "-p", "-e", "-J", "-t", pane],
        capture_output=True,
        timeout=TMUX_TIMEOUT_SECONDS,
        check=False,
    )
    if proc.returncode != 0:
        raise RuntimeError(proc.stderr.decode("utf-8", errors="replace").strip())
    return proc.stdout


def _spawn_node(payload: NodeCreatePayload, *, config: WebAppConfig) -> dict[str, object]:
    name = _validated_node_ref(payload.name, field_name="name")
    agent = payload.agent.strip()
    if agent not in NODE_AGENTS:
        raise HTTPException(status_code=400, detail="agent must be codex, claude, or antigravity")
    role = _optional_text(payload.role, field_name="role", max_length=200)
    description = _optional_text(payload.description, field_name="description", max_length=1000)
    parent = _optional_node_ref(payload.parent, field_name="parent")
    group = _optional_node_ref(payload.group, field_name="group")
    args = ["grove", "spawn", "--name", name, "--agent", agent]
    if role is not None:
        args.extend(["--role", role])
    if description is not None:
        args.extend(["--description", description])
    if parent is not None:
        args.extend(["--parent", parent])
    if group is not None:
        args.extend(["--group", group])
    if payload.window is not None:
        args.extend(["--window", str(payload.window)])
    args.extend(["--session", config.registry_session, "--json"])
    try:
        proc = subprocess.run(
            args,
            capture_output=True,
            text=True,
            timeout=GROVE_SPAWN_TIMEOUT_SECONDS,
            check=False,
        )
    except FileNotFoundError as exc:
        raise HTTPException(status_code=400, detail="grove CLI not found") from exc
    except subprocess.TimeoutExpired as exc:
        raise HTTPException(status_code=400, detail="grove spawn timed out") from exc
    if proc.returncode != 0:
        raise HTTPException(
            status_code=400,
            detail=_safe_cli_error(proc.stdout, proc.stderr, fallback="grove spawn failed"),
        )
    try:
        loaded: object = json.loads(proc.stdout)
    except json.JSONDecodeError as exc:
        raise HTTPException(status_code=400, detail="grove spawn returned invalid json") from exc
    if not isinstance(loaded, dict):
        raise HTTPException(status_code=400, detail="grove spawn returned invalid json")
    return {str(key): value for key, value in loaded.items()}


def _node_name_from_spawn_result(payload: Mapping[str, object], *, fallback: str) -> str:
    for key in ("name", "node", "id"):
        value = payload.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    raw_node = payload.get("node")
    if isinstance(raw_node, Mapping):
        value = raw_node.get("name")
        if isinstance(value, str) and value.strip():
            return value.strip()
    return fallback


def _update_node_relationships(
    name: str,
    payload: NodeUpdatePayload,
    *,
    config: WebAppConfig,
) -> dict[str, object]:
    target_name = _validated_node_ref(name, field_name="name")
    registry_path, registry, raw_nodes = _load_mutable_registry(config)
    nodes_by_name = _nodes_by_name(raw_nodes)
    target = nodes_by_name.get(target_name)
    if target is None:
        raise HTTPException(status_code=404, detail="node not found")

    if "parent" in payload.model_fields_set:
        new_parent = _optional_node_ref(payload.parent, field_name="parent")
        if new_parent is not None and new_parent not in nodes_by_name:
            raise HTTPException(status_code=404, detail="parent not found")
        if new_parent is not None and (
            new_parent == target_name or new_parent in _descendant_names(target_name, nodes_by_name)
        ):
            raise HTTPException(status_code=400, detail="parent would create a cycle")
        _set_node_parent(target_name, target, new_parent, nodes_by_name)

    if "group" in payload.model_fields_set:
        new_group = _optional_node_ref(payload.group, field_name="group")
        if new_group is None:
            target.pop("group", None)
        else:
            target["group"] = new_group

    if "description" in payload.model_fields_set:
        new_description = _optional_text(
            payload.description,
            field_name="description",
            max_length=1000,
        )
        if new_description is None:
            target.pop("description", None)
        else:
            target["description"] = new_description

    _write_registry_atomic(registry_path, registry)
    return _org_payload(config)


def _load_mutable_registry(
    config: WebAppConfig,
) -> tuple[Path, dict[str, object], dict[str, object]]:
    path = _registry_path(config)
    if not path.is_file():
        raise HTTPException(status_code=404, detail="registry not found")
    loaded = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(loaded, dict):
        raise HTTPException(status_code=500, detail="invalid grove registry")
    registry = cast(dict[str, object], loaded)
    raw_nodes = registry.get("nodes")
    if not isinstance(raw_nodes, dict):
        raise HTTPException(status_code=500, detail="invalid grove registry")
    return path, registry, cast(dict[str, object], raw_nodes)


def _nodes_by_name(raw_nodes: Mapping[str, object]) -> dict[str, dict[str, object]]:
    nodes: dict[str, dict[str, object]] = {}
    for key, raw_node in raw_nodes.items():
        if not isinstance(raw_node, dict):
            continue
        node = cast(dict[str, object], raw_node)
        name = _mapping_string(node, "name") or key
        nodes[name] = node
    return nodes


def _set_node_parent(
    target_name: str,
    target: dict[str, object],
    new_parent: str | None,
    nodes_by_name: Mapping[str, dict[str, object]],
) -> None:
    for node in nodes_by_name.values():
        _set_node_children(node, [child for child in _node_children(node) if child != target_name])
    if new_parent is None:
        target.pop("parent", None)
        return
    target["parent"] = new_parent
    parent_node = nodes_by_name[new_parent]
    children = _node_children(parent_node)
    if target_name not in children:
        children.append(target_name)
    _set_node_children(parent_node, children)


def _descendant_names(
    name: str,
    nodes_by_name: Mapping[str, dict[str, object]],
) -> set[str]:
    descendants: set[str] = set()
    pending = list(_direct_children(name, nodes_by_name))
    while pending:
        child = pending.pop()
        if child in descendants:
            continue
        descendants.add(child)
        pending.extend(_direct_children(child, nodes_by_name))
    return descendants


def _direct_children(
    name: str,
    nodes_by_name: Mapping[str, dict[str, object]],
) -> set[str]:
    children = set(_node_children(nodes_by_name.get(name, {})))
    for node_name, node in nodes_by_name.items():
        if _mapping_string(node, "parent") == name:
            children.add(node_name)
    return children


def _node_children(node: Mapping[str, object]) -> list[str]:
    raw_children = node.get("children")
    if not isinstance(raw_children, list):
        return []
    return [child for child in raw_children if isinstance(child, str)]


def _set_node_children(node: dict[str, object], children: list[str]) -> None:
    unique_children = list(dict.fromkeys(children))
    node["children"] = unique_children


def _write_registry_atomic(path: Path, registry: Mapping[str, object]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp_path = path.with_name(f".{path.name}.{secrets.token_hex(8)}.tmp")
    fd = os.open(temp_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            fd = -1
            handle.write(json.dumps(registry, indent=2) + "\n")
        os.replace(temp_path, path)
    except Exception:
        if fd >= 0:
            os.close(fd)
        try:
            temp_path.unlink()
        except FileNotFoundError:
            pass
        raise


def _validated_node_ref(value: str, *, field_name: str) -> str:
    stripped = value.strip()
    if NODE_NAME_RE.fullmatch(stripped) is None:
        raise HTTPException(
            status_code=400,
            detail=f"{field_name} must contain only letters, digits, hyphen, or underscore",
        )
    return stripped


def _optional_node_ref(value: str | None, *, field_name: str) -> str | None:
    if value is None:
        return None
    stripped = value.strip()
    if not stripped:
        return None
    return _validated_node_ref(stripped, field_name=field_name)


def _optional_text(value: str | None, *, field_name: str, max_length: int) -> str | None:
    if value is None:
        return None
    stripped = value.strip()
    if not stripped:
        return None
    if len(stripped) > max_length:
        raise HTTPException(status_code=400, detail=f"{field_name} is too long")
    return stripped


def _optional_config_text(value: str | None) -> str | None:
    if value is None:
        return None
    stripped = value.strip()
    return stripped or None


def _summary_text(value: str) -> str:
    return re.sub(r"\s+", " ", value).strip()[:500]


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


def _slack_thread_payload(thread: SlackThread) -> dict[str, object]:
    return {
        "task_id": thread.task_id,
        "team_id": thread.team_id,
        "channel_id": thread.channel_id,
        "thread_ts": thread.thread_ts,
        "mode": thread.mode,
        "node": thread.node,
    }


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


def _audit_event_payload(
    store: SQLiteBoardStore,
    event: BoardEvent,
    *,
    project: ProjectContext,
) -> dict[str, object]:
    payload = dict(event.payload)
    rendered: dict[str, object] = {
        "cursor": event.cursor,
        "id": event.id,
        "ts": event.created_at,
        "type": event.kind,
        "project": project.name,
        "board_id": event.board_id,
        "task_id": event.task_id,
        "run_id": event.run_id,
        "actor": payload.get("actor"),
        "action": payload.get("action"),
        "target": payload.get("target"),
    }
    try:
        rendered["board"] = store.board_slug_for_id(event.board_id)
    except KeyError:
        rendered["board"] = project.board
    for key in ("from_node", "to_node", "status", "summary", "source", "confidence"):
        if key in payload:
            rendered[key] = payload[key]
    return rendered


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
    parser.add_argument(
        "--unsafe-bind",
        action="store_true",
        help=(
            "Inject the session token into HTML even when binding to a non-loopback host. "
            "Required for intentional remote access; unsafe on untrusted networks."
        ),
    )
    parser.add_argument(
        "--allow-host",
        action="append",
        default=[],
        metavar="HOST[,HOST...]",
        help=(
            "Allow state-changing requests for these Host/Origin hosts. "
            "May be repeated or comma-separated; loopback hosts are always allowed."
        ),
    )
    parser.add_argument(
        "--team-auth",
        action="store_true",
        help=(
            "Use team cookie sessions with member login and CSRF instead of local dashboard tokens."
        ),
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
        unsafe_bind_token_bootstrap=args.unsafe_bind,
        allowed_hosts=_normalize_allowed_hosts(args.allow_host),
        auth_mode=AuthMode.TEAM_COOKIE if args.team_auth else AuthMode.LOCAL_TOKEN,
    )
    app = create_app(config=config)
    started_at = cast(int, app.state.started_at)
    try:
        uvicorn.run(app, host=config.host, port=config.port)
    finally:
        _remove_web_companion(config, started_at=started_at)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
