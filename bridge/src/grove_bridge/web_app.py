"""Grove dev-room web server."""

from __future__ import annotations

import argparse
import asyncio
import base64
import hashlib
import hmac
import importlib.metadata
import ipaddress
import json
import logging
import os
import re
import secrets
import subprocess
import sys
import time
from collections.abc import Awaitable, Callable, Iterable, Mapping, Sequence
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
    MEMBER_ROLES,
    TEAM_SESSION_COOKIE,
    TEAM_SESSION_TTL_SECONDS,
    IssuedSession,
    MemberRegistry,
    MemberRole,
    SessionSigner,
    TeamJoinCodeStore,
    TeamMember,
    TeamSessionStore,
    bootstrap_hint,
    hash_secret,
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
TAILSCALE_IP_TIMEOUT_SECONDS = 1.0
TRANSCRIPT_MAX_BYTES = 2_000_000
MAX_TIMESTAMP_SECONDS = 4_102_444_800
PRESENCE_ACTIVE_SECONDS = 5 * 60
SUMMARY_FRESHNESS_SECONDS = 5 * 60
SUMMARY_CLOCK_SKEW_SECONDS = 60
HANDOFF_TTL_SECONDS = 24 * 60 * 60
SUMMARY_SCHEMA = "grove.summary.v1"
HANDOFF_SCHEMA = "grove.handoff.v1"
SUMMARY_ALGORITHM = "hmac-sha256"
SUMMARY_OTHER_BUCKET = "other"
SUMMARY_TRUSTED_KEYS_FILENAME = "summary-trusted-keys.json"
SUMMARY_TASK_STATUSES = frozenset({"ready", "running", "blocked", "done", "archived"})
SUMMARY_RUN_STATUSES = frozenset({"running", "ok", "blocked", "failed", "released"})
SUMMARY_NODE_STATUSES = frozenset({"running", "idle", "error", "blocked", "dead", "stale"})
SUMMARY_NODE_AGENTS = frozenset({"codex", "claude", "antigravity", "agy"})
TMUX_PANE_RE = re.compile(r"^(?P<session>[A-Za-z0-9_.-]+):(?P<window>[0-9]+)\.(?P<pane>[0-9]+)$")
NODE_NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]*$")
PROJECT_NAME_RE = NODE_NAME_RE
HANDOFF_ID_RE = re.compile(r"^handoff_[A-Za-z0-9_-]{16,}$")
JOIN_MEMBER_NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_. -]{0,63}$")
NOTIFICATION_TEXT_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$")
BOARD_NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]*$")
ABSOLUTE_PATH_RE = re.compile(r"(?<![A-Za-z0-9_./-])/(?!/)[^\s'\"()<>]+")
EMAIL_RE = re.compile(r"\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b")
STACK_TRACE_RE = re.compile(r"(?i)(traceback|\bfile \"|\bat .+\(.+:\d+:\d+\))")
NODE_AGENTS = frozenset({"codex", "claude", "antigravity"})
COST_AGENTS = ("codex", "claude", "agy")
RETRO_ANALYTICS_SMALL_SAMPLE = 3
RETRO_SLOW_RUN_SECONDS = 60 * 60
USAGE_TREND_WINDOWS = {"7d": 7, "14d": 14, "30d": 30}
USAGE_TREND_MIN_BASELINE_DAYS = 3
USAGE_TREND_SPIKE_RATIO = 2.0
USAGE_TREND_SPIKE_ZSCORE = 3.0
RETRO_THEME_TERMS: dict[str, tuple[str, ...]] = {
    "testing": ("test", "tests", "pytest", "coverage", "flake", "flaky"),
    "blocked": ("blocked", "stuck", "waiting", "dependency"),
    "scope": ("scope", "requirement", "contract"),
    "review": ("review", "reviewer", "feedback"),
    "tooling": ("ruff", "mypy", "pytest", "lint", "format", "tooling"),
}
PLAN_ROLE_WEIGHT = 50.0
PLAN_CAPABILITY_WEIGHT = 20.0
PLAN_LOAD_WEIGHT = 30.0
PLAN_COST_WEIGHT = 10.0
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
PROJECT_BOARD_ALIASES = frozenset({"main", "default"})
DELEGATE_BOARD_ALIASES = frozenset({"dev-room"})
DELEGATE_BOARD_OWNER_PROJECT = "dev10"
LEAD_NODE_NAME = "lead"


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
    summary_export_enabled: bool = False
    summary_freshness_seconds: int = SUMMARY_FRESHNESS_SECONDS
    summary_trusted_keys_path: Path | None = None
    handoff_enabled: bool = False
    handoff_ttl_seconds: int = HANDOFF_TTL_SECONDS
    shared_access: bool = False
    shared_join_role: MemberRole = "operator"
    quota_enabled: bool = False
    slack_intake_enabled: bool = False
    retro_analytics_enabled: bool = False
    usage_trend_enabled: bool = False

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
        auth_mode = AuthMode(self.auth_mode)
        if self.shared_access:
            auth_mode = AuthMode.TEAM_COOKIE
        object.__setattr__(self, "auth_mode", auth_mode)
        if self.shared_join_role not in MEMBER_ROLES:
            raise ValueError("shared join role is invalid")
        if self.shared_access and self.shared_join_role == "admin":
            LOGGER.warning(
                "event=shared_access_admin_join_role message=join-codes-will-create-admin-members"
            )
        if self.shared_access and _is_shared_remote_bind(self.host) and not self.allowed_hosts:
            raise ValueError("shared access on non-loopback bind requires --allow-host")
        if self.summary_trusted_keys_path is not None:
            object.__setattr__(
                self,
                "summary_trusted_keys_path",
                self.summary_trusted_keys_path.expanduser(),
            )
        if self.summary_freshness_seconds <= 0:
            raise ValueError("summary freshness must be positive")
        if self.handoff_ttl_seconds <= 0:
            raise ValueError("handoff ttl must be positive")


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


@dataclass(frozen=True)
class PlanCandidateDraft:
    node: str
    payload: dict[str, object]
    role_score: float
    capability_score: float
    load_score: float
    token_signal: float | None
    cost_usd_signal: float | None
    cost_source: str
    cost_confidence: str


@dataclass(frozen=True)
class UsageTrendDay:
    day: str
    total_tokens: int | None
    cost_usd: float | None


class CommentPayload(BaseModel):
    author: str = Field(default="dev-room", min_length=1, max_length=200)
    body: str = Field(min_length=1, max_length=20_000)


class AnswerPayload(BaseModel):
    text: str = Field(min_length=1, max_length=20_000)


class RetroPayload(BaseModel):
    text: str = Field(min_length=1, max_length=20_000)
    node: str | None = Field(default=None, max_length=200)


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


class AutoPickupTogglePayload(BaseModel):
    enabled: bool


class ExecutionTogglePayload(BaseModel):
    enabled: bool


class ExecutionAbortPayload(BaseModel):
    reason: str = Field(default="aborted by operator", max_length=2000)


class ExecutionGatePayload(BaseModel):
    enabled: bool | None = None
    kill_switch: bool | None = None
    board_enabled: bool | None = None
    board_kill_switch: bool | None = None


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


class QuotaPayload(BaseModel):
    member_id: str = Field(min_length=1, max_length=200)
    enabled: bool = True
    soft_run_limit: int | None = Field(default=None, ge=0)
    soft_token_limit: int | None = Field(default=None, ge=0)
    soft_cost_usd: float | None = Field(default=None, ge=0)


class NotificationTargetPayload(BaseModel):
    channel_kind: str = Field(min_length=1, max_length=100)
    room_id: str = Field(min_length=1, max_length=200)


class NotificationRoutePayload(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    event_type: str = Field(default="*", min_length=1, max_length=50)
    node: str | None = Field(default=None, max_length=100)
    severity: str | None = Field(default=None, max_length=50)
    target: NotificationTargetPayload
    escalate_after_seconds: int | None = Field(default=None, ge=0, le=86_400)
    escalation_targets: list[NotificationTargetPayload] = Field(default_factory=list, max_length=5)
    max_escalations: int = Field(default=0, ge=0, le=5)


class NotificationRoutingPayload(BaseModel):
    enabled: bool = False
    dry_run: bool = True
    rules: list[NotificationRoutePayload] = Field(default_factory=list, max_length=50)


class SavedViewPayload(BaseModel):
    name: str = Field(min_length=1, max_length=64)
    filters: dict[str, object] = Field(default_factory=dict)


class WsTicketPayload(BaseModel):
    kind: str | None = Field(default=None, max_length=50)
    pane_id: str | None = Field(default=None, max_length=200)


class LoginPayload(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    secret: str = Field(min_length=1, max_length=5000)


class JoinPayload(BaseModel):
    code: str = Field(min_length=1, max_length=200)
    name: str = Field(min_length=1, max_length=80)


class AggregatePayload(BaseModel):
    summaries: list[dict[str, object]] = Field(default_factory=list, max_length=100)


class HandoffExportPayload(BaseModel):
    task_id: str = Field(min_length=1, max_length=200)


class HandoffAcceptPayload(BaseModel):
    package: dict[str, object]


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
    app.state.team_join_code_store = TeamJoinCodeStore()
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

    @app.get("/api/share")
    def share_get_endpoint() -> dict[str, object]:
        raise HTTPException(status_code=405, detail="share code issuance requires POST")

    @app.post("/api/share")
    def share_endpoint(request: Request) -> dict[str, object]:
        config_value = _config(request)
        _require_shared_access_enabled(config_value)
        _require_operator_state_change(request, detail="share requires operator role")
        record = _team_join_code_store(request).issue(role=config_value.shared_join_role)
        return {
            "code": record.code,
            "role": record.role,
            "expires_at": record.expires_at,
            "url": _share_url(request, record.code),
        }

    @app.post("/api/join")
    def join_endpoint(
        request: Request,
        response: Response,
        payload: JoinPayload,
    ) -> dict[str, object]:
        config_value = _config(request)
        _require_shared_access_enabled(config_value)
        _require_allowed_origin(request)
        clean_name = _validated_join_name(payload.name)
        record, failure = _team_join_code_store(request).consume(
            payload.code,
            client_key=_join_client_key(request),
        )
        if failure == "rate_limited":
            raise HTTPException(status_code=429, detail="join rate limit exceeded")
        if failure == "expired":
            raise HTTPException(status_code=410, detail="join code expired")
        if record is None:
            raise HTTPException(status_code=403, detail="invalid join code")
        registry = _member_registry(config_value)
        members = registry.list_members()
        if any(member.name == clean_name for member in members):
            raise HTTPException(status_code=409, detail="member name already exists")
        member = TeamMember(
            id="member_" + secrets.token_urlsafe(12),
            name=clean_name,
            role=record.role,
            secret_hash=hash_secret(secrets.token_urlsafe(32)),
        )
        registry.add_member(member)
        issued = _session_signer(config_value).issue(member)
        _team_session_store(request).add(issued)
        _set_team_session_cookie(response, request=request, issued=issued)
        return {
            "auth_mode": config_value.auth_mode.value,
            "member": member.to_payload(),
            "csrf": issued.csrf_token,
            "expires_at": issued.expires_at,
        }

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

    @app.get("/api/presence")
    def presence_endpoint(request: Request) -> dict[str, object]:
        auth = _require_auth(request)
        project = resolve_project(request)
        return _presence_payload(request, project=project, auth=auth)

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

    @app.get("/api/usage")
    def usage_endpoint(
        request: Request,
        window: str = Query(default="7d"),
        project_name: str | None = Query(default=None, alias="project"),
        node: str | None = Query(default=None),
        agent: str | None = Query(default=None),
    ) -> dict[str, object]:
        auth = _require_auth(request)
        _require_cost_access(auth)
        project = _cost_project_context(request, project_name)
        return _usage_payload(
            _store(request),
            project=project,
            window=window,
            node_filter=node,
            agent_filter=agent,
        )

    @app.get("/api/usage/trend")
    def usage_trend_endpoint(
        request: Request,
        window: str = Query(default="14d"),
        project_name: str | None = Query(default=None, alias="project"),
        member: str | None = Query(default=None),
    ) -> dict[str, object]:
        auth = _require_auth(request)
        _require_cost_access(auth)
        config_value = _config(request)
        _require_usage_trend_enabled(config_value)
        project = _cost_project_context(request, project_name)
        return _usage_trend_payload(
            _store(request),
            project=project,
            auth=auth,
            window=window,
            member_filter=member,
        )

    @app.get("/api/ledger")
    def ledger_endpoint(
        request: Request,
        window: str = Query(default="7d"),
        project_name: str | None = Query(default=None, alias="project"),
        member: str | None = Query(default=None),
    ) -> dict[str, object]:
        auth = _require_auth(request)
        project = _cost_project_context(request, project_name)
        member_filter = _ledger_member_filter(auth, member)
        return _ledger_payload(
            _store(request),
            project=project,
            auth=auth,
            window=window,
            member_filter=member_filter,
            quota_enabled=_config(request).quota_enabled,
        )

    @app.get("/api/retro/analytics")
    def retro_analytics_endpoint(
        request: Request,
        window: str = Query(default="7d"),
        project_name: str | None = Query(default=None, alias="project"),
    ) -> dict[str, object]:
        auth = _require_auth(request)
        _require_retro_access(auth)
        config_value = _config(request)
        _require_retro_analytics_enabled(config_value)
        project = _cost_project_context(request, project_name)
        return _retro_analytics_payload(
            _store(request),
            project=project,
            auth=auth,
            window=window,
        )

    @app.post("/api/quota")
    def quota_endpoint(request: Request, payload: QuotaPayload) -> dict[str, object]:
        config_value = _config(request)
        _require_quota_enabled(config_value)
        auth = _require_operator_state_change(request, detail="quota requires operator role")
        project = resolve_project(request)
        member_id = _quota_member_id(payload.member_id, config=config_value)
        state = _store(request).set_member_quota(
            board=project.board,
            member_id=member_id,
            enabled=payload.enabled,
            soft_run_limit=payload.soft_run_limit,
            soft_token_limit=payload.soft_token_limit,
            soft_cost_usd=payload.soft_cost_usd,
        )
        _store(request).add_audit_event(
            board=project.board,
            kind="audit.quota.update",
            actor=_actor_payload(auth),
            action="quota-update",
            target={"type": "member", "id": member_id},
            payload={
                "project": project.name,
                "member_id": member_id,
                "quota": state,
                "hard_kill": False,
            },
            summary=f"quota updated for {member_id}",
        )
        return {
            "ok": True,
            "project": project.name,
            "member": _ledger_member_payload(member_id, _member_lookup(config_value)),
            "quota": _quota_public_payload(state, usage=_unknown_usage(), quota_enabled=True),
        }

    @app.get("/api/notifications/routing")
    def notification_routing_get_endpoint(request: Request) -> dict[str, object]:
        _require_auth(request)
        project = resolve_project(request)
        return {
            "project": project.name,
            "routing": _store(request).notification_routing_state(board=project.board),
        }

    @app.post("/api/notifications/routing")
    def notification_routing_post_endpoint(
        request: Request,
        payload: NotificationRoutingPayload,
    ) -> dict[str, object]:
        auth = _require_operator_state_change(
            request,
            detail="notification routing requires operator role",
        )
        project = resolve_project(request)
        state = _store(request).set_notification_routing(
            board=project.board,
            state=_notification_routing_state_from_payload(payload),
        )
        _store(request).add_audit_event(
            board=project.board,
            kind="audit.notification.routing",
            actor=_actor_payload(auth),
            action="notification-routing-config",
            target={"type": "notification_routing", "id": project.name},
            payload={"project": project.name, "routing": state},
            summary="notification routing updated",
        )
        return {"ok": True, "project": project.name, "routing": state}

    @app.get("/api/summary")
    def summary_endpoint(
        request: Request,
        project_name: str | None = Query(default=None, alias="project"),
    ) -> dict[str, object]:
        _require_auth(request)
        config_value = _config(request)
        _require_summary_enabled(config_value)
        project = _cost_project_context(request, project_name)
        return _signed_summary_payload(_store(request), project=project)

    @app.post("/api/aggregate")
    def aggregate_endpoint(
        request: Request,
        payload: AggregatePayload,
        project_name: str | None = Query(default=None, alias="project"),
    ) -> dict[str, object]:
        _require_auth(request)
        config_value = _config(request)
        _require_summary_enabled(config_value)
        project = _cost_project_context(request, project_name)
        return _aggregate_summary_payload(project.config, payload)

    @app.get("/api/handoff/export")
    def handoff_export_get_endpoint(
        request: Request,
        task_id: str = Query(min_length=1, max_length=200),
        project_name: str | None = Query(default=None, alias="project"),
    ) -> dict[str, object]:
        auth = _require_operator_state_change(request, detail="handoff requires operator role")
        config_value = _config(request)
        _require_handoff_enabled(config_value)
        project = _cost_project_context(request, project_name)
        task = _task_for_project(_store(request), task_id, project=project)
        return _signed_handoff_payload(_store(request), project=project, task=task, auth=auth)

    @app.post("/api/handoff/export")
    def handoff_export_post_endpoint(
        request: Request,
        payload: HandoffExportPayload,
        project_name: str | None = Query(default=None, alias="project"),
    ) -> dict[str, object]:
        auth = _require_operator_state_change(request, detail="handoff requires operator role")
        config_value = _config(request)
        _require_handoff_enabled(config_value)
        project = _cost_project_context(request, project_name)
        task = _task_for_project(_store(request), payload.task_id, project=project)
        return _signed_handoff_payload(_store(request), project=project, task=task, auth=auth)

    @app.post("/api/handoff/accept")
    def handoff_accept_endpoint(
        request: Request,
        payload: HandoffAcceptPayload,
        project_name: str | None = Query(default=None, alias="project"),
    ) -> dict[str, object]:
        auth = _require_operator_state_change(request, detail="handoff requires operator role")
        config_value = _config(request)
        _require_handoff_enabled(config_value)
        project = _cost_project_context(request, project_name)
        return _accept_handoff_payload(
            _store(request),
            config=project.config,
            project=project,
            package=payload.package,
            auth=auth,
        )

    @app.get("/api/plan")
    def plan_endpoint(
        request: Request,
        role: str = Query(min_length=1, max_length=200),
        task_id: str = Query(min_length=1, max_length=200),
    ) -> dict[str, object]:
        _require_auth(request)
        project = resolve_project(request)
        task = _task_for_project(_store(request), task_id, project=project)
        return _plan_payload(_store(request), project=project, task=task, role=role)

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
        auth = _require_operator_state_change(
            request,
            detail="project mutation requires operator role",
        )
        result = _create_project(payload)
        project = resolve_project(request)
        _store(request).add_audit_event(
            board=project.board,
            kind="audit.project.create",
            actor=_actor_payload(auth),
            action="create",
            target={"type": "project", "name": result.get("name", payload.name)},
            payload={"project": project.name},
            summary=str(result.get("name", payload.name)),
        )
        return result

    @app.post("/api/projects/load")
    def load_project_endpoint(
        request: Request,
        payload: ProjectLoadPayload,
    ) -> dict[str, object]:
        auth = _require_operator_state_change(
            request,
            detail="project mutation requires operator role",
        )
        result = _load_project(payload)
        project = resolve_project(request)
        _store(request).add_audit_event(
            board=project.board,
            kind="audit.project.load",
            actor=_actor_payload(auth),
            action="load",
            target={"type": "project", "path": payload.path},
            payload={"project": project.name},
            summary=str(result.get("name", "load-project")),
        )
        return result

    @app.get("/api/boards")
    def boards_endpoint(request: Request) -> list[dict[str, object]]:
        _require_auth(request)
        project = resolve_project(request)
        boards = _store(request).list_boards()
        if project.from_header:
            allowed_boards = {project.board}
            if project.name == DELEGATE_BOARD_OWNER_PROJECT:
                allowed_boards.update(DELEGATE_BOARD_ALIASES)
            boards = [board for board in boards if board.id in allowed_boards]
        return [_board_payload(board) for board in boards]

    @app.get("/api/boards//tasks")
    def empty_board_tasks_get_endpoint(request: Request) -> None:
        _require_auth(request)
        raise HTTPException(status_code=400, detail="board id is required")

    @app.post("/api/boards//tasks")
    def empty_board_tasks_post_endpoint(request: Request) -> None:
        _require_operator_state_change(request, detail="task mutation requires operator role")
        raise HTTPException(status_code=400, detail="board id is required")

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

    @app.get("/api/boards/{board_id}/query")
    def board_query_endpoint(
        request: Request,
        board_id: str,
        status_filter: str | None = Query(default=None, alias="status"),
        assignee: str | None = Query(default=None),
        label: str | None = Query(default=None),
        q: str | None = Query(default=None, max_length=500),
        cursor: int = Query(default=0, ge=0),
        limit: int = Query(default=50, ge=1, le=100),
        view: str | None = Query(default=None, max_length=64),
    ) -> dict[str, object]:
        _require_auth(request)
        project = resolve_project(request)
        resolved_board = _resolve_board_id(board_id, project=project)
        filters = _board_query_filters(
            _store(request),
            board=resolved_board,
            view=view,
            status=status_filter,
            assignee=assignee,
            label=label,
            q=q,
            limit=limit,
        )
        tasks, next_cursor, total = _store(request).query_tasks(
            board=resolved_board,
            status=cast(str | None, filters.get("status")),
            assignee=cast(str | None, filters.get("assignee")),
            label=cast(str | None, filters.get("label")),
            text=cast(str | None, filters.get("q")),
            cursor=cursor,
            limit=cast(int, filters["limit"]),
        )
        return {
            "project": project.name,
            "board": resolved_board,
            "filters": _safe_query_filters(filters),
            "items": [_query_task_payload(task) for task in tasks],
            "pagination": {
                "cursor": cursor,
                "limit": filters["limit"],
                "next_cursor": next_cursor,
                "total": total,
            },
        }

    @app.get("/api/boards/{board_id}/views")
    def board_saved_views_endpoint(request: Request, board_id: str) -> dict[str, object]:
        _require_auth(request)
        project = resolve_project(request)
        resolved_board = _resolve_board_id(board_id, project=project)
        views = _store(request).saved_views(board=resolved_board)
        return {
            "project": project.name,
            "board": resolved_board,
            "views": _saved_view_payloads(views),
        }

    @app.get("/api/boards/{board_id}/views/{name}")
    def board_saved_view_endpoint(
        request: Request,
        board_id: str,
        name: str,
    ) -> dict[str, object]:
        _require_auth(request)
        project = resolve_project(request)
        resolved_board = _resolve_board_id(board_id, project=project)
        clean_name = _saved_view_name(name)
        view_value = _store(request).saved_views(board=resolved_board).get(clean_name)
        if view_value is None:
            raise HTTPException(status_code=404, detail="saved view not found")
        return {
            "project": project.name,
            "board": resolved_board,
            "view": _saved_view_payload(clean_name, view_value),
        }

    @app.post("/api/boards/{board_id}/views")
    def save_board_view_endpoint(
        request: Request,
        board_id: str,
        payload: SavedViewPayload,
    ) -> dict[str, object]:
        auth = _require_operator_state_change(
            request,
            detail="saved view mutation requires operator role",
        )
        project = resolve_project(request)
        resolved_board = _resolve_board_id(board_id, project=project)
        name = _saved_view_name(payload.name)
        filters = _saved_view_filters(payload.filters)
        view_value = _store(request).set_saved_view(
            board=resolved_board,
            name=name,
            filters=filters,
        )
        _store(request).add_audit_event(
            board=resolved_board,
            kind="audit.board.saved_view",
            actor=_actor_payload(auth),
            action="saved-view-upsert",
            target={"type": "saved_view", "id": name},
            status="ok",
            summary=name,
            payload={"filters": _safe_query_filters(view_value), "project": project.name},
        )
        return {
            "project": project.name,
            "board": resolved_board,
            "view": _saved_view_payload(name, view_value),
        }

    @app.delete("/api/boards/{board_id}/views/{name}")
    def delete_board_view_endpoint(
        request: Request,
        board_id: str,
        name: str,
    ) -> dict[str, object]:
        auth = _require_operator_state_change(
            request,
            detail="saved view mutation requires operator role",
        )
        project = resolve_project(request)
        resolved_board = _resolve_board_id(board_id, project=project)
        clean_name = _saved_view_name(name)
        deleted = _store(request).delete_saved_view(board=resolved_board, name=clean_name)
        _store(request).add_audit_event(
            board=resolved_board,
            kind="audit.board.saved_view",
            actor=_actor_payload(auth),
            action="saved-view-delete",
            target={"type": "saved_view", "id": clean_name},
            status="ok" if deleted else "missing",
            summary=clean_name,
            payload={"project": project.name},
        )
        return {"project": project.name, "board": resolved_board, "deleted": deleted}

    @app.post("/api/boards/{board_id}/tasks")
    def create_task_endpoint(
        request: Request,
        board_id: str,
        payload: TaskCreatePayload,
    ) -> dict[str, object]:
        auth = _require_operator_state_change(
            request,
            detail="task mutation requires operator role",
        )
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
        _require_operator_state_change(request, detail="comment requires operator role")
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
        auth = _require_operator_state_change(request, detail="answer requires operator role")
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

    @app.post("/api/tasks/{task_id}/retro")
    def retro_task_endpoint(
        request: Request,
        task_id: str,
        payload: RetroPayload,
    ) -> dict[str, object]:
        auth = _require_operator_state_change(request, detail="retro requires operator role")
        project = resolve_project(request)
        task = _task_for_project(_store(request), task_id, project=project)
        if task.status != "done":
            raise HTTPException(status_code=409, detail="task is not complete")
        if not _retro_enabled(task):
            raise HTTPException(status_code=403, detail="retro is not enabled")
        text = _safe_log_text(payload.text)
        node = _optional_node_ref(payload.node, field_name="node")
        safe_node = node
        author = (
            f"retro:{safe_node}" if safe_node is not None else _answer_author(_actor_payload(auth))
        )
        comment = _store(request).add_comment_to_task(
            task_id=task_id,
            author=author,
            body=text,
            metadata={"kind": "retro", "node": node or ""},
        )
        actor = (
            {"kind": "node", "id": safe_node, "login": safe_node, "role": "none"}
            if safe_node is not None
            else _actor_payload(auth)
        )
        _store(request).add_audit_event(
            board=project.board,
            kind="audit.task.retro",
            actor=actor,
            action="retro",
            target={"type": "task", "id": task_id, "node": node or task.assignee or ""},
            task_id=task_id,
            summary=text,
            payload={"project": project.name, "node": node or ""},
        )
        return {"ok": True, "comment": _comment_payload(comment)}

    @app.get("/api/nodes")
    def nodes_endpoint(request: Request) -> list[dict[str, str]]:
        _require_auth(request)
        return [_node_payload(node) for node in _registry_nodes(resolve_project(request).config)]

    @app.post("/api/nodes")
    def create_node_endpoint(
        request: Request,
        payload: NodeCreatePayload,
    ) -> dict[str, object]:
        auth = _require_operator_state_change(
            request,
            detail="node mutation requires operator role",
        )
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
        auth = _require_operator_state_change(
            request,
            detail="node mutation requires operator role",
        )
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

    @app.get("/api/nodes/{node}/autopickup")
    def get_node_autopickup_endpoint(request: Request, node: str) -> dict[str, object]:
        _require_auth(request)
        project = resolve_project(request)
        node_name = _node_in_project(node, config=project.config)
        return _node_autopickup_payload(_store(request), project=project, node=node_name)

    @app.post("/api/nodes/{node}/autopickup")
    def set_node_autopickup_endpoint(
        request: Request,
        node: str,
        payload: AutoPickupTogglePayload,
    ) -> dict[str, object]:
        auth = _require_operator_state_change(
            request,
            detail="node mutation requires operator role",
        )
        project = resolve_project(request)
        node_name = _node_in_project(node, config=project.config)
        global_state = _store(request).autopickup_global_state(board=project.board)
        if payload.enabled and (not global_state["enabled"] or global_state["kill_switch"]):
            raise HTTPException(status_code=409, detail="global autopickup gate is disabled")
        state = _store(request).set_node_autopickup_enabled(
            board=project.board,
            node=node_name,
            enabled=payload.enabled,
        )
        _store(request).add_audit_event(
            board=project.board,
            kind="audit.node.autopickup",
            actor=_actor_payload(auth),
            action="autopickup",
            target={"type": "node", "id": node_name, "node": node_name},
            payload={"project": project.name, "enabled": payload.enabled},
            summary=f"{node_name} autopickup {'enabled' if payload.enabled else 'disabled'}",
        )
        return _node_autopickup_payload(
            _store(request),
            project=project,
            node=node_name,
            state=state,
        )

    @app.get("/api/execution")
    def execution_gate_endpoint(request: Request) -> dict[str, object]:
        _require_auth(request)
        project = resolve_project(request)
        return _execution_gate_payload(_store(request), project=project)

    @app.post("/api/execution")
    def set_execution_gate_endpoint(
        request: Request,
        payload: ExecutionGatePayload,
    ) -> dict[str, object]:
        auth = _require_operator_state_change(request, detail="execution requires operator role")
        project = resolve_project(request)
        state = _store(request).set_execution_global(
            board=project.board,
            enabled=payload.enabled,
            kill_switch=payload.kill_switch,
            board_enabled=payload.board_enabled,
            board_kill_switch=payload.board_kill_switch,
        )
        _store(request).add_audit_event(
            board=project.board,
            kind="audit.execution.config",
            actor=_actor_payload(auth),
            action="execution-config",
            target={"type": "board", "id": project.board},
            payload={"project": project.name, **state},
            summary="execution gate updated",
        )
        return _execution_gate_payload(_store(request), project=project, state=state)

    @app.get("/api/nodes/{node}/execution")
    def get_node_execution_endpoint(request: Request, node: str) -> dict[str, object]:
        _require_auth(request)
        project = resolve_project(request)
        node_name = _node_in_project(node, config=project.config)
        return _node_execution_payload(_store(request), project=project, node=node_name)

    @app.post("/api/nodes/{node}/execution")
    def set_node_execution_endpoint(
        request: Request,
        node: str,
        payload: ExecutionTogglePayload,
    ) -> dict[str, object]:
        auth = _require_operator_state_change(request, detail="execution requires operator role")
        project = resolve_project(request)
        node_name = _node_in_project(node, config=project.config)
        store = _store(request)
        if payload.enabled:
            global_state = store.execution_global_state(board=project.board)
            node_state = store.node_execution_state(board=project.board, node=node_name)
            if not global_state["enabled"] or not global_state["board_enabled"]:
                raise HTTPException(status_code=409, detail="execution gate is disabled")
            if (
                global_state["kill_switch"]
                or global_state["board_kill_switch"]
                or bool(node_state["kill_switch"])
            ):
                raise HTTPException(status_code=409, detail="execution kill switch is enabled")
        state = store.set_node_execution_enabled(
            board=project.board,
            node=node_name,
            enabled=payload.enabled,
        )
        store.add_audit_event(
            board=project.board,
            kind="audit.node.execution",
            actor=_actor_payload(auth),
            action="execution-toggle",
            target={"type": "node", "id": node_name, "node": node_name},
            payload={"project": project.name, "enabled": payload.enabled},
            summary=f"{node_name} execution {'enabled' if payload.enabled else 'disabled'}",
        )
        return _node_execution_payload(
            store,
            project=project,
            node=node_name,
            state=state,
        )

    @app.get("/api/tasks/{task_id}/execution")
    def task_execution_endpoint(request: Request, task_id: str) -> dict[str, object]:
        _require_auth(request)
        project = resolve_project(request)
        task = _task_for_project(_store(request), task_id, project=project)
        return _task_execution_payload(_store(request), project=project, task=task)

    @app.post("/api/tasks/{task_id}/approve")
    def approve_task_execution_endpoint(
        request: Request,
        task_id: str,
    ) -> dict[str, object]:
        auth = _require_operator_state_change(request, detail="execution requires operator role")
        project = resolve_project(request)
        task = _task_for_project(_store(request), task_id, project=project)
        node = _execution_node_for_task(_store(request), project=project, task=task)
        gate = _store(request).execution_gate_state(
            board=project.board,
            node=node,
            task_id=task.id,
        )
        if not bool(gate["allowed"]):
            raise HTTPException(status_code=409, detail="execution gate is blocked")
        if not _store(request).approve_execution(
            board=project.board,
            task_id=task.id,
            actor=_actor_payload(auth),
        ):
            raise HTTPException(status_code=409, detail="task is not awaiting approval")
        task = _store(request).get_task(board=project.board, task_id=task_id)
        return _task_execution_payload(_store(request), project=project, task=task)

    @app.post("/api/tasks/{task_id}/abort")
    def abort_task_execution_endpoint(
        request: Request,
        task_id: str,
        payload: ExecutionAbortPayload,
    ) -> dict[str, object]:
        auth = _require_operator_state_change(request, detail="execution requires operator role")
        project = resolve_project(request)
        task = _task_for_project(_store(request), task_id, project=project)
        if not _store(request).abort_execution(
            board=project.board,
            task_id=task.id,
            actor=_actor_payload(auth),
            reason=payload.reason,
        ):
            raise HTTPException(status_code=409, detail="task execution is already terminal")
        task = _store(request).get_task(board=project.board, task_id=task_id)
        return _task_execution_payload(_store(request), project=project, task=task)

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
        config_value = _config(request)
        return config_status(
            _slack_config_path(config_value),
            intake_enabled=config_value.slack_intake_enabled,
        )

    @app.post("/api/slack/config")
    def slack_config_endpoint(
        request: Request,
        payload: SlackConfigPayload,
    ) -> dict[str, object]:
        _require_operator_state_change(request, detail="slack config requires operator role")
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
        _require_operator_state_change(request, detail="slack test requires operator role")
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


def _presence_payload(
    request: Request,
    *,
    project: ProjectContext,
    auth: AuthContext,
) -> dict[str, object]:
    config = _config(request)
    if auth.mode == AuthMode.LOCAL_TOKEN:
        return {
            "project": project.name,
            "auth_mode": config.auth_mode.value,
            "active_window_seconds": PRESENCE_ACTIVE_SECONDS,
            "viewers": [{"kind": "anonymous", "count": 1}],
            "anonymous_count": 1,
        }
    registry = _member_registry(config)
    viewers: list[dict[str, object]] = []
    seen: set[str] = set()
    for record in _team_session_store(request).active_sessions(
        within_seconds=PRESENCE_ACTIVE_SECONDS
    ):
        member = registry.find_by_id(record.member_id)
        if member is None or not member.enabled or member.id in seen:
            continue
        seen.add(member.id)
        viewers.append({"name": member.name, "role": member.role})
    return {
        "project": project.name,
        "auth_mode": config.auth_mode.value,
        "active_window_seconds": PRESENCE_ACTIVE_SECONDS,
        "viewers": viewers,
        "anonymous_count": 0,
    }


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


def _usage_payload(
    store: SQLiteBoardStore,
    *,
    project: ProjectContext,
    window: str,
    node_filter: str | None,
    agent_filter: str | None,
) -> dict[str, object]:
    now = int(time.time())
    window_payload, since = _cost_window(window, now=now)
    clean_node = node_filter.strip() if node_filter is not None and node_filter.strip() else None
    clean_agent = _cost_agent_filter(agent_filter)
    registry_nodes = _cost_registry_node_records(project.config)
    agent_by_node = {_cost_node_name(node): _cost_node_agent(node) for node in registry_nodes}
    runs = [
        run
        for run in store.list_runs_for_board(board=project.board, since=since)
        if _usage_run_matches(
            run,
            node_filter=clean_node,
            agent_filter=clean_agent,
            agent_by_node=agent_by_node,
        )
    ]
    return {
        "project": project.name,
        "generated_at": _cost_metric(now, source="server", confidence="explicit"),
        "window": window_payload,
        "filters": {
            "node": _safe_log_text(clean_node) if clean_node is not None else None,
            "agent": clean_agent,
        },
        "totals": _usage_totals_payload(runs),
        "nodes": _usage_nodes_payload(runs, agent_by_node=agent_by_node),
        "days": _usage_days_payload(runs, agent_by_node=agent_by_node),
        "limitations": _usage_limitations(runs),
    }


def _usage_trend_payload(
    store: SQLiteBoardStore,
    *,
    project: ProjectContext,
    auth: AuthContext,
    window: str,
    member_filter: str | None,
) -> dict[str, object]:
    now = int(time.time())
    window_payload, since = _usage_trend_window(window, now=now)
    registry_nodes = _cost_registry_node_records(project.config)
    agent_by_node = {_cost_node_name(node): _cost_node_agent(node) for node in registry_nodes}
    clean_member = _usage_trend_member_filter(member_filter)
    tasks = {task.id: task for task in store.list_tasks(board=project.board)}
    runs = [
        run
        for run in store.list_runs_for_board(board=project.board, since=since)
        if _usage_trend_run_matches_member(run, tasks=tasks, member_filter=clean_member)
    ]
    grouped = _runs_by_node(runs)
    store.add_audit_event(
        board=project.board,
        kind="audit.usage.trend",
        actor=_actor_payload(auth),
        action="usage-trend",
        target={"type": "usage_trend", "id": project.name},
        status="ok",
        summary="usage trend read",
        payload={
            "project": project.name,
            "advisory_only": True,
            "window": window_payload["name"],
            "member": clean_member,
        },
    )
    has_agy = any(
        _usage_agent_for_node(node, agent_by_node=agent_by_node) == "agy" for node in grouped
    )
    limitations = [
        "advisory-only: signals do not throttle, abort, kill, dispatch, or change config",
        "trend and anomaly signals use explicit run metadata only",
        "forecast is a simple labeled extrapolation, not a prediction",
    ]
    if not runs:
        limitations.append("no runs matched the requested project and period")
    if has_agy:
        limitations.append("agy cost is unknown and excluded from cost anomaly checks")
    return {
        "ok": True,
        "project": project.name,
        "mode": "advisory",
        "actions": [],
        "enforcement": {"called": False},
        "generated_at": _cost_metric(now, source="server", confidence="explicit"),
        "window": window_payload,
        "filters": {"member": _safe_public_text(clean_member) if clean_member else None},
        "nodes": [
            _usage_trend_node_payload(
                node,
                agent=_usage_agent_for_node(node, agent_by_node=agent_by_node),
                runs=node_runs,
            )
            for node, node_runs in sorted(grouped.items())
        ],
        "limitations": limitations,
    }


def _usage_trend_window(window: str, *, now: int) -> tuple[dict[str, object], int]:
    clean = window.strip().lower()
    days = USAGE_TREND_WINDOWS.get(clean)
    if days is None:
        raise HTTPException(status_code=400, detail="invalid usage trend window")
    since = now - (days * 86_400)
    return (
        {
            "name": clean,
            "days": _cost_metric(days, source="server", confidence="explicit"),
            "since": _cost_metric(since, source="server", confidence="explicit"),
            "until": _cost_metric(now, source="server", confidence="explicit"),
        },
        since,
    )


def _usage_trend_member_filter(member_filter: str | None) -> str | None:
    if member_filter is None or not member_filter.strip():
        return None
    return _safe_public_text(member_filter.strip())


def _usage_trend_run_matches_member(
    run: Run,
    *,
    tasks: Mapping[str, Task],
    member_filter: str | None,
) -> bool:
    if member_filter is None:
        return True
    task = tasks.get(run.task_id)
    return task is not None and task.created_by == member_filter


def _usage_trend_node_payload(
    node: str,
    *,
    agent: str,
    runs: Sequence[Run],
) -> dict[str, object]:
    day_runs = _runs_by_day(runs)
    day_values = [
        _usage_trend_day_value(day, runs=day_runs[day], agent=agent) for day in sorted(day_runs)
    ]
    token_values = [day.total_tokens for day in day_values if day.total_tokens is not None]
    cost_values = [day.cost_usd for day in day_values if day.cost_usd is not None]
    confidence = "low" if len(token_values) < USAGE_TREND_MIN_BASELINE_DAYS + 1 else "medium"
    payload: dict[str, object] = {
        "node": _safe_public_text(node),
        "agent": agent,
        "confidence": confidence,
        "days": [
            {
                "day": day.day,
                "totals": _usage_trend_day_totals(day_runs[day.day], agent=agent),
            }
            for day in day_values
        ],
        "trend": {
            "total_tokens": _usage_trend_signal(token_values, confidence=confidence),
            "cost_usd_estimate": _usage_trend_signal(
                cost_values,
                confidence=confidence,
                unknown=agent == "agy",
            ),
        },
        "anomaly": {
            "total_tokens": _usage_anomaly_signal(token_values, confidence=confidence),
            "cost_usd_estimate": _usage_anomaly_signal(
                cost_values,
                confidence=confidence,
                excluded=agent == "agy",
            ),
        },
        "forecast": {
            "label": "simple extrapolation; not a prediction",
            "total_tokens_next_day": _usage_forecast_signal(token_values, confidence=confidence),
            "cost_usd_next_day": _usage_forecast_signal(
                cost_values,
                confidence=confidence,
                unknown=agent == "agy",
            ),
        },
    }
    warnings = _usage_trend_warnings(day_values=day_values, agent=agent, confidence=confidence)
    if warnings:
        payload["warnings"] = warnings
    return payload


def _usage_trend_day_value(day: str, *, runs: Sequence[Run], agent: str) -> UsageTrendDay:
    usage = _usage_from_runs(runs)
    return UsageTrendDay(
        day=day,
        total_tokens=usage.total_tokens,
        cost_usd=None if agent == "agy" else usage.cost_usd,
    )


def _usage_trend_day_totals(runs: Sequence[Run], *, agent: str) -> dict[str, object]:
    usage = _usage_from_runs(runs)
    if agent != "agy":
        return _usage_totals_from_usage(usage, runs=len(runs))
    return {
        **_usage_totals_from_usage(
            CostUsage(
                input_tokens=usage.input_tokens,
                output_tokens=usage.output_tokens,
                total_tokens=usage.total_tokens,
                cost_usd=None,
                source=usage.source,
                confidence=usage.confidence,
                warnings=usage.warnings,
            ),
            runs=len(runs),
        ),
        "cost_usd_estimate": _cost_metric(
            None,
            source="estimate",
            confidence="unknown",
            status_value="unknown",
        ),
    }


def _usage_trend_signal(
    values: Sequence[float | int],
    *,
    confidence: str,
    unknown: bool = False,
) -> dict[str, object]:
    if unknown:
        return _cost_metric(None, source="estimate", confidence="unknown", status_value="unknown")
    if len(values) < 2:
        return _cost_metric(None, source="run_metadata", confidence="low", status_value="unknown")
    baseline = _mean(values[:-1])
    latest = float(values[-1])
    delta = latest - baseline
    return {
        "latest": _cost_metric(round(latest, 6), source="run_metadata", confidence=confidence),
        "baseline": _cost_metric(round(baseline, 6), source="run_metadata", confidence=confidence),
        "delta": _cost_metric(round(delta, 6), source="run_metadata", confidence=confidence),
        "ratio": _cost_metric(
            round(latest / baseline, 6) if baseline > 0 else None,
            source="run_metadata" if baseline > 0 else "none",
            confidence=confidence if baseline > 0 else "unknown",
            status_value="unknown" if baseline <= 0 else None,
        ),
    }


def _usage_anomaly_signal(
    values: Sequence[float | int],
    *,
    confidence: str,
    excluded: bool = False,
) -> dict[str, object]:
    if excluded:
        return {
            "flagged": False,
            "reason": "excluded: agy cost is unknown",
            "confidence": "unknown",
        }
    if len(values) < USAGE_TREND_MIN_BASELINE_DAYS + 1:
        return {
            "flagged": False,
            "reason": "insufficient baseline data",
            "confidence": "low",
        }
    baseline_values = [float(value) for value in values[:-1]]
    latest = float(values[-1])
    baseline = _mean(baseline_values)
    stdev = _population_stdev(baseline_values, mean=baseline)
    ratio = latest / baseline if baseline > 0 else 0.0
    zscore = (latest - baseline) / stdev if stdev > 0 else 0.0
    flagged = ratio >= USAGE_TREND_SPIKE_RATIO or zscore >= USAGE_TREND_SPIKE_ZSCORE
    return {
        "flagged": flagged,
        "reason": "spike" if flagged else "within baseline",
        "latest": _cost_metric(round(latest, 6), source="run_metadata", confidence=confidence),
        "baseline": _cost_metric(round(baseline, 6), source="run_metadata", confidence=confidence),
        "ratio": _cost_metric(round(ratio, 6), source="run_metadata", confidence=confidence),
        "zscore": _cost_metric(round(zscore, 6), source="run_metadata", confidence=confidence),
        "confidence": confidence,
    }


def _usage_forecast_signal(
    values: Sequence[float | int],
    *,
    confidence: str,
    unknown: bool = False,
) -> dict[str, object]:
    if unknown:
        return _cost_metric(None, source="estimate", confidence="unknown", status_value="unknown")
    if len(values) < 2:
        return _cost_metric(None, source="run_metadata", confidence="low", status_value="unknown")
    latest = float(values[-1])
    previous = float(values[-2])
    forecast = max(0.0, latest + (latest - previous))
    return _cost_metric(round(forecast, 6), source="run_metadata", confidence=confidence)


def _usage_trend_warnings(
    *,
    day_values: Sequence[UsageTrendDay],
    agent: str,
    confidence: str,
) -> list[str]:
    warnings: list[str] = []
    if confidence == "low":
        warnings.append("thin data; trend and forecast confidence is low")
    if agent == "agy":
        warnings.append("agy cost is unknown and excluded from cost anomaly checks")
    if not day_values:
        warnings.append("no measured run metadata for this node in the window")
    return warnings


def _mean(values: Sequence[float | int]) -> float:
    if not values:
        return 0.0
    return sum(float(value) for value in values) / len(values)


def _population_stdev(values: Sequence[float], *, mean: float) -> float:
    if not values:
        return 0.0
    variance = sum((value - mean) ** 2 for value in values) / len(values)
    return float(variance**0.5)


def _ledger_payload(
    store: SQLiteBoardStore,
    *,
    project: ProjectContext,
    auth: AuthContext,
    window: str,
    member_filter: str | None,
    quota_enabled: bool,
) -> dict[str, object]:
    now = int(time.time())
    window_payload, since = _cost_window(window, now=now)
    runs = store.list_runs_for_board(board=project.board, since=since)
    tasks = {task.id: task for task in store.list_tasks(board=project.board)}
    member_lookup = _member_lookup(project.config)
    registry_nodes = _cost_registry_node_records(project.config)
    agent_by_node = {_cost_node_name(node): _cost_node_agent(node) for node in registry_nodes}
    grouped: dict[str, list[Run]] = {}
    for run in runs:
        member_id = _run_member_id(run, tasks=tasks)
        if member_filter is not None and member_id != member_filter:
            continue
        grouped.setdefault(member_id, []).append(run)
    quota_states = store.quota_members(board=project.board) if quota_enabled else {}
    members = [
        _ledger_member_rollup(
            member_id,
            member_runs,
            quota_state=quota_states.get(member_id),
            quota_enabled=quota_enabled,
            member_lookup=member_lookup,
            agent_by_node=agent_by_node,
        )
        for member_id, member_runs in sorted(grouped.items())
    ]
    if member_filter is not None and member_filter not in grouped:
        members.append(
            _ledger_member_rollup(
                member_filter,
                [],
                quota_state=quota_states.get(member_filter),
                quota_enabled=quota_enabled,
                member_lookup=member_lookup,
                agent_by_node=agent_by_node,
            )
        )
    return {
        "project": project.name,
        "generated_at": _cost_metric(now, source="server", confidence="explicit"),
        "window": window_payload,
        "scope": "self" if _ledger_self_scoped(auth, member_filter) else "all",
        "quota_enabled": quota_enabled,
        "members": members,
        "host_pressure": _host_pressure_payload(store, project=project, runs=runs),
        "limitations": [
            "ledger uses explicit run metadata and task creator attribution only",
            "soft quota never hard-kills running tasks",
            "agy credit and missing cost fields remain unknown; no costs are invented",
        ],
    }


def _retro_analytics_payload(
    store: SQLiteBoardStore,
    *,
    project: ProjectContext,
    auth: AuthContext,
    window: str,
) -> dict[str, object]:
    now = int(time.time())
    window_payload, since = _cost_window(window, now=now)
    tasks = store.list_tasks(board=project.board)
    runs = store.list_runs_for_board(board=project.board, since=since)
    retro_comments = _retro_comments_for_tasks(store, board=project.board, tasks=tasks, since=since)
    completed_runs = [run for run in runs if _retro_run_completed(run)]
    sample_count = len(retro_comments) + len(completed_runs)
    confidence = "low" if sample_count < RETRO_ANALYTICS_SMALL_SAMPLE else "medium"
    registry_nodes = _registry_node_records(project.config)
    has_agy = any(_normalized_cost_agent(node["agent"]) == "agy" for node in registry_nodes)
    store.add_audit_event(
        board=project.board,
        kind="audit.retro.analytics",
        actor=_actor_payload(auth),
        action="retro-analytics",
        target={"type": "retro_analytics", "id": project.name},
        status="ok",
        summary="retro analytics read",
        payload={
            "project": project.name,
            "advisory_only": True,
            "sample_count": sample_count,
            "confidence": confidence,
        },
    )
    limitations = [
        "advisory-only: this endpoint does not create tasks, change config, or dispatch work",
        "themes are deterministic allowlist categories from redacted retro text",
        "slow patterns use measured run timestamps only",
    ]
    if has_agy:
        limitations.append("agy credit is unknown; no credit or cost values are invented")
    if confidence == "low":
        limitations.append("small sample size; confidence is low")
    return {
        "ok": True,
        "project": project.name,
        "mode": "advisory",
        "actions": [],
        "generated_at": _cost_metric(now, source="server", confidence="explicit"),
        "window": window_payload,
        "confidence": confidence,
        "sample": {
            "completed_runs": _cost_metric(
                len(completed_runs),
                source="run_metadata",
                confidence="explicit",
            ),
            "retro_comments": _cost_metric(
                len(retro_comments),
                source="comments",
                confidence="explicit",
            ),
            "blocked_tasks": _cost_metric(
                len([task for task in tasks if task.status == "blocked"]),
                source="tasks",
                confidence="explicit",
            ),
        },
        "throughput": _retro_throughput_payload(runs, confidence=confidence),
        "themes": _retro_theme_payload(retro_comments, confidence=confidence),
        "patterns": _retro_patterns_payload(tasks=tasks, runs=runs, confidence=confidence),
        "outcomes": _retro_outcomes_payload(
            runs,
            nodes=registry_nodes,
            confidence=confidence,
        ),
        "cost_signals": {
            "agy_credit": _cost_metric(
                None,
                source="none",
                confidence="unknown",
                status_value="unknown",
            )
        },
        "limitations": limitations,
    }


def _retro_comments_for_tasks(
    store: SQLiteBoardStore,
    *,
    board: str,
    tasks: Sequence[Task],
    since: int | None,
) -> list[Comment]:
    comments: list[Comment] = []
    for task in tasks:
        for comment in store.list_comments(board=board, task_id=task.id):
            if since is not None and comment.created_at < since:
                continue
            if _is_retro_comment(comment):
                comments.append(comment)
    return comments


def _is_retro_comment(comment: Comment) -> bool:
    kind = comment.metadata.get("kind")
    return kind == "retro" or comment.author.startswith("retro:")


def _retro_throughput_payload(
    runs: Sequence[Run],
    *,
    confidence: str,
) -> list[dict[str, object]]:
    counts: dict[str, int] = {}
    for run in runs:
        if not _retro_run_completed(run):
            continue
        completed_at = run.ended_at or run.started_at
        bucket = _retro_day_bucket(completed_at)
        counts[bucket] = counts.get(bucket, 0) + 1
    return [
        {
            "bucket": bucket,
            "completed": _cost_metric(count, source="run_metadata", confidence=confidence),
        }
        for bucket, count in sorted(counts.items())
    ]


def _retro_theme_payload(
    comments: Sequence[Comment],
    *,
    confidence: str,
) -> list[dict[str, object]]:
    counts: dict[str, int] = {theme: 0 for theme in RETRO_THEME_TERMS}
    for comment in comments:
        text = _safe_public_text(comment.body).lower()
        for theme, terms in RETRO_THEME_TERMS.items():
            if any(term in text for term in terms):
                counts[theme] += 1
    return [
        {
            "theme": theme,
            "count": _cost_metric(count, source="retro_comments", confidence=confidence),
            "keywords": list(RETRO_THEME_TERMS[theme]),
        }
        for theme, count in sorted(counts.items(), key=lambda item: (-item[1], item[0]))
        if count > 0
    ]


def _retro_patterns_payload(
    *,
    tasks: Sequence[Task],
    runs: Sequence[Run],
    confidence: str,
) -> dict[str, object]:
    blocked_tasks = [task for task in tasks if task.status == "blocked"]
    durations = [
        run.ended_at - run.started_at
        for run in runs
        if _retro_run_completed(run) and run.ended_at is not None and run.ended_at >= run.started_at
    ]
    slow = [duration for duration in durations if duration >= RETRO_SLOW_RUN_SECONDS]
    return {
        "blocked": {
            "current": _cost_metric(
                len(blocked_tasks),
                source="tasks",
                confidence="explicit",
            ),
            "by_assignee": _retro_blocked_by_assignee(blocked_tasks, confidence=confidence),
            "blocked_runs": _cost_metric(
                len([run for run in runs if _retro_run_outcome(run) == "blocked"]),
                source="run_metadata",
                confidence=confidence,
            ),
        },
        "slow": {
            "threshold_seconds": _cost_metric(
                RETRO_SLOW_RUN_SECONDS,
                source="server",
                confidence="explicit",
            ),
            "count": _cost_metric(len(slow), source="run_metadata", confidence=confidence),
            "average_duration_seconds": _cost_metric(
                int(sum(durations) / len(durations)) if durations else None,
                source="run_metadata" if durations else "none",
                confidence=confidence if durations else "unknown",
                status_value="unknown" if not durations else None,
            ),
        },
    }


def _retro_blocked_by_assignee(
    tasks: Sequence[Task],
    *,
    confidence: str,
) -> list[dict[str, object]]:
    counts: dict[str, int] = {}
    for task in tasks:
        assignee = _safe_public_text(task.assignee or "unassigned")
        counts[assignee] = counts.get(assignee, 0) + 1
    return [
        {
            "assignee": assignee,
            "count": _cost_metric(count, source="tasks", confidence=confidence),
        }
        for assignee, count in sorted(counts.items(), key=lambda item: (-item[1], item[0]))
    ]


def _retro_outcomes_payload(
    runs: Sequence[Run],
    *,
    nodes: Sequence[Mapping[str, str]],
    confidence: str,
) -> dict[str, object]:
    node_info = {_safe_public_text(node["name"]): node for node in nodes}
    node_counts: dict[str, dict[str, int]] = {}
    role_counts: dict[str, dict[str, int]] = {}
    for run in runs:
        node = _safe_public_text(run.node_id)
        outcome = _retro_run_outcome(run)
        counts = node_counts.setdefault(node, _empty_outcome_counts())
        counts[outcome] = counts.get(outcome, 0) + 1
        role = _safe_public_text(node_info.get(node, {}).get("role") or "unknown")
        role_bucket = role_counts.setdefault(role, _empty_outcome_counts())
        role_bucket[outcome] = role_bucket.get(outcome, 0) + 1
    return {
        "by_node": [
            _retro_outcome_item(
                key_name="node",
                key=node,
                counts=counts,
                source="run_metadata",
                confidence=confidence,
                extra={
                    "role": _safe_public_text(node_info.get(node, {}).get("role") or "unknown"),
                    "agent": _safe_public_text(node_info.get(node, {}).get("agent") or "unknown"),
                },
            )
            for node, counts in sorted(node_counts.items())
        ],
        "by_role": [
            _retro_outcome_item(
                key_name="role",
                key=role,
                counts=counts,
                source="run_metadata",
                confidence=confidence,
            )
            for role, counts in sorted(role_counts.items())
        ],
    }


def _retro_outcome_item(
    *,
    key_name: str,
    key: str,
    counts: Mapping[str, int],
    source: str,
    confidence: str,
    extra: Mapping[str, object] | None = None,
) -> dict[str, object]:
    payload: dict[str, object] = {key_name: key, **dict(extra or {})}
    for outcome in ("completed", "blocked", "failed", "running", "other"):
        payload[outcome] = _cost_metric(
            counts.get(outcome, 0),
            source=source,
            confidence=confidence,
        )
    return payload


def _empty_outcome_counts() -> dict[str, int]:
    return {"completed": 0, "blocked": 0, "failed": 0, "running": 0, "other": 0}


def _retro_run_completed(run: Run) -> bool:
    return _retro_run_outcome(run) == "completed"


def _retro_run_outcome(run: Run) -> str:
    if run.outcome == "complete" or run.status == "completed":
        return "completed"
    if run.outcome == "blocked" or run.status == "blocked":
        return "blocked"
    if run.status == "running":
        return "running"
    if run.outcome in {"failed", "abort", "rollback"} or run.status in {"failed", "aborted"}:
        return "failed"
    return "other"


def _retro_day_bucket(ts: int) -> str:
    return time.strftime("%Y-%m-%d", time.gmtime(ts))


def _ledger_member_rollup(
    member_id: str,
    runs: Sequence[Run],
    *,
    quota_state: Mapping[str, object] | None,
    quota_enabled: bool,
    member_lookup: Mapping[str, TeamMember],
    agent_by_node: Mapping[str, str],
) -> dict[str, object]:
    usage = _usage_from_runs(runs)
    quota = _quota_public_payload(
        quota_state or {"configured": False, "enabled": False},
        usage=usage,
        quota_enabled=quota_enabled,
        runs=len(runs),
    )
    payload: dict[str, object] = {
        "member": _ledger_member_payload(member_id, member_lookup),
        "totals": _usage_totals_from_usage(usage, runs=len(runs)),
        "quota": quota,
    }
    warnings = _ledger_warnings(usage, quota, runs=runs, agent_by_node=agent_by_node)
    if warnings:
        payload["warnings"] = warnings
    return payload


def _ledger_member_payload(
    member_id: str,
    member_lookup: Mapping[str, TeamMember],
) -> dict[str, object]:
    member = member_lookup.get(member_id)
    return {
        "id": _safe_public_text(member_id),
        "name": _safe_public_text(member.name) if member is not None else None,
        "role": member.role if member is not None else "unknown",
    }


def _member_lookup(config: WebAppConfig) -> dict[str, TeamMember]:
    try:
        return {member.id: member for member in _member_registry(config).list_members()}
    except ValueError:
        return {}


def _run_member_id(run: Run, *, tasks: Mapping[str, Task]) -> str:
    for key in ("member_id", "member", "actor_id", "started_by", "created_by"):
        value = _mapping_string(run.metadata, key)
        if value is not None:
            return value
    task = tasks.get(run.task_id)
    if task is not None and task.created_by:
        return task.created_by
    return "unattributed"


def _ledger_member_filter(auth: AuthContext, requested: str | None) -> str | None:
    clean = _optional_text(requested, field_name="member", max_length=200)
    if auth.mode == AuthMode.TEAM_COOKIE and auth.member is not None:
        if auth.member.role == "viewer":
            if clean is not None and clean not in {auth.member.id, auth.member.name}:
                raise HTTPException(status_code=403, detail="ledger self scope only")
            return auth.member.id
        if clean == auth.member.name:
            return auth.member.id
    return clean


def _ledger_self_scoped(auth: AuthContext, member_filter: str | None) -> bool:
    if auth.mode != AuthMode.TEAM_COOKIE or auth.member is None:
        return False
    return member_filter == auth.member.id


def _quota_public_payload(
    quota_state: Mapping[str, object],
    *,
    usage: CostUsage,
    quota_enabled: bool,
    runs: int = 0,
) -> dict[str, object]:
    configured = bool(quota_state.get("configured"))
    enabled = quota_enabled and bool(quota_state.get("enabled")) and configured
    exceeded = _quota_exceeded_reasons(quota_state, usage=usage, runs=runs) if enabled else []
    payload: dict[str, object] = {
        "configured": configured,
        "enabled": enabled,
        "mode": "soft",
        "hard_kill": False,
        "status": "exceeded" if exceeded else "ok" if enabled else "disabled",
        "soft_throttle": {
            "active": bool(exceeded),
            "action": "queue-delay" if exceeded else "none",
            "reasons": exceeded,
            "hard_kill": False,
        },
    }
    for key in ("soft_run_limit", "soft_token_limit", "soft_cost_usd", "updated_at"):
        if key in quota_state:
            payload[key] = quota_state[key]
    if enabled and "soft_cost_usd" in quota_state and usage.cost_usd is None:
        payload["cost_warning"] = "cost usage is unknown; cost quota is warning-only"
    return payload


def _quota_exceeded_reasons(
    quota_state: Mapping[str, object],
    *,
    usage: CostUsage,
    runs: int,
) -> list[str]:
    reasons: list[str] = []
    run_limit = _mapping_int(quota_state, "soft_run_limit")
    if run_limit is not None and runs > run_limit:
        reasons.append("runs")
    token_limit = _mapping_int(quota_state, "soft_token_limit")
    if (
        token_limit is not None
        and usage.total_tokens is not None
        and usage.total_tokens > token_limit
    ):
        reasons.append("tokens")
    cost_limit = _mapping_float(quota_state, "soft_cost_usd")
    if cost_limit is not None and usage.cost_usd is not None and usage.cost_usd > cost_limit:
        reasons.append("cost")
    return reasons


def _ledger_warnings(
    usage: CostUsage,
    quota: Mapping[str, object],
    *,
    runs: Sequence[Run],
    agent_by_node: Mapping[str, str],
) -> list[str]:
    warnings = [_safe_log_text(warning) for warning in usage.warnings]
    if any(
        _usage_agent_for_node(_run_node_name(run), agent_by_node=agent_by_node) == "agy"
        for run in runs
    ):
        warnings.append(
            "agy credit is unknown because no reliable local credit source is configured"
        )
    throttle = quota.get("soft_throttle")
    if isinstance(throttle, Mapping) and throttle.get("active") is True:
        warnings.append(
            "soft quota exceeded; new work may be delayed, running tasks are not killed"
        )
    cost_warning = quota.get("cost_warning")
    if isinstance(cost_warning, str):
        warnings.append(cost_warning)
    return sorted(set(warnings))


def _host_pressure_payload(
    store: SQLiteBoardStore,
    *,
    project: ProjectContext,
    runs: Sequence[Run],
) -> dict[str, object]:
    running_runs = [run for run in runs if run.status == "running" and run.ended_at is None]
    node_count = len(_cost_registry_node_records(project.config))
    capacity = max(1, node_count)
    ratio = round(len(running_runs) / capacity, 3)
    payload: dict[str, object] = {
        "status": "saturated" if ratio >= 1 else "nominal",
        "running": _cost_metric(len(running_runs), source="run_metadata", confidence="explicit"),
        "capacity": _cost_metric(capacity, source="registry", confidence="inferred"),
        "ratio": _cost_metric(ratio, source="run_metadata+registry", confidence="inferred"),
    }
    try:
        load_1m = os.getloadavg()[0]
    except (AttributeError, OSError):
        load_1m = None
    payload["load_1m"] = _cost_metric(
        round(load_1m, 3) if load_1m is not None else None,
        source="os",
        confidence="explicit" if load_1m is not None else "unknown",
        status_value="unknown" if load_1m is None else None,
    )
    blocked_count = len(store.list_tasks(board=project.board, status="blocked"))
    payload["blocked_tasks"] = _cost_metric(
        blocked_count,
        source="board",
        confidence="explicit",
    )
    return payload


def _usage_run_matches(
    run: Run,
    *,
    node_filter: str | None,
    agent_filter: str | None,
    agent_by_node: Mapping[str, str],
) -> bool:
    node = _run_node_name(run)
    if node_filter is not None and node != node_filter:
        return False
    if agent_filter is None:
        return True
    return _usage_agent_for_node(node, agent_by_node=agent_by_node) == agent_filter


def _usage_agent_for_node(node: str, *, agent_by_node: Mapping[str, str]) -> str:
    return agent_by_node.get(node, "unknown")


def _usage_nodes_payload(
    runs: Sequence[Run],
    *,
    agent_by_node: Mapping[str, str],
) -> list[dict[str, object]]:
    grouped = _runs_by_node(runs)
    return [
        _usage_node_payload(
            node,
            agent=_usage_agent_for_node(node, agent_by_node=agent_by_node),
            runs=node_runs,
            include_days=True,
        )
        for node, node_runs in sorted(grouped.items())
    ]


def _usage_days_payload(
    runs: Sequence[Run],
    *,
    agent_by_node: Mapping[str, str],
) -> list[dict[str, object]]:
    return [
        {
            "day": day,
            "totals": _usage_totals_payload(day_runs),
            "nodes": [
                _usage_node_payload(
                    node,
                    agent=_usage_agent_for_node(node, agent_by_node=agent_by_node),
                    runs=node_runs,
                    include_days=False,
                )
                for node, node_runs in sorted(_runs_by_node(day_runs).items())
            ],
        }
        for day, day_runs in sorted(_runs_by_day(runs).items())
    ]


def _usage_node_payload(
    node: str,
    *,
    agent: str,
    runs: Sequence[Run],
    include_days: bool,
) -> dict[str, object]:
    usage = _usage_from_runs(runs)
    payload: dict[str, object] = {
        "node": _safe_log_text(node),
        "agent": agent,
        "totals": _usage_totals_from_usage(usage, runs=len(runs)),
    }
    warnings = _usage_warnings(usage, agent=agent)
    if warnings:
        payload["warnings"] = warnings
    if agent == "agy":
        payload["credit_remaining"] = _cost_metric(
            None,
            source="none",
            confidence="unknown",
            status_value="unknown",
        )
        payload["credit_status"] = "unknown"
    if include_days:
        payload["days"] = [
            {"day": day, "totals": _usage_totals_payload(day_runs)}
            for day, day_runs in sorted(_runs_by_day(runs).items())
        ]
    return payload


def _runs_by_day(runs: Sequence[Run]) -> dict[str, list[Run]]:
    grouped: dict[str, list[Run]] = {}
    for run in runs:
        grouped.setdefault(_usage_day(run.started_at), []).append(run)
    return grouped


def _usage_day(timestamp: int) -> str:
    return time.strftime("%Y-%m-%d", time.gmtime(timestamp))


def _usage_totals_payload(runs: Sequence[Run]) -> dict[str, object]:
    return _usage_totals_from_usage(_usage_from_runs(runs), runs=len(runs))


def _usage_totals_from_usage(usage: CostUsage, *, runs: int) -> dict[str, object]:
    return {
        "runs": _cost_metric(runs, source="run_metadata", confidence="explicit"),
        "input_tokens": _usage_int_metric(usage, "input_tokens"),
        "output_tokens": _usage_int_metric(usage, "output_tokens"),
        "total_tokens": _usage_int_metric(usage, "total_tokens"),
        "cost_usd_estimate": _usage_cost_metric(usage),
        "confidence": usage.confidence if _usage_has_signal(usage) else "unknown",
    }


def _usage_int_metric(usage: CostUsage, field: str) -> dict[str, object]:
    value = _usage_int_field(usage, field)
    if value is None:
        return _cost_metric(None, source="none", confidence="unknown", status_value="unknown")
    return _cost_metric(value, source=usage.source, confidence=usage.confidence)


def _usage_cost_metric(usage: CostUsage) -> dict[str, object]:
    if usage.cost_usd is None:
        return _cost_metric(None, source="estimate", confidence="unknown", status_value="unknown")
    return _cost_metric(
        round(usage.cost_usd, 6),
        source=usage.source,
        confidence=usage.confidence,
    )


def _usage_warnings(usage: CostUsage, *, agent: str) -> list[str]:
    warnings = [_safe_log_text(warning) for warning in usage.warnings]
    if agent == "agy":
        warnings.append(
            "agy credit is unknown because no reliable local credit source is configured"
        )
    return sorted(set(warnings))


def _usage_limitations(runs: Sequence[Run]) -> list[str]:
    limitations = [
        "usage rollups only use explicit run metadata fields",
        "no hard-coded model prices are applied",
        "agy credit is unknown without a reliable local credit source",
    ]
    if not runs:
        limitations.append("no runs matched the requested project and period")
    elif not _usage_has_signal(_usage_from_runs(runs)):
        limitations.append("no token usage signals were found in run metadata")
    return limitations


def _signed_summary_payload(
    store: SQLiteBoardStore,
    *,
    project: ProjectContext,
) -> dict[str, object]:
    key = _load_or_create_summary_key(project.config)
    payload = _summary_payload(store, project=project, generated_at=int(time.time()))
    return {
        "algorithm": SUMMARY_ALGORITHM,
        "key_id": _summary_key_id(key),
        "payload": payload,
        "signature": _summary_signature(key, payload),
    }


def _summary_payload(
    store: SQLiteBoardStore,
    *,
    project: ProjectContext,
    generated_at: int,
) -> dict[str, object]:
    boards = [board for board in store.list_boards() if board.id == project.board]
    tasks = store.list_tasks(board=project.board) if boards else []
    runs = store.list_runs_for_board(board=project.board)
    nodes = _registry_node_records(project.config)
    return {
        "schema": SUMMARY_SCHEMA,
        "project": project.name,
        "version": APP_VERSION,
        "generated_at": generated_at,
        "summary": {
            "boards": {"total": len(boards)},
            "tasks": {
                "total": len(tasks),
                "by_status": _summary_counts(
                    (task.status for task in tasks),
                    allowed_values=SUMMARY_TASK_STATUSES,
                ),
            },
            "nodes": {
                "total": len(nodes),
                "by_status": _summary_counts(
                    (node["status"] for node in nodes),
                    allowed_values=SUMMARY_NODE_STATUSES,
                ),
                "by_agent": _summary_counts(
                    (node["agent"] for node in nodes),
                    allowed_values=SUMMARY_NODE_AGENTS,
                ),
            },
            "runs": {
                "total": len(runs),
                "by_status": _summary_counts(
                    (run.status for run in runs),
                    allowed_values=SUMMARY_RUN_STATUSES,
                ),
            },
        },
    }


def _aggregate_summary_payload(
    config: WebAppConfig,
    payload: AggregatePayload,
) -> dict[str, object]:
    trusted_keys = _summary_trusted_keys(config)
    now = int(time.time())
    items = [
        _verify_summary_envelope(
            item,
            trusted_keys=trusted_keys,
            now=now,
            freshness_seconds=config.summary_freshness_seconds,
        )
        for item in payload.summaries
    ]
    trusted_fresh = [
        item["payload"]
        for item in items
        if item["trust"] == "trusted" and item["freshness"] == "fresh"
    ]
    trusted_stale = [
        item for item in items if item["trust"] == "trusted" and item["freshness"] == "stale"
    ]
    return {
        "generated_at": _cost_metric(now, source="server", confidence="explicit"),
        "trust": {
            "trusted": sum(1 for item in items if item["trust"] == "trusted"),
            "untrusted": sum(1 for item in items if item["trust"] == "untrusted"),
            "stale": len(trusted_stale),
        },
        "summaries": items,
        "combined": _combined_summary_payload(trusted_fresh),
        "limitations": [
            "aggregate is read-only and does not perform cross-machine control",
            "stale summaries are excluded from the live combined rollup",
        ],
    }


def _verify_summary_envelope(
    envelope: Mapping[str, object],
    *,
    trusted_keys: Mapping[str, str],
    now: int,
    freshness_seconds: int,
) -> dict[str, object]:
    payload = envelope.get("payload")
    signature = envelope.get("signature")
    algorithm = envelope.get("algorithm")
    key_id = envelope.get("key_id")
    if not isinstance(payload, Mapping) or not isinstance(signature, str):
        return _untrusted_summary(reason="invalid summary envelope")
    if algorithm != SUMMARY_ALGORITHM:
        return _untrusted_summary(reason="unsupported summary algorithm")
    if not isinstance(key_id, str) or key_id not in trusted_keys:
        return _untrusted_summary(reason="unknown summary key")
    key = trusted_keys[key_id]
    expected = _summary_signature(key, payload)
    if not hmac.compare_digest(signature, expected):
        return _untrusted_summary(reason="signature verification failed")
    public_payload = _summary_public_view(payload)
    if public_payload is None:
        return _untrusted_summary(reason="invalid summary payload")
    generated_at = cast(int, public_payload["generated_at"])
    if generated_at > now + SUMMARY_CLOCK_SKEW_SECONDS:
        return _untrusted_summary(reason="summary timestamp is invalid")
    freshness = "stale" if now - generated_at > freshness_seconds else "fresh"
    return {
        "trust": "trusted",
        "freshness": freshness,
        "key_id": _safe_log_text(key_id),
        "project": public_payload["project"],
        "generated_at": generated_at,
        "payload": public_payload,
    }


def _untrusted_summary(*, reason: str) -> dict[str, object]:
    return {
        "trust": "untrusted",
        "freshness": "unknown",
        "reason": _safe_log_text(reason),
    }


def _summary_public_view(payload: Mapping[str, object]) -> dict[str, object] | None:
    if payload.get("schema") != SUMMARY_SCHEMA:
        return None
    project = payload.get("project")
    version = payload.get("version")
    generated_at = _summary_int(payload.get("generated_at"))
    raw_summary = payload.get("summary")
    if not isinstance(project, str) or not isinstance(version, str) or generated_at is None:
        return None
    if not isinstance(raw_summary, Mapping):
        return None
    boards = _summary_count_section(raw_summary.get("boards"), keys={})
    tasks = _summary_count_section(
        raw_summary.get("tasks"),
        keys={"by_status": SUMMARY_TASK_STATUSES},
    )
    nodes = _summary_count_section(
        raw_summary.get("nodes"),
        keys={"by_status": SUMMARY_NODE_STATUSES, "by_agent": SUMMARY_NODE_AGENTS},
    )
    runs = _summary_count_section(
        raw_summary.get("runs"),
        keys={"by_status": SUMMARY_RUN_STATUSES},
    )
    if None in (boards, tasks, nodes, runs):
        return None
    return {
        "schema": SUMMARY_SCHEMA,
        "project": _safe_log_text(project),
        "version": _safe_log_text(version),
        "generated_at": generated_at,
        "summary": {
            "boards": boards,
            "tasks": tasks,
            "nodes": nodes,
            "runs": runs,
        },
    }


def _combined_summary_payload(summaries: Sequence[object]) -> dict[str, object]:
    payloads = [summary for summary in summaries if isinstance(summary, Mapping)]
    return {
        "sources": len(payloads),
        "projects": sorted(
            {
                str(payload.get("project"))
                for payload in payloads
                if isinstance(payload.get("project"), str)
            }
        ),
        "boards": _combine_summary_section(payloads, section="boards", keys=()),
        "tasks": _combine_summary_section(payloads, section="tasks", keys=("by_status",)),
        "nodes": _combine_summary_section(
            payloads,
            section="nodes",
            keys=("by_status", "by_agent"),
        ),
        "runs": _combine_summary_section(payloads, section="runs", keys=("by_status",)),
    }


def _combine_summary_section(
    payloads: Sequence[Mapping[str, object]],
    *,
    section: str,
    keys: Sequence[str],
) -> dict[str, object]:
    total = 0
    combined: dict[str, object] = {"total": 0}
    grouped: dict[str, dict[str, int]] = {key: {} for key in keys}
    for payload in payloads:
        summary = payload.get("summary")
        if not isinstance(summary, Mapping):
            continue
        raw_section = summary.get(section)
        if not isinstance(raw_section, Mapping):
            continue
        total += _summary_int(raw_section.get("total")) or 0
        for key in keys:
            raw_counts = raw_section.get(key)
            if isinstance(raw_counts, Mapping):
                _merge_counts(grouped[key], raw_counts)
    combined["total"] = total
    for key in keys:
        combined[key] = dict(sorted(grouped[key].items()))
    return combined


def _merge_counts(
    target: dict[str, int],
    source: Mapping[object, object],
    *,
    allowed_values: frozenset[str] | None = None,
) -> None:
    for raw_key, raw_value in source.items():
        if not isinstance(raw_key, str):
            continue
        value = _summary_int(raw_value)
        if value is None:
            continue
        if allowed_values is None:
            clean_key = _safe_log_text(raw_key)
        else:
            clean_key = _summary_allowed_count_key(raw_key, allowed_values=allowed_values)
        target[clean_key] = target.get(clean_key, 0) + value


def _summary_count_section(
    value: object,
    *,
    keys: Mapping[str, frozenset[str]],
) -> dict[str, object] | None:
    if not isinstance(value, Mapping):
        return None
    total = _summary_int(value.get("total"))
    if total is None:
        return None
    section: dict[str, object] = {"total": total}
    for key, allowed_values in keys.items():
        raw_counts = value.get(key)
        if not isinstance(raw_counts, Mapping):
            return None
        section[key] = _summary_sanitized_counts(raw_counts, allowed_values=allowed_values)
    return section


def _summary_sanitized_counts(
    value: Mapping[object, object],
    *,
    allowed_values: frozenset[str],
) -> dict[str, int]:
    counts: dict[str, int] = {}
    _merge_counts(counts, value, allowed_values=allowed_values)
    return dict(sorted(counts.items()))


def _summary_counts(values: Iterable[str], *, allowed_values: frozenset[str]) -> dict[str, int]:
    counts: dict[str, int] = {}
    for value in values:
        key = _summary_allowed_count_key(value, allowed_values=allowed_values)
        counts[key] = counts.get(key, 0) + 1
    return dict(sorted(counts.items()))


def _summary_allowed_count_key(value: str, *, allowed_values: frozenset[str]) -> str:
    normalized = value.strip().lower()
    if normalized in allowed_values:
        return normalized
    return SUMMARY_OTHER_BUCKET


def _summary_int(value: object) -> int | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, int) and value >= 0:
        return value
    return None


def _summary_signature(key: str, payload: Mapping[str, object]) -> str:
    digest = hmac.new(
        key.encode("utf-8"),
        _summary_canonical_json(payload),
        hashlib.sha256,
    ).hexdigest()
    return f"sha256:{digest}"


def _summary_canonical_json(payload: Mapping[str, object]) -> bytes:
    return json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode(
        "utf-8"
    )


def _summary_key_id(key: str) -> str:
    return hashlib.sha256(key.encode("utf-8")).hexdigest()[:16]


def _summary_trusted_keys(config: WebAppConfig) -> dict[str, str]:
    local_key = _load_or_create_summary_key(config)
    trusted = {_summary_key_id(local_key): local_key}
    path = _summary_trusted_keys_path(config)
    if not path.is_file():
        return trusted
    path.chmod(0o600)
    try:
        loaded = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return trusted
    if isinstance(loaded, Mapping) and isinstance(loaded.get("keys"), Mapping):
        loaded = loaded["keys"]
    if not isinstance(loaded, Mapping):
        return trusted
    for raw_key_id, raw_key in loaded.items():
        if not isinstance(raw_key_id, str) or not isinstance(raw_key, str):
            continue
        if _summary_key_id(raw_key) != raw_key_id:
            continue
        trusted[raw_key_id] = raw_key
    return trusted


def _load_or_create_summary_key(config: WebAppConfig) -> str:
    path = _summary_key_path(config.grove_home, config.registry_session)
    key = secrets.token_urlsafe(48)
    try:
        _create_secret_file_exclusive(path, key + "\n")
    except FileExistsError:
        return _read_summary_key(path)
    return _read_summary_key(path)


def _summary_key_path(grove_home: Path, session: str) -> Path:
    return grove_home / session / "summary-signing-key"


def _summary_trusted_keys_path(config: WebAppConfig) -> Path:
    if config.summary_trusted_keys_path is not None:
        return config.summary_trusted_keys_path
    return config.grove_home / config.registry_session / SUMMARY_TRUSTED_KEYS_FILENAME


def _read_summary_key(path: Path) -> str:
    key = path.read_text(encoding="utf-8").strip()
    if not key:
        raise ValueError("summary signing key file is empty")
    path.chmod(0o600)
    return key


def _signed_handoff_payload(
    store: SQLiteBoardStore,
    *,
    project: ProjectContext,
    task: Task,
    auth: AuthContext,
) -> dict[str, object]:
    now = int(time.time())
    handoff_id = "handoff_" + secrets.token_urlsafe(18)
    key = _load_or_create_summary_key(project.config)
    payload = _handoff_payload(
        task,
        project=project,
        handoff_id=handoff_id,
        generated_at=now,
        expires_at=now + project.config.handoff_ttl_seconds,
    )
    actor = _actor_payload(auth)
    store.add_audit_event(
        board=project.board,
        kind="audit.handoff.export",
        actor=actor,
        action="export",
        target={"type": "handoff", "id": handoff_id, "task_id": task.id},
        task_id=task.id,
        payload={"project": project.name, "handoff_id": handoff_id},
        summary=task.title,
    )
    return {
        "algorithm": SUMMARY_ALGORITHM,
        "key_id": _summary_key_id(key),
        "payload": payload,
        "signature": _summary_signature(key, payload),
    }


def _handoff_payload(
    task: Task,
    *,
    project: ProjectContext,
    handoff_id: str,
    generated_at: int,
    expires_at: int,
) -> dict[str, object]:
    return {
        "schema": HANDOFF_SCHEMA,
        "handoff_id": handoff_id,
        "source_project": project.name,
        "generated_at": generated_at,
        "expires_at": expires_at,
        "task": {
            "title": _handoff_text(task.title, max_length=300),
            "body": _handoff_optional_text(task.body, max_length=4000),
            "priority": max(0, min(task.priority, 1000)),
            "labels": _handoff_labels(task.metadata),
        },
    }


def _accept_handoff_payload(
    store: SQLiteBoardStore,
    *,
    config: WebAppConfig,
    project: ProjectContext,
    package: Mapping[str, object],
    auth: AuthContext,
) -> dict[str, object]:
    verified = _verify_handoff_envelope(
        package,
        trusted_keys=_summary_trusted_keys(config),
        now=int(time.time()),
        receiver_ttl_seconds=config.handoff_ttl_seconds,
    )
    if verified["trust"] != "trusted":
        reason = str(verified.get("reason", "handoff package is untrusted"))
        status_code = 410 if "expired" in reason else 403
        raise HTTPException(status_code=status_code, detail=reason)
    payload = cast(Mapping[str, object], verified["payload"])
    task_payload = cast(Mapping[str, object], payload["task"])
    actor = _actor_payload(auth)
    task, created = store.accept_handoff_task(
        board=project.board,
        handoff_id=cast(str, payload["handoff_id"]),
        title=cast(str, task_payload["title"]),
        body=cast(str | None, task_payload.get("body")),
        priority=cast(int, task_payload["priority"]),
        labels=cast(list[str], task_payload["labels"]),
        metadata={
            "handoff": {
                "id": payload["handoff_id"],
                "source_project": payload["source_project"],
                "source_key_id": verified["key_id"],
                "generated_at": payload["generated_at"],
            }
        },
        created_by=_actor_id(actor),
        actor=actor,
    )
    return {
        "status": "created" if created else "existing",
        "created": created,
        "handoff_id": payload["handoff_id"],
        "task": _task_payload(task),
        "limitations": [
            "handoff accept creates a local unassigned ready task only",
            "handoff accept never dispatches or executes remote work",
        ],
    }


def _verify_handoff_envelope(
    envelope: Mapping[str, object],
    *,
    trusted_keys: Mapping[str, str],
    now: int,
    receiver_ttl_seconds: int,
) -> dict[str, object]:
    payload = envelope.get("payload")
    signature = envelope.get("signature")
    algorithm = envelope.get("algorithm")
    key_id = envelope.get("key_id")
    if not isinstance(payload, Mapping) or not isinstance(signature, str):
        return _untrusted_summary(reason="invalid handoff envelope")
    if algorithm != SUMMARY_ALGORITHM:
        return _untrusted_summary(reason="unsupported handoff algorithm")
    if not isinstance(key_id, str) or key_id not in trusted_keys:
        return _untrusted_summary(reason="unknown handoff key")
    expected = _summary_signature(trusted_keys[key_id], payload)
    if not hmac.compare_digest(signature, expected):
        return _untrusted_summary(reason="handoff signature verification failed")
    public_payload = _handoff_public_view(payload)
    if public_payload is None:
        return _untrusted_summary(reason="invalid handoff payload")
    generated_at = cast(int, public_payload["generated_at"])
    expires_at = cast(int, public_payload["expires_at"])
    if generated_at > now + SUMMARY_CLOCK_SKEW_SECONDS:
        return _untrusted_summary(reason="handoff timestamp is invalid")
    if generated_at + receiver_ttl_seconds < now:
        return _untrusted_summary(reason="handoff package expired by receiver ttl")
    if expires_at < now:
        return _untrusted_summary(reason="handoff package expired")
    return {
        "trust": "trusted",
        "freshness": "fresh",
        "key_id": _safe_log_text(key_id),
        "handoff_id": public_payload["handoff_id"],
        "payload": public_payload,
    }


def _handoff_public_view(payload: Mapping[str, object]) -> dict[str, object] | None:
    if payload.get("schema") != HANDOFF_SCHEMA:
        return None
    handoff_id = payload.get("handoff_id")
    source_project = payload.get("source_project")
    generated_at = _summary_int(payload.get("generated_at"))
    expires_at = _summary_int(payload.get("expires_at"))
    task = payload.get("task")
    if (
        not isinstance(handoff_id, str)
        or HANDOFF_ID_RE.fullmatch(handoff_id) is None
        or not isinstance(source_project, str)
        or generated_at is None
        or expires_at is None
        or not isinstance(task, Mapping)
    ):
        return None
    title = task.get("title")
    if not isinstance(title, str) or not title.strip():
        return None
    priority = _summary_int(task.get("priority"))
    if priority is None:
        return None
    body = task.get("body")
    if body is not None and not isinstance(body, str):
        return None
    labels = _handoff_public_labels(task.get("labels"))
    if labels is None:
        return None
    return {
        "schema": HANDOFF_SCHEMA,
        "handoff_id": handoff_id,
        "source_project": _safe_log_text(source_project),
        "generated_at": generated_at,
        "expires_at": expires_at,
        "task": {
            "title": _handoff_text(title, max_length=300),
            "body": _handoff_optional_text(body, max_length=4000),
            "priority": max(0, min(priority, 1000)),
            "labels": labels,
        },
    }


def _handoff_labels(metadata: Mapping[str, object]) -> list[str]:
    raw = metadata.get("labels")
    return _handoff_public_labels(raw) or []


def _handoff_public_labels(value: object) -> list[str] | None:
    if value is None:
        return []
    if not isinstance(value, list):
        return None
    labels: list[str] = []
    for item in value[:50]:
        if not isinstance(item, str):
            return None
        label = _handoff_text(item, max_length=100)
        if label:
            labels.append(label)
    return labels


def _handoff_optional_text(value: str | None, *, max_length: int) -> str | None:
    if value is None:
        return None
    text = _handoff_text(value, max_length=max_length)
    return text or None


def _handoff_text(value: str, *, max_length: int) -> str:
    raw = value.replace("\r", "\n")
    without_paths = ABSOLUTE_PATH_RE.sub("[path]", raw)
    without_secrets = redact_secret_text(without_paths)
    without_pii = EMAIL_RE.sub("[pii]", without_secrets)
    return re.sub(r"\s+", " ", without_pii).strip()[:max_length]


def _plan_payload(
    store: SQLiteBoardStore,
    *,
    project: ProjectContext,
    task: Task,
    role: str,
) -> dict[str, object]:
    clean_role = _safe_log_text(role)
    role_terms = _plan_terms(role) | _plan_metadata_terms(task.metadata, "role", "roles")
    if not role_terms:
        raise HTTPException(status_code=400, detail="role must contain searchable terms")
    capability_terms = _plan_metadata_terms(task.metadata, "capability", "capabilities")
    runs = store.list_runs_for_board(board=project.board)
    runs_by_node = _runs_by_node(runs)
    drafts = [
        _plan_candidate_draft(
            store,
            project=project,
            node=node,
            role_terms=role_terms,
            capability_terms=capability_terms,
            runs=runs_by_node.get(_cost_node_name(node), []),
        )
        for node in _cost_registry_node_records(project.config)
    ]
    candidates = _plan_ranked_candidates(drafts)
    return {
        "project": project.name,
        "task": {
            "id": task.id,
            "title": _safe_log_text(task.title),
            "status": task.status,
        },
        "requested_role": clean_role,
        "requirements": {
            "role_terms": sorted(
                _plan_public_terms(role)
                | _plan_public_metadata_terms(task.metadata, "role", "roles")
            ),
            "capability_terms": sorted(
                _plan_public_metadata_terms(task.metadata, "capability", "capabilities")
            ),
        },
        "generated_at": _cost_metric(int(time.time()), source="server", confidence="explicit"),
        "read_only": True,
        "recommended_action": "review the ranked candidates and assign manually",
        "candidates": candidates,
        "limitations": [
            "Scores are best-effort routing hints from registry, board load, and usage metadata.",
            "No task is claimed, assigned, spawned, or executed by this endpoint.",
        ],
    }


def _plan_candidate_draft(
    store: SQLiteBoardStore,
    *,
    project: ProjectContext,
    node: Mapping[str, object],
    role_terms: set[str],
    capability_terms: set[str],
    runs: Sequence[Run],
) -> PlanCandidateDraft:
    name = _cost_node_name(node)
    agent = _cost_node_agent(node)
    status_value, reason, status_confidence = _node_status_detail(node)
    running_tasks = len(store.list_tasks(board=project.board, status="running", assignee=name))
    blocked_tasks = len(store.list_tasks(board=project.board, status="blocked", assignee=name))
    node_terms = _plan_node_terms(node)
    role_score = _plan_match_score(role_terms, node_terms, PLAN_ROLE_WEIGHT)
    capability_score = _plan_match_score(
        capability_terms,
        node_terms,
        PLAN_CAPABILITY_WEIGHT,
    )
    load_score = _plan_load_score(
        status_value,
        running_tasks=running_tasks,
        blocked_tasks=blocked_tasks,
    )
    usage = _cost_usage_for_node(node, config=project.config, runs=runs)
    payload: dict[str, object] = {
        "node": _safe_log_text(name),
        "agent": _safe_log_text(agent),
        "role": _safe_log_text(_mapping_string(node, "role") or ""),
        "group": _safe_log_text(_mapping_string(node, "group") or ""),
        "status": status_value,
        "status_reason": _safe_log_text(reason),
        "score_breakdown": {
            "role_match": _cost_metric(
                round(role_score, 3),
                source="registry+request",
                confidence="inferred",
            ),
            "capability_match": _cost_metric(
                round(capability_score, 3),
                source="registry+task_metadata",
                confidence="inferred" if capability_terms else "unknown",
                status_value="unknown" if not capability_terms else None,
            ),
            "load": _cost_metric(
                round(load_score, 3),
                source="registry+board_store",
                confidence="partial" if status_confidence != "explicit" else "explicit",
            ),
        },
        "signals": {
            "running_tasks": _cost_metric(
                running_tasks,
                source="board_store",
                confidence="explicit",
            ),
            "blocked_tasks": _cost_metric(
                blocked_tasks,
                source="board_store",
                confidence="explicit",
            ),
            "cost_basis": {
                "total_tokens": _cost_metric(
                    usage.total_tokens,
                    source=usage.source if usage.total_tokens is not None else "none",
                    confidence=usage.confidence if usage.total_tokens is not None else "unknown",
                    status_value="unknown" if usage.total_tokens is None else None,
                ),
                "cost_usd": _cost_metric(
                    usage.cost_usd,
                    source=usage.source if usage.cost_usd is not None else "none",
                    confidence=usage.confidence if usage.cost_usd is not None else "unknown",
                    status_value="unknown" if usage.cost_usd is None else None,
                ),
            },
        },
    }
    return PlanCandidateDraft(
        node=name,
        payload=payload,
        role_score=role_score,
        capability_score=capability_score,
        load_score=load_score,
        token_signal=float(usage.total_tokens) if usage.total_tokens is not None else None,
        cost_usd_signal=usage.cost_usd,
        cost_source=_plan_cost_source(usage),
        cost_confidence=_plan_cost_confidence(usage),
    )


def _plan_ranked_candidates(drafts: Sequence[PlanCandidateDraft]) -> list[dict[str, object]]:
    cost_scores = _plan_cost_scores(drafts)
    candidates: list[dict[str, object]] = []
    for draft in drafts:
        cost_score = cost_scores.get(draft.node, 0.0)
        total_score = draft.role_score + draft.capability_score + draft.load_score + cost_score
        payload = dict(draft.payload)
        score_breakdown = dict(cast(dict[str, object], payload["score_breakdown"]))
        score_breakdown["cost"] = _cost_metric(
            round(cost_score, 3),
            source=draft.cost_source,
            confidence=draft.cost_confidence,
            status_value=(
                "unknown" if draft.token_signal is None and draft.cost_usd_signal is None else None
            ),
        )
        payload["score_breakdown"] = score_breakdown
        payload["score"] = _cost_metric(
            round(total_score, 3),
            source="planner",
            confidence=_plan_candidate_confidence(draft),
        )
        candidates.append(payload)
    candidates.sort(
        key=lambda item: (
            -_plan_payload_score(item),
            str(item["node"]),
        )
    )
    for index, candidate in enumerate(candidates, start=1):
        candidate["rank"] = _cost_metric(index, source="planner", confidence="explicit")
    return candidates


def _plan_payload_score(item: Mapping[str, object]) -> float:
    score = item.get("score")
    if not isinstance(score, Mapping):
        return 0.0
    value = score.get("value")
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return float(value)
    return 0.0


def _plan_cost_scores(drafts: Sequence[PlanCandidateDraft]) -> dict[str, float]:
    token_scores = _plan_inverse_unit_scores(
        {draft.node: draft.token_signal for draft in drafts},
    )
    usd_scores = _plan_inverse_unit_scores(
        {draft.node: draft.cost_usd_signal for draft in drafts},
    )
    combined: dict[str, float] = {}
    for draft in drafts:
        components: list[float] = []
        if draft.token_signal is not None:
            components.append(token_scores[draft.node])
        if draft.cost_usd_signal is not None:
            components.append(usd_scores[draft.node])
        combined[draft.node] = sum(components) / len(components) if components else 0.0
    return combined


def _plan_inverse_unit_scores(values_by_node: Mapping[str, float | None]) -> dict[str, float]:
    values = [value for value in values_by_node.values() if value is not None]
    if not values:
        return {node: 0.0 for node in values_by_node}
    low = min(values)
    high = max(values)
    scores: dict[str, float] = {}
    for node, value in values_by_node.items():
        if value is None:
            scores[node] = 0.0
        elif high == low:
            scores[node] = PLAN_COST_WEIGHT
        else:
            scores[node] = PLAN_COST_WEIGHT * ((high - value) / (high - low))
    return scores


def _plan_candidate_confidence(draft: PlanCandidateDraft) -> str:
    if draft.token_signal is None and draft.cost_usd_signal is None:
        return "partial"
    if draft.cost_confidence == "explicit":
        return "partial"
    if draft.cost_confidence == "unknown":
        return "partial"
    return draft.cost_confidence


def _plan_cost_source(usage: CostUsage) -> str:
    sources: list[str] = []
    if usage.total_tokens is not None:
        sources.append("total_tokens")
    if usage.cost_usd is not None:
        sources.append("cost_usd")
    if not sources:
        return "none"
    return f"{usage.source}:{'+'.join(sources)}"


def _plan_cost_confidence(usage: CostUsage) -> str:
    if usage.total_tokens is None and usage.cost_usd is None:
        return "unknown"
    return usage.confidence


def _plan_load_score(status_value: str, *, running_tasks: int, blocked_tasks: int) -> float:
    base = {
        "idle": PLAN_LOAD_WEIGHT,
        "running": 12.0,
        "blocked": 6.0,
        "error": 0.0,
        "dead": 0.0,
    }.get(status_value, 15.0)
    penalty = min(10.0, (running_tasks * 5.0) + (blocked_tasks * 3.0))
    return max(0.0, base - penalty)


def _plan_match_score(required: set[str], available: set[str], weight: float) -> float:
    if not required:
        return 0.0
    matched = required & available
    return weight * (len(matched) / len(required))


def _plan_node_terms(node: Mapping[str, object]) -> set[str]:
    terms: set[str] = set()
    for key in (
        "_cost_name",
        "_cost_agent",
        "agent",
        "name",
        "role",
        "group",
        "description",
        "capability",
        "capabilities",
        "skills",
        "tags",
    ):
        terms.update(_plan_value_terms(node.get(key)))
    return terms


def _plan_metadata_terms(metadata: Mapping[str, object], *keys: str) -> set[str]:
    terms: set[str] = set()
    for key in keys:
        terms.update(_plan_value_terms(metadata.get(key)))
    return terms


def _plan_public_metadata_terms(metadata: Mapping[str, object], *keys: str) -> set[str]:
    terms: set[str] = set()
    for key in keys:
        terms.update(_plan_public_value_terms(metadata.get(key)))
    return terms


def _plan_value_terms(value: object) -> set[str]:
    if isinstance(value, str):
        return _plan_terms(value)
    if isinstance(value, Sequence) and not isinstance(value, str):
        terms: set[str] = set()
        for item in value:
            terms.update(_plan_value_terms(item))
        return terms
    return set()


def _plan_public_value_terms(value: object) -> set[str]:
    if isinstance(value, str):
        return _plan_public_terms(value)
    if isinstance(value, Sequence) and not isinstance(value, str):
        terms: set[str] = set()
        for item in value:
            terms.update(_plan_public_value_terms(item))
        return terms
    return set()


def _plan_public_terms(value: str) -> set[str]:
    safe_terms = _plan_terms(_safe_log_text(value))
    return {_plan_public_term(term) for term in safe_terms if term}


def _plan_public_term(term: str) -> str:
    if len(term) > 48:
        return "redacted"
    if term in {"applications", "etc", "home", "opt", "private", "tmp", "users", "usr", "var"}:
        return "path"
    return term


def _plan_terms(value: str) -> set[str]:
    return {term for term in re.findall(r"[a-z0-9]+", value.lower()) if term}


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


def _safe_public_text(value: object) -> str:
    return EMAIL_RE.sub("[pii]", _safe_log_text(value))


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


def _require_operator_state_change(
    request: Request,
    *,
    detail: str = "mutation requires operator role",
) -> AuthContext:
    auth = _require_state_change(request)
    _require_operator_access(auth, detail=detail)
    return auth


def _require_team_csrf(request: Request, *, auth: AuthContext) -> None:
    supplied = request.headers.get(CSRF_HEADER)
    expected = auth.csrf_token
    if expected is None or supplied is None or not secrets.compare_digest(supplied, expected):
        raise HTTPException(status_code=403, detail="missing or invalid csrf token")


def _require_operator_access(auth: AuthContext, *, detail: str) -> None:
    if auth.mode == AuthMode.TEAM_COOKIE:
        if auth.member is None or auth.member.role == "viewer":
            raise HTTPException(status_code=403, detail=detail)


def _require_audit_access(auth: AuthContext) -> None:
    _require_operator_access(auth, detail="audit requires operator role")


def _require_cost_access(auth: AuthContext) -> None:
    _require_operator_access(auth, detail="cost requires operator role")


def _require_summary_enabled(config: WebAppConfig) -> None:
    if not config.summary_export_enabled:
        raise HTTPException(status_code=404, detail="summary export is not enabled")


def _require_handoff_enabled(config: WebAppConfig) -> None:
    if not config.handoff_enabled:
        raise HTTPException(status_code=404, detail="handoff is not enabled")


def _require_quota_enabled(config: WebAppConfig) -> None:
    if not config.quota_enabled:
        raise HTTPException(status_code=404, detail="quota is not enabled")


def _require_retro_analytics_enabled(config: WebAppConfig) -> None:
    if not config.retro_analytics_enabled:
        raise HTTPException(status_code=404, detail="retro analytics is not enabled")


def _require_usage_trend_enabled(config: WebAppConfig) -> None:
    if not config.usage_trend_enabled:
        raise HTTPException(status_code=404, detail="usage trend is not enabled")


def _require_answer_access(auth: AuthContext) -> None:
    _require_operator_access(auth, detail="answer requires operator role")


def _require_retro_access(auth: AuthContext) -> None:
    _require_operator_access(auth, detail="retro requires operator role")


def _require_execution_access(auth: AuthContext) -> None:
    _require_operator_access(auth, detail="execution requires operator role")


def _require_node_mutation_access(auth: AuthContext) -> None:
    _require_operator_access(auth, detail="node mutation requires operator role")


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


def _retro_enabled(task: Task) -> bool:
    for key in ("self_retro", "retro_enabled", "self_retro_enabled"):
        value = task.metadata.get(key)
        if isinstance(value, bool) and value:
            return True
    return False


def _member_registry(config: WebAppConfig) -> MemberRegistry:
    return MemberRegistry(members_path(config.grove_home, config.registry_session))


def _session_signer(config: WebAppConfig) -> SessionSigner:
    return SessionSigner(session_secret_path(config.grove_home, config.registry_session))


def _team_session_store(request: Request) -> TeamSessionStore:
    return cast(TeamSessionStore, request.app.state.team_session_store)


def _team_join_code_store(request: Request) -> TeamJoinCodeStore:
    return cast(TeamJoinCodeStore, request.app.state.team_join_code_store)


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


def _require_shared_access_enabled(config: WebAppConfig) -> None:
    if not config.shared_access:
        raise HTTPException(status_code=404, detail="shared access is not enabled")
    if config.auth_mode != AuthMode.TEAM_COOKIE:
        raise HTTPException(status_code=500, detail="shared access requires team auth")


def _require_share_access(auth: AuthContext) -> None:
    if auth.mode != AuthMode.TEAM_COOKIE or auth.member is None:
        raise HTTPException(status_code=403, detail="share requires team member")
    _require_operator_access(auth, detail="share requires operator role")


def _require_project_mutation_access(auth: AuthContext) -> None:
    _require_operator_access(auth, detail="project mutation requires operator role")


def _validated_join_name(name: str) -> str:
    clean = re.sub(r"\s+", " ", name.strip())
    if JOIN_MEMBER_NAME_RE.fullmatch(clean) is None:
        raise HTTPException(status_code=400, detail="invalid member name")
    return clean


def _join_client_key(request: Request) -> str:
    if request.client is not None:
        return _safe_log_text(request.client.host)
    return "unknown"


def _share_url(request: Request, code: str) -> str:
    return str(request.url_for("index_endpoint")) + f"?join={code}"


def _quota_member_id(value: str, *, config: WebAppConfig) -> str:
    clean = _optional_text(value, field_name="member_id", max_length=200)
    if clean is None:
        raise HTTPException(status_code=400, detail="member_id is required")
    try:
        members = _member_registry(config).list_members()
    except ValueError:
        members = []
    for member in members:
        if clean in {member.id, member.name}:
            return member.id
    if members:
        raise HTTPException(status_code=404, detail="member not found")
    if NODE_NAME_RE.fullmatch(clean) is None:
        raise HTTPException(status_code=400, detail="invalid member_id")
    return clean


def _board_query_filters(
    store: SQLiteBoardStore,
    *,
    board: str,
    view: str | None,
    status: str | None,
    assignee: str | None,
    label: str | None,
    q: str | None,
    limit: int,
) -> dict[str, object]:
    filters: dict[str, object] = {"limit": limit}
    if view is not None and view.strip():
        name = _saved_view_name(view)
        saved = store.saved_views(board=board).get(name)
        if saved is None:
            raise HTTPException(status_code=404, detail="saved view not found")
        filters.update(_saved_view_filters(saved))
    for key, value in (
        ("status", status),
        ("assignee", assignee),
        ("label", label),
        ("q", q),
    ):
        clean = _optional_query_text(value, field=key)
        if clean is not None:
            filters[key] = clean
    filters["limit"] = _query_limit(filters.get("limit"), fallback=limit)
    return filters


def _saved_view_name(value: str) -> str:
    clean = value.strip()
    if NOTIFICATION_TEXT_RE.fullmatch(clean) is None:
        raise HTTPException(status_code=400, detail="invalid saved view name")
    return clean


def _saved_view_filters(value: Mapping[str, object]) -> dict[str, object]:
    filters: dict[str, object] = {}
    for key in ("status", "assignee", "label", "q"):
        raw = value.get(key)
        if isinstance(raw, str) and raw.strip():
            filters[key] = raw.strip()[:500]
    filters["limit"] = _query_limit(value.get("limit"), fallback=50)
    return filters


def _query_limit(value: object, *, fallback: int) -> int:
    if isinstance(value, int) and not isinstance(value, bool):
        return max(1, min(value, 100))
    return max(1, min(fallback, 100))


def _optional_query_text(value: str | None, *, field: str) -> str | None:
    if value is None:
        return None
    clean = value.strip()
    if not clean:
        return None
    if len(clean) > 500:
        raise HTTPException(status_code=400, detail=f"{field} is too long")
    if field != "q" and any(ord(char) < 32 for char in clean):
        raise HTTPException(status_code=400, detail=f"invalid {field}")
    return clean


def _safe_query_filters(filters: Mapping[str, object]) -> dict[str, object]:
    safe: dict[str, object] = {}
    for key, value in filters.items():
        if isinstance(value, str):
            safe[key] = _safe_public_text(value)
        elif isinstance(value, int) and not isinstance(value, bool):
            safe[key] = value
    return safe


def _saved_view_payloads(
    views: Mapping[str, Mapping[str, object]],
) -> list[dict[str, object]]:
    return [_saved_view_payload(name, views[name]) for name in sorted(views)]


def _saved_view_payload(name: str, value: Mapping[str, object]) -> dict[str, object]:
    payload: dict[str, object] = {
        "name": _safe_public_text(name),
        "filters": _safe_query_filters(value),
    }
    updated_at = value.get("updated_at")
    if isinstance(updated_at, int) and not isinstance(updated_at, bool):
        payload["updated_at"] = updated_at
    return payload


def _query_task_payload(task: Task) -> dict[str, object]:
    payload: dict[str, object] = {
        "id": task.id,
        "title": _safe_public_text(task.title),
        "status": _safe_public_text(task.status),
        "body": _safe_public_text(task.body or ""),
        "priority": task.priority,
        "created": task.created_at,
        "updated": task.updated_at,
        "labels": [_safe_public_text(label) for label in _task_labels(task)],
    }
    if task.assignee is not None:
        payload["assignee"] = _safe_public_text(task.assignee)
    if task.result is not None:
        payload["latest_summary"] = _safe_public_text(task.result)
    return payload


def _task_labels(task: Task) -> tuple[str, ...]:
    raw = task.metadata.get("labels")
    labels: list[str] = []
    if isinstance(raw, str) and raw.strip():
        labels.append(raw.strip())
    elif isinstance(raw, Sequence) and not isinstance(raw, str | bytes):
        for item in raw:
            if isinstance(item, str) and item.strip():
                labels.append(item.strip())
    return tuple(labels)


def _notification_routing_state_from_payload(
    payload: NotificationRoutingPayload,
) -> dict[str, object]:
    return {
        "enabled": payload.enabled,
        "dry_run": payload.dry_run,
        "rules": [_notification_rule_payload(rule) for rule in payload.rules],
    }


def _notification_rule_payload(rule: NotificationRoutePayload) -> dict[str, object]:
    clean_event = rule.event_type.strip()
    if clean_event not in {"*", "blocked", "ask_human_pending", "anomaly"}:
        raise HTTPException(status_code=400, detail="invalid notification event_type")
    clean_rule: dict[str, object] = {
        "name": _notification_text(rule.name, field_name="name"),
        "event_type": clean_event,
        "target": _notification_target_payload(rule.target),
        "escalation_targets": [
            _notification_target_payload(target) for target in rule.escalation_targets
        ],
        "max_escalations": min(rule.max_escalations, len(rule.escalation_targets)),
    }
    if rule.node is not None:
        clean_rule["node"] = _optional_node_ref(rule.node, field_name="node")
    if rule.severity is not None:
        clean_rule["severity"] = _notification_text(rule.severity, field_name="severity").lower()
    if rule.escalate_after_seconds is not None:
        clean_rule["escalate_after_seconds"] = rule.escalate_after_seconds
    return clean_rule


def _notification_target_payload(target: NotificationTargetPayload) -> dict[str, object]:
    return {
        "channel_kind": _notification_text(target.channel_kind, field_name="channel_kind"),
        "room_id": _notification_text(target.room_id, field_name="room_id"),
    }


def _notification_text(value: str, *, field_name: str) -> str:
    clean = value.strip()
    if NOTIFICATION_TEXT_RE.fullmatch(clean) is None:
        raise HTTPException(status_code=400, detail=f"invalid notification {field_name}")
    return clean


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


def _is_shared_remote_bind(host: str) -> bool:
    normalized = _normalize_hostname(host)
    if normalized is None:
        return True
    return normalized not in LOOPBACK_HOSTS


def _startup_connect_lines(config: WebAppConfig) -> list[str]:
    bind_host = _normalize_hostname(config.host) or config.host
    tailnet_ip = _detect_tailnet_ip()
    local_url = _http_url("127.0.0.1", config.port)
    lines = [
        "Grove dev-room is starting.",
        f"Local dashboard: {local_url}",
    ]
    if _is_shared_remote_bind(config.host):
        if bind_host in WILDCARD_BIND_HOSTS:
            lines.append("Warning: wildcard bind exposes grove-web on every network interface.")
            if tailnet_ip is not None:
                lines.append(
                    f"Team dashboard: {_http_url(tailnet_ip, config.port)} "
                    "(Tailscale tailnet address)"
                )
            else:
                lines.append(
                    "Team dashboard: use this host's trusted tailnet/LAN IP with the same port."
                )
        else:
            lines.append(f"Team dashboard: {_http_url(bind_host, config.port)}")
        if config.allowed_hosts:
            lines.append(f"Allowed browser hosts: {', '.join(config.allowed_hosts)}")
        else:
            lines.append(
                "Warning: no --allow-host entries; remote state-changing requests are denied."
            )
    elif tailnet_ip is not None:
        lines.append(
            "For teammates on your tailnet, restart with "
            f"--host 0.0.0.0 --allow-host {tailnet_ip} and share "
            f"{_http_url(tailnet_ip, config.port)}."
        )
    if config.shared_access:
        lines.append(
            "Shared access: enabled. Invite teammates from the dashboard, or issue a "
            "one-time code with POST /api/share from an operator session."
        )
    else:
        lines.append("Shared access: off. Use --shared-access for teammate join codes.")
    return lines


def _print_startup_connect_hint(config: WebAppConfig) -> None:
    for line in _startup_connect_lines(config):
        print(line, file=sys.stderr, flush=True)


def _print_bind_refusal_hint(host: str) -> None:
    print(
        "Grove dev-room refused shared-access on a non-loopback bind without "
        "--allow-host. Add trusted tailnet/LAN hosts explicitly.",
        file=sys.stderr,
        flush=True,
    )
    if _normalize_hostname(host) in WILDCARD_BIND_HOSTS:
        print(
            "Wildcard bind requested: keep --allow-host limited to trusted peer hosts.",
            file=sys.stderr,
            flush=True,
        )


def _detect_tailnet_ip() -> str | None:
    try:
        proc = subprocess.run(
            ["tailscale", "ip", "-4"],
            capture_output=True,
            text=True,
            timeout=TAILSCALE_IP_TIMEOUT_SECONDS,
            check=False,
        )
    except (FileNotFoundError, OSError, subprocess.TimeoutExpired):
        return None
    if proc.returncode != 0:
        return None
    tailnet = ipaddress.ip_network("100.64.0.0/10")
    for line in proc.stdout.splitlines():
        candidate = line.strip()
        if not candidate:
            continue
        try:
            address = ipaddress.ip_address(candidate)
        except ValueError:
            continue
        if isinstance(address, ipaddress.IPv4Address) and address in tailnet:
            return candidate
    return None


def _http_url(host: str, port: int) -> str:
    if ":" in host and not host.startswith("["):
        return f"http://[{host}]:{port}"
    return f"http://{host}:{port}"


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
    clean = board_id.strip()
    if not clean:
        raise HTTPException(status_code=400, detail="board id is required")
    if BOARD_NAME_RE.fullmatch(clean) is None:
        raise HTTPException(status_code=400, detail="invalid board id")
    if not project.from_header:
        return clean
    if clean == project.board or clean in PROJECT_BOARD_ALIASES:
        return project.board
    if clean in DELEGATE_BOARD_ALIASES and project.name == DELEGATE_BOARD_OWNER_PROJECT:
        return clean
    raise HTTPException(
        status_code=404,
        detail=f"board {clean!r} not in project {project.name!r}",
    )


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
    if not any(node["name"] == LEAD_NODE_NAME for node in nodes):
        nodes.append(_external_lead_node())
        nodes = sorted(nodes, key=lambda node: node["name"])
    names = {node["name"] for node in nodes}
    children_by_parent: dict[str, list[str]] = {name: [] for name in names}
    groups: dict[str, list[str]] = {}
    parent_by_node: dict[str, str] = {}
    for node in nodes:
        parent = _org_parent(node, names=names)
        parent_by_node[node["name"]] = parent
        if parent in names:
            children_by_parent[parent].append(node["name"])
        group = node["group"]
        if group:
            groups.setdefault(group, []).append(node["name"])

    graph_nodes: list[dict[str, object]] = []
    for node in nodes:
        parent = parent_by_node[node["name"]]
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
        "roots": sorted(node["name"] for node in nodes if not parent_by_node[node["name"]]),
        "groups": [
            {"name": group, "parent": LEAD_NODE_NAME, "nodes": sorted(group_nodes)}
            for group, group_nodes in sorted(groups.items())
        ],
        "nodes": graph_nodes,
    }


def _external_lead_node() -> dict[str, str]:
    return {
        "name": LEAD_NODE_NAME,
        "agent": "claude",
        "tmux_pane": "",
        "session_id": "",
        "status": "external",
        "role": "orchestrator",
        "parent": "",
        "group": "",
        "description": "External lead/orchestrator.",
    }


def _org_parent(node: Mapping[str, str], *, names: set[str]) -> str:
    name = node["name"]
    parent = node["parent"]
    if name == LEAD_NODE_NAME:
        return ""
    if parent in names:
        return parent
    if node["group"] and LEAD_NODE_NAME in names:
        return LEAD_NODE_NAME
    return ""


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


def _node_in_project(name: str, *, config: WebAppConfig) -> str:
    node_name = _validated_node_ref(name, field_name="node")
    if not any(node["name"] == node_name for node in _registry_node_records(config)):
        raise HTTPException(status_code=404, detail="node not found")
    return node_name


def _node_autopickup_payload(
    store: SQLiteBoardStore,
    *,
    project: ProjectContext,
    node: str,
    state: Mapping[str, object] | None = None,
) -> dict[str, object]:
    raw = (
        dict(state)
        if state is not None
        else store.node_autopickup_state(
            board=project.board,
            node=node,
        )
    )
    return {
        "project": project.name,
        "node": _safe_log_text(node),
        "enabled": bool(raw.get("enabled")),
        "configured": bool(raw.get("configured")),
        "global_enabled": bool(raw.get("global_enabled")),
        "global_kill_switch": bool(raw.get("global_kill_switch")),
    }


def _node_execution_payload(
    store: SQLiteBoardStore,
    *,
    project: ProjectContext,
    node: str,
    state: Mapping[str, object] | None = None,
) -> dict[str, object]:
    raw = (
        dict(state)
        if state is not None
        else store.node_execution_state(
            board=project.board,
            node=node,
        )
    )
    return {
        "project": project.name,
        "node": _safe_log_text(node),
        "enabled": bool(raw.get("enabled")),
        "configured": bool(raw.get("configured")),
        "kill_switch": bool(raw.get("kill_switch")),
        "global_enabled": bool(raw.get("global_enabled")),
        "global_kill_switch": bool(raw.get("global_kill_switch")),
        "board_enabled": bool(raw.get("board_enabled")),
        "board_kill_switch": bool(raw.get("board_kill_switch")),
    }


def _execution_gate_payload(
    store: SQLiteBoardStore,
    *,
    project: ProjectContext,
    state: Mapping[str, object] | None = None,
) -> dict[str, object]:
    raw = dict(state) if state is not None else store.execution_global_state(board=project.board)
    return {
        "project": project.name,
        "enabled": bool(raw.get("enabled")),
        "kill_switch": bool(raw.get("kill_switch")),
        "board_enabled": bool(raw.get("board_enabled")),
        "board_kill_switch": bool(raw.get("board_kill_switch")),
    }


def _task_execution_payload(
    store: SQLiteBoardStore,
    *,
    project: ProjectContext,
    task: Task,
) -> dict[str, object]:
    execution = _public_execution_state(
        store.task_execution_state(board=project.board, task_id=task.id)
    )
    node = _execution_node_for_task(store, project=project, task=task)
    gate = store.execution_gate_state(board=project.board, node=node, task_id=task.id)
    return {
        "project": project.name,
        "task_id": task.id,
        "node": _safe_log_text(node),
        "state": _safe_log_text(execution.get("state", "none")),
        "approved": bool(execution.get("approved")),
        "gate": gate,
        "execution": execution,
    }


def _public_execution_state(execution: Mapping[str, object]) -> dict[str, object]:
    public = dict(execution)
    public.pop("dispatch_lease", None)
    return public


def _execution_node_for_task(
    store: SQLiteBoardStore,
    *,
    project: ProjectContext,
    task: Task,
) -> str:
    execution = store.task_execution_state(board=project.board, task_id=task.id)
    raw_node = execution.get("node")
    if isinstance(raw_node, str) and raw_node.strip():
        return _validated_node_ref(raw_node, field_name="node")
    if task.assignee is not None and task.assignee.strip():
        return _validated_node_ref(task.assignee, field_name="node")
    raise HTTPException(status_code=409, detail="task has no execution node")


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


def _mapping_int(mapping: Mapping[str, object], key: str) -> int | None:
    value = mapping.get(key)
    if isinstance(value, int) and not isinstance(value, bool):
        return value
    return None


def _mapping_float(mapping: Mapping[str, object], key: str) -> float | None:
    value = mapping.get(key)
    if isinstance(value, int | float) and not isinstance(value, bool):
        return float(value)
    return None


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
    parser.add_argument(
        "--shared-access",
        action="store_true",
        help=(
            "Allow tailnet-scoped multi-user access with one-time join codes. "
            "Use --allow-host for non-loopback peers."
        ),
    )
    parser.add_argument(
        "--shared-join-role",
        choices=sorted(MEMBER_ROLES),
        default="operator",
        help="Role granted to members created from one-time join codes.",
    )
    parser.add_argument(
        "--enable-summary-export",
        action="store_true",
        help="Enable signed read-only summary export and aggregation endpoints.",
    )
    parser.add_argument(
        "--summary-freshness-seconds",
        type=int,
        default=SUMMARY_FRESHNESS_SECONDS,
        help="Freshness window for signed summaries accepted by /api/aggregate.",
    )
    parser.add_argument(
        "--summary-trusted-keys",
        type=Path,
        default=None,
        help=(
            "Optional JSON file with trusted summary signing keys, formatted as "
            '{"keys":{"<key_id>":"<key>"}}.'
        ),
    )
    parser.add_argument(
        "--enable-handoff",
        action="store_true",
        help="Enable signed read-only handoff export and receiver-local accept endpoints.",
    )
    parser.add_argument(
        "--handoff-ttl-seconds",
        type=int,
        default=HANDOFF_TTL_SECONDS,
        help="Lifetime for signed handoff packages.",
    )
    parser.add_argument(
        "--enable-quotas",
        action="store_true",
        help="Enable soft per-member quota configuration. Enforcement is warning-only.",
    )
    parser.add_argument(
        "--enable-intake",
        action="store_true",
        help="Report Slack intent intake as enabled in /api/slack/config/status.",
    )
    parser.add_argument(
        "--enable-retro-analytics",
        action="store_true",
        help="Enable read-only retro analytics insights.",
    )
    parser.add_argument(
        "--enable-usage-trend",
        action="store_true",
        help="Enable advisory-only usage trend and anomaly signals.",
    )
    args = parser.parse_args(argv)

    import uvicorn

    allowed_hosts = _normalize_allowed_hosts(args.allow_host)
    if args.shared_access and _is_shared_remote_bind(args.host) and not allowed_hosts:
        _print_bind_refusal_hint(args.host)
    config = WebAppConfig(
        dist_dir=args.dist_dir,
        board_db_path=args.board_db_path,
        grove_home=Path(os.environ.get("GROVE_HOME", "~/.grove")).expanduser(),
        registry_session=args.session,
        host=args.host,
        port=args.port,
        unsafe_bind_token_bootstrap=args.unsafe_bind,
        allowed_hosts=allowed_hosts,
        auth_mode=AuthMode.TEAM_COOKIE
        if args.team_auth or args.shared_access
        else AuthMode.LOCAL_TOKEN,
        shared_access=args.shared_access,
        shared_join_role=args.shared_join_role,
        summary_export_enabled=args.enable_summary_export,
        summary_freshness_seconds=args.summary_freshness_seconds,
        summary_trusted_keys_path=args.summary_trusted_keys,
        handoff_enabled=args.enable_handoff,
        handoff_ttl_seconds=args.handoff_ttl_seconds,
        quota_enabled=args.enable_quotas,
        slack_intake_enabled=args.enable_intake,
        retro_analytics_enabled=args.enable_retro_analytics,
        usage_trend_enabled=args.enable_usage_trend,
    )
    app = create_app(config=config)
    started_at = cast(int, app.state.started_at)
    _print_startup_connect_hint(config)
    try:
        uvicorn.run(app, host=config.host, port=config.port)
    finally:
        _remove_web_companion(config, started_at=started_at)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
