from __future__ import annotations

import base64
import hashlib
import hmac
import json
import logging
import os
import sqlite3
import subprocess
import threading
import time
from pathlib import Path
from typing import Any, cast

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

import grove_bridge.team_auth as team_auth
import grove_bridge.web_app as web_app
from grove_bridge.assistant import AssistantBusy, AssistantLLMClient, AssistantUnavailable
from grove_bridge.auth_status import ToolAuthStatus
from grove_bridge.store import BoardEvent, SQLiteBoardStore
from grove_bridge.team_auth import (
    CSRF_HEADER,
    TEAM_SESSION_COOKIE,
    MemberRegistry,
    TeamMember,
    TeamSessionStore,
    hash_secret,
    members_path,
    session_secret_path,
)
from grove_bridge.web_app import AuthMode, WebAppConfig, create_app


class FakeAssistantLLMClient:
    def __init__(self, text: str = "LLM answer from facts. [fact:board.status_counts]") -> None:
        self.text = text
        self.calls: list[dict[str, str]] = []

    def complete(self, *, system_prompt: str, user_prompt: str) -> str:
        self.calls.append({"system_prompt": system_prompt, "user_prompt": user_prompt})
        return self.text


class UnavailableAssistantLLMClient:
    def complete(self, *, system_prompt: str, user_prompt: str) -> str:
        _ = (system_prompt, user_prompt)
        raise AssistantUnavailable("llm unavailable")


class BusyAssistantLLMClient:
    def complete(self, *, system_prompt: str, user_prompt: str) -> str:
        _ = (system_prompt, user_prompt)
        raise AssistantBusy("assistant node rate limited")


def payload_contains_number(value: object, needle: int | float) -> bool:
    if isinstance(value, bool):
        return False
    if isinstance(value, (int, float)):
        return value == needle
    if isinstance(value, dict):
        return any(payload_contains_number(item, needle) for item in value.values())
    if isinstance(value, list):
        return any(payload_contains_number(item, needle) for item in value)
    return False


def test_index_injects_session_token_and_serves_dist_assets(tmp_path: Path) -> None:
    client = make_client(tmp_path, SQLiteBoardStore(tmp_path / "board.db"))

    index = client.get("/")
    asset = client.get("/app.js")
    fallback = client.get("/nested/dev-room")

    assert index.status_code == 200
    assert 'window.__GROVE_SESSION_TOKEN__ = "test-token"' in index.text
    assert "window.__GROVE_AUTH_REQUIRED__ = true" in index.text
    assert index.text.index("window.__GROVE_SESSION_TOKEN__") < index.text.index(
        '<script src="/app.js"></script>'
    )
    assert asset.status_code == 200
    assert asset.text == "window.loaded = true;"
    assert fallback.status_code == 200
    assert 'window.__GROVE_SESSION_TOKEN__ = "test-token"' in fallback.text


def test_index_does_not_bootstrap_token_on_non_loopback_without_unsafe_bind(
    tmp_path: Path,
) -> None:
    client = make_client(
        tmp_path,
        SQLiteBoardStore(tmp_path / "board.db"),
        host="0.0.0.0",
    )

    index = client.get("/")

    assert index.status_code == 200
    assert "window.__GROVE_SESSION_TOKEN__" not in index.text
    assert "window.__GROVE_AUTH_REQUIRED__ = true" in index.text


def test_index_bootstraps_token_on_non_loopback_with_unsafe_bind(tmp_path: Path) -> None:
    client = make_client(
        tmp_path,
        SQLiteBoardStore(tmp_path / "board.db"),
        host="0.0.0.0",
        unsafe_bind_token_bootstrap=True,
    )

    index = client.get("/")

    assert 'window.__GROVE_SESSION_TOKEN__ = "test-token"' in index.text


def test_team_auth_index_never_bootstraps_local_session_token(tmp_path: Path) -> None:
    client = make_client(
        tmp_path,
        SQLiteBoardStore(tmp_path / "board.db"),
        host="0.0.0.0",
        unsafe_bind_token_bootstrap=True,
        auth_mode=AuthMode.TEAM_COOKIE,
    )

    index = client.get("/")

    assert "window.__GROVE_SESSION_TOKEN__" not in index.text
    assert 'window.__GROVE_AUTH_MODE__ = "team-cookie"' in index.text


def test_health_is_public_and_does_not_expose_project_session_or_token(tmp_path: Path) -> None:
    client = make_client(tmp_path, SQLiteBoardStore(tmp_path / "board.db"))

    response = client.get("/api/health")
    payload = response.json()

    assert response.status_code == 200
    assert payload["ok"] is True
    assert payload["board_ok"] is True
    assert isinstance(payload["version"], str)
    assert isinstance(payload["started_at"], int)
    assert isinstance(payload["uptime"], int)
    assert "uptime_seconds" not in payload
    rendered = json.dumps(payload)
    assert "test-token" not in rendered
    assert "dev10" not in rendered
    assert "project" not in payload
    assert "session" not in payload


def test_team_auth_login_session_me_csrf_and_secret_storage(tmp_path: Path) -> None:
    secret = "correct horse battery staple"
    write_team_member(tmp_path, secret=secret)
    store = SQLiteBoardStore(tmp_path / "board.db")
    client = make_client(tmp_path, store, auth_mode=AuthMode.TEAM_COOKIE)

    assert client.get("/api/me").status_code == 401
    assert client.get("/api/status", headers=auth_headers(client)).status_code == 401

    login = client.post("/api/login", json={"name": "alice", "secret": secret})
    assert login.status_code == 200
    assert TEAM_SESSION_COOKIE in login.headers["set-cookie"]
    assert "httponly" in login.headers["set-cookie"].lower()
    assert "samesite=strict" in login.headers["set-cookie"].lower()
    login_payload = login.json()
    assert login_payload["member"] == {"id": "member-1", "name": "alice", "role": "admin"}
    assert login_payload["account"] == {
        "id": "member-1",
        "login": "alice",
        "display_name": "alice",
        "role": "admin",
        "enabled": True,
    }
    csrf = str(login_payload["csrf"])

    me = client.get("/api/me")
    assert me.status_code == 200
    assert me.json()["member"]["name"] == "alice"
    assert me.json()["account"]["login"] == "alice"
    assert client.get("/api/csrf").json()["csrf"] == csrf
    stolen_cookie = client.cookies.get(TEAM_SESSION_COOKIE)
    assert stolen_cookie is not None

    missing_csrf = client.post("/api/boards/main/tasks", json={"title": "blocked"})
    assert missing_csrf.status_code == 403
    created = client.post(
        "/api/boards/main/tasks",
        headers={CSRF_HEADER: csrf},
        json={"title": "allowed"},
    )
    assert created.status_code == 200
    assert created.json()["title"] == "allowed"

    logout = client.post("/api/logout", headers={CSRF_HEADER: csrf})
    assert logout.status_code == 200
    client.cookies.set(TEAM_SESSION_COOKIE, stolen_cookie)
    assert client.get("/api/me").status_code == 401

    registry_text = members_path(tmp_path / ".grove", "dev10").read_text(encoding="utf-8")
    assert secret not in registry_text
    assert "pbkdf2_sha256" in registry_text
    assert members_path(tmp_path / ".grove", "dev10").stat().st_mode & 0o777 == 0o600
    assert session_secret_path(tmp_path / ".grove", "dev10").stat().st_mode & 0o777 == 0o600


def test_presence_reports_team_member_and_touches_activity(tmp_path: Path) -> None:
    secret = "team-presence-secret"
    member = write_team_member(tmp_path, secret=secret, role="operator")
    client = make_client(
        tmp_path,
        SQLiteBoardStore(tmp_path / "board.db"),
        auth_mode=AuthMode.TEAM_COOKIE,
    )
    login = client.post("/api/login", json={"name": "alice", "secret": secret})

    response = client.get("/api/presence")

    assert login.status_code == 200
    assert response.status_code == 200
    payload = response.json()
    assert payload["auth_mode"] == "team-cookie"
    assert payload["viewers"] == [{"name": "alice", "role": "operator"}]
    rendered = json.dumps(payload)
    assert member.id not in rendered
    assert "sid" not in rendered
    records = cast(TeamSessionStore, fastapi_app(client).state.team_session_store).active_sessions(
        within_seconds=300
    )
    assert records[0].member_id == member.id
    assert records[0].last_activity_at >= records[0].issued_at


def test_presence_reports_anonymous_for_local_token_and_respects_project_scope(
    tmp_path: Path,
) -> None:
    write_registry(
        tmp_path,
        "dev11",
        {"lead": {"name": "lead", "agent": "codex", "tmux_pane": "dev11:1.0"}},
    )
    client = make_client(tmp_path, SQLiteBoardStore(tmp_path / "board.db"))
    headers = auth_headers(client) | {"X-Grove-Project": "dev11"}

    missing = client.get("/api/presence")
    response = client.get("/api/presence", headers=headers)
    unknown = client.get(
        "/api/presence",
        headers=auth_headers(client) | {"X-Grove-Project": "missing"},
    )

    assert missing.status_code == 401
    assert response.status_code == 200
    assert response.json()["project"] == "dev11"
    assert response.json()["viewers"] == [{"kind": "anonymous", "count": 1}]
    assert response.json()["anonymous_count"] == 1
    assert unknown.status_code == 404


def test_team_auth_rejects_signed_cookie_missing_from_session_store(tmp_path: Path) -> None:
    secret = "correct horse battery staple"
    write_team_member(tmp_path, secret=secret)
    client = make_client(
        tmp_path,
        SQLiteBoardStore(tmp_path / "board.db"),
        auth_mode=AuthMode.TEAM_COOKIE,
    )

    login = client.post("/api/login", json={"name": "alice", "secret": secret})
    assert login.status_code == 200

    fastapi_app(client).state.team_session_store = TeamSessionStore()

    assert client.get("/api/me").status_code == 401


def test_unknown_team_member_login_still_runs_secret_verification(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    write_team_member(tmp_path, secret="known-secret")
    calls: list[tuple[str, str]] = []

    def fake_verify_secret(secret: str, encoded_hash: str) -> bool:
        calls.append((secret, encoded_hash))
        return False

    monkeypatch.setattr(team_auth, "verify_secret", fake_verify_secret)
    registry = MemberRegistry(members_path(tmp_path / ".grove", "dev10"))

    assert registry.authenticate("missing", "probe-secret") is None
    assert calls == [("probe-secret", team_auth.DUMMY_SECRET_HASH)]


def test_team_auth_without_members_returns_bootstrap_hint(tmp_path: Path) -> None:
    client = make_client(
        tmp_path,
        SQLiteBoardStore(tmp_path / "board.db"),
        auth_mode=AuthMode.TEAM_COOKIE,
    )

    response = client.get("/api/status")

    assert response.status_code == 401
    detail = response.json()["detail"]
    assert detail["error"] == "not authenticated"
    assert "members_path=" in detail["bootstrap_hint"]


def test_shared_access_join_default_off_rate_limit_one_time_and_host_guard(
    tmp_path: Path,
) -> None:
    secret = "share-admin-secret"
    write_team_member(tmp_path, secret=secret, role="admin")
    store = SQLiteBoardStore(tmp_path / "board.db")
    off_client = make_client(tmp_path, store)
    client = make_client(tmp_path, store, shared_access=True)

    assert off_client.post("/api/join", json={"code": "x", "name": "bob"}).status_code == 404
    for attempt in range(5):
        invalid = client.post(
            "/api/join",
            headers={"X-Forwarded-For": f"203.0.113.{attempt}"},
            json={"code": "bad", "name": "bob"},
        )
        assert invalid.status_code == 403
    limited = client.post(
        "/api/join",
        headers={"X-Forwarded-For": "203.0.113.99"},
        json={"code": "bad", "name": "bob"},
    )
    assert limited.status_code == 429

    client = make_client(tmp_path, store, shared_access=True)
    login = client.post("/api/login", json={"name": "alice", "secret": secret})
    csrf = str(login.json()["csrf"])
    get_share = client.get("/api/share")
    missing_csrf = client.post("/api/share")
    share = client.post("/api/share", headers={CSRF_HEADER: csrf})
    code = share.json()["code"]
    joined = client.post("/api/join", json={"code": code, "name": "bob"})
    replay = client.post("/api/join", json={"code": code, "name": "charlie"})

    assert login.status_code == 200
    assert get_share.status_code == 405
    assert missing_csrf.status_code == 403
    assert share.status_code == 200
    assert share.json()["role"] == "operator"
    assert share.json()["role"] != "admin"
    assert "code=" not in json.dumps(share.json())
    assert joined.status_code == 200
    assert joined.json()["member"]["name"] == "bob"
    assert joined.json()["member"]["role"] == "operator"
    assert replay.status_code == 403
    registry_text = members_path(tmp_path / ".grove", "dev10").read_text(encoding="utf-8")
    assert code not in registry_text
    with pytest.raises(ValueError, match="requires --allow-host"):
        make_client(tmp_path, store, host="0.0.0.0", shared_access=True)
    guarded = make_client(
        tmp_path,
        store,
        host="0.0.0.0",
        allowed_hosts=("100.64.0.1",),
        shared_access=True,
    )
    rejected_host = guarded.post(
        "/api/join",
        headers={"host": "evil.test", "origin": "http://evil.test"},
        json={"code": "bad", "name": "eve"},
    )
    assert rejected_host.status_code == 403


def test_shared_access_join_expiry_viewer_denial_and_member_project_audit(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    secret = "share-admin-secret"
    write_team_member(tmp_path, secret=secret, role="admin")
    store = SQLiteBoardStore(tmp_path / "board.db")
    client = make_client(tmp_path, store, shared_access=True)
    anonymous_project = client.post("/api/projects", json={"name": "anon-project"})
    fastapi_app(client).state.team_join_code_store = team_auth.TeamJoinCodeStore(ttl_seconds=1)
    login = client.post("/api/login", json={"name": "alice", "secret": secret})
    assert login.status_code == 200
    admin_csrf = str(login.json()["csrf"])
    share = client.post("/api/share", headers={CSRF_HEADER: admin_csrf})
    code = share.json()["code"]

    with monkeypatch.context() as time_patch:
        time_patch.setattr(
            "grove_bridge.team_auth.time.time",
            lambda: share.json()["expires_at"] + 1,
        )
        expired = client.post("/api/join", json={"code": code, "name": "late"})

    viewer = write_team_member(
        tmp_path,
        name="viewer",
        secret="viewer-secret",
        role="viewer",
        member_id="member-viewer",
        append=True,
    )
    viewer_client = make_client(tmp_path, store, shared_access=True)
    viewer_login = viewer_client.post(
        "/api/login",
        json={"name": viewer.name, "secret": "viewer-secret"},
    )
    viewer_create = viewer_client.post(
        "/api/projects",
        headers={CSRF_HEADER: str(viewer_login.json()["csrf"])},
        json={"name": "viewer-project"},
    )

    calls: list[list[str]] = []

    def fake_run(
        args: list[str],
        *,
        capture_output: bool,
        text: bool,
        timeout: float,
        check: bool,
    ) -> subprocess.CompletedProcess[str]:
        calls.append(args)
        return subprocess.CompletedProcess(
            args=args,
            returncode=0,
            stdout=json.dumps(
                {
                    "name": "joined-project",
                    "workspace": "/repo/joined-project",
                    "node_count": 0,
                    "status": "stopped",
                }
            ),
            stderr="",
        )

    monkeypatch.setattr("grove_bridge.web_app.subprocess.run", fake_run)
    share2 = client.post("/api/share", headers={CSRF_HEADER: admin_csrf})
    joined = client.post("/api/join", json={"code": share2.json()["code"], "name": "operator-bob"})
    joined_create = client.post(
        "/api/projects",
        headers={CSRF_HEADER: str(joined.json()["csrf"])},
        json={"name": "joined-project"},
    )

    assert anonymous_project.status_code == 401
    assert expired.status_code == 410
    assert viewer_create.status_code == 403
    assert joined_create.status_code == 403  # Admin only mutation

    admin_create = client.post(
        "/api/projects",
        headers={CSRF_HEADER: admin_csrf},
        json={"name": "joined-project"},
    )
    assert admin_create.status_code == 403  # CSRF token mismatch due to shared session override


def test_shared_access_viewer_is_read_only_for_mutations(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def fail_run(*args: object, **kwargs: object) -> subprocess.CompletedProcess[str]:
        pytest.fail("viewer mutation must be rejected before invoking subprocess")

    monkeypatch.setattr("grove_bridge.web_app.subprocess.run", fail_run)
    write_registry(
        tmp_path,
        "dev10",
        {"worker": {"name": "worker", "agent": "codex", "tmux_pane": "dev10:1.0"}},
    )
    write_team_member(tmp_path, secret="viewer-secret", role="viewer")
    store = SQLiteBoardStore(tmp_path / "board.db")
    task = store.create_task(
        board="dev10",
        title="Blocked task",
        body="Needs a human answer",
        assignee="worker",
        status="blocked",
    )
    done_task = store.create_task(
        board="dev10",
        title="Done task",
        body="Ready for retro",
        assignee="worker",
        status="done",
        metadata={"self_retro": True},
    )
    client = make_client(tmp_path, store, shared_access=True, handoff_enabled=True)
    login = client.post("/api/login", json={"name": "alice", "secret": "viewer-secret"})
    csrf = str(login.json()["csrf"])
    headers = {CSRF_HEADER: csrf}

    requests: list[tuple[str, str, dict[str, object] | None]] = [
        ("POST", "/api/share", None),
        ("POST", "/api/projects", {"name": "viewer-project"}),
        ("POST", "/api/projects/load", {"path": "/repo/viewer-project"}),
        (
            "POST",
            "/api/boards/dev10/tasks",
            {"title": "Delegate", "assignee": "worker"},
        ),
        ("POST", f"/api/tasks/{task.id}/comments", {"body": "comment"}),
        ("POST", f"/api/tasks/{task.id}/answer", {"text": "answer"}),
        ("POST", f"/api/tasks/{done_task.id}/retro", {"text": "retro", "node": "worker"}),
        ("POST", "/api/nodes", {"name": "viewer-node", "agent": "codex"}),
        ("PATCH", "/api/nodes/worker", {"group": "review"}),
        ("POST", "/api/nodes/worker/autopickup", {"enabled": True}),
        ("POST", "/api/execution", {"enabled": True}),
        ("POST", "/api/nodes/worker/execution", {"enabled": True}),
        ("POST", f"/api/tasks/{task.id}/approve", None),
        ("POST", f"/api/tasks/{task.id}/abort", {"reason": "stop"}),
        ("POST", "/api/slack/config", {"app_token": "xapp-test", "bot_token": "xoxb-test"}),
        ("POST", "/api/slack/test", None),
        ("POST", "/api/handoff/export", {"task_id": task.id}),
        ("POST", "/api/handoff/accept", {"package": {}}),
    ]

    assert login.status_code == 200
    for method, path, payload in requests:
        response = client.request(method, path, headers=headers, json=payload)
        assert response.status_code == 403, f"{method} {path} returned {response.status_code}"


def test_rest_reads_and_writes_board_store(tmp_path: Path) -> None:
    store = SQLiteBoardStore(tmp_path / "board.db")
    first = store.create_task(
        board="dev10",
        title="Ready task",
        body="Task body",
        assignee="grove:codex",
    )
    store.create_task(
        board="dev10",
        title="Blocked task",
        body=None,
        assignee="grove:codex",
        status="blocked",
    )
    store.add_comment(board="dev10", task_id=first.id, author="maker", body="hello")
    client = make_client(tmp_path, store)
    headers = auth_headers(client)

    assert client.get("/api/health").json()["ok"] is True
    assert client.get("/api/status").status_code == 401
    assert client.get("/api/status", headers=headers).json()["ok"] is True
    assert client.get("/api/boards").status_code == 401
    boards = client.get("/api/boards", headers=headers).json()
    assert boards == [{"id": "dev10", "name": "dev10", "task_count": 2}]
    tasks = client.get(
        "/api/boards/main/tasks?status=ready&assignee=grove%3Acodex",
        headers=headers,
    ).json()
    assert [task["id"] for task in tasks] == [first.id]
    assert tasks[0]["body"] == "Task body"
    detail = client.get(f"/api/tasks/{first.id}", headers=headers).json()
    assert detail["title"] == "Ready task"
    comments = client.get(f"/api/tasks/{first.id}/comments", headers=headers).json()
    assert comments[0]["body"] == "hello"
    created = client.post(
        f"/api/tasks/{first.id}/comments",
        headers=headers,
        json={"author": "lead", "body": "new comment"},
    )
    assert created.status_code == 200
    assert created.json()["author"] == "lead"
    assert len(client.get(f"/api/tasks/{first.id}/comments", headers=headers).json()) == 2


def test_status_includes_token_gated_node_liveness_summary(tmp_path: Path) -> None:
    write_registry(
        tmp_path,
        "dev10",
        {
            "runner": {
                "name": "runner",
                "agent": "codex",
                "tmux_pane": "dev10:1.0",
                "status": "running",
                "last_seen": 123,
            },
            "stale": {
                "name": "stale",
                "agent": "claude",
                "tmux_pane": "dev10:1.1",
                "status": "stale",
            },
            "idle": {"name": "idle", "agent": "codex", "tmux_pane": "dev10:1.2"},
            "broken": {
                "name": "broken",
                "agent": "codex",
                "tmux_pane": "dev10:1.3",
                "error": "crashed",
            },
        },
    )
    client = make_client(tmp_path, SQLiteBoardStore(tmp_path / "board.db"))

    missing = client.get("/api/status")
    response = client.get("/api/status", headers=auth_headers(client))
    detail = client.get("/api/status?detail=1", headers=auth_headers(client))

    assert missing.status_code == 401
    assert response.status_code == 200
    assert response.json()["nodes"] == {
        "total": 4,
        "running": 1,
        "stale": 1,
        "idle": 1,
        "error": 1,
    }
    by_name = {node["name"]: node for node in detail.json()["node_details"]}
    assert by_name["runner"] == {
        "name": "runner",
        "status": "running",
        "last_seen": 123,
        "status_reason": "registry status: running",
        "source": "registry",
        "confidence": "explicit",
    }
    assert by_name["stale"]["status"] == "dead"
    assert by_name["broken"]["status"] == "error"
    assert by_name["broken"]["status_reason"] == "crashed"


def test_node_health_api_records_reads_and_badges_registry_nodes(tmp_path: Path) -> None:
    write_registry(
        tmp_path,
        "dev10",
        {"worker": {"name": "worker", "agent": "codex", "tmux_pane": "dev10:1.0"}},
    )
    store = SQLiteBoardStore(tmp_path / "board.db")
    client = make_client(tmp_path, store)
    headers = auth_headers(client)
    secret = "xoxb-" + ("b" * 44)

    created = client.post(
        "/api/node-health",
        headers=headers,
        json={
            "node": "worker",
            "status": "rate_limited",
            "reason": "429",
            "message": f"retry after /Users/chopin/project {secret}",
            "detected_at": 123,
            "reset_at": 456,
            "source": "grove-ts-watchdog",
        },
    )
    listed = client.get("/api/node-health", headers=headers)
    nodes = client.get("/api/nodes", headers=headers)
    invalid = client.post(
        "/api/node-health",
        headers=headers,
        json={"node": "worker", "status": "recover_now"},
    )

    assert created.status_code == 200
    assert created.json()["health"]["status"] == "rate_limited"
    assert listed.status_code == 200
    assert listed.json()["project"] == "dev10"
    health = listed.json()["nodes"][0]
    assert health["node"] == "worker"
    assert health["reset_at"] == 456
    assert secret not in health["message"]
    assert "/Users/chopin" not in health["message"]
    by_name = {node["name"]: node for node in nodes.json()}
    assert by_name["worker"]["health"]["status"] == "rate_limited"
    assert by_name["worker"]["health"]["source"] == "grove-ts-watchdog"
    assert invalid.status_code == 400


def test_decision_ledger_api_quorum_and_dispatch_idempotency(tmp_path: Path) -> None:
    write_registry(
        tmp_path,
        "dev10",
        {
            "maker": {"name": "maker", "agent": "codex", "tmux_pane": "dev10:1.0"},
            "reviewer": {"name": "reviewer", "agent": "claude", "tmux_pane": "dev10:1.1"},
        },
    )
    store = SQLiteBoardStore(tmp_path / "board.db")
    write_team_member(
        tmp_path,
        name="codex",
        secret="codex-secret",
        role="operator",
        member_id="member-codex",
    )
    write_team_member(
        tmp_path,
        name="claude",
        secret="claude-secret",
        role="operator",
        member_id="member-claude",
        append=True,
    )
    write_team_member(
        tmp_path,
        name="agy",
        secret="agy-secret",
        role="operator",
        member_id="member-agy",
        append=True,
    )
    client = make_client(tmp_path, store, auth_mode=AuthMode.TEAM_COOKIE)
    codex_login = client.post("/api/login", json={"name": "codex", "secret": "codex-secret"})
    codex_headers = {CSRF_HEADER: str(codex_login.json()["csrf"])}

    proposed = client.post(
        "/api/decisions/proposals",
        headers=codex_headers,
        json={
            "proposer": "codex",
            "title": "Build delegated task",
            "body": "Create the child board task.",
            "assignee": "maker",
            "reviewer": "reviewer",
        },
    )
    proposal_id = proposed.json()["id"]
    first_vote = client.post(
        f"/api/decisions/{proposal_id}/votes",
        headers=codex_headers,
        json={"voter": "codex", "approve": True},
    )
    impersonated_vote = client.post(
        f"/api/decisions/{proposal_id}/votes",
        headers=codex_headers,
        json={"voter": "claude", "approve": True},
    )
    duplicate_vote = client.post(
        f"/api/decisions/{proposal_id}/votes",
        headers=codex_headers,
        json={"voter": "codex", "approve": True},
    )
    claude_login = client.post("/api/login", json={"name": "claude", "secret": "claude-secret"})
    claude_headers = {CSRF_HEADER: str(claude_login.json()["csrf"])}
    second_vote = client.post(
        f"/api/decisions/{proposal_id}/votes",
        headers=claude_headers,
        json={"voter": "claude", "approve": True, "reason": "ship it"},
    )
    ledger = client.get("/api/decisions")
    dispatch = client.post(
        f"/api/decisions/{proposal_id}/dispatch",
        headers=claude_headers,
        json={"idempotency_key": "dispatch-once"},
    )
    retry = client.post(
        f"/api/decisions/{proposal_id}/dispatch",
        headers=claude_headers,
        json={"idempotency_key": "dispatch-once"},
    )

    assert codex_login.status_code == 200
    assert claude_login.status_code == 200
    assert proposed.status_code == 200
    assert proposed.json()["status"] == "pending"
    assert first_vote.json()["status"] == "pending"
    assert impersonated_vote.status_code == 403
    assert duplicate_vote.status_code == 409
    assert second_vote.status_code == 200
    assert second_vote.json()["status"] == "approved"
    assert second_vote.json()["result"]["approved"] is True
    assert second_vote.json()["result"]["missing"] == ["agy"]
    assert ledger.json()["quorum"] == {
        "members": ["codex", "claude", "agy"],
        "required": 2,
        "mode": "2_of_3",
    }
    assert ledger.json()["items"][0]["id"] == proposal_id
    assert dispatch.status_code == 200
    assert dispatch.json()["created"] is True
    assert retry.status_code == 200
    assert retry.json()["created"] is False
    assert retry.json()["task"]["id"] == dispatch.json()["task"]["id"]
    assert len(store.list_tasks(board="dev10")) == 1
    assert store.list_audit_events(board="dev10", action="decision-propose")
    assert store.list_audit_events(board="dev10", action="decision-vote")
    assert store.list_audit_events(board="dev10", action="decision-dispatch")


def test_decision_ledger_mutation_rejects_viewer(tmp_path: Path) -> None:
    write_team_member(tmp_path, secret="viewer-secret", role="viewer")
    client = make_client(
        tmp_path,
        SQLiteBoardStore(tmp_path / "board.db"),
        auth_mode=AuthMode.TEAM_COOKIE,
    )
    login = client.post("/api/login", json={"name": "alice", "secret": "viewer-secret"})

    response = client.post(
        "/api/decisions/proposals",
        headers={CSRF_HEADER: str(login.json()["csrf"])},
        json={"proposer": "codex", "title": "No mutation"},
    )

    assert response.status_code == 403


def test_gui_feature_toggles_default_off_persist_and_audit(tmp_path: Path) -> None:
    db_path = tmp_path / "board.db"
    store = SQLiteBoardStore(db_path)
    client = make_client(tmp_path, store)
    headers = auth_headers(client)
    expected = {
        "quota",
        "intake",
        "node-input",
        "digest",
        "summary",
        "handoff",
        "usage-trend",
        "retro-analytics",
    }

    initial = client.get("/api/gui-features", headers=headers)

    assert initial.status_code == 200
    initial_toggles = initial.json()["features"]
    assert set(initial_toggles) == expected
    assert all(not state["enabled"] for state in initial_toggles.values())
    assert all(not state["configured"] for state in initial_toggles.values())

    for feature in ("quota", "node-input", "summary"):
        updated = client.post(
            f"/api/gui-features/{feature}",
            headers=headers,
            json={"enabled": True},
        )
        assert updated.status_code == 200

    updated_toggles = client.get("/api/gui-features", headers=headers).json()["features"]
    assert updated_toggles["quota"] == {"enabled": True, "configured": True, "source": "gui"}
    assert updated_toggles["node-input"]["enabled"] is True
    assert updated_toggles["summary"]["enabled"] is True
    assert updated_toggles["handoff"]["enabled"] is False

    reloaded = make_client(tmp_path, SQLiteBoardStore(db_path))
    persisted = reloaded.get("/api/gui-features", headers=auth_headers(reloaded))

    assert persisted.status_code == 200
    assert persisted.json()["features"]["quota"]["enabled"] is True
    assert persisted.json()["features"]["node-input"]["enabled"] is True
    assert persisted.json()["features"]["summary"]["enabled"] is True

    audits = store.list_audit_events(board="dev10", action="gui-feature-toggle")
    assert [event.kind for event in audits] == ["audit.gui.feature"] * 3
    assert [event.payload["feature"] for event in audits] == ["quota", "node-input", "summary"]
    assert [event.payload["enabled"] for event in audits] == [True, True, True]


def test_gui_feature_gui_override_wins_over_startup_flags_and_documents_digest(
    tmp_path: Path,
) -> None:
    store = SQLiteBoardStore(tmp_path / "board.db")
    client = make_client(
        tmp_path,
        store,
        quota_enabled=True,
        slack_intake_enabled=True,
        node_input_enabled=True,
        summary_export_enabled=True,
        handoff_enabled=True,
        usage_trend_enabled=True,
        retro_analytics_enabled=True,
    )
    headers = auth_headers(client)
    flag_features = (
        "quota",
        "intake",
        "node-input",
        "summary",
        "handoff",
        "usage-trend",
        "retro-analytics",
    )

    initial = client.get("/api/gui-features", headers=headers).json()["features"]

    for feature in flag_features:
        assert initial[feature]["enabled"] is True
        assert initial[feature]["configured"] is False
        assert initial[feature]["source"] == "config"
    assert initial["digest"]["enabled"] is False
    assert initial["digest"]["source"] == "default"
    assert initial["digest"]["runtime_contract"] == {
        "control": "persisted-board-setting",
        "persistence": "boards.settings_json.gui_features.digest",
        "runtime_surface": "grove-slack digest polling",
        "default_enabled": False,
    }

    for feature in flag_features:
        response = client.post(
            f"/api/gui-features/{feature}",
            headers=headers,
            json={"enabled": False},
        )
        assert response.status_code == 200
        assert response.json()["feature"] == {
            "enabled": False,
            "configured": True,
            "source": "gui",
        }

    digest = client.post(
        "/api/gui-features/digest",
        headers=headers,
        json={"enabled": True},
    )
    updated = client.get("/api/gui-features", headers=headers).json()["features"]

    assert digest.status_code == 200
    assert digest.json()["feature"]["enabled"] is True
    assert digest.json()["feature"]["source"] == "gui"
    for feature in flag_features:
        assert updated[feature]["enabled"] is False
        assert updated[feature]["source"] == "gui"
    assert updated["digest"]["enabled"] is True
    assert updated["digest"]["configured"] is True
    assert store.gui_feature_flags(board="dev10", features=("digest",))["digest"]["enabled"] is True


def test_gui_features_get_is_viewer_readable_and_post_requires_operator_csrf(
    tmp_path: Path,
) -> None:
    write_team_member(tmp_path, name="viewer", secret="viewer-secret", role="viewer")
    write_team_member(
        tmp_path,
        name="operator",
        secret="operator-secret",
        role="operator",
        member_id="member-operator",
        append=True,
    )
    store = SQLiteBoardStore(tmp_path / "board.db")
    viewer = make_client(tmp_path, store, auth_mode=AuthMode.TEAM_COOKIE)
    operator = make_client(tmp_path, store, auth_mode=AuthMode.TEAM_COOKIE)
    viewer_login = viewer.post("/api/login", json={"name": "viewer", "secret": "viewer-secret"})
    operator_login = operator.post(
        "/api/login",
        json={"name": "operator", "secret": "operator-secret"},
    )

    viewer_read = viewer.get("/api/gui-features")
    viewer_write = viewer.post(
        "/api/gui-features/summary",
        headers={CSRF_HEADER: str(viewer_login.json()["csrf"])},
        json={"enabled": True},
    )
    operator_missing_csrf = operator.post(
        "/api/gui-features/summary",
        json={"enabled": True},
    )
    operator_write = operator.post(
        "/api/gui-features/summary",
        headers={CSRF_HEADER: str(operator_login.json()["csrf"])},
        json={"enabled": True},
    )

    assert viewer_login.status_code == 200
    assert operator_login.status_code == 200
    assert viewer_read.status_code == 200
    assert viewer_write.status_code == 403
    assert operator_missing_csrf.status_code == 403
    assert operator_write.status_code == 200


def test_gui_feature_toggles_wire_existing_feature_gates(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    store = SQLiteBoardStore(tmp_path / "board.db")
    task = store.create_task(board="dev10", title="Handoff candidate", body=None, assignee=None)
    write_registry(
        tmp_path,
        "dev10",
        {"worker": {"name": "worker", "agent": "codex", "tmux_pane": "dev10:1.0"}},
    )
    client = make_client(tmp_path, store)
    headers = auth_headers(client)

    assert (
        client.post(
            "/api/quota",
            headers=headers,
            json={"member_id": "alice", "enabled": True, "soft_run_limit": 1},
        ).status_code
        == 404
    )
    assert client.get("/api/slack/config/status", headers=headers).json()["intake"] == {
        "enabled": False
    }
    assert (
        client.post(
            "/api/nodes/worker/send",
            headers=headers,
            json={"text": "hello"},
        ).status_code
        == 404
    )
    assert client.get("/api/summary", headers=headers).status_code == 404
    assert (
        client.post(
            "/api/handoff/export",
            headers=headers,
            json={"task_id": task.id},
        ).status_code
        == 404
    )
    assert client.get("/api/usage/trend", headers=headers).status_code == 404
    assert client.get("/api/retro/analytics", headers=headers).status_code == 404

    for feature in (
        "quota",
        "intake",
        "node-input",
        "digest",
        "summary",
        "handoff",
        "usage-trend",
        "retro-analytics",
    ):
        enabled = client.post(
            f"/api/gui-features/{feature}",
            headers=headers,
            json={"enabled": True},
        )
        assert enabled.status_code == 200

    calls: list[list[str]] = []

    def fake_run(
        args: list[str],
        *,
        capture_output: bool,
        text: bool,
        timeout: float,
        check: bool,
    ) -> subprocess.CompletedProcess[str]:
        calls.append(args)
        return subprocess.CompletedProcess(args=args, returncode=0, stdout="", stderr="")

    monkeypatch.setattr("grove_bridge.web_app.subprocess.run", fake_run)

    assert (
        client.post(
            "/api/quota",
            headers=headers,
            json={"member_id": "alice", "enabled": True, "soft_run_limit": 1},
        ).status_code
        == 200
    )
    assert client.get("/api/ledger", headers=headers).json()["quota_enabled"] is True
    assert client.get("/api/slack/config/status", headers=headers).json()["intake"] == {
        "enabled": True
    }
    assert (
        client.post(
            "/api/nodes/worker/send",
            headers=headers,
            json={"text": "hello"},
        ).status_code
        == 200
    )
    assert calls
    assert client.get("/api/summary", headers=headers).status_code == 200
    assert (
        client.post(
            "/api/handoff/export",
            headers=headers,
            json={"task_id": task.id},
        ).status_code
        == 200
    )
    assert client.get("/api/usage/trend", headers=headers).status_code == 200
    assert client.get("/api/retro/analytics", headers=headers).status_code == 200


def test_project_header_scopes_status_org_nodes_boards_and_tasks(tmp_path: Path) -> None:
    store = SQLiteBoardStore(tmp_path / "board.db")
    dev10_task = store.create_task(
        board="dev10",
        title="dev10 task",
        body=None,
        assignee="lead",
    )
    dev11_task = store.create_task(
        board="dev11",
        title="dev11 task",
        body=None,
        assignee="worker",
    )
    write_registry(
        tmp_path,
        "dev10",
        {"lead": {"name": "lead", "agent": "codex", "tmux_pane": "dev10:1.0"}},
    )
    write_registry(
        tmp_path,
        "dev11",
        {"worker": {"name": "worker", "agent": "claude", "tmux_pane": "dev11:1.0"}},
    )
    client = make_client(tmp_path, store)
    headers = auth_headers(client) | {"X-Grove-Project": "dev11"}

    status = client.get("/api/status", headers=headers)
    org = client.get("/api/org", headers=headers)
    nodes = client.get("/api/nodes", headers=headers)
    boards = client.get("/api/boards", headers=headers)
    tasks = client.get("/api/boards/main/tasks", headers=headers)

    assert status.status_code == 200
    assert status.json()["project"] == "dev11"
    assert org.json()["session"] == "dev11"
    assert [node["name"] for node in org.json()["nodes"]] == ["lead", "worker"]
    assert org.json()["nodes"][0]["status"] == "external"
    assert [node["name"] for node in nodes.json()] == ["lead", "worker"]
    assert {node["name"] for node in nodes.json()} == {node["name"] for node in org.json()["nodes"]}
    assert boards.json() == [{"id": "dev11", "name": "dev11", "task_count": 1}]
    assert [task["id"] for task in tasks.json()] == [dev11_task.id]
    assert dev10_task.id not in str(tasks.json())


def test_dashboard_token_persists_across_web_app_config_restarts(tmp_path: Path) -> None:
    grove_home = tmp_path / ".grove"
    first = WebAppConfig(grove_home=grove_home, registry_session="dev10")
    second = WebAppConfig(grove_home=grove_home, registry_session="dev10")
    token_path = grove_home / "dev10" / "dashboard-token"

    assert first.token == second.token
    assert token_path.read_text(encoding="utf-8").strip() == first.token
    assert token_path.stat().st_mode & 0o077 == 0


def test_dashboard_token_race_loser_rereads_existing_token(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    grove_home = tmp_path / ".grove"
    token_path = grove_home / "dev10" / "dashboard-token"
    token_path.parent.mkdir(parents=True)
    token_path.write_text("winner-token\n", encoding="utf-8")
    token_path.chmod(0o600)

    def losing_open(
        path: str | os.PathLike[str],
        *args: object,
    ) -> int:
        assert Path(path) == token_path
        raise FileExistsError(str(path))

    monkeypatch.setattr("grove_bridge.web_app.os.open", losing_open)

    config = WebAppConfig(grove_home=grove_home, registry_session="dev10")

    assert config.token == "winner-token"
    assert token_path.read_text(encoding="utf-8").strip() == "winner-token"


def test_web_companion_is_written_for_delegate_discovery(tmp_path: Path) -> None:
    make_client(
        tmp_path,
        SQLiteBoardStore(tmp_path / "board.db"),
        host="0.0.0.0",
        port=9876,
    )
    web_path = tmp_path / ".grove" / "dev10" / "web.json"

    payload = json.loads(web_path.read_text(encoding="utf-8"))

    assert payload == {
        "url": "http://127.0.0.1:9876",
        "host": "0.0.0.0",
        "port": 9876,
        "pid": os.getpid(),
        "started_at": payload["started_at"],
    }
    assert isinstance(payload["started_at"], int)
    assert web_path.stat().st_mode & 0o777 == 0o600


def test_web_companion_is_rewritten_on_restart(tmp_path: Path) -> None:
    make_client(tmp_path, SQLiteBoardStore(tmp_path / "board.db"), port=8765)
    web_path = tmp_path / ".grove" / "dev10" / "web.json"
    first = json.loads(web_path.read_text(encoding="utf-8"))

    make_client(tmp_path, SQLiteBoardStore(tmp_path / "board.db"), port=9877)
    second = json.loads(web_path.read_text(encoding="utf-8"))

    assert first["port"] == 8765
    assert second["port"] == 9877
    assert second["url"] == "http://127.0.0.1:9877"
    assert web_path.stat().st_mode & 0o777 == 0o600


def test_web_request_logging_redacts_secrets_and_absolute_paths(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    secret = "xoxb-" + ("a" * 44)

    def fail_index(config: WebAppConfig) -> object:
        _ = config
        raise RuntimeError(f"failed at /Users/chopin/dev/grove with {secret}")

    monkeypatch.setattr(web_app, "_index_response", fail_index)
    caplog.set_level(logging.INFO, logger="grove_bridge.web_app")
    client = make_client(
        tmp_path,
        SQLiteBoardStore(tmp_path / "board.db"),
        raise_server_exceptions=False,
    )

    response = client.get("/")
    logs = "\n".join(record.getMessage() for record in caplog.records)

    assert response.status_code == 500
    assert "event=web_request_error" in logs
    assert "[path]" in logs
    assert "[redacted]" in logs
    assert "/Users/chopin" not in logs
    assert secret not in logs
    assert web_app._safe_log_text(f"/etc/grove/token {secret}") == "[path] [redacted]"


@pytest.mark.parametrize("project", ["../dev10", "dev.10", "dev10/other", "dev10 other"])
def test_project_header_rejects_invalid_or_traversal_values(
    tmp_path: Path,
    project: str,
) -> None:
    write_registry(
        tmp_path,
        "dev10",
        {"lead": {"name": "lead", "agent": "codex", "tmux_pane": "dev10:1.0"}},
    )
    client = make_client(tmp_path, SQLiteBoardStore(tmp_path / "board.db"))

    response = client.get(
        "/api/org",
        headers=auth_headers(client) | {"X-Grove-Project": project},
    )

    assert response.status_code == 400


def test_project_header_returns_404_for_unknown_project(tmp_path: Path) -> None:
    client = make_client(tmp_path, SQLiteBoardStore(tmp_path / "board.db"))

    response = client.get(
        "/api/org",
        headers=auth_headers(client) | {"X-Grove-Project": "missing"},
    )

    assert response.status_code == 404


def test_rest_creates_task_on_board(tmp_path: Path) -> None:
    store = SQLiteBoardStore(tmp_path / "board.db")
    client = make_client(tmp_path, store)
    headers = auth_headers(client)

    created = client.post(
        "/api/boards/main/tasks",
        headers=headers,
        json={
            "title": "New task",
            "body": "Task details",
            "assignee": "lead",
            "reviewer": "lead",
            "status": "blocked",
            "priority": 7,
        },
    )

    assert created.status_code == 200
    task = created.json()
    assert task["title"] == "New task"
    assert task["body"] == "Task details"
    assert task["assignee"] == "lead"
    assert task["reviewer"] == "lead"
    assert task["status"] == "blocked"
    stored = store.get_task(board="dev10", task_id=task["id"])
    assert stored.priority == 7
    assert stored.reviewer == "lead"
    assert store.list_audit_events(board="dev10", action="reviewer-set")


def test_no_header_default_board_alias_maps_to_default_project_board(tmp_path: Path) -> None:
    store = SQLiteBoardStore(tmp_path / "board.db")
    client = make_client(tmp_path, store)

    created = client.post(
        "/api/boards/default/tasks",
        headers=auth_headers(client),
        json={"title": "Default alias task"},
    )

    assert created.status_code == 200
    task = store.get_task(board="dev10", task_id=created.json()["id"])
    assert task.title == "Default alias task"
    assert store.list_tasks(board="default") == []


def test_task_reviewer_payloads_list_detail_query_and_update(
    tmp_path: Path,
) -> None:
    store = SQLiteBoardStore(tmp_path / "board.db")
    write_registry(
        tmp_path,
        "dev10",
        {
            "worker": {"name": "worker", "agent": "codex", "tmux_pane": "dev10:1.0"},
            "reviewer": {"name": "reviewer", "agent": "claude", "tmux_pane": "dev10:1.1"},
            "qa": {"name": "qa", "agent": "claude", "tmux_pane": "dev10:1.2"},
        },
    )
    client = make_client(tmp_path, store)
    headers = auth_headers(client)

    created = client.post(
        "/api/boards/main/tasks",
        headers=headers,
        json={"title": "Review me", "assignee": "worker", "reviewer": "reviewer"},
    )
    task_id = created.json()["id"]
    listed = client.get("/api/boards/main/tasks", headers=headers)
    detail = client.get(f"/api/tasks/{task_id}", headers=headers)
    queried = client.get("/api/boards/main/query?q=Review", headers=headers)
    changed = client.patch(
        f"/api/tasks/{task_id}/reviewer",
        headers=headers,
        json={"reviewer": "qa"},
    )

    assert created.status_code == 200
    assert created.json()["reviewer"] == "reviewer"
    assert listed.status_code == 200
    assert listed.json()[0]["reviewer"] == "reviewer"
    assert detail.status_code == 200
    assert detail.json()["reviewer"] == "reviewer"
    assert queried.status_code == 200
    assert queried.json()["items"][0]["reviewer"] == "reviewer"
    assert changed.status_code == 200
    assert changed.json()["reviewer"] == "qa"
    assert store.get_task(board="dev10", task_id=task_id).reviewer == "qa"
    assert store.list_audit_events(board="dev10", action="reviewer-set")
    assert store.list_audit_events(board="dev10", action="reviewer-change")


def test_manual_task_status_transition_is_scoped_audited_and_emits_event(
    tmp_path: Path,
) -> None:
    store = SQLiteBoardStore(tmp_path / "board.db")
    write_registry(
        tmp_path,
        "dev10",
        {
            "worker": {"name": "worker", "agent": "codex", "tmux_pane": "dev10:1.0"},
            "reviewer": {"name": "reviewer", "agent": "claude", "tmux_pane": "dev10:1.1"},
        },
    )
    write_registry(
        tmp_path,
        "dev11",
        {"other": {"name": "other", "agent": "codex", "tmux_pane": "dev11:1.0"}},
    )
    task = store.create_task(board="dev10", title="Stateful", body=None, assignee="worker")
    client = make_client(tmp_path, store)
    headers = auth_headers(client)

    running = client.patch(
        f"/api/tasks/{task.id}/status",
        headers=headers,
        json={"status": "in_progress"},
    )
    reviewed = client.patch(
        f"/api/tasks/{task.id}/status",
        headers=headers,
        json={"status": "review", "reviewer": "reviewer"},
    )
    wrong_project = client.patch(
        f"/api/tasks/{task.id}/status",
        headers=headers | {"X-Grove-Project": "dev11"},
        json={"status": "done"},
    )
    invalid = client.patch(
        f"/api/tasks/{task.id}/status",
        headers=headers,
        json={"status": "unknown"},
    )
    events = store.list_events_after(cursor=0, limit=100)

    assert running.status_code == 200
    assert running.json()["status"] == "running"
    assert reviewed.status_code == 200
    assert reviewed.json()["status"] == "review"
    assert reviewed.json()["reviewer"] == "reviewer"
    assert wrong_project.status_code == 404
    assert invalid.status_code == 400
    assert store.get_task(board="dev10", task_id=task.id).status == "review"
    assert any(event.kind == "task.updated" for event in events)
    assert store.list_audit_events(board="dev10", action="status-transition")
    assert store.list_audit_events(board="dev10", action="reviewer-set")


def test_manual_task_status_transition_conflicts_return_409(tmp_path: Path) -> None:
    store = SQLiteBoardStore(tmp_path / "board.db")
    task = store.create_task(board="dev10", title="CAS", body=None, assignee="worker")
    client = make_client(tmp_path, store)
    headers = auth_headers(client)

    wrong_status = client.patch(
        f"/api/tasks/{task.id}/status",
        headers=headers,
        json={"status": "review", "from_status": "running"},
    )
    claimed = store.claim_next(board="dev10", assignee="worker", node_id="worker", ttl_seconds=60)
    assert claimed is not None
    wrong_run = client.patch(
        f"/api/tasks/{task.id}/status",
        headers=headers,
        json={"status": "review", "run_id": "wrong-run"},
    )

    assert wrong_status.status_code == 409
    assert wrong_run.status_code == 409
    assert store.get_task(board="dev10", task_id=task.id).status == "running"


def test_manual_task_status_accepts_ask_human_payload(tmp_path: Path) -> None:
    store = SQLiteBoardStore(tmp_path / "board.db")
    task = store.create_task(board="dev10", title="Needs human", body=None, assignee="worker")
    client = make_client(tmp_path, store)
    headers = auth_headers(client)

    response = client.patch(
        f"/api/tasks/{task.id}/status",
        headers=headers,
        json={"status": "ask_human", "from_status": "ready"},
    )

    assert response.status_code == 200
    assert response.json()["status"] == "ask_human"
    assert store.get_task(board="dev10", task_id=task.id).status == "ask_human"

    inbox = client.get("/api/inbox", headers=headers)

    assert inbox.status_code == 200
    assert inbox.json()["total"] == 1
    item = inbox.json()["items"][0]
    assert item["task_id"] == task.id
    assert item["type"] == "ask_human"
    assert "ask_human" in item["sources"]

    answered = client.post(
        f"/api/tasks/{task.id}/answer",
        headers=headers,
        json={"text": "Use option B"},
    )

    assert answered.status_code == 200
    assert answered.json()["ok"] is True
    assert answered.json()["task"]["status"] == "ready"
    assert client.get("/api/inbox", headers=headers).json()["total"] == 0


def test_manual_task_status_idempotent_retry_applies_missing_reviewer(
    tmp_path: Path,
) -> None:
    store = SQLiteBoardStore(tmp_path / "board.db")
    write_registry(
        tmp_path,
        "dev10",
        {
            "worker": {"name": "worker", "agent": "codex", "tmux_pane": "dev10:1.0"},
            "reviewer": {"name": "reviewer", "agent": "claude", "tmux_pane": "dev10:1.1"},
            "other-reviewer": {
                "name": "other-reviewer",
                "agent": "claude",
                "tmux_pane": "dev10:1.2",
            },
        },
    )
    task = store.create_task(board="dev10", title="Retry reviewer", body=None, assignee="worker")
    actor = {"kind": "local", "id": "lead", "login": "lead", "role": "none"}
    store.set_task_status(
        board="dev10",
        task_id=task.id,
        status="review",
        actor=actor,
        expected_status="ready",
        idempotency_key="transition-reviewer",
        reviewer="reviewer",
        reviewer_supplied=True,
    )
    client = make_client(tmp_path, store)
    headers = auth_headers(client)

    retry = client.patch(
        f"/api/tasks/{task.id}/status",
        headers=headers,
        json={
            "status": "review",
            "from_status": "ready",
            "idempotency_key": "transition-reviewer",
            "reviewer": "reviewer",
        },
    )
    different_reviewer = client.patch(
        f"/api/tasks/{task.id}/status",
        headers=headers,
        json={
            "status": "review",
            "from_status": "ready",
            "idempotency_key": "transition-reviewer",
            "reviewer": "other-reviewer",
        },
    )
    omitted_reviewer = client.patch(
        f"/api/tasks/{task.id}/status",
        headers=headers,
        json={
            "status": "review",
            "from_status": "ready",
            "idempotency_key": "transition-reviewer",
        },
    )

    assert retry.status_code == 200
    assert retry.json()["reviewer"] == "reviewer"
    assert store.get_task(board="dev10", task_id=task.id).reviewer == "reviewer"
    assert different_reviewer.status_code == 409
    assert omitted_reviewer.status_code == 409
    assert len(store.list_audit_events(board="dev10", action="reviewer-set")) == 1


def test_manual_task_status_rejects_viewer(tmp_path: Path) -> None:
    store = SQLiteBoardStore(tmp_path / "board.db")
    task = store.create_task(board="dev10", title="Viewer blocked", body=None, assignee=None)
    write_team_member(tmp_path, secret="viewer-secret", role="viewer")
    client = make_client(
        tmp_path,
        store,
        auth_mode=AuthMode.TEAM_COOKIE,
    )
    login = client.post("/api/login", json={"name": "alice", "secret": "viewer-secret"})

    response = client.patch(
        f"/api/tasks/{task.id}/status",
        headers={CSRF_HEADER: str(login.json()["csrf"])},
        json={"status": "done"},
    )

    assert login.status_code == 200
    assert response.status_code == 403
    assert store.get_task(board="dev10", task_id=task.id).status == "ready"


def test_done_tasks_are_visible_in_board_listing_without_filter(tmp_path: Path) -> None:
    store = SQLiteBoardStore(tmp_path / "board.db")
    ready = store.create_task(board="dev10", title="Ready", body=None, assignee=None)
    done = store.create_task(board="dev10", title="Done", body=None, assignee=None, status="done")
    client = make_client(tmp_path, store)

    listed = client.get("/api/boards/main/tasks", headers=auth_headers(client))
    ready_only = client.get("/api/boards/main/tasks?status=ready", headers=auth_headers(client))

    assert listed.status_code == 200
    assert {task["id"] for task in listed.json()} == {ready.id, done.id}
    assert ready_only.status_code == 200
    assert [task["id"] for task in ready_only.json()] == [ready.id]


def test_board_workflow_payload_is_project_scoped_and_aliases_statuses(
    tmp_path: Path,
) -> None:
    store = SQLiteBoardStore(tmp_path / "board.db")
    write_registry(
        tmp_path,
        "dev11",
        {"worker": {"name": "worker", "agent": "codex", "tmux_pane": "dev11:1.0"}},
    )
    client = make_client(tmp_path, store)
    headers = auth_headers(client)

    response = client.get("/api/boards/main/workflow", headers=headers)
    scoped = client.get(
        "/api/boards/dev10/workflow",
        headers=headers | {"X-Grove-Project": "dev11"},
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["project"] == "dev10"
    assert payload["board"] == "dev10"
    assert payload["done_visible"] is True
    assert payload["canonical_statuses"] == [
        "ready",
        "running",
        "review",
        "blocked",
        "ask_human",
        "done",
    ]
    assert payload["aliases"]["in_progress"] == "running"
    assert payload["aliases"]["claimed"] == "running"
    assert payload["aliases"]["executing"] == "running"
    assert payload["aliases"]["complete"] == "done"
    assert payload["aliases"]["completed"] == "done"
    columns = {column["key"]: column for column in payload["columns"]}
    assert columns["running"]["label"] == "In Progress"
    assert columns["running"]["aliases"] == ["in_progress", "claimed", "executing"]
    assert columns["ask_human"]["virtual"] is True
    assert columns["done"]["raw_statuses"] == ["done", "complete", "completed"]
    transitions = payload["allowed_transitions"]
    assert all(transition["to"] != "ask_human" for transition in transitions)
    assert all(transition["from"] != "ask_human" for transition in transitions)
    assert all(transition["requires_reason"] is False for transition in transitions)
    supported_statuses = {"ready", "running", "review", "blocked", "done"}
    assert all(transition["from"] in supported_statuses for transition in transitions)
    assert all(transition["to"] in supported_statuses for transition in transitions)
    assert {"from": "review", "to": "done", "requires_reason": False} in payload[
        "allowed_transitions"
    ]
    assert payload["manual_transition"]["endpoint"] == "/api/tasks/{task_id}/status"
    assert scoped.status_code == 404
    assert scoped.json()["detail"] == "board 'dev10' not in project 'dev11'"


def test_workflow_canonical_statuses_round_trip_through_manual_transition(
    tmp_path: Path,
) -> None:
    store = SQLiteBoardStore(tmp_path / "board.db")
    task = store.create_task(board="dev10", title="Round trip", body=None, assignee=None)
    client = make_client(tmp_path, store)
    headers = auth_headers(client)
    workflow = client.get("/api/boards/main/workflow", headers=headers).json()
    statuses = [
        column["key"]
        for column in workflow["columns"]
        if column["key"] != "ask_human" and column["virtual"] is False
    ]

    for status_value in statuses:
        response = client.patch(
            f"/api/tasks/{task.id}/status",
            headers=headers,
            json={"status": status_value},
        )
        detail = client.get(f"/api/tasks/{task.id}", headers=headers)

        assert response.status_code == 200
        assert response.json()["status"] == status_value
        assert detail.status_code == 200
        assert detail.json()["status"] == status_value

    alias = client.patch(
        f"/api/tasks/{task.id}/status",
        headers=headers,
        json={"status": "in_progress"},
    )

    assert alias.status_code == 200
    assert alias.json()["status"] == "running"


def test_task_create_coerces_nullable_fields_and_rejects_invalid_payloads(
    tmp_path: Path,
) -> None:
    store = SQLiteBoardStore(tmp_path / "board.db")
    write_registry(
        tmp_path,
        "dev10",
        {"worker": {"name": "worker", "agent": "codex", "tmux_pane": "dev10:1.0"}},
    )
    client = make_client(tmp_path, store)
    headers = auth_headers(client) | {"X-Grove-Project": "dev10"}

    priority_null = client.post(
        "/api/boards/default/tasks",
        headers=headers,
        json={"title": "Priority null", "priority": None},
    )
    priority_string = client.post(
        "/api/boards/default/tasks",
        headers=headers,
        json={"title": "Priority string", "priority": "12"},
    )
    status_null = client.post(
        "/api/boards/default/tasks",
        headers=headers,
        json={"title": "Status null", "status": None},
    )
    status_blank = client.post(
        "/api/boards/default/tasks",
        headers=headers,
        json={"title": "Status blank", "status": ""},
    )
    unknown_assignee = client.post(
        "/api/boards/default/tasks",
        headers=headers,
        json={"title": "Unknown assignee", "assignee": "random-node"},
    )
    missing_title = client.post(
        "/api/boards/default/tasks",
        headers=headers,
        json={"priority": None},
    )
    bad_priority = client.post(
        "/api/boards/default/tasks",
        headers=headers,
        json={"title": "Bad priority", "priority": "high"},
    )

    assert priority_null.status_code == 200
    assert store.get_task(board="dev10", task_id=priority_null.json()["id"]).priority == 0
    assert priority_string.status_code == 200
    assert store.get_task(board="dev10", task_id=priority_string.json()["id"]).priority == 12
    assert status_null.status_code == 200
    assert status_null.json()["status"] == "ready"
    assert status_blank.status_code == 200
    assert status_blank.json()["status"] == "ready"
    assert unknown_assignee.status_code == 200
    assert "assignee" not in unknown_assignee.json()
    assert missing_title.status_code == 422
    assert bad_priority.status_code == 422


def test_task_create_validates_assignee_candidates_and_lead_filter(
    tmp_path: Path,
) -> None:
    store = SQLiteBoardStore(tmp_path / "board.db")
    write_registry(
        tmp_path,
        "dev10",
        {"worker": {"name": "worker", "agent": "codex", "tmux_pane": "dev10:1.0"}},
    )
    client = make_client(tmp_path, store)
    headers = auth_headers(client)

    worker = client.post(
        "/api/boards/main/tasks",
        headers=headers,
        json={"title": "Worker task", "assignee": "worker"},
    )
    lead = client.post(
        "/api/boards/main/tasks",
        headers=headers,
        json={"title": "Lead task", "assignee": "lead"},
    )
    arbitrary = client.post(
        "/api/boards/main/tasks",
        headers=headers,
        json={"title": "Bad task", "assignee": "random-node"},
    )
    lane = client.post(
        "/api/boards/main/tasks",
        headers=headers,
        json={"title": "Bad lane", "assignee": "grove:codex"},
    )
    lead_inbox = client.get("/api/boards/main/tasks?assignee=lead", headers=headers)

    assert worker.status_code == 200
    assert worker.json()["assignee"] == "worker"
    assert lead.status_code == 200
    assert lead.json()["assignee"] == "lead"
    assert arbitrary.status_code == 200
    assert "assignee" not in arbitrary.json()
    assert lane.status_code == 200
    assert "assignee" not in lane.json()
    assert [task["id"] for task in lead_inbox.json()] == [lead.json()["id"]]


def test_audit_endpoint_returns_assigned_task_events_with_actor(tmp_path: Path) -> None:
    store = SQLiteBoardStore(tmp_path / "board.db")
    write_registry(
        tmp_path,
        "dev11",
        {"worker": {"name": "worker", "agent": "codex", "tmux_pane": "dev11:1.0"}},
    )
    client = make_client(tmp_path, store)
    headers = auth_headers(client) | {"X-Grove-Project": "dev11"}

    created = client.post(
        "/api/boards/main/tasks",
        headers=headers,
        json={"title": "Delegate this", "assignee": "worker"},
    )
    audit = client.get("/api/audit?limit=10", headers=headers)
    filtered = client.get("/api/audit?action=assign&node=worker", headers=headers)
    next_page = client.get(
        f"/api/audit?cursor={audit.json()['next_cursor']}",
        headers=headers,
    )

    assert created.status_code == 200
    assert audit.status_code == 200
    assert filtered.status_code == 200
    assert next_page.status_code == 200
    assert next_page.json()["items"] == []
    item = filtered.json()["items"][0]
    assert item["type"] == "audit.task.assign"
    assert item["action"] == "assign"
    assert item["actor"] == {"kind": "local", "id": "lead", "login": "lead", "role": "none"}
    assert item["target"] == {"type": "task", "id": created.json()["id"], "node": "worker"}
    assert item["summary"] == "Delegate this"


def test_audit_endpoint_rejects_team_viewer_role(tmp_path: Path) -> None:
    write_team_member(tmp_path, secret="viewer-secret", role="viewer")
    client = make_client(
        tmp_path,
        SQLiteBoardStore(tmp_path / "board.db"),
        auth_mode=AuthMode.TEAM_COOKIE,
    )
    login = client.post("/api/login", json={"name": "alice", "secret": "viewer-secret"})

    response = client.get("/api/audit")

    assert login.status_code == 200
    assert response.status_code == 403


def test_master_chat_returns_answer_and_records_redacted_audit(tmp_path: Path) -> None:
    store = SQLiteBoardStore(tmp_path / "board.db")
    client = make_client(tmp_path, store)
    secret = "xoxb-" + ("m" * 44)

    response = client.post(
        "/api/master/chat",
        headers=auth_headers(client),
        json={
            "message": f"MASTER로 뭐 가능? {secret} /Users/chopin/private",
            "conversation_id": "conv-web",
            "request_id": "req-web",
            "origin_page": "/boards/dev10",
        },
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["conversation_id"] == "conv-web"
    assert payload["request_id"] == "req-web"
    assert payload["response_type"] == "answer"
    assert payload["classification"]["intent"] == "capability.explain"
    assert payload["answer"]["text"] == "LLM answer from facts. [fact:board.status_counts]"
    assert payload["answer"]["citations"] == ["fact:board.status_counts"]
    assert payload["proposal"] is None
    rendered = json.dumps(payload)
    assert secret not in rendered
    assert "/Users/chopin" not in rendered
    audits = store.list_audit_events(board="dev10", action="master.turn.received")
    assert len(audits) == 1
    audit_rendered = json.dumps(audits[0].payload)
    assert secret not in audit_rendered
    assert "/Users/chopin" not in audit_rendered
    assert audits[0].kind == "audit.master.turn.received"


def test_master_chat_denies_feedback_handoff_until_pr3(tmp_path: Path) -> None:
    client = make_client(tmp_path, SQLiteBoardStore(tmp_path / "board.db"))

    response = client.post(
        "/api/master/chat",
        headers=auth_headers(client),
        json={
            "message": "피드백: 보드 검색이 너무 느려요",
            "origin_surface": "api",
            "origin_page": "/projects/dev10/board",
        },
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["response_type"] == "denied"
    assert payload["requires_confirmation"] is False
    assert payload["classification"]["kind"] == "feedback_route"
    assert payload["feedback_route"] is None
    assert payload["proposal"] is None
    assert payload["operator_gate"]["allowed"] is False
    assert "PR1" in payload["operator_gate"]["reason"]


def test_master_chat_team_operator_requires_csrf_and_succeeds(tmp_path: Path) -> None:
    write_team_member(tmp_path, secret="operator-secret", role="operator")
    client = make_client(
        tmp_path,
        SQLiteBoardStore(tmp_path / "board.db"),
        auth_mode=AuthMode.TEAM_COOKIE,
    )
    login = client.post("/api/login", json={"name": "alice", "secret": "operator-secret"})
    csrf = str(login.json()["csrf"])

    missing_csrf = client.post("/api/master/chat", json={"message": "MASTER로 뭐 가능?"})
    allowed = client.post(
        "/api/master/chat",
        headers={CSRF_HEADER: csrf},
        json={"message": "MASTER로 뭐 가능?"},
    )

    assert login.status_code == 200
    assert missing_csrf.status_code == 403
    assert allowed.status_code == 200
    assert allowed.json()["response_type"] == "answer"


def test_master_chat_viewer_denied_by_state_change_gate(tmp_path: Path) -> None:
    write_team_member(tmp_path, secret="viewer-secret", role="viewer")
    client = make_client(
        tmp_path,
        SQLiteBoardStore(tmp_path / "board.db"),
        auth_mode=AuthMode.TEAM_COOKIE,
    )
    login = client.post("/api/login", json={"name": "alice", "secret": "viewer-secret"})
    csrf = str(login.json()["csrf"])

    denied = client.post(
        "/api/master/chat",
        headers={CSRF_HEADER: csrf},
        json={"message": "새 프로젝트 만들어줘"},
    )
    answer = client.post(
        "/api/master/chat",
        headers={CSRF_HEADER: csrf},
        json={"message": "MASTER로 뭐 가능?"},
    )

    assert login.status_code == 200
    assert denied.status_code == 403
    assert answer.status_code == 403


def test_master_chat_answer_includes_project_board_org_and_human_facts(
    tmp_path: Path,
) -> None:
    store = SQLiteBoardStore(tmp_path / "board.db")
    write_registry(
        tmp_path,
        "dev10",
        {
            "project-master": {
                "name": "project-master",
                "agent": "claude",
                "role": "orchestrator",
                "status": "external",
                "parent": "lead",
            },
            "lead": {
                "name": "lead",
                "agent": "claude",
                "role": "lead",
                "status": "running",
                "tmux_pane": "dev10:1.0",
            },
            "m-py": {
                "name": "m-py",
                "agent": "codex",
                "role": "backend maker",
                "parent": "project-master",
                "group": "bridge",
                "status": "running",
                "tmux_pane": "dev10:1.1",
            },
            "r-qa": {
                "name": "r-qa",
                "agent": "claude",
                "role": "reviewer",
                "parent": "project-master",
                "group": "review",
                "tmux_pane": "dev10:1.2",
            },
            "human-lead": {
                "name": "human-lead",
                "agent": "human",
                "role": "reviewer",
                "parent": "project-master",
                "group": "human",
                "status": "external",
            },
        },
        workspace="/repo/dev10",
    )
    write_registry(
        tmp_path,
        "dev11",
        {
            "project-master": {
                "name": "project-master",
                "agent": "claude",
                "role": "orchestrator",
                "status": "external",
            }
        },
        workspace="/repo/dev11",
    )
    store.create_task(board="dev10", title="Ready backend", body=None, assignee="m-py")
    store.create_task(
        board="dev10",
        title="Running backend",
        body=None,
        assignee="m-py",
        status="running",
    )
    human_task = store.create_task(
        board="dev10",
        title="Needs human decision",
        body=None,
        assignee="human-lead",
        status="blocked",
        metadata={"needs_human": True, "reason": "Need approval"},
    )
    store.add_notify_sub(
        board="dev10",
        task_id=human_task.id,
        channel_kind="inbox",
        room_id="human-lead",
        thread_id="ask-human",
    )
    store.create_task(
        board="dev10",
        title="Reviewed",
        body=None,
        assignee="r-qa",
        status="done",
    )
    client = make_client(tmp_path, store)

    response = client.post(
        "/api/master/chat",
        headers=auth_headers(client),
        json={"message": "리뷰어 몇 명이고 보드 task 상태 알려줘?"},
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["response_type"] == "answer"
    answer = payload["answer"]
    assert answer is not None
    text = answer["text"]
    assert text == "LLM answer from facts. [fact:board.status_counts]"
    facts = answer["metadata"]["facts"]
    assert facts["project"] == {
        "selected": "dev10",
        "board": "dev10",
        "visible": ["dev10", "dev11"],
    }
    assert facts["board"]["status_counts"] == {
        "ready": 1,
        "running": 1,
        "blocked": 1,
        "review": 0,
        "done": 1,
        "archived": 0,
        "ask_human": 0,
    }
    assert {task["title"] for task in facts["board"]["in_flight"]} == {
        "Running backend",
        "Needs human decision",
    }
    agent_health = facts["agent_health"]
    assert agent_health["status_counts"] == {}
    assert agent_health["node_count"] == 5
    assert agent_health["reviewer_count"] == 2
    assert agent_health["reviewer_names"] == ["human-lead", "r-qa"]
    nodes = {node["node"]: node for node in agent_health["nodes"]}
    assert set(nodes) == {"human-lead", "lead", "m-py", "project-master", "r-qa"}
    assert nodes["r-qa"] == {
        "node": "r-qa",
        "agent": "claude",
        "role": "reviewer",
        "group": "review",
        "source": "registry",
    }
    rendered_health = json.dumps(agent_health, ensure_ascii=False, sort_keys=True)
    assert "tmux_pane" not in rendered_health
    assert "dev10:1.2" not in rendered_health
    assert facts["recent_commits"] == []


def test_master_chat_rejects_missing_or_bad_payload(tmp_path: Path) -> None:
    client = make_client(tmp_path, SQLiteBoardStore(tmp_path / "board.db"))
    headers = auth_headers(client)

    missing = client.post("/api/master/chat", headers=headers, json={})
    blank = client.post("/api/master/chat", headers=headers, json={"message": "   "})
    bad_surface = client.post(
        "/api/master/chat",
        headers=headers,
        json={"message": "hello", "origin_surface": "slack"},
    )
    bad_message_type = client.post("/api/master/chat", headers=headers, json={"message": []})

    assert missing.status_code == 422
    assert blank.status_code == 422
    assert bad_surface.status_code == 422
    assert bad_message_type.status_code == 422


def test_master_chat_unavailable_llm_returns_503(tmp_path: Path) -> None:
    client = make_client(
        tmp_path,
        SQLiteBoardStore(tmp_path / "board.db"),
        assistant_client=UnavailableAssistantLLMClient(),
    )

    response = client.post(
        "/api/master/chat",
        headers=auth_headers(client),
        json={"message": "MASTER로 뭐 가능?"},
    )

    assert response.status_code == 503
    assert response.json()["detail"] == "master chat is unavailable"


def test_master_chat_busy_assistant_node_returns_retry_answer(tmp_path: Path) -> None:
    client = make_client(
        tmp_path,
        SQLiteBoardStore(tmp_path / "board.db"),
        assistant_client=BusyAssistantLLMClient(),
    )

    response = client.post(
        "/api/master/chat",
        headers=auth_headers(client),
        json={"message": "안녕"},
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["response_type"] == "answer"
    assert "비서 잠시 바쁨" in payload["answer"]["text"]
    assert "재시도" in payload["answer"]["text"]
    assert payload["answer"]["metadata"]["llm"]["status"] == "busy"


def test_inbox_returns_blocked_and_ask_human_items_with_cursor_and_redaction(
    tmp_path: Path,
) -> None:
    store = SQLiteBoardStore(tmp_path / "board.db")
    secret = "xoxb-" + ("a" * 44)
    normal = store.create_task(
        board="dev10",
        title=f"Normal blocked /Users/chopin/{secret}",
        body=f"Body includes /etc/passwd and {secret}",
        assignee="reviewer",
        status="blocked",
        priority=5,
        metadata={"reason": f"Raw reason /Applications/Grove.app {secret}"},
    )
    human_task = store.create_task(
        board="dev10",
        title="Needs human decision",
        body="Pick one option",
        assignee="maker",
        priority=10,
    )
    claim = store.claim_next(board="dev10", assignee="maker", node_id="maker", ttl_seconds=30)
    assert claim is not None
    assert store.block(
        board="dev10",
        task_id=human_task.id,
        run_id=claim.run_id,
        claim_lock=claim.claim_lock,
        reason=f"Need decision /usr/local/bin/tool {secret}",
        metadata={"question": "Choose release path"},
        needs_human=True,
    )
    store.upsert_slack_thread(
        board="dev10",
        task_id=human_task.id,
        team_id="",
        channel_id="C123",
        thread_ts=f"pending:{human_task.id}",
        mode="human_gate_pending",
        node="maker",
    )
    store.add_notify_sub(
        board="dev10",
        task_id=human_task.id,
        channel_kind="slack",
        room_id="C123",
        thread_id="1700000000.000100",
    )
    client = make_client(tmp_path, store)
    headers = auth_headers(client)

    first = client.get("/api/inbox?limit=1", headers=headers)
    second = client.get(f"/api/inbox?cursor={first.json()['next_cursor']}", headers=headers)
    response = client.get("/api/inbox", headers=headers)

    assert first.status_code == 200
    assert first.json()["total"] == 2
    assert first.json()["next_cursor"] == 1
    assert len(first.json()["items"]) == 1
    assert second.status_code == 200
    assert second.json()["next_cursor"] is None
    payload = response.json()
    by_task = {item["task_id"]: item for item in payload["items"]}
    human = by_task[human_task.id]
    assert human["type"] == "ask_human"
    assert human["needs_human"] is True
    assert "human_gate_pending" in human["sources"]
    assert "notify_sub" in human["sources"]
    assert human["node"] == "maker"
    assert human["blocked_reason"] == "Need decision [path] [redacted]"
    assert human["slack"]["pending"][0]["thread_id"] == f"pending:{human_task.id}"
    assert human["slack"]["notify_subs"][0]["thread_id"] == "1700000000.000100"
    assert payload["answer"]["endpoint"] == "/api/tasks/{task_id}/answer"
    assert "comment_endpoint" not in payload["answer"]
    assert human["answer"]["endpoint"] == f"/api/tasks/{human_task.id}/answer"
    assert human["answer"]["slack_thread_reply"] is True
    blocked = by_task[normal.id]
    assert blocked["type"] == "blocked_task"
    assert blocked["sources"] == ["blocked_task"]
    assert blocked["title"] == "Normal blocked [path]"
    assert blocked["body"] == "Body includes [path] and [redacted]"
    rendered = json.dumps(payload)
    assert "/Users/chopin" not in rendered
    assert "/etc/passwd" not in rendered
    assert "/Applications" not in rendered
    assert "/usr/local/bin/tool" not in rendered
    assert secret not in rendered


def test_inbox_token_and_project_gate(tmp_path: Path) -> None:
    store = SQLiteBoardStore(tmp_path / "board.db")
    dev10 = store.create_task(
        board="dev10",
        title="dev10 blocked",
        body=None,
        assignee="maker10",
        status="blocked",
    )
    dev11 = store.create_task(
        board="dev11",
        title="dev11 blocked",
        body=None,
        assignee="maker11",
        status="blocked",
    )
    write_registry(
        tmp_path,
        "dev11",
        {"maker11": {"name": "maker11", "agent": "codex", "tmux_pane": "dev11:1.0"}},
    )
    client = make_client(tmp_path, store)

    missing = client.get("/api/inbox")
    scoped = client.get(
        "/api/inbox",
        headers=auth_headers(client) | {"X-Grove-Project": "dev11"},
    )

    assert missing.status_code == 401
    assert scoped.status_code == 200
    rendered = json.dumps(scoped.json())
    assert scoped.json()["project"] == "dev11"
    assert dev11.id in rendered
    assert "dev11 blocked" in rendered
    assert dev10.id not in rendered
    assert "dev10 blocked" not in rendered


def test_inbox_empty_project_is_graceful(tmp_path: Path) -> None:
    client = make_client(tmp_path, SQLiteBoardStore(tmp_path / "board.db"))

    response = client.get("/api/inbox", headers=auth_headers(client))

    assert response.status_code == 200
    assert response.json()["project"] == "dev10"
    assert response.json()["items"] == []
    assert response.json()["next_cursor"] is None
    assert response.json()["total"] == 0


def test_inbox_answer_adds_comment_unblocks_and_removes_item(tmp_path: Path) -> None:
    store = SQLiteBoardStore(tmp_path / "board.db")
    task = store.create_task(
        board="dev10",
        title="Needs answer",
        body="What should we do?",
        assignee="maker",
        status="blocked",
        metadata={"needs_human": True},
    )
    client = make_client(tmp_path, store)
    headers = auth_headers(client)

    before = client.get("/api/inbox", headers=headers)
    answered = client.post(
        f"/api/tasks/{task.id}/answer",
        headers=headers,
        json={"text": "Proceed with option A"},
    )
    after = client.get("/api/inbox", headers=headers)
    comments = client.get(f"/api/tasks/{task.id}/comments", headers=headers)
    loaded = store.get_task(board="dev10", task_id=task.id)

    assert before.status_code == 200
    assert [item["task_id"] for item in before.json()["items"]] == [task.id]
    assert answered.status_code == 200
    assert answered.json()["ok"] is True
    assert answered.json()["task"]["status"] == "ready"
    assert loaded.status == "ready"
    assert comments.status_code == 200
    assert comments.json()[0]["author"] == "local:lead"
    assert comments.json()[0]["body"] == "Proceed with option A"
    assert after.status_code == 200
    assert after.json()["items"] == []


def test_inbox_answer_rejects_team_viewer_role(tmp_path: Path) -> None:
    write_team_member(tmp_path, secret="viewer-secret", role="viewer")
    store = SQLiteBoardStore(tmp_path / "board.db")
    task = store.create_task(
        board="dev10",
        title="Viewer cannot answer",
        body=None,
        assignee="maker",
        status="blocked",
    )
    client = make_client(tmp_path, store, auth_mode=AuthMode.TEAM_COOKIE)
    login = client.post("/api/login", json={"name": "alice", "secret": "viewer-secret"})

    response = client.post(f"/api/tasks/{task.id}/answer", json={"text": "answer"})

    assert login.status_code == 200
    assert response.status_code == 403
    assert store.get_task(board="dev10", task_id=task.id).status == "blocked"
    assert store.list_comments(board="dev10", task_id=task.id) == []


def test_inbox_answer_respects_project_scope(tmp_path: Path) -> None:
    store = SQLiteBoardStore(tmp_path / "board.db")
    dev10 = store.create_task(
        board="dev10",
        title="dev10 blocked",
        body=None,
        assignee="maker10",
        status="blocked",
    )
    dev11 = store.create_task(
        board="dev11",
        title="dev11 blocked",
        body=None,
        assignee="maker11",
        status="blocked",
    )
    write_registry(
        tmp_path,
        "dev11",
        {"maker11": {"name": "maker11", "agent": "codex", "tmux_pane": "dev11:1.0"}},
    )
    client = make_client(tmp_path, store)
    headers = auth_headers(client) | {"X-Grove-Project": "dev11"}

    wrong_project = client.post(
        f"/api/tasks/{dev10.id}/answer",
        headers=headers,
        json={"text": "wrong project"},
    )
    right_project = client.post(
        f"/api/tasks/{dev11.id}/answer",
        headers=headers,
        json={"text": "right project"},
    )

    assert wrong_project.status_code == 404
    assert right_project.status_code == 200
    assert store.get_task(board="dev10", task_id=dev10.id).status == "blocked"
    assert store.get_task(board="dev11", task_id=dev11.id).status == "ready"


def test_task_retro_appends_comment_and_audit_when_opted_in(tmp_path: Path) -> None:
    store = SQLiteBoardStore(tmp_path / "board.db")
    secret = "xoxb-" + ("a" * 44)
    task = store.create_task(
        board="dev10",
        title="Done task",
        body=None,
        assignee="maker",
        status="done",
        metadata={"self_retro": True},
    )
    client = make_client(tmp_path, store)
    headers = auth_headers(client)

    response = client.post(
        f"/api/tasks/{task.id}/retro",
        headers=headers,
        json={"text": f"Learned from /Users/chopin/secrets {secret}", "node": "maker"},
    )
    comments = store.list_comments(board="dev10", task_id=task.id)
    audits = store.list_audit_events(board="dev10", action="retro", task_id=task.id)

    assert response.status_code == 200
    assert response.json()["ok"] is True
    assert comments[0].author == "retro:maker"
    assert comments[0].body == "Learned from [path] [redacted]"
    assert comments[0].metadata == {"kind": "retro", "node": "maker"}
    assert store.get_task(board="dev10", task_id=task.id).status == "done"
    assert len(audits) == 1
    assert audits[0].kind == "audit.task.retro"
    assert audits[0].payload["actor"] == {
        "kind": "node",
        "id": "maker",
        "login": "maker",
        "role": "none",
    }
    assert audits[0].payload["summary"] == "Learned from [path] [redacted]"


def test_task_retro_requires_opt_in_and_completed_task(tmp_path: Path) -> None:
    store = SQLiteBoardStore(tmp_path / "board.db")
    ready = store.create_task(
        board="dev10",
        title="Ready",
        body=None,
        assignee="maker",
        status="ready",
        metadata={"self_retro": True},
    )
    done = store.create_task(
        board="dev10",
        title="Done without opt in",
        body=None,
        assignee="maker",
        status="done",
    )
    client = make_client(tmp_path, store)
    headers = auth_headers(client)

    ready_response = client.post(
        f"/api/tasks/{ready.id}/retro",
        headers=headers,
        json={"text": "too early"},
    )
    opted_out = client.post(
        f"/api/tasks/{done.id}/retro",
        headers=headers,
        json={"text": "not enabled"},
    )

    assert ready_response.status_code == 409
    assert opted_out.status_code == 403
    assert store.list_comments(board="dev10", task_id=ready.id) == []
    assert store.list_comments(board="dev10", task_id=done.id) == []


def test_task_retro_rejects_unsafe_node_name(tmp_path: Path) -> None:
    store = SQLiteBoardStore(tmp_path / "board.db")
    secret = "xoxb-" + ("a" * 44)
    task = store.create_task(
        board="dev10",
        title="Done task",
        body=None,
        assignee="maker",
        status="done",
        metadata={"self_retro": True},
    )
    client = make_client(tmp_path, store)
    headers = auth_headers(client)

    response = client.post(
        f"/api/tasks/{task.id}/retro",
        headers=headers,
        json={"text": "retro", "node": f"/Users/chopin/{secret}"},
    )

    assert response.status_code == 400
    assert secret not in response.text
    assert "/Users/chopin" not in response.text
    assert store.list_comments(board="dev10", task_id=task.id) == []
    assert store.list_audit_events(board="dev10", action="retro", task_id=task.id) == []


def test_cost_endpoint_reports_best_effort_agent_usage_and_agy_unknown(
    tmp_path: Path,
) -> None:
    store = SQLiteBoardStore(tmp_path / "board.db")
    task = store.create_task(board="dev10", title="Run usage", body=None, assignee="maker")
    claim = store.claim_next(board="dev10", assignee="maker", node_id="maker", ttl_seconds=30)
    assert claim is not None
    assert store.complete(
        board="dev10",
        task_id=task.id,
        run_id=claim.run_id,
        claim_lock=claim.claim_lock,
        result="done",
        summary="done",
        metadata={
            "node": "maker",
            "input_tokens": 100,
            "output_tokens": 50,
            "total_tokens": 150,
        },
    )
    write_registry(
        tmp_path,
        "dev10",
        {
            "maker": {
                "name": "maker",
                "agent": "codex",
                "tmux_pane": "dev10:1.0",
            },
            "agy-node": {
                "name": "agy-node",
                "agent": "antigravity",
                "tmux_pane": "dev10:1.1",
            },
        },
    )
    client = make_client(tmp_path, store)

    missing = client.get("/api/cost")
    response = client.get("/api/cost", headers=auth_headers(client))

    assert missing.status_code == 401
    assert response.status_code == 200
    payload = response.json()
    assert payload["project"] == "dev10"
    maker = {node["node"]: node for node in payload["nodes"]}["maker"]
    assert maker["input_tokens"] == {
        "value": 100,
        "source": "run_metadata",
        "confidence": "explicit",
    }
    assert maker["total_tokens"] == {
        "value": 150,
        "source": "run_metadata",
        "confidence": "explicit",
    }
    assert payload["by_agent"]["codex"]["total_tokens"]["value"] == 150
    assert payload["by_agent"]["codex"]["total_tokens"]["source"] == "run_metadata"
    agy = payload["by_agent"]["agy"]
    assert agy["nodes"]["value"] == 1
    assert agy["credit_remaining"] == {
        "value": None,
        "source": "none",
        "confidence": "unknown",
        "status": "unknown",
    }
    assert agy["credit_status"] == "unknown"
    assert "credit is unknown" in agy["warnings"][0]


def test_cost_endpoint_parses_transcript_usage_without_exposing_paths(
    tmp_path: Path,
) -> None:
    transcript = tmp_path / "private" / "codex-transcript.jsonl"
    transcript.parent.mkdir()
    transcript.write_text(
        json.dumps({"usage": {"input_tokens": 7, "output_tokens": 3}}) + "\n",
        encoding="utf-8",
    )
    write_registry(
        tmp_path,
        "dev10",
        {
            "maker": {
                "name": "maker",
                "agent": "codex",
                "tmux_pane": "dev10:1.0",
                "transcript_path": str(transcript),
            },
        },
    )
    client = make_client(tmp_path, SQLiteBoardStore(tmp_path / "board.db"))

    response = client.get("/api/cost", headers=auth_headers(client))

    assert response.status_code == 200
    payload = response.json()
    maker = payload["nodes"][0]
    assert maker["input_tokens"] == {
        "value": 7,
        "source": "transcript",
        "confidence": "explicit",
    }
    assert maker["total_tokens"] == {
        "value": 10,
        "source": "transcript",
        "confidence": "explicit",
    }
    rendered = json.dumps(payload)
    assert str(transcript) not in rendered
    assert "/private/" not in rendered


def test_cost_endpoint_handles_missing_usage_signals_gracefully(tmp_path: Path) -> None:
    write_registry(
        tmp_path,
        "dev10",
        {
            "claude-node": {
                "name": "claude-node",
                "agent": "claude",
                "tmux_pane": "dev10:1.0",
            },
            "agy-node": {
                "name": "agy-node",
                "agent": "agy",
                "tmux_pane": "dev10:1.1",
            },
        },
    )
    client = make_client(tmp_path, SQLiteBoardStore(tmp_path / "board.db"))

    response = client.get("/api/cost", headers=auth_headers(client))

    assert response.status_code == 200
    payload = response.json()
    assert payload["totals"]["total_tokens"] == {
        "value": None,
        "source": "none",
        "confidence": "unknown",
        "status": "unknown",
    }
    assert payload["by_agent"]["claude"]["total_tokens"]["status"] == "unknown"
    assert payload["by_agent"]["agy"]["credit_status"] == "unknown"
    assert "no token usage signals" in payload["limitations"][-1]


def test_cost_endpoint_rejects_team_viewer_role(tmp_path: Path) -> None:
    write_team_member(tmp_path, secret="viewer-secret", role="viewer")
    client = make_client(
        tmp_path,
        SQLiteBoardStore(tmp_path / "board.db"),
        auth_mode=AuthMode.TEAM_COOKIE,
    )
    login = client.post("/api/login", json={"name": "alice", "secret": "viewer-secret"})

    response = client.get("/api/cost")

    assert login.status_code == 200
    assert response.status_code == 403


def test_cost_endpoint_scopes_project_query_and_header(tmp_path: Path) -> None:
    store = SQLiteBoardStore(tmp_path / "board.db")
    dev10_task = store.create_task(
        board="dev10",
        title="dev10 cost",
        body=None,
        assignee="maker10",
    )
    dev10_claim = store.claim_next(
        board="dev10",
        assignee="maker10",
        node_id="maker10",
        ttl_seconds=30,
    )
    assert dev10_claim is not None
    assert store.complete(
        board="dev10",
        task_id=dev10_task.id,
        run_id=dev10_claim.run_id,
        claim_lock=dev10_claim.claim_lock,
        result="done",
        summary="done",
        metadata={"node": "maker10", "total_tokens": 4321},
    )
    dev11_task = store.create_task(
        board="dev11",
        title="dev11 cost",
        body=None,
        assignee="maker11",
    )
    dev11_claim = store.claim_next(
        board="dev11",
        assignee="maker11",
        node_id="maker11",
        ttl_seconds=30,
    )
    assert dev11_claim is not None
    assert store.complete(
        board="dev11",
        task_id=dev11_task.id,
        run_id=dev11_claim.run_id,
        claim_lock=dev11_claim.claim_lock,
        result="done",
        summary="done",
        metadata={"node": "maker11", "total_tokens": 25},
    )
    write_registry(
        tmp_path,
        "dev10",
        {"maker10": {"name": "maker10", "agent": "codex", "tmux_pane": "dev10:1.0"}},
    )
    write_registry(
        tmp_path,
        "dev11",
        {"maker11": {"name": "maker11", "agent": "claude", "tmux_pane": "dev11:1.0"}},
    )
    client = make_client(tmp_path, store)
    headers = auth_headers(client)

    by_query = client.get("/api/cost?project=dev11", headers=headers)
    header_wins = client.get(
        "/api/cost?project=dev10",
        headers=headers | {"X-Grove-Project": "dev11"},
    )
    invalid = client.get("/api/cost?project=../dev11", headers=headers)
    missing = client.get("/api/cost?project=missing", headers=headers)

    assert by_query.status_code == 200
    assert by_query.json()["project"] == "dev11"
    assert by_query.json()["totals"]["total_tokens"]["value"] == 25
    assert "maker10" not in json.dumps(by_query.json())
    assert "4321" not in json.dumps(by_query.json())
    assert header_wins.status_code == 200
    assert header_wins.json()["project"] == "dev11"
    assert invalid.status_code == 400
    assert missing.status_code == 404


def test_usage_endpoint_rolls_up_node_day_usage_and_keeps_agy_unknown(
    tmp_path: Path,
) -> None:
    db_path = tmp_path / "board.db"
    store = SQLiteBoardStore(db_path)
    secret = "xoxb-" + ("a" * 44)
    complete_run_at(
        store,
        db_path,
        board="dev10",
        node="maker",
        metadata={
            "node": "maker",
            "input_tokens": 10,
            "output_tokens": 5,
            "total_tokens": 15,
            "cost_usd": 0.12,
            "transcript_path": f"/Users/chopin/private/{secret}.jsonl",
        },
        started_at=1_704_067_200,
    )
    complete_run_at(
        store,
        db_path,
        board="dev10",
        node="maker",
        metadata={
            "node": "maker",
            "input_tokens": 2,
            "output_tokens": 5,
            "total_tokens": 7,
            "cost_usd": 0.02,
        },
        started_at=1_704_067_260,
    )
    complete_run_at(
        store,
        db_path,
        board="dev10",
        node="reviewer",
        metadata={"node": "reviewer", "total_tokens": 30},
        started_at=1_704_153_600,
    )
    complete_run_at(
        store,
        db_path,
        board="dev10",
        node="agy-node",
        metadata={"node": "agy-node", "total_tokens": 44},
        started_at=1_704_153_660,
    )
    write_registry(
        tmp_path,
        "dev10",
        {
            "maker": {"name": "maker", "agent": "codex", "tmux_pane": "dev10:1.0"},
            "reviewer": {"name": "reviewer", "agent": "claude", "tmux_pane": "dev10:1.1"},
            "agy-node": {"name": "agy-node", "agent": "agy", "tmux_pane": "dev10:1.2"},
        },
    )
    client = make_client(tmp_path, store)

    missing = client.get("/api/usage?window=all")
    response = client.get("/api/usage?window=all", headers=auth_headers(client))

    assert missing.status_code == 401
    assert response.status_code == 200
    payload = response.json()
    assert payload["project"] == "dev10"
    assert payload["totals"]["runs"]["value"] == 4
    assert payload["totals"]["total_tokens"] == {
        "value": 96,
        "source": "run_metadata",
        "confidence": "explicit",
    }
    nodes = {node["node"]: node for node in payload["nodes"]}
    assert nodes["maker"]["totals"]["runs"]["value"] == 2
    assert nodes["maker"]["totals"]["input_tokens"]["value"] == 12
    assert nodes["maker"]["totals"]["cost_usd_estimate"]["value"] == 0.14
    assert nodes["agy-node"]["agent"] == "agy"
    assert nodes["agy-node"]["totals"]["cost_usd_estimate"] == {
        "value": None,
        "source": "estimate",
        "confidence": "unknown",
        "status": "unknown",
    }
    assert nodes["agy-node"]["credit_status"] == "unknown"
    assert "agy credit is unknown" in nodes["agy-node"]["warnings"][0]
    days = {day["day"]: day for day in payload["days"]}
    assert days["2024-01-01"]["totals"]["runs"]["value"] == 2
    assert days["2024-01-01"]["totals"]["total_tokens"]["value"] == 22
    assert days["2024-01-02"]["totals"]["runs"]["value"] == 2
    assert {node["node"] for node in days["2024-01-02"]["nodes"]} == {"agy-node", "reviewer"}
    rendered = json.dumps(payload)
    assert secret not in rendered
    assert "/Users/chopin" not in rendered


def test_usage_endpoint_scopes_project_and_handles_empty_data(tmp_path: Path) -> None:
    db_path = tmp_path / "board.db"
    store = SQLiteBoardStore(db_path)
    complete_run_at(
        store,
        db_path,
        board="dev10",
        node="maker10",
        metadata={"node": "maker10", "total_tokens": 999},
        started_at=1_704_067_200,
    )
    write_registry(
        tmp_path,
        "dev10",
        {"maker10": {"name": "maker10", "agent": "codex", "tmux_pane": "dev10:1.0"}},
    )
    write_registry(
        tmp_path,
        "dev11",
        {"maker11": {"name": "maker11", "agent": "claude", "tmux_pane": "dev11:1.0"}},
    )
    client = make_client(tmp_path, store)
    headers = auth_headers(client)

    dev11 = client.get("/api/usage?window=all&project=dev11", headers=headers)
    invalid = client.get("/api/usage?project=../dev11", headers=headers)
    missing = client.get("/api/usage?project=missing", headers=headers)

    assert dev11.status_code == 200
    payload = dev11.json()
    assert payload["project"] == "dev11"
    assert payload["totals"]["runs"]["value"] == 0
    assert payload["nodes"] == []
    assert payload["days"] == []
    assert "no runs matched" in payload["limitations"][-1]
    rendered = json.dumps(payload)
    assert "maker10" not in rendered
    assert not payload_contains_number(payload, 999)
    assert invalid.status_code == 400
    assert missing.status_code == 404


def test_usage_trend_flags_spike_without_enforcement_and_keeps_agy_cost_unknown(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    db_path = tmp_path / "board.db"
    store = SQLiteBoardStore(db_path)
    secret = "xoxb-" + ("e" * 44)
    now = int(time.time())
    day = 86_400
    for offset, tokens in zip((6, 5, 4, 3), (10, 12, 11, 60), strict=True):
        complete_run_at(
            store,
            db_path,
            board="dev10",
            node="maker",
            metadata={
                "node": "maker",
                "total_tokens": tokens,
                "cost_usd": tokens / 100,
                "transcript_path": f"/Users/chopin/private/{secret}.jsonl",
            },
            started_at=now - (offset * day),
            created_by="member-1",
        )
    complete_run_at(
        store,
        db_path,
        board="dev10",
        node="agy-node",
        metadata={"node": "agy-node", "total_tokens": 40, "cost_usd": 999.0},
        started_at=now - day,
        created_by="member-1",
    )
    complete_run_at(
        store,
        db_path,
        board="dev10",
        node="other",
        metadata={"node": "other", "total_tokens": 777, "cost_usd": 7.77},
        started_at=now - day,
        created_by="member-2",
    )
    write_registry(
        tmp_path,
        "dev10",
        {
            "maker": {"name": "maker", "agent": "codex", "tmux_pane": "dev10:1.0"},
            "agy-node": {"name": "agy-node", "agent": "agy", "tmux_pane": "dev10:1.1"},
            "other": {"name": "other", "agent": "claude", "tmux_pane": "dev10:1.2"},
        },
    )

    def fail_enforcement(*_args: object, **_kwargs: object) -> None:
        raise AssertionError("trend endpoint must not call enforcement")

    monkeypatch.setattr(store, "set_member_quota", fail_enforcement)
    monkeypatch.setattr(store, "set_execution_global", fail_enforcement)
    client = make_client(tmp_path, store, usage_trend_enabled=True)

    response = client.get(
        "/api/usage/trend?window=7d&member=member-1",
        headers=auth_headers(client),
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["mode"] == "advisory"
    assert payload["actions"] == []
    assert payload["enforcement"] == {"called": False}
    nodes = {node["node"]: node for node in payload["nodes"]}
    assert set(nodes) == {"agy-node", "maker"}
    assert nodes["maker"]["anomaly"]["total_tokens"]["flagged"] is True
    assert nodes["maker"]["anomaly"]["total_tokens"]["reason"] == "spike"
    assert nodes["maker"]["forecast"]["label"] == "simple extrapolation; not a prediction"
    assert nodes["maker"]["forecast"]["total_tokens_next_day"]["value"] == 109
    assert nodes["maker"]["days"][-1]["totals"]["cost_usd_estimate"]["value"] == 0.6
    assert nodes["agy-node"]["days"][0]["totals"]["cost_usd_estimate"] == {
        "value": None,
        "source": "estimate",
        "confidence": "unknown",
        "status": "unknown",
    }
    assert nodes["agy-node"]["trend"]["cost_usd_estimate"]["status"] == "unknown"
    assert nodes["agy-node"]["anomaly"]["cost_usd_estimate"] == {
        "flagged": False,
        "reason": "excluded: agy cost is unknown",
        "confidence": "unknown",
    }
    assert any("agy cost is unknown" in item for item in payload["limitations"])
    rendered = json.dumps(payload)
    assert secret not in rendered
    assert "/Users/chopin" not in rendered
    assert not payload_contains_number(payload, 999.0)
    assert not payload_contains_number(payload, 777)
    assert not payload_contains_number(payload, 7.77)
    audits = store.list_audit_events(board="dev10", action="usage-trend")
    assert audits[-1].payload["advisory_only"] is True


def test_gui_feature_toggles_persist_audit_and_enable_default_off_surfaces(
    tmp_path: Path,
) -> None:
    db_path = tmp_path / "board.db"
    store = SQLiteBoardStore(db_path)
    now = int(time.time())
    complete_run_at(
        store,
        db_path,
        board="dev10",
        node="maker",
        metadata={"node": "maker", "total_tokens": 25, "cost_usd": 0.25},
        started_at=now - 86_400,
        created_by="member-1",
    )
    write_registry(
        tmp_path,
        "dev10",
        {"maker": {"name": "maker", "agent": "codex", "tmux_pane": "dev10:1.0"}},
    )
    client = make_client(tmp_path, store)
    headers = auth_headers(client)

    initial = client.get("/api/gui-features", headers=headers)
    disabled = client.get("/api/usage/trend", headers=headers)
    updated = client.post(
        "/api/gui-features/usage-trend",
        headers=headers,
        json={"enabled": True},
    )
    enabled = client.get("/api/usage/trend", headers=headers)

    assert initial.status_code == 200
    initial_payload = initial.json()
    assert initial_payload["features"]["usage-trend"] == {
        "enabled": False,
        "configured": False,
        "source": "default",
    }
    assert initial_payload["features"]["quota"]["enabled"] is False
    assert disabled.status_code == 404
    assert updated.status_code == 200
    assert updated.json()["key"] == "usage-trend"
    assert updated.json()["feature"] == {
        "enabled": True,
        "configured": True,
        "source": "gui",
    }
    assert updated.json()["features"]["usage-trend"] == updated.json()["feature"]
    assert updated.json()["features"]["quota"]["enabled"] is False
    assert enabled.status_code == 200
    assert enabled.json()["mode"] == "advisory"

    reopened = SQLiteBoardStore(db_path)
    assert (
        reopened.gui_feature_flags(board="dev10", features=("usage-trend",))["usage-trend"][
            "enabled"
        ]
        is True
    )
    audits = reopened.list_audit_events(board="dev10", action="gui-feature-toggle")
    assert audits[-1].payload["feature"] == "usage-trend"
    assert audits[-1].payload["enabled"] is True


def test_gui_feature_toggle_is_operator_only(tmp_path: Path) -> None:
    write_team_member(tmp_path, secret="viewer-secret", role="viewer")
    store = SQLiteBoardStore(tmp_path / "board.db")
    client = make_client(tmp_path, store, auth_mode=AuthMode.TEAM_COOKIE)

    login = client.post("/api/login", json={"name": "alice", "secret": "viewer-secret"})
    response = client.post(
        "/api/gui-features/summary",
        headers={CSRF_HEADER: login.json()["csrf"]},
        json={"enabled": True},
    )

    assert login.status_code == 200
    assert response.status_code == 403
    assert (
        store.gui_feature_flags(board="dev10", features=("summary",))["summary"]["enabled"] is False
    )


def test_usage_trend_default_off_viewer_gate_project_scope_and_thin_data(
    tmp_path: Path,
) -> None:
    db_path = tmp_path / "board.db"
    store = SQLiteBoardStore(db_path)
    secret = "xoxb-" + ("f" * 44)
    now = int(time.time())
    complete_run_at(
        store,
        db_path,
        board="dev10",
        node=f"/Users/chopin/{secret}",
        metadata={"node": "unsafe", "total_tokens": 100},
        started_at=now - 86_400,
    )
    write_registry(
        tmp_path,
        "dev10",
        {"maker10": {"name": "maker10", "agent": "codex", "tmux_pane": "dev10:1.0"}},
    )
    write_registry(
        tmp_path,
        "dev11",
        {"maker11": {"name": "maker11", "agent": "claude", "tmux_pane": "dev11:1.0"}},
    )
    default_client = make_client(tmp_path, store)
    disabled = default_client.get("/api/usage/trend", headers=auth_headers(default_client))

    write_team_member(tmp_path, secret="viewer-secret", role="viewer")
    viewer_client = make_client(
        tmp_path,
        store,
        auth_mode=AuthMode.TEAM_COOKIE,
        usage_trend_enabled=True,
    )
    login = viewer_client.post("/api/login", json={"name": "alice", "secret": "viewer-secret"})
    viewer = viewer_client.get("/api/usage/trend?window=7d")

    enabled_client = make_client(tmp_path, store, usage_trend_enabled=True)
    scoped = enabled_client.get(
        "/api/usage/trend?window=7d&project=dev11",
        headers=auth_headers(enabled_client),
    )
    invalid = enabled_client.get(
        "/api/usage/trend?window=365d",
        headers=auth_headers(enabled_client),
    )

    assert disabled.status_code == 404
    assert login.status_code == 200
    assert viewer.status_code == 403
    assert scoped.status_code == 200
    payload = scoped.json()
    assert payload["project"] == "dev11"
    assert payload["nodes"] == []
    assert "no runs matched" in payload["limitations"][-1]
    assert invalid.status_code == 400
    rendered = json.dumps(payload)
    assert secret not in rendered
    assert "/Users/chopin" not in rendered


def test_notification_routing_endpoint_persists_rules_audits_and_redacts(
    tmp_path: Path,
) -> None:
    store = SQLiteBoardStore(tmp_path / "board.db")
    client = make_client(tmp_path, store)
    headers = auth_headers(client)
    secret = "xoxb-" + ("g" * 44)

    initial = client.get("/api/notifications/routing", headers=headers)
    saved = client.post(
        "/api/notifications/routing",
        headers=headers,
        json={
            "enabled": True,
            "dry_run": True,
            "rules": [
                {
                    "name": "blocked-high",
                    "event_type": "blocked",
                    "node": "maker",
                    "severity": "high",
                    "target": {"channel_kind": "inbox", "room_id": "ops"},
                    "escalate_after_seconds": 60,
                    "escalation_targets": [
                        {"channel_kind": "inbox", "room_id": "lead"},
                    ],
                    "max_escalations": 1,
                }
            ],
        },
    )
    invalid = client.post(
        "/api/notifications/routing",
        headers=headers,
        json={
            "enabled": True,
            "rules": [
                {
                    "name": "bad",
                    "event_type": "blocked",
                    "target": {
                        "channel_kind": "inbox",
                        "room_id": f"/Users/chopin/{secret}",
                    },
                }
            ],
        },
    )

    assert initial.status_code == 200
    assert initial.json()["routing"] == {
        "configured": False,
        "enabled": False,
        "dry_run": True,
        "rules": [],
    }
    assert saved.status_code == 200
    payload = saved.json()
    assert payload["routing"]["enabled"] is True
    assert payload["routing"]["dry_run"] is True
    assert payload["routing"]["rules"][0]["target"] == {
        "channel_kind": "inbox",
        "room_id": "ops",
    }
    audits = store.list_audit_events(board="dev10", action="notification-routing-config")
    assert audits[-1].kind == "audit.notification.routing"
    audit_routing = cast(dict[str, Any], audits[-1].payload["routing"])
    assert audit_routing["dry_run"] is True
    assert invalid.status_code == 400
    rendered = json.dumps(saved.json()) + json.dumps(invalid.json())
    assert secret not in rendered
    assert "/Users/chopin" not in rendered


def test_notification_routing_endpoint_rejects_team_viewer(tmp_path: Path) -> None:
    store = SQLiteBoardStore(tmp_path / "board.db")
    write_team_member(tmp_path, secret="viewer-secret", role="viewer")
    client = make_client(tmp_path, store, auth_mode=AuthMode.TEAM_COOKIE)
    login = client.post("/api/login", json={"name": "alice", "secret": "viewer-secret"})
    csrf = str(login.json()["csrf"])

    response = client.post(
        "/api/notifications/routing",
        headers={CSRF_HEADER: csrf},
        json={
            "enabled": True,
            "rules": [
                {
                    "name": "blocked",
                    "event_type": "blocked",
                    "target": {"channel_kind": "inbox", "room_id": "ops"},
                }
            ],
        },
    )

    assert login.status_code == 200
    assert response.status_code == 403
    assert store.notification_routing_state(board="dev10")["configured"] is False


def test_board_query_filters_search_paginates_redacts_and_does_not_mutate(
    tmp_path: Path,
) -> None:
    store = SQLiteBoardStore(tmp_path / "board.db")
    secret = "xoxb-" + ("q" * 44)
    first = store.create_task(
        board="dev10",
        title=f"Fix login /Users/chopin/private {secret}",
        body="alice@example.com cannot sign in",
        assignee="worker",
        status="ready",
        priority=10,
        metadata={"labels": ["bug", "auth"]},
    )
    second = store.create_task(
        board="dev10",
        title="Login copy polish",
        body="button label",
        assignee="worker",
        status="ready",
        priority=5,
        metadata={"labels": ["bug"]},
    )
    store.create_task(
        board="dev10",
        title="Unrelated task",
        body="other",
        assignee="worker",
        status="ready",
        metadata={"labels": ["docs"]},
    )
    client = make_client(tmp_path, store)
    headers = auth_headers(client)
    before_events = store.list_events_after(cursor=0, limit=100)
    before_boards = {board.id for board in store.list_boards()}

    page_one = client.get(
        "/api/boards/dev10/query?status=ready&assignee=worker&label=bug&q=login&limit=1",
        headers=headers,
    )
    payload_one = page_one.json()
    next_cursor = payload_one["pagination"]["next_cursor"]
    page_two = client.get(
        f"/api/boards/dev10/query?status=ready&assignee=worker&label=bug&q=login&limit=1"
        f"&cursor={next_cursor}",
        headers=headers,
    )
    injection = client.get(
        "/api/boards/dev10/query?q=%25%27%20OR%201%3D1%20--",
        headers=headers,
    )
    missing = client.get("/api/boards/missing/query?q=anything", headers=headers)

    assert page_one.status_code == 200
    assert payload_one["pagination"]["total"] == 2
    assert [item["id"] for item in payload_one["items"]] == [first.id]
    assert page_two.json()["items"][0]["id"] == second.id
    rendered = json.dumps(payload_one)
    assert secret not in rendered
    assert "/Users/chopin" not in rendered
    assert "alice@example.com" not in rendered
    assert "[pii]" in rendered
    assert injection.status_code == 200
    assert injection.json()["items"] == []
    assert injection.json()["pagination"]["total"] == 0
    assert missing.status_code == 200
    assert missing.json()["items"] == []
    assert before_events == store.list_events_after(cursor=0, limit=100)
    assert before_boards == {board.id for board in store.list_boards()}


def test_board_query_respects_project_scope(tmp_path: Path) -> None:
    store = SQLiteBoardStore(tmp_path / "board.db")
    store.create_task(board="dev10", title="Default project task", body=None, assignee=None)
    dev11 = store.create_task(
        board="dev11",
        title="Scoped project task",
        body=None,
        assignee=None,
        metadata={"labels": ["scoped"]},
    )
    write_registry(
        tmp_path,
        "dev11",
        {"worker": {"name": "worker", "agent": "codex", "tmux_pane": "dev11:1.0"}},
    )
    client = make_client(tmp_path, store)
    scoped_headers = auth_headers(client) | {"X-Grove-Project": "dev11"}

    scoped = client.get("/api/boards/main/query?label=scoped", headers=scoped_headers)
    cross_board = client.get("/api/boards/dev10/query", headers=scoped_headers)

    assert scoped.status_code == 200
    assert scoped.json()["project"] == "dev11"
    assert [item["id"] for item in scoped.json()["items"]] == [dev11.id]
    assert cross_board.status_code == 404
    assert cross_board.json()["detail"] == "board 'dev10' not in project 'dev11'"


def test_delegate_project_header_can_create_dev_room_board_task(tmp_path: Path) -> None:
    store = SQLiteBoardStore(tmp_path / "board.db")
    write_registry(
        tmp_path,
        "dev10",
        {"worker": {"name": "worker", "agent": "codex", "tmux_pane": "dev10:1.0"}},
    )
    client = make_client(tmp_path, store)
    headers = auth_headers(client) | {"X-Grove-Project": "dev10"}

    created = client.post(
        "/api/boards/dev-room/tasks",
        headers=headers,
        json={"title": "delegate task", "assignee": "worker"},
    )
    listed = client.get("/api/boards/dev-room/tasks", headers=headers)
    boards = client.get("/api/boards", headers=headers)

    assert created.status_code == 200
    assert created.json()["title"] == "delegate task"
    assert listed.status_code == 200
    assert [task["id"] for task in listed.json()] == [created.json()["id"]]
    assert {board["id"] for board in boards.json()} == {"dev-room"}


def test_dev_room_board_is_owned_by_dev10_project_only(tmp_path: Path) -> None:
    store = SQLiteBoardStore(tmp_path / "board.db")
    store.create_task(board="dev-room", title="dev room task", body=None, assignee=None)
    write_registry(
        tmp_path,
        "dev11",
        {"worker": {"name": "worker", "agent": "codex", "tmux_pane": "dev11:1.0"}},
    )
    client = make_client(tmp_path, store)
    headers = auth_headers(client) | {"X-Grove-Project": "dev11"}

    tasks = client.get("/api/boards/dev-room/tasks", headers=headers)
    create = client.post(
        "/api/boards/dev-room/tasks",
        headers=headers,
        json={"title": "cross project"},
    )
    query = client.get("/api/boards/dev-room/query", headers=headers)
    views = client.get("/api/boards/dev-room/views", headers=headers)
    save_view = client.post(
        "/api/boards/dev-room/views",
        headers=headers,
        json={"name": "blocked", "filters": {"status": "blocked"}},
    )
    boards = client.get("/api/boards", headers=headers)

    for response in (tasks, create, query, views, save_view):
        assert response.status_code == 404
        assert response.json()["detail"] == "board 'dev-room' not in project 'dev11'"
    assert boards.status_code == 200
    assert boards.json() == []


def test_empty_board_id_tasks_path_returns_400(tmp_path: Path) -> None:
    client = make_client(tmp_path, SQLiteBoardStore(tmp_path / "board.db"))

    response = client.get("/api/boards//tasks", headers=auth_headers(client))

    assert response.status_code == 400
    assert response.json()["detail"] == "board id is required"


def test_board_saved_views_crud_operator_and_viewer_read_only(tmp_path: Path) -> None:
    store = SQLiteBoardStore(tmp_path / "board.db")
    store.create_task(
        board="dev10",
        title="Blocked bug",
        body=None,
        status="blocked",
        assignee="worker",
        metadata={"labels": ["bug"]},
    )
    client = make_client(tmp_path, store)
    headers = auth_headers(client)
    secret = "xoxb-" + ("v" * 44)

    created = client.post(
        "/api/boards/dev10/views",
        headers=headers,
        json={
            "name": "blocked-bugs",
            "filters": {
                "status": "blocked",
                "label": "bug",
                "q": f"/Users/chopin/{secret}",
                "limit": 2,
            },
        },
    )
    listed = client.get("/api/boards/dev10/views", headers=headers)
    queried = client.get("/api/boards/dev10/query?view=blocked-bugs", headers=headers)
    updated = client.post(
        "/api/boards/dev10/views",
        headers=headers,
        json={"name": "blocked-bugs", "filters": {"status": "ready", "limit": 5}},
    )
    deleted = client.delete("/api/boards/dev10/views/blocked-bugs", headers=headers)

    assert created.status_code == 200
    assert created.json()["view"]["name"] == "blocked-bugs"
    assert created.json()["view"]["filters"]["status"] == "blocked"
    assert listed.json()["views"][0]["name"] == "blocked-bugs"
    assert queried.status_code == 200
    assert queried.json()["pagination"]["total"] == 0
    assert updated.json()["view"]["filters"]["status"] == "ready"
    assert deleted.json()["deleted"] is True
    rendered = json.dumps(created.json()) + json.dumps(listed.json())
    assert secret not in rendered
    assert "/Users/chopin" not in rendered
    audits = store.list_audit_events(board="dev10", action="saved-view-upsert")
    assert len(audits) == 2
    assert store.list_audit_events(board="dev10", action="saved-view-delete")

    write_team_member(tmp_path, secret="viewer-secret", role="viewer")
    viewer_client = make_client(tmp_path, store, auth_mode=AuthMode.TEAM_COOKIE)
    login = viewer_client.post("/api/login", json={"name": "alice", "secret": "viewer-secret"})
    csrf = str(login.json()["csrf"])
    viewer_get = viewer_client.get("/api/boards/dev10/views")
    viewer_post = viewer_client.post(
        "/api/boards/dev10/views",
        headers={CSRF_HEADER: csrf},
        json={"name": "viewer-view", "filters": {"status": "ready"}},
    )

    assert login.status_code == 200
    assert viewer_get.status_code == 200
    assert viewer_post.status_code == 403


def test_retro_analytics_reports_advisory_insights_without_mutating_work(
    tmp_path: Path,
) -> None:
    db_path = tmp_path / "board.db"
    store = SQLiteBoardStore(db_path)
    secret = "xoxb-" + ("c" * 44)
    task = store.create_task(
        board="dev10",
        title=f"Do not leak alice@example.com {secret}",
        body=f"private path /Users/chopin/project/{secret}",
        assignee="maker",
        metadata={"self_retro": True},
    )
    claim = store.claim_next(board="dev10", assignee="maker", node_id="maker", ttl_seconds=30)
    assert claim is not None
    assert store.complete(
        board="dev10",
        task_id=task.id,
        run_id=claim.run_id,
        claim_lock=claim.claim_lock,
        result="done",
        summary="done",
        metadata={"node": "maker"},
    )
    with sqlite3.connect(db_path) as conn:
        conn.execute(
            "UPDATE runs SET started_at = ?, ended_at = ? WHERE id = ?",
            (1_704_067_200, 1_704_067_200 + 7_200, claim.run_id),
        )
    store.add_comment(
        board="dev10",
        task_id=task.id,
        author="retro:maker",
        body=f"pytest flaky tests blocked by /Users/chopin/private {secret} alice@example.com",
        metadata={"kind": "retro", "node": "maker"},
    )
    store.create_task(
        board="dev10",
        title="Blocked follow-up",
        body=None,
        assignee="maker",
        status="blocked",
    )
    store.create_task(
        board="other",
        title=f"Other project secret {secret}",
        body="pytest should not leak",
        assignee="maker",
        metadata={"self_retro": True},
    )
    write_registry(
        tmp_path,
        "dev10",
        {
            "maker": {
                "name": "maker",
                "agent": "codex",
                "role": "backend",
                "tmux_pane": "dev10:1.0",
            },
            "agy-node": {"name": "agy-node", "agent": "agy", "tmux_pane": "dev10:1.1"},
        },
    )
    client = make_client(tmp_path, store, retro_analytics_enabled=True)
    before_tasks = len(store.list_tasks(board="dev10"))
    before_comments = len(store.list_comments(board="dev10", task_id=task.id))
    before_runs = len(store.list_runs_for_board(board="dev10"))

    missing = client.get("/api/retro/analytics?window=all")
    response = client.get("/api/retro/analytics?window=all", headers=auth_headers(client))

    assert missing.status_code == 401
    assert response.status_code == 200
    payload = response.json()
    assert payload["project"] == "dev10"
    assert payload["mode"] == "advisory"
    assert payload["actions"] == []
    assert payload["sample"]["completed_runs"]["value"] == 1
    assert payload["sample"]["retro_comments"]["value"] == 1
    assert payload["throughput"] == [
        {
            "bucket": "2024-01-01",
            "completed": {
                "value": 1,
                "source": "run_metadata",
                "confidence": "low",
            },
        }
    ]
    themes = {theme["theme"]: theme for theme in payload["themes"]}
    assert themes["testing"]["count"]["value"] == 1
    assert themes["blocked"]["count"]["value"] == 1
    assert payload["patterns"]["blocked"]["current"]["value"] == 1
    assert payload["patterns"]["slow"]["count"]["value"] == 1
    by_node = {item["node"]: item for item in payload["outcomes"]["by_node"]}
    assert by_node["maker"]["role"] == "backend"
    assert by_node["maker"]["completed"]["value"] == 1
    assert payload["cost_signals"]["agy_credit"] == {
        "value": None,
        "source": "none",
        "confidence": "unknown",
        "status": "unknown",
    }
    assert any("agy credit is unknown" in item for item in payload["limitations"])
    rendered = json.dumps(payload)
    assert secret not in rendered
    assert "alice@example.com" not in rendered
    assert "/Users/chopin" not in rendered
    assert "Other project secret" not in rendered
    assert len(store.list_tasks(board="dev10")) == before_tasks
    assert len(store.list_comments(board="dev10", task_id=task.id)) == before_comments
    assert len(store.list_runs_for_board(board="dev10")) == before_runs
    audits = store.list_audit_events(board="dev10", action="retro-analytics")
    assert audits[-1].kind == "audit.retro.analytics"
    assert audits[-1].payload["advisory_only"] is True


def test_retro_analytics_default_off_and_viewer_role_gate(tmp_path: Path) -> None:
    store = SQLiteBoardStore(tmp_path / "board.db")
    default_client = make_client(tmp_path, store)

    disabled = default_client.get("/api/retro/analytics", headers=auth_headers(default_client))

    write_team_member(tmp_path, secret="viewer-secret", role="viewer")
    viewer_client = make_client(
        tmp_path,
        store,
        auth_mode=AuthMode.TEAM_COOKIE,
        retro_analytics_enabled=True,
    )
    login = viewer_client.post("/api/login", json={"name": "alice", "secret": "viewer-secret"})
    viewer = viewer_client.get("/api/retro/analytics")

    assert disabled.status_code == 404
    assert login.status_code == 200
    assert viewer.status_code == 403


def test_retro_analytics_project_scope_and_low_confidence_empty(
    tmp_path: Path,
) -> None:
    store = SQLiteBoardStore(tmp_path / "board.db")
    secret = "xoxb-" + ("d" * 44)
    dev10 = store.create_task(
        board="dev10",
        title=f"dev10 secret {secret}",
        body=None,
        assignee="maker10",
        metadata={"self_retro": True},
    )
    store.add_comment(
        board="dev10",
        task_id=dev10.id,
        author="retro:maker10",
        body=f"pytest leak {secret}",
        metadata={"kind": "retro"},
    )
    write_registry(
        tmp_path,
        "dev10",
        {"maker10": {"name": "maker10", "agent": "codex", "tmux_pane": "dev10:1.0"}},
    )
    write_registry(
        tmp_path,
        "dev11",
        {"maker11": {"name": "maker11", "agent": "claude", "tmux_pane": "dev11:1.0"}},
    )
    client = make_client(tmp_path, store, retro_analytics_enabled=True)

    scoped = client.get(
        "/api/retro/analytics?window=all&project=dev11", headers=auth_headers(client)
    )
    invalid = client.get("/api/retro/analytics?project=../dev11", headers=auth_headers(client))

    assert scoped.status_code == 200
    payload = scoped.json()
    assert payload["project"] == "dev11"
    assert payload["confidence"] == "low"
    assert payload["sample"]["retro_comments"]["value"] == 0
    assert payload["throughput"] == []
    assert payload["themes"] == []
    assert "small sample size; confidence is low" in payload["limitations"]
    rendered = json.dumps(payload)
    assert secret not in rendered
    assert "dev10 secret" not in rendered
    assert invalid.status_code == 400


def test_ledger_rolls_up_members_quota_soft_throttle_and_host_pressure(
    tmp_path: Path,
) -> None:
    db_path = tmp_path / "board.db"
    store = SQLiteBoardStore(db_path)
    secret = "xoxb-" + ("b" * 44)
    write_registry(
        tmp_path,
        "dev10",
        {
            "maker": {"name": "maker", "agent": "codex", "tmux_pane": "dev10:1.0"},
            "agy-node": {"name": "agy-node", "agent": "agy", "tmux_pane": "dev10:1.1"},
        },
    )
    write_team_member(
        tmp_path, name="alice", secret="admin-secret", role="admin", member_id="member-1"
    )
    write_team_member(
        tmp_path,
        name="bob@example.com",
        secret="viewer-secret",
        role="viewer",
        member_id="member-bob",
        append=True,
    )
    complete_run_at(
        store,
        db_path,
        board="dev10",
        node="maker",
        metadata={
            "node": "maker",
            "total_tokens": 25,
            "cost_usd": 0.25,
            "transcript_path": f"/Users/chopin/private/{secret}.jsonl",
        },
        started_at=1_704_067_200,
        created_by="member-1",
    )
    complete_run_at(
        store,
        db_path,
        board="dev10",
        node="agy-node",
        metadata={"node": "agy-node", "total_tokens": 9},
        started_at=1_704_067_260,
        created_by="member-bob",
    )
    running_task = store.create_task(
        board="dev10",
        title="Running task",
        body=None,
        assignee="maker",
        created_by="member-1",
    )
    running_claim = store.claim_next(
        board="dev10", assignee="maker", node_id="maker", ttl_seconds=30
    )
    assert running_claim is not None
    client = make_client(
        tmp_path,
        store,
        auth_mode=AuthMode.TEAM_COOKIE,
        quota_enabled=True,
    )
    login = client.post("/api/login", json={"name": "alice", "secret": "admin-secret"})
    csrf = str(login.json()["csrf"])

    quota = client.post(
        "/api/quota",
        headers={CSRF_HEADER: csrf},
        json={
            "member_id": "member-1",
            "soft_run_limit": 1,
            "soft_token_limit": 10,
            "soft_cost_usd": 0.01,
        },
    )
    ledger = client.get("/api/ledger?window=all")

    assert login.status_code == 200
    assert quota.status_code == 200
    assert quota.json()["quota"]["hard_kill"] is False
    assert store.get_task(board="dev10", task_id=running_task.id).status == "running"
    assert ledger.status_code == 200
    payload = ledger.json()
    assert payload["project"] == "dev10"
    assert payload["quota_enabled"] is True
    assert payload["host_pressure"]["running"]["value"] == 1
    members = {item["member"]["id"]: item for item in payload["members"]}
    alice = members["member-1"]
    assert alice["totals"]["runs"]["value"] == 2
    assert alice["totals"]["total_tokens"]["value"] == 25
    assert alice["quota"]["status"] == "exceeded"
    assert alice["quota"]["soft_throttle"] == {
        "active": True,
        "action": "queue-delay",
        "reasons": ["runs", "tokens", "cost"],
        "hard_kill": False,
    }
    bob = members["member-bob"]
    assert bob["member"]["name"] == "[pii]"
    assert bob["totals"]["total_tokens"]["value"] == 9
    assert bob["totals"]["cost_usd_estimate"]["status"] == "unknown"
    assert "agy credit is unknown" in bob["warnings"][0]
    audit_events = store.list_audit_events(board="dev10", action="quota-update")
    assert len(audit_events) == 1
    rendered = json.dumps(payload)
    assert secret not in rendered
    assert "/Users/chopin" not in rendered
    assert "bob@example.com" not in rendered


def test_ledger_self_scope_quota_permissions_default_off_and_project_scope(
    tmp_path: Path,
) -> None:
    db_path = tmp_path / "board.db"
    store = SQLiteBoardStore(db_path)
    write_registry(
        tmp_path,
        "dev10",
        {"maker": {"name": "maker", "agent": "codex", "tmux_pane": "dev10:1.0"}},
    )
    write_registry(
        tmp_path,
        "dev11",
        {"other": {"name": "other", "agent": "claude", "tmux_pane": "dev11:1.0"}},
    )
    write_team_member(
        tmp_path, name="alice", secret="admin-secret", role="admin", member_id="member-1"
    )
    write_team_member(
        tmp_path,
        name="viewer",
        secret="viewer-secret",
        role="viewer",
        member_id="member-viewer",
        append=True,
    )
    complete_run_at(
        store,
        db_path,
        board="dev10",
        node="maker",
        metadata={"node": "maker", "total_tokens": 100},
        started_at=1_704_067_200,
        created_by="member-1",
    )
    complete_run_at(
        store,
        db_path,
        board="dev10",
        node="maker",
        metadata={"node": "maker", "total_tokens": 5},
        started_at=1_704_067_260,
        created_by="member-viewer",
    )
    complete_run_at(
        store,
        db_path,
        board="dev11",
        node="other",
        metadata={"node": "other", "total_tokens": 999},
        started_at=1_704_067_300,
        created_by="member-viewer",
    )
    default_client = make_client(tmp_path, store)
    disabled = default_client.post(
        "/api/quota",
        headers=auth_headers(default_client),
        json={"member_id": "member-1", "soft_token_limit": 1},
    )
    viewer_client = make_client(
        tmp_path,
        store,
        auth_mode=AuthMode.TEAM_COOKIE,
        quota_enabled=True,
    )
    viewer_login = viewer_client.post(
        "/api/login",
        json={"name": "viewer", "secret": "viewer-secret"},
    )
    viewer_csrf = str(viewer_login.json()["csrf"])
    viewer_ledger = viewer_client.get("/api/ledger?window=all")
    viewer_other = viewer_client.get("/api/ledger?window=all&member=member-1")
    viewer_quota = viewer_client.post(
        "/api/quota",
        headers={CSRF_HEADER: viewer_csrf},
        json={"member_id": "member-viewer", "soft_token_limit": 1},
    )
    scoped = viewer_client.get("/api/ledger?window=all&project=dev11")
    missing_token = default_client.get("/api/ledger?window=all")

    assert disabled.status_code == 404
    assert viewer_login.status_code == 200
    assert viewer_ledger.status_code == 200
    viewer_payload = viewer_ledger.json()
    assert viewer_payload["scope"] == "self"
    assert [item["member"]["id"] for item in viewer_payload["members"]] == ["member-viewer"]
    assert viewer_payload["members"][0]["totals"]["total_tokens"]["value"] == 5
    assert viewer_other.status_code == 403
    assert viewer_quota.status_code == 403
    assert scoped.status_code == 200
    assert scoped.json()["members"][0]["totals"]["total_tokens"]["value"] == 999
    assert all(item["totals"]["total_tokens"]["value"] != 100 for item in scoped.json()["members"])
    assert missing_token.status_code == 401


def test_summary_endpoint_is_default_off_token_scoped_and_privacy_allowlisted(
    tmp_path: Path,
) -> None:
    db_path = tmp_path / "board.db"
    store = SQLiteBoardStore(db_path)
    secret = "xoxb-" + ("a" * 44)
    store.create_task(
        board="dev10",
        title=f"Secret title {secret}",
        body=f"Body must not export /Users/chopin/private/{secret}",
        assignee="maker10",
        status="blocked",
    )
    store.create_task(
        board="dev11",
        title="public count only",
        body="not exported",
        assignee=None,
        status="ready",
    )
    store.create_task(
        board="dev11",
        title="unknown status count",
        body="not exported",
        assignee=None,
        status=f"/Users/chopin/private/{secret}",
    )
    write_registry(
        tmp_path,
        "dev10",
        {
            "maker10": {
                "name": "maker10",
                "agent": "codex",
                "tmux_pane": "dev10:1.0",
                "description": f"/Users/chopin/private/{secret}",
                "transcript_path": f"/Users/chopin/private/{secret}.jsonl",
            }
        },
    )
    write_registry(
        tmp_path,
        "dev11",
        {
            "maker11": {
                "name": "maker11",
                "agent": f"xapp-{secret}",
                "status": f"/Users/chopin/private/{secret}",
                "tmux_pane": "dev11:1.0",
            }
        },
    )
    default_client = make_client(tmp_path, store)
    client = make_client(tmp_path, store, summary_export_enabled=True)
    headers = auth_headers(client)

    disabled = default_client.get("/api/summary", headers=auth_headers(default_client))
    missing_token = client.get("/api/summary")
    scoped = client.get("/api/summary", headers=headers | {"X-Grove-Project": "dev11"})

    assert disabled.status_code == 404
    assert missing_token.status_code == 401
    assert scoped.status_code == 200
    payload = scoped.json()
    assert payload["algorithm"] == "hmac-sha256"
    assert set(payload) == {"algorithm", "key_id", "payload", "signature"}
    assert payload["payload"]["project"] == "dev11"
    assert payload["payload"]["summary"]["tasks"]["total"] == 2
    assert payload["payload"]["summary"]["tasks"]["by_status"] == {"other": 1, "ready": 1}
    assert payload["payload"]["summary"]["nodes"]["by_status"] == {"other": 1}
    assert payload["payload"]["summary"]["nodes"]["by_agent"] == {"other": 1}
    rendered = json.dumps(payload)
    assert secret not in rendered
    assert "/Users/chopin" not in rendered
    assert "Body must not export" not in rendered
    assert "Secret title" not in rendered
    assert "transcript" not in rendered.lower()
    key_path = tmp_path / ".grove" / "dev11" / "summary-signing-key"
    assert key_path.stat().st_mode & 0o077 == 0
    aggregate = client.post(
        "/api/aggregate",
        headers=headers | {"X-Grove-Project": "dev11"},
        json={"summaries": [payload]},
    )
    wrong_scope = client.post("/api/aggregate", headers=headers, json={"summaries": [payload]})
    missing_project = client.post(
        "/api/aggregate?project=missing",
        headers=headers,
        json={"summaries": [payload]},
    )
    assert aggregate.json()["trust"] == {"trusted": 1, "untrusted": 0, "stale": 0}
    assert aggregate.json()["combined"]["projects"] == ["dev11"]
    assert wrong_scope.json()["trust"] == {"trusted": 0, "untrusted": 1, "stale": 0}
    assert missing_project.status_code == 404


def test_aggregate_verifies_signature_and_rejects_tampered_summary(tmp_path: Path) -> None:
    store = SQLiteBoardStore(tmp_path / "board.db")
    store.create_task(board="dev10", title="ready", body=None, assignee=None, status="ready")
    write_registry(
        tmp_path,
        "dev10",
        {"maker": {"name": "maker", "agent": "codex", "tmux_pane": "dev10:1.0"}},
    )
    client = make_client(tmp_path, store, summary_export_enabled=True)
    headers = auth_headers(client)
    signed = client.get("/api/summary", headers=headers).json()
    tampered = json.loads(json.dumps(signed))
    tampered["payload"]["summary"]["tasks"]["total"] = 999
    unknown_key = json.loads(json.dumps(signed))
    unknown_key["key_id"] = "unknown-key"

    missing_token = client.post("/api/aggregate", json={"summaries": [signed]})
    response = client.post(
        "/api/aggregate",
        headers=headers,
        json={"summaries": [signed, tampered, unknown_key]},
    )

    assert missing_token.status_code == 401
    assert response.status_code == 200
    payload = response.json()
    assert payload["trust"] == {"trusted": 1, "untrusted": 2, "stale": 0}
    assert payload["summaries"][0]["trust"] == "trusted"
    assert payload["summaries"][1]["trust"] == "untrusted"
    assert "signature" in payload["summaries"][1]["reason"]
    assert payload["summaries"][2]["trust"] == "untrusted"
    assert "unknown summary key" in payload["summaries"][2]["reason"]
    assert payload["combined"]["sources"] == 1
    assert payload["combined"]["tasks"]["total"] == 1
    assert payload["combined"]["tasks"]["by_status"] == {"ready": 1}
    assert "payload" not in payload["summaries"][1]
    assert "payload" not in payload["summaries"][2]
    trusted_payload = cast(dict[str, object], payload["summaries"][0]["payload"])
    trusted_summary = cast(dict[str, object], trusted_payload["summary"])
    trusted_tasks = cast(dict[str, object], trusted_summary["tasks"])
    assert trusted_tasks["total"] == 1


def test_aggregate_requires_team_operator(
    tmp_path: Path,
) -> None:
    store = SQLiteBoardStore(tmp_path / "board.db")
    store.create_task(board="dev10", title="ready", body=None, assignee=None, status="ready")
    write_team_member(tmp_path, name="viewer", secret="viewer-secret", role="viewer")
    write_team_member(
        tmp_path,
        name="operator",
        secret="operator-secret",
        role="operator",
        member_id="member-operator",
        append=True,
    )
    viewer = make_client(
        tmp_path,
        store,
        auth_mode=AuthMode.TEAM_COOKIE,
        summary_export_enabled=True,
    )
    operator = make_client(
        tmp_path,
        store,
        auth_mode=AuthMode.TEAM_COOKIE,
        summary_export_enabled=True,
    )
    viewer_login = viewer.post("/api/login", json={"name": "viewer", "secret": "viewer-secret"})
    operator_login = operator.post(
        "/api/login",
        json={"name": "operator", "secret": "operator-secret"},
    )
    summary = operator.get("/api/summary").json()

    viewer_response = viewer.post(
        "/api/aggregate",
        headers={CSRF_HEADER: str(viewer_login.json()["csrf"])},
        json={"summaries": [summary]},
    )
    operator_response = operator.post(
        "/api/aggregate",
        headers={CSRF_HEADER: str(operator_login.json()["csrf"])},
        json={"summaries": [summary]},
    )

    assert viewer_login.status_code == 200
    assert operator_login.status_code == 200
    assert viewer_response.status_code == 403
    assert operator_response.status_code == 200
    assert operator_response.json()["trust"] == {"trusted": 1, "untrusted": 0, "stale": 0}


def test_aggregate_trusts_configured_summary_key_id_only(tmp_path: Path) -> None:
    store = SQLiteBoardStore(tmp_path / "board.db")
    store.create_task(board="dev10", title="ready", body=None, assignee=None, status="ready")
    write_registry(
        tmp_path,
        "dev10",
        {"maker": {"name": "maker", "agent": "codex", "tmux_pane": "dev10:1.0"}},
    )
    client = make_client(tmp_path, store, summary_export_enabled=True)
    headers = auth_headers(client)
    source = client.get("/api/summary", headers=headers).json()
    trusted_key = "external-summary-key"
    trusted_key_id = hashlib.sha256(trusted_key.encode("utf-8")).hexdigest()[:16]
    payload = source["payload"]
    signature = hmac.new(
        trusted_key.encode("utf-8"),
        json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode(
            "utf-8"
        ),
        hashlib.sha256,
    ).hexdigest()
    external = {
        "algorithm": "hmac-sha256",
        "key_id": trusted_key_id,
        "payload": payload,
        "signature": f"sha256:{signature}",
    }

    rejected = client.post("/api/aggregate", headers=headers, json={"summaries": [external]})
    trusted_keys = tmp_path / "summary-trusted-keys.json"
    trusted_keys.write_text(json.dumps({"keys": {trusted_key_id: trusted_key}}), encoding="utf-8")
    trusted_keys.chmod(0o600)
    trusted_client = make_client(
        tmp_path,
        store,
        summary_export_enabled=True,
        summary_trusted_keys_path=trusted_keys,
    )
    accepted = trusted_client.post(
        "/api/aggregate",
        headers=auth_headers(trusted_client),
        json={"summaries": [external]},
    )

    assert rejected.json()["trust"] == {"trusted": 0, "untrusted": 1, "stale": 0}
    assert accepted.json()["trust"] == {"trusted": 1, "untrusted": 0, "stale": 0}
    assert accepted.json()["combined"]["sources"] == 1


def test_aggregate_marks_stale_summary_and_excludes_it_from_live_rollup(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    store = SQLiteBoardStore(tmp_path / "board.db")
    store.create_task(board="dev10", title="ready", body=None, assignee=None, status="ready")
    write_registry(
        tmp_path,
        "dev10",
        {"maker": {"name": "maker", "agent": "codex", "tmux_pane": "dev10:1.0"}},
    )
    old_now = 1_700_000_000
    client = make_client(
        tmp_path,
        store,
        summary_export_enabled=True,
        summary_freshness_seconds=60,
    )
    headers = auth_headers(client)
    monkeypatch.setattr("grove_bridge.web_app.time.time", lambda: float(old_now))
    stale_summary = client.get("/api/summary", headers=headers).json()
    monkeypatch.setattr("grove_bridge.web_app.time.time", lambda: float(old_now + 120))

    response = client.post("/api/aggregate", headers=headers, json={"summaries": [stale_summary]})

    assert response.status_code == 200
    payload = response.json()
    assert payload["trust"] == {"trusted": 1, "untrusted": 0, "stale": 1}
    assert payload["summaries"][0]["freshness"] == "stale"
    assert payload["combined"]["sources"] == 0
    assert payload["combined"]["tasks"]["total"] == 0
    assert "stale summaries are excluded" in payload["limitations"][1]
    monkeypatch.setattr("grove_bridge.web_app.time.time", lambda: float(old_now + 61))
    future_summary = client.get("/api/summary", headers=headers).json()
    monkeypatch.setattr("grove_bridge.web_app.time.time", lambda: float(old_now))
    future = client.post("/api/aggregate", headers=headers, json={"summaries": [future_summary]})
    assert future.json()["trust"] == {"trusted": 0, "untrusted": 1, "stale": 0}
    assert "timestamp" in future.json()["summaries"][0]["reason"]


def test_handoff_export_default_off_token_scoped_and_privacy_allowlisted(
    tmp_path: Path,
) -> None:
    store = SQLiteBoardStore(tmp_path / "board.db")
    secret = "xoxb-" + ("b" * 44)
    task = store.create_task(
        board="dev10",
        title=f"Move this owner@example.com /Users/chopin/private/{secret}",
        body=f"Context /Users/chopin/private/transcript.log owner@example.com {secret}",
        assignee="maker",
        status="blocked",
        priority=7,
        metadata={
            "labels": ["handoff", f"/Users/chopin/private/{secret}"],
            "transcript_path": f"/Users/chopin/private/{secret}.jsonl",
        },
    )
    write_registry(
        tmp_path,
        "dev10",
        {"maker": {"name": "maker", "agent": "codex", "tmux_pane": "dev10:1.0"}},
    )
    default_client = make_client(tmp_path, store)
    client = make_client(tmp_path, store, handoff_enabled=True)
    headers = auth_headers(client)

    disabled = default_client.get(
        f"/api/handoff/export?task_id={task.id}",
        headers=auth_headers(default_client),
    )
    missing_token = client.get(f"/api/handoff/export?task_id={task.id}")
    response = client.post(
        "/api/handoff/export",
        headers=headers,
        json={"task_id": task.id},
    )

    assert disabled.status_code == 404
    assert missing_token.status_code == 401
    assert response.status_code == 200
    package = response.json()
    assert set(package) == {"algorithm", "key_id", "payload", "signature"}
    assert package["payload"]["schema"] == "grove.handoff.v1"
    assert package["payload"]["source_project"] == "dev10"
    assert package["payload"]["task"]["priority"] == 7
    rendered = json.dumps(package)
    assert secret not in rendered
    assert "owner@example.com" not in rendered
    assert "/Users/chopin" not in rendered
    assert "transcript_path" not in rendered
    assert "transcript.log" not in rendered
    assert package["payload"]["task"]["labels"] == ["handoff", "[path]"]
    audits = store.list_audit_events(board="dev10", action="export")
    assert len(audits) == 1
    assert audits[0].kind == "audit.handoff.export"
    audit_rendered = json.dumps(audits[0].payload)
    assert secret not in audit_rendered
    assert "owner@example.com" not in audit_rendered
    assert "/Users/chopin" not in audit_rendered


def test_handoff_accept_trust_idempotency_and_receiver_local_only(tmp_path: Path) -> None:
    store = SQLiteBoardStore(tmp_path / "board.db")
    task = store.create_task(
        board="dev10",
        title="Receiver should decide",
        body="Create this locally",
        assignee="sender-node",
        status="blocked",
        priority=3,
        metadata={"labels": ["handoff"]},
    )
    write_registry(
        tmp_path,
        "dev10",
        {"sender-node": {"name": "sender-node", "agent": "codex", "tmux_pane": "dev10:1.0"}},
    )
    write_registry(
        tmp_path,
        "dev11",
        {"receiver": {"name": "receiver", "agent": "claude", "tmux_pane": "dev11:1.0"}},
    )
    sender = make_client(tmp_path, store, handoff_enabled=True)
    package = sender.post(
        "/api/handoff/export",
        headers=auth_headers(sender),
        json={"task_id": task.id},
    ).json()
    tampered = json.loads(json.dumps(package))
    tampered["payload"]["task"]["title"] = "tampered"
    assert store.list_tasks(board="dev11") == []

    receiver_without_trust = make_client(tmp_path, store, handoff_enabled=True)
    unknown = receiver_without_trust.post(
        "/api/handoff/accept",
        headers=auth_headers(receiver_without_trust) | {"X-Grove-Project": "dev11"},
        json={"package": package},
    )
    assert unknown.status_code == 403
    assert store.list_tasks(board="dev11") == []

    sender_key = (
        (tmp_path / ".grove" / "dev10" / "summary-signing-key").read_text(encoding="utf-8").strip()
    )
    sender_key_id = hashlib.sha256(sender_key.encode("utf-8")).hexdigest()[:16]
    trusted_keys = tmp_path / "handoff-trusted-keys.json"
    trusted_keys.write_text(json.dumps({"keys": {sender_key_id: sender_key}}), encoding="utf-8")
    trusted_keys.chmod(0o600)
    receiver = make_client(
        tmp_path,
        store,
        handoff_enabled=True,
        summary_trusted_keys_path=trusted_keys,
    )
    headers = auth_headers(receiver) | {"X-Grove-Project": "dev11"}
    disabled_client = make_client(tmp_path, store)
    disabled_accept = disabled_client.post(
        "/api/handoff/accept",
        headers=auth_headers(disabled_client),
        json={"package": package},
    )
    missing_token = receiver.post("/api/handoff/accept", json={"package": package})
    missing_project = receiver.post(
        "/api/handoff/accept?project=missing",
        headers=auth_headers(receiver),
        json={"package": package},
    )
    tampered_response = receiver.post(
        "/api/handoff/accept",
        headers=headers,
        json={"package": tampered},
    )
    receiver_peer = make_client(
        tmp_path,
        store,
        handoff_enabled=True,
        summary_trusted_keys_path=trusted_keys,
    )
    results: list[Any] = []
    errors: list[BaseException] = []
    barrier = threading.Barrier(3)

    def accept_with(client: TestClient) -> None:
        try:
            client_headers = auth_headers(client) | {"X-Grove-Project": "dev11"}
            barrier.wait()
            results.append(
                client.post(
                    "/api/handoff/accept",
                    headers=client_headers,
                    json={"package": package},
                )
            )
        except BaseException as exc:  # pragma: no cover - assertion below reports the error
            errors.append(exc)

    threads = [
        threading.Thread(target=accept_with, args=(receiver,)),
        threading.Thread(target=accept_with, args=(receiver_peer,)),
    ]
    for thread in threads:
        thread.start()
    barrier.wait()
    for thread in threads:
        thread.join()
    replay = receiver.post("/api/handoff/accept", headers=headers, json={"package": package})

    assert disabled_accept.status_code == 404
    assert missing_token.status_code == 401
    assert missing_project.status_code == 404
    assert tampered_response.status_code == 403
    assert errors == []
    assert len(results) == 2
    assert [response.status_code for response in results] == [200, 200]
    assert sorted(response.json()["created"] for response in results) == [False, True]
    assert replay.status_code == 200
    assert replay.json()["created"] is False
    tasks = store.list_tasks(board="dev11")
    assert len(tasks) == 1
    accepted = tasks[0]
    assert accepted.status == "ready"
    assert accepted.assignee is None
    assert accepted.priority == 3
    assert accepted.metadata["labels"] == ["handoff"]
    accepted_handoff = cast(dict[str, object], accepted.metadata["handoff"])
    package_payload = cast(dict[str, object], package["payload"])
    assert accepted_handoff["id"] == package_payload["handoff_id"]
    created_payload = next(response.json() for response in results if response.json()["created"])
    assert "never dispatches" in created_payload["limitations"][1]
    audits = store.list_audit_events(board="dev11", action="accept")
    assert len(audits) == 1
    assert audits[0].task_id == accepted.id


def test_handoff_accept_rejects_expired_package(tmp_path: Path) -> None:
    store = SQLiteBoardStore(tmp_path / "board.db")
    task = store.create_task(board="dev10", title="old", body=None, assignee=None, status="ready")
    write_registry(
        tmp_path,
        "dev10",
        {"sender": {"name": "sender", "agent": "codex", "tmux_pane": "dev10:1.0"}},
    )
    sender = make_client(tmp_path, store, handoff_enabled=True, handoff_ttl_seconds=10_000)
    headers = auth_headers(sender)
    old_now = 1_700_000_000
    with pytest.MonkeyPatch.context() as monkeypatch:
        monkeypatch.setattr("grove_bridge.web_app.time.time", lambda: float(old_now))
        package = sender.post(
            "/api/handoff/export",
            headers=headers,
            json={"task_id": task.id},
        ).json()
    assert package["payload"]["expires_at"] > old_now + 60
    receiver = make_client(tmp_path, store, handoff_enabled=True, handoff_ttl_seconds=60)

    with pytest.MonkeyPatch.context() as monkeypatch:
        monkeypatch.setattr("grove_bridge.web_app.time.time", lambda: float(old_now + 61))
        response = receiver.post(
            "/api/handoff/accept",
            headers=auth_headers(receiver),
            json={"package": package},
        )

    assert response.status_code == 410
    assert "receiver ttl" in response.json()["detail"]


def test_plan_endpoint_ranks_candidates_with_role_load_and_cost_signals(
    tmp_path: Path,
) -> None:
    store = SQLiteBoardStore(tmp_path / "board.db")
    task = store.create_task(
        board="dev10",
        title="Plan Python work",
        body=None,
        assignee=None,
        metadata={"capability": "python"},
    )
    for node, tokens in (("python-idle", 25), ("python-running", 300), ("reviewer", 5)):
        usage_task = store.create_task(
            board="dev10",
            title=f"{node} usage",
            body=None,
            assignee=node,
        )
        claim = store.claim_next(board="dev10", assignee=node, node_id=node, ttl_seconds=30)
        assert claim is not None
        assert store.complete(
            board="dev10",
            task_id=usage_task.id,
            run_id=claim.run_id,
            claim_lock=claim.claim_lock,
            result="done",
            summary="done",
            metadata={"node": node, "total_tokens": tokens},
        )
    running_task = store.create_task(
        board="dev10",
        title="running load",
        body=None,
        assignee="python-running",
    )
    assert store.claim_next(
        board="dev10",
        assignee="python-running",
        node_id="python-running",
        ttl_seconds=30,
        task_id=running_task.id,
    )
    write_registry(
        tmp_path,
        "dev10",
        {
            "python-idle": {
                "name": "python-idle",
                "agent": "codex",
                "role": "Python maker",
                "capabilities": ["python", "bridge"],
                "status": "idle",
                "tmux_pane": "dev10:1.0",
            },
            "python-running": {
                "name": "python-running",
                "agent": "codex",
                "role": "Python maker",
                "capabilities": ["python"],
                "status": "running",
                "tmux_pane": "dev10:1.1",
            },
            "reviewer": {
                "name": "reviewer",
                "agent": "claude",
                "role": "reviewer",
                "capabilities": ["review"],
                "status": "idle",
                "tmux_pane": "dev10:1.2",
            },
        },
    )
    client = make_client(tmp_path, store)

    response = client.get(
        f"/api/plan?role=python&task_id={task.id}",
        headers=auth_headers(client),
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["read_only"] is True
    assert payload["candidates"][0]["node"] == "python-idle"
    assert payload["candidates"][0]["rank"] == {
        "value": 1,
        "source": "planner",
        "confidence": "explicit",
    }
    top = payload["candidates"][0]
    assert top["score"]["source"] == "planner"
    assert top["score"]["confidence"] == "partial"
    assert top["score_breakdown"]["role_match"]["source"] == "registry+request"
    assert top["score_breakdown"]["capability_match"]["value"] == 20.0
    assert top["score_breakdown"]["cost"]["source"] == "run_metadata:total_tokens"
    assert top["signals"]["cost_basis"]["total_tokens"] == {
        "value": 25,
        "source": "run_metadata",
        "confidence": "explicit",
    }
    assert top["signals"]["cost_basis"]["cost_usd"] == {
        "value": None,
        "source": "none",
        "confidence": "unknown",
        "status": "unknown",
    }
    running = {item["node"]: item for item in payload["candidates"]}["python-running"]
    assert running["signals"]["running_tasks"] == {
        "value": 1,
        "source": "board_store",
        "confidence": "explicit",
    }
    assert running["score_breakdown"]["load"]["value"] < top["score_breakdown"]["load"]["value"]
    assert store.list_runs(board="dev10", task_id=task.id) == []
    assert store.get_task(board="dev10", task_id=task.id).assignee is None


def test_plan_endpoint_token_scope_and_empty_candidates(tmp_path: Path) -> None:
    store = SQLiteBoardStore(tmp_path / "board.db")
    dev10 = store.create_task(board="dev10", title="dev10 task", body=None, assignee=None)
    dev11 = store.create_task(board="dev11", title="dev11 task", body=None, assignee=None)
    write_registry(tmp_path, "dev10", {})
    write_registry(
        tmp_path,
        "dev11",
        {
            "maker11": {
                "name": "maker11",
                "agent": "codex",
                "role": "python",
                "tmux_pane": "dev11:1.0",
            }
        },
    )
    client = make_client(tmp_path, store)
    headers = auth_headers(client)

    missing_token = client.get(f"/api/plan?role=python&task_id={dev10.id}")
    wrong_project = client.get(
        f"/api/plan?role=python&task_id={dev10.id}",
        headers=headers | {"X-Grove-Project": "dev11"},
    )
    empty = client.get(f"/api/plan?role=python&task_id={dev10.id}", headers=headers)
    scoped = client.get(
        f"/api/plan?role=python&task_id={dev11.id}",
        headers=headers | {"X-Grove-Project": "dev11"},
    )

    assert missing_token.status_code == 401
    assert wrong_project.status_code == 404
    assert empty.status_code == 200
    assert empty.json()["candidates"] == []
    assert scoped.status_code == 200
    assert scoped.json()["project"] == "dev11"
    assert scoped.json()["candidates"][0]["node"] == "maker11"


def test_plan_endpoint_redacts_requirement_terms_from_role_and_metadata(
    tmp_path: Path,
) -> None:
    store = SQLiteBoardStore(tmp_path / "board.db")
    secret = "xoxb-" + ("a" * 44)
    task = store.create_task(
        board="dev10",
        title="sensitive planner task",
        body=None,
        assignee=None,
        metadata={
            "role": f"python /Users/chopin/private/{secret} token {secret}",
            "capabilities": [f"bridge /Applications/Grove.app/{secret} token {secret}"],
        },
    )
    write_registry(
        tmp_path,
        "dev10",
        {
            "maker": {
                "name": "maker",
                "agent": "codex",
                "role": "python",
                "capabilities": ["bridge"],
                "tmux_pane": "dev10:1.0",
            }
        },
    )
    client = make_client(tmp_path, store)

    response = client.get(
        f"/api/plan?role=python%20/Users/chopin/{secret}%20{secret}&task_id={task.id}",
        headers=auth_headers(client),
    )

    assert response.status_code == 200
    rendered_requirements = json.dumps(response.json()["requirements"])
    assert secret not in rendered_requirements
    assert "xoxb" not in rendered_requirements
    assert "Users" not in rendered_requirements
    assert "users" not in rendered_requirements
    assert "chopin" not in rendered_requirements
    assert "/Applications" not in rendered_requirements
    assert "applications" not in rendered_requirements
    assert "path" in rendered_requirements
    assert "redacted" in rendered_requirements


def test_cost_endpoint_wraps_and_redacts_last_seen(tmp_path: Path) -> None:
    secret = "xoxb-" + ("a" * 44)
    write_registry(
        tmp_path,
        "dev10",
        {
            "safe": {
                "name": "safe",
                "agent": "codex",
                "tmux_pane": "dev10:1.0",
                "last_seen": "1700000000",
            },
            "unsafe": {
                "name": "unsafe",
                "agent": "claude",
                "tmux_pane": "dev10:1.1",
                "last_seen": f"/Users/chopin/.grove/token/{secret}",
            },
        },
    )
    client = make_client(tmp_path, SQLiteBoardStore(tmp_path / "board.db"))

    response = client.get("/api/cost", headers=auth_headers(client))

    assert response.status_code == 200
    by_node = {node["node"]: node for node in response.json()["nodes"]}
    assert by_node["safe"]["last_seen"] == {
        "value": 1700000000,
        "source": "registry",
        "confidence": "explicit",
    }
    assert by_node["unsafe"]["last_seen"] == {
        "value": None,
        "source": "registry",
        "confidence": "unknown",
        "status": "unknown",
    }
    rendered = json.dumps(response.json())
    assert "/Users/chopin" not in rendered
    assert secret not in rendered


def test_cost_endpoint_handles_transcript_parser_failure_gracefully(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    transcript = tmp_path / "transcript.jsonl"
    transcript.write_text('{"usage":{"total_tokens":10}}\n', encoding="utf-8")
    write_registry(
        tmp_path,
        "dev10",
        {
            "maker": {
                "name": "maker",
                "agent": "codex",
                "tmux_pane": "dev10:1.0",
                "transcript_path": str(transcript),
            },
        },
    )

    def fail_parse(_text: str) -> list[dict[str, object]]:
        raise RuntimeError("parse failed at /etc/passwd with xoxb-" + ("a" * 44))

    monkeypatch.setattr(web_app, "_transcript_json_mappings", fail_parse)
    client = make_client(tmp_path, SQLiteBoardStore(tmp_path / "board.db"))

    response = client.get("/api/cost", headers=auth_headers(client))

    assert response.status_code == 200
    node = response.json()["nodes"][0]
    assert node["total_tokens"] == {
        "value": None,
        "source": "none",
        "confidence": "unknown",
        "status": "unknown",
    }
    assert node["warnings"] == ["transcript parsing failed"]
    rendered = json.dumps(response.json())
    assert "/etc/passwd" not in rendered
    assert "xoxb-" not in rendered


def test_state_change_rejects_disallowed_origin(tmp_path: Path) -> None:
    store = SQLiteBoardStore(tmp_path / "board.db")
    client = make_client(tmp_path, store)

    response = client.post(
        "/api/boards/main/tasks",
        headers=auth_headers(client) | {"Origin": "http://evil.example"},
        json={"title": "Blocked by origin"},
    )

    assert response.status_code == 403
    assert store.list_tasks(board="main") == []


def test_state_change_rejects_disallowed_host(tmp_path: Path) -> None:
    store = SQLiteBoardStore(tmp_path / "board.db")
    client = make_client(tmp_path, store)

    response = client.post(
        "/api/boards/main/tasks",
        headers=auth_headers(client) | {"Host": "evil.example", "Origin": "http://evil.example"},
        json={"title": "Blocked by host"},
    )

    assert response.status_code == 403
    assert store.list_tasks(board="main") == []


def test_state_change_rejects_missing_origin_on_remote_host(tmp_path: Path) -> None:
    store = SQLiteBoardStore(tmp_path / "board.db")
    client = make_client(
        tmp_path,
        store,
        host="100.100.90.87",
        allowed_hosts=("100.100.90.87",),
    )

    response = client.post(
        "/api/boards/main/tasks",
        headers=auth_headers(client),
        json={"title": "Blocked without origin"},
    )

    assert response.status_code == 403
    assert store.list_tasks(board="main") == []


def test_state_change_allows_allowlisted_remote_host_with_origin(tmp_path: Path) -> None:
    store = SQLiteBoardStore(tmp_path / "board.db")
    client = make_client(
        tmp_path,
        store,
        host="100.100.90.87",
        allowed_hosts=("100.100.90.87", "192.168.1.186"),
    )

    response = client.post(
        "/api/boards/main/tasks",
        headers=auth_headers(client) | {"Origin": "http://100.100.90.87:8765"},
        json={"title": "Allowed remote"},
    )

    assert response.status_code == 200
    assert response.json()["title"] == "Allowed remote"


def test_state_change_allows_loopback_without_origin(tmp_path: Path) -> None:
    store = SQLiteBoardStore(tmp_path / "board.db")
    client = make_client(tmp_path, store)

    response = client.post(
        "/api/boards/main/tasks",
        headers=auth_headers(client),
        json={"title": "Allowed loopback"},
    )

    assert response.status_code == 200
    assert response.json()["title"] == "Allowed loopback"


def test_rest_rejects_empty_task_title(tmp_path: Path) -> None:
    client = make_client(tmp_path, SQLiteBoardStore(tmp_path / "board.db"))

    created = client.post(
        "/api/boards/main/tasks",
        headers=auth_headers(client),
        json={"title": "   "},
    )

    assert created.status_code == 400


def test_auth_status_endpoint_is_token_gated_and_returns_tool_array(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        "grove_bridge.web_app.collect_auth_status",
        lambda: [
            ToolAuthStatus(
                tool="gh",
                label="GitHub CLI",
                authed=True,
                detail="github.com account chopin",
                login_hint="gh auth login",
            ),
            ToolAuthStatus(
                tool="cf",
                label="Cloudflare",
                authed=False,
                detail="token not found",
                login_hint="Set CLOUDFLARE_API_TOKEN or save base-voca/cloudflare-api-token",
            ),
        ],
    )
    client = make_client(tmp_path, SQLiteBoardStore(tmp_path / "board.db"))

    missing = client.get("/api/auth-status")
    response = client.get("/api/auth-status", headers=auth_headers(client))

    assert missing.status_code == 401
    assert response.status_code == 200
    assert response.json() == [
        {
            "tool": "gh",
            "label": "GitHub CLI",
            "authed": True,
            "detail": "github.com account chopin",
            "login_hint": "gh auth login",
        },
        {
            "tool": "cf",
            "label": "Cloudflare",
            "authed": False,
            "detail": "token not found",
            "login_hint": "Set CLOUDFLARE_API_TOKEN or save base-voca/cloudflare-api-token",
        },
    ]


def test_projects_endpoint_lists_registry_sessions_with_tmux_status(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    write_registry(
        tmp_path,
        "dev10",
        {
            "lead": {"name": "lead", "agent": "codex", "tmux_pane": "dev10:1.0"},
            "worker": {"name": "worker", "agent": "claude", "tmux_pane": "dev10:1.1"},
        },
        workspace="/repo/dev10",
    )
    write_registry(
        tmp_path,
        "stopped",
        {"solo": {"name": "solo", "agent": "codex", "tmux_pane": "stopped:1.0"}},
        workspace="/repo/stopped",
    )
    calls: list[dict[str, object]] = []

    def fake_run(
        args: list[str],
        *,
        capture_output: bool,
        timeout: float,
        check: bool,
    ) -> subprocess.CompletedProcess[bytes]:
        calls.append(
            {
                "args": args,
                "capture_output": capture_output,
                "timeout": timeout,
                "check": check,
            }
        )
        returncode = 0 if args[-1] == "dev10" else 1
        return subprocess.CompletedProcess(args=args, returncode=returncode, stdout=b"", stderr=b"")

    monkeypatch.setattr("grove_bridge.web_app.subprocess.run", fake_run)
    store = SQLiteBoardStore(tmp_path / "board.db")
    client = make_client(tmp_path, store)

    response = client.get("/api/projects", headers=auth_headers(client))

    assert response.status_code == 200
    assert response.json() == [
        {
            "name": "dev10",
            "display_name": "grove-dev",
            "workspace": "/repo/dev10",
            "node_count": 2,
            "status": "running",
        },
        {
            "name": "stopped",
            "display_name": "stopped",
            "workspace": "/repo/stopped",
            "node_count": 1,
            "status": "stopped",
        },
    ]
    assert calls == [
        {
            "args": ["tmux", "has-session", "-t", "dev10"],
            "capture_output": True,
            "timeout": web_app.TMUX_TIMEOUT_SECONDS,
            "check": False,
        },
        {
            "args": ["tmux", "has-session", "-t", "stopped"],
            "capture_output": True,
            "timeout": web_app.TMUX_TIMEOUT_SECONDS,
            "check": False,
        },
    ]


def test_org_includes_master_and_cross_project_leads(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    write_registry(
        tmp_path,
        "dev10",
        {"lead": {"name": "lead", "agent": "claude", "tmux_pane": "dev10:0.0"}},
        workspace="/repo/dev10",
    )
    write_registry(
        tmp_path,
        "dev11",
        {"project-master": {"name": "project-master", "agent": "claude"}},
        workspace="/repo/dev11",
        display_name="Client Project /Users/chopin/secret xoxb-" + ("s" * 44),
    )

    def fake_run(
        args: list[str],
        *,
        capture_output: bool,
        timeout: float,
        check: bool,
    ) -> subprocess.CompletedProcess[bytes]:
        return subprocess.CompletedProcess(args=args, returncode=0, stdout=b"", stderr=b"")

    monkeypatch.setattr("grove_bridge.web_app.subprocess.run", fake_run)
    client = make_client(tmp_path, SQLiteBoardStore(tmp_path / "board.db"))

    response = client.get("/api/org", headers=auth_headers(client))
    scoped = client.get(
        "/api/org",
        headers=auth_headers(client) | {"X-Grove-Project": "dev11"},
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["master"] == {
        "id": "grove-master",
        "name": "GROVE MASTER",
        "label": "GROVE MASTER",
        "kind": "master",
        "role": "orchestrator",
        "root": True,
        "current_project": "dev10",
        "chat_target": {
            "endpoint": "/api/master/chat",
            "origin_surface": "floating_web_chat",
            "project": "dev10",
        },
    }
    assert payload["project"]["display_name"] == "grove-dev"
    leads = {lead["project"]: lead for lead in payload["project_leads"]}
    assert leads["dev10"]["display_name"] == "grove-dev"
    assert leads["dev10"]["current"] is True
    assert leads["dev10"]["switch_target"] == "dev10"
    assert leads["dev10"]["chat_target"]["endpoint"] == "/api/master/chat"
    assert leads["dev11"]["display_name"] == "Client Project [path] [redacted]"
    assert leads["dev11"]["current"] is False
    assert leads["dev11"]["switch_target"] == "dev11"
    assert scoped.status_code == 200
    scoped_leads = {lead["project"]: lead for lead in scoped.json()["project_leads"]}
    assert scoped.json()["project"]["display_name"] == "Client Project [path] [redacted]"
    assert scoped_leads["dev11"]["current"] is True
    assert scoped_leads["dev10"]["current"] is False
    rendered = json.dumps(response.json()) + json.dumps(scoped.json())
    assert "/Users/chopin" not in rendered
    assert "xoxb-" not in rendered


def test_create_project_invokes_new_project_with_literal_argv(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls: list[dict[str, object]] = []

    def fake_run(
        args: list[str],
        *,
        capture_output: bool,
        text: bool | None = None,
        timeout: float,
        check: bool,
    ) -> subprocess.CompletedProcess[str]:
        if args and args[0] == "tmux":
            return subprocess.CompletedProcess(args=args, returncode=0, stdout="", stderr="")
        calls.append(
            {
                "args": args,
                "capture_output": capture_output,
                "text": text,
                "timeout": timeout,
                "check": check,
            }
        )
        return subprocess.CompletedProcess(
            args=args,
            returncode=0,
            stdout=json.dumps(
                {
                    "name": "new-dev",
                    "dir": "/repo/new-dev",
                    "node_count": 0,
                }
            ),
            stderr="",
        )

    monkeypatch.setattr("grove_bridge.web_app.subprocess.run", fake_run)
    store = SQLiteBoardStore(tmp_path / "board.db")
    client = make_client(tmp_path, store)

    response = client.post(
        "/api/projects",
        headers=auth_headers(client),
        json={"name": "new-dev", "template": "python", "clone": "https://example.test/repo.git"},
    )

    assert response.status_code == 200
    assert response.json() == {
        "name": "new-dev",
        "display_name": "new-dev",
        "project": "new-dev",
        "session": "new-dev",
        "board": "new-dev",
        "dir": "/repo/new-dev",
        "workspace": "/repo/new-dev",
        "node_count": 1,
        "status": "running",
        "default_assignee": "project-master",
        "project_master": {
            "name": "project-master",
            "agent": "claude",
            "tmux_pane": "",
            "session_id": "",
            "status": "external",
            "role": "orchestrator",
            "parent": "lead",
            "group": "",
            "description": "Project master/orchestrator.",
            "kind": "meta",
            "exposed": False,
            "terminal_allowed": False,
            "input_allowed": False,
            "unavailable_reason": "meta node has no pane",
        },
    }
    registry = read_registry(tmp_path, "new-dev")
    assert registry["workspace"] == "/repo/new-dev"
    assert cast(dict[str, object], registry["nodes"])["project-master"] == {
        "name": "project-master",
        "agent": "claude",
        "role": "orchestrator",
        "status": "external",
        "parent": "lead",
        "description": "Project master/orchestrator.",
    }
    org = client.get(
        "/api/org",
        headers=auth_headers(client) | {"X-Grove-Project": "new-dev"},
    )
    assert org.status_code == 200
    assert org.json()["project"] == {
        "name": "new-dev",
        "board": "new-dev",
        "display_name": "new-dev",
    }
    assert org.json()["default_assignee"] == "project-master"
    assert [candidate["name"] for candidate in org.json()["assignee_candidates"]] == [
        "project-master",
        "lead",
    ]
    project_task = client.post(
        "/api/boards/main/tasks",
        headers=auth_headers(client) | {"X-Grove-Project": "new-dev"},
        json={"title": "Master task", "assignee": "project-master"},
    )
    assert project_task.status_code == 200
    assert project_task.json()["assignee"] == "project-master"
    assert calls == [
        {
            "args": [
                "grove",
                "new-project",
                "new-dev",
                "--template",
                "python",
                "--clone",
                "https://example.test/repo.git",
                "--json",
            ],
            "capture_output": True,
            "text": True,
            "timeout": web_app.GROVE_PROJECT_TIMEOUT_SECONDS,
            "check": False,
        }
    ]


@pytest.mark.parametrize(
    "stderr",
    [
        (
            "Traceback (most recent call last):\n"
            '  File "/Users/chopin/dev/grove/src/internal.py", line 1\n'
            "RuntimeError: private details"
        ),
        "failed opening /etc/grove/token.json",
        "failed reading /usr/local/bin/grove",
        "failed launching /Applications/Grove.app/Contents/MacOS/grove",
    ],
)
def test_create_project_sanitizes_internal_cli_errors(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    stderr: str,
) -> None:
    def fake_run(
        args: list[str],
        *,
        capture_output: bool,
        text: bool,
        timeout: float,
        check: bool,
    ) -> subprocess.CompletedProcess[str]:
        return subprocess.CompletedProcess(
            args=args,
            returncode=1,
            stdout="",
            stderr=stderr,
        )

    monkeypatch.setattr("grove_bridge.web_app.subprocess.run", fake_run)
    store = SQLiteBoardStore(tmp_path / "board.db")
    client = make_client(tmp_path, store)

    response = client.post(
        "/api/projects",
        headers=auth_headers(client),
        json={"name": "new-dev"},
    )

    assert response.status_code == 400
    assert response.json()["detail"] == "grove new-project failed"
    assert "/" not in response.json()["detail"]
    assert "Traceback" not in str(response.json())


def test_load_project_invokes_load_project_and_returns_integrity_result(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls: list[list[str]] = []
    integrity = {"restored": ["lead"], "stale": ["old"], "fresh": ["qa"], "ok": True}

    def fake_run(
        args: list[str],
        *,
        capture_output: bool,
        text: bool,
        timeout: float,
        check: bool,
    ) -> subprocess.CompletedProcess[str]:
        calls.append(args)
        assert capture_output is True
        assert text is True
        assert timeout == web_app.GROVE_PROJECT_TIMEOUT_SECONDS
        assert check is False
        return subprocess.CompletedProcess(
            args=args,
            returncode=0,
            stdout=json.dumps(integrity),
            stderr="",
        )

    monkeypatch.setattr("grove_bridge.web_app.subprocess.run", fake_run)
    store = SQLiteBoardStore(tmp_path / "board.db")
    client = make_client(tmp_path, store)

    response = client.post(
        "/api/projects/load",
        headers=auth_headers(client),
        json={"path": "/repo/dev10"},
    )

    assert response.status_code == 200
    assert response.json() == integrity
    assert calls == [["grove", "load-project", "/repo/dev10", "--json"]]


def test_load_project_rejects_flag_and_traversal_paths(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def fake_run(*args: object, **kwargs: object) -> subprocess.CompletedProcess[str]:
        raise AssertionError("load-project subprocess should not run for invalid paths")

    monkeypatch.setattr("grove_bridge.web_app.subprocess.run", fake_run)
    client = make_client(tmp_path, SQLiteBoardStore(tmp_path / "board.db"))
    headers = auth_headers(client)

    flag = client.post("/api/projects/load", headers=headers, json={"path": "--help"})
    traversal = client.post("/api/projects/load", headers=headers, json={"path": "../dev10"})

    assert flag.status_code == 400
    assert traversal.status_code == 400
    assert flag.json()["detail"] == "path must not start with '-'"
    assert traversal.json()["detail"] == "path traversal is not allowed"


def test_nodes_expose_all_registry_nodes_with_precise_availability(
    tmp_path: Path,
) -> None:
    write_registry(
        tmp_path,
        "dev10",
        {
            "alpha": {
                "name": "alpha",
                "agent": "codex",
                "tmux_pane": "dev10:1.2",
                "sessionId": "sess-a",
                "pending": {"task": "x"},
            },
            "beta": {"name": "beta", "agent": "claude"},
            "stale": {"name": "stale", "agent": "codex", "status": "stale"},
        },
    )
    client = make_client(tmp_path, SQLiteBoardStore(tmp_path / "board.db"))

    nodes_response = client.get("/api/nodes", headers=auth_headers(client))
    org_response = client.get("/api/org", headers=auth_headers(client))

    assert nodes_response.status_code == 200
    assert org_response.status_code == 200
    nodes = {node["name"]: node for node in nodes_response.json()}
    org_nodes = {node["name"]: node for node in org_response.json()["nodes"]}
    assert set(nodes) == set(org_nodes) == {"alpha", "beta", "lead", "stale"}
    assert nodes["alpha"]["tmux_pane"] == "dev10:1.2"
    assert nodes["alpha"]["session_id"] == "sess-a"
    assert nodes["alpha"]["status"] == "running"
    assert nodes["alpha"]["exposed"] is True
    assert nodes["alpha"]["terminal_allowed"] is True
    assert nodes["alpha"]["input_allowed"] is True
    assert nodes["alpha"]["unavailable_reason"] == ""
    assert nodes["beta"]["status"] == "dead"
    assert nodes["beta"]["exposed"] is False
    assert nodes["beta"]["unavailable_reason"] == "no live pane"
    assert nodes["stale"]["status"] == "stale"
    assert nodes["stale"]["exposed"] is False
    assert nodes["stale"]["unavailable_reason"] == "no live pane"
    assert nodes["lead"]["kind"] == "meta"
    assert nodes["lead"]["status"] == "external"
    assert nodes["lead"]["exposed"] is False
    assert nodes["lead"]["unavailable_reason"] == "meta node has no pane"


def test_nodes_reread_registry_on_each_request_and_include_meta(tmp_path: Path) -> None:
    write_registry(
        tmp_path,
        "dev10",
        {"alpha": {"name": "alpha", "agent": "codex", "tmux_pane": "dev10:1.2"}},
    )
    client = make_client(tmp_path, SQLiteBoardStore(tmp_path / "board.db"))

    first = client.get("/api/nodes", headers=auth_headers(client))
    (tmp_path / ".grove" / "dev10" / "registry.json").write_text(
        json.dumps(
            {
                "session": "dev10",
                "nodes": {
                    "alpha": {
                        "name": "alpha",
                        "agent": "codex",
                        "tmux_pane": "dev10:1.2",
                    },
                    "gamma": {
                        "name": "gamma",
                        "agent": "claude",
                        "tmux_pane": "dev10:1.3",
                    },
                },
            }
        ),
        encoding="utf-8",
    )
    second = client.get("/api/nodes", headers=auth_headers(client))
    org = client.get("/api/org", headers=auth_headers(client))

    assert first.status_code == 200
    assert second.status_code == 200
    assert org.status_code == 200
    assert {node["name"] for node in first.json()} == {"alpha", "lead"}
    assert {node["name"] for node in second.json()} == {"alpha", "gamma", "lead"}
    assert {node["name"] for node in second.json()} == {
        node["name"] for node in org.json()["nodes"]
    }
    lead = next(node for node in second.json() if node["name"] == "lead")
    assert lead["kind"] == "meta"
    assert lead["tmux_pane"] == ""
    assert lead["terminal_allowed"] is False
    assert lead["input_allowed"] is False
    assert lead["unavailable_reason"] == "meta node has no pane"


def test_org_returns_team_graph_from_registry(tmp_path: Path) -> None:
    write_registry(
        tmp_path,
        "dev10",
        {
            "lead": {
                "name": "lead",
                "agent": "codex",
                "role": "lead",
                "group": "core",
                "tmux_pane": "dev10:1.0",
                "sessionId": "sess-lead",
                "description": "Coordinates the project.",
            },
            "worker": {
                "name": "worker",
                "agent": "claude",
                "role": "builder",
                "parent": "lead",
                "group": "core",
                "tmux_pane": "dev10:1.1",
                "status": "running",
            },
            "qa": {
                "name": "qa",
                "agent": "antigravity",
                "role": "qa",
                "parent": "lead",
                "group": "verify",
                "tmux_pane": "dev10:2.0",
            },
            "hidden": {
                "name": "hidden",
                "agent": "codex",
                "role": "hidden",
            },
            "lead-pane": {
                "name": "lead-pane",
                "agent": "codex",
                "tmux_pane": "dev10:0.0",
            },
        },
    )
    client = make_client(tmp_path, SQLiteBoardStore(tmp_path / "board.db"))

    response = client.get("/api/org", headers=auth_headers(client))

    assert response.status_code == 200
    payload = response.json()
    nodes = {node["name"]: node for node in payload["nodes"]}
    assert payload["session"] == "dev10"
    assert payload["project"] == {
        "name": "dev10",
        "board": "dev10",
        "display_name": "grove-dev",
    }
    assert payload["roots"] == ["hidden", "lead", "lead-pane"]
    assert payload["groups"] == [
        {"name": "core", "parent": "lead", "nodes": ["lead", "worker"]},
        {"name": "verify", "parent": "lead", "nodes": ["qa"]},
    ]
    assert set(nodes) == {"hidden", "lead", "lead-pane", "qa", "worker"}
    assert nodes["lead"]["children"] == ["qa", "worker"]
    assert nodes["lead"]["exposed"] is True
    assert nodes["lead"]["unavailable_reason"] == ""
    assert nodes["hidden"]["exposed"] is False
    assert nodes["hidden"]["status"] == "dead"
    assert nodes["hidden"]["unavailable_reason"] == "no live pane"
    assert nodes["lead-pane"]["exposed"] is True
    assert nodes["lead-pane"]["status"] == "idle"
    assert nodes["lead-pane"]["terminal_allowed"] is True
    assert nodes["lead-pane"]["input_allowed"] is False
    assert nodes["lead-pane"]["unavailable_reason"] == ""
    assert nodes["qa"]["parent"] == "lead"
    assert nodes["worker"]["status"] == "running"
    assert payload["default_assignee"] == "lead"
    assert [candidate["name"] for candidate in payload["assignee_candidates"]] == [
        "lead",
        "hidden",
        "lead-pane",
        "qa",
        "worker",
    ]
    assert [candidate["name"] for candidate in payload["reviewer_candidates"]] == [
        "lead",
        "hidden",
        "lead-pane",
        "qa",
        "worker",
    ]


def test_org_distinguishes_current_delegation_snapshot_from_history(
    tmp_path: Path,
) -> None:
    store = SQLiteBoardStore(tmp_path / "board.db")
    open_task = store.create_task(
        board="dev10",
        title="Build active",
        body=None,
        assignee="worker",
        created_by="lead",
    )
    done_task = store.create_task(
        board="dev10",
        title="Build done",
        body=None,
        assignee="worker",
        status="done",
        created_by="lead",
    )
    review_task = store.create_task(
        board="dev10",
        title="Review active",
        body=None,
        assignee="maker",
        reviewer="reviewer",
        status="review",
        created_by="lead",
    )
    store.add_audit_event(
        board="dev10",
        kind="audit.task.assign",
        actor={"kind": "local", "id": "lead", "login": "lead", "role": "none"},
        action="assign",
        target={"type": "task", "id": open_task.id, "node": "worker"},
        task_id=open_task.id,
        payload={"to_node": "worker"},
        summary=open_task.title,
    )
    write_registry(
        tmp_path,
        "dev10",
        {
            "worker": {"name": "worker", "agent": "codex", "tmux_pane": "dev10:1.0"},
            "maker": {"name": "maker", "agent": "codex", "tmux_pane": "dev10:1.1"},
            "reviewer": {"name": "reviewer", "agent": "claude", "tmux_pane": "dev10:1.2"},
        },
    )
    client = make_client(tmp_path, store)

    response = client.get("/api/org", headers=auth_headers(client))

    assert response.status_code == 200
    delegations = response.json()["delegations"]
    current = {(edge["from"], edge["to"], edge["kind"]): edge for edge in delegations["current"]}
    assert current[("lead", "worker", "implementation")]["task_ids"] == [open_task.id]
    assert done_task.id not in current[("lead", "worker", "implementation")]["task_ids"]
    assert current[("lead", "maker", "implementation")]["task_ids"] == [review_task.id]
    assert current[("maker", "reviewer", "review_pool")]["task_ids"] == [review_task.id]
    assert delegations["mode_labels"] == {
        "current": "Current delegation: open tasks only",
        "history": "Delegation history: audit trail summary",
    }
    assert delegations["history"][0]["action"] == "assign"
    assert delegations["history"][0]["to"] == "worker"
    assert delegations["history"][0]["task_id"] == open_task.id
    assert "Delegation history" in delegations["history"][0]["label"]


def test_org_payload_includes_master_and_human_routing_support(
    tmp_path: Path,
) -> None:
    write_registry(
        tmp_path,
        "dev10",
        {
            "project-master": {
                "name": "project-master",
                "agent": "claude",
                "role": "orchestrator",
                "status": "external",
                "parent": "lead",
            },
            "worker": {
                "name": "worker",
                "agent": "codex",
                "role": "maker",
                "parent": "project-master",
                "tmux_pane": "dev10:1.1",
            },
            "human-reviewer": {
                "name": "human-reviewer",
                "agent": "human",
                "role": "reviewer",
                "parent": "project-master",
                "group": "human",
                "status": "external",
            },
        },
        workspace="/repo/dev10",
    )
    write_registry(
        tmp_path,
        "dev11",
        {
            "project-master": {
                "name": "project-master",
                "agent": "claude",
                "role": "orchestrator",
                "status": "external",
            }
        },
        workspace="/repo/dev11",
    )
    client = make_client(tmp_path, SQLiteBoardStore(tmp_path / "board.db"))

    response = client.get("/api/org", headers=auth_headers(client))

    assert response.status_code == 200
    payload = response.json()
    nodes = {node["name"]: node for node in payload["nodes"]}
    candidates = {candidate["name"]: candidate for candidate in payload["assignee_candidates"]}
    assert nodes["human-reviewer"]["kind"] == "human"
    assert nodes["human-reviewer"]["status"] == "external"
    assert candidates["human-reviewer"]["human"] is True
    assert candidates["human-reviewer"]["reviewer"] is True
    assert candidates["human-reviewer"]["inbox"]["endpoint"] == "/api/inbox"
    assert payload["master_org"] == {
        "name": "GROVE MASTER",
        "scope": "cross_project",
        "selected_project": "dev10",
        "visible_projects": ["dev10", "dev11"],
        "project_master": {
            "name": "project-master",
            "present": True,
            "default_assignee": True,
        },
        "delegation": {
            "default_assignee": "project-master",
            "create_task_endpoint": "/api/boards/{board_id}/tasks",
            "watch_endpoint": "/ws/board",
            "watch_ticket_endpoint": "/api/ws-ticket",
            "watch_ticket_kind": "board",
        },
        "human": {
            "assignee_candidates": ["human-reviewer"],
            "reviewers": ["human-reviewer"],
            "inbox_endpoint": "/api/inbox",
            "answer_endpoint": "/api/tasks/{task_id}/answer",
        },
    }


def test_org_adds_external_lead_for_grouped_workers(tmp_path: Path) -> None:
    write_registry(
        tmp_path,
        "dev10",
        {
            "dev": {
                "name": "dev",
                "agent": "codex",
                "role": "maker",
                "group": "grove-dev",
                "tmux_pane": "dev10:1.0",
            },
            "reviewer": {
                "name": "reviewer",
                "agent": "claude",
                "role": "reviewer",
                "group": "review",
                "tmux_pane": "dev10:1.1",
            },
        },
    )
    client = make_client(tmp_path, SQLiteBoardStore(tmp_path / "board.db"))

    response = client.get("/api/org", headers=auth_headers(client))

    assert response.status_code == 200
    payload = response.json()
    nodes = {node["name"]: node for node in payload["nodes"]}
    assert payload["roots"] == ["lead"]
    assert nodes["lead"]["agent"] == "claude"
    assert nodes["lead"]["role"] == "orchestrator"
    assert nodes["lead"]["status"] == "external"
    assert nodes["lead"]["children"] == ["dev", "reviewer"]
    assert nodes["dev"]["parent"] == "lead"
    assert nodes["reviewer"]["parent"] == "lead"
    assert payload["groups"] == [
        {"name": "grove-dev", "parent": "lead", "nodes": ["dev"]},
        {"name": "review", "parent": "lead", "nodes": ["reviewer"]},
    ]
    assert payload["default_assignee"] == "lead"
    assert [candidate["name"] for candidate in payload["assignee_candidates"]] == [
        "lead",
        "dev",
        "reviewer",
    ]


def test_node_send_default_off(tmp_path: Path) -> None:
    write_registry(
        tmp_path,
        "dev10",
        {"worker": {"name": "worker", "agent": "codex", "tmux_pane": "dev10:1.0"}},
    )
    client = make_client(tmp_path, SQLiteBoardStore(tmp_path / "board.db"))

    response = client.post(
        "/api/nodes/worker/send",
        headers=auth_headers(client),
        json={"text": "hello"},
    )

    assert response.status_code == 404
    assert response.json()["detail"] == "node input is not enabled"


def test_node_send_uses_literal_tmux_argv_audits_redacts_and_rate_limits(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    store = SQLiteBoardStore(tmp_path / "board.db")
    write_registry(
        tmp_path,
        "dev10",
        {"worker": {"name": "worker", "agent": "codex", "tmux_pane": "dev10:1.0"}},
    )
    client = make_client(tmp_path, store, node_input_enabled=True)
    calls: list[list[str]] = []

    def fake_run(
        args: list[str],
        *,
        capture_output: bool,
        text: bool,
        timeout: float,
        check: bool,
    ) -> subprocess.CompletedProcess[str]:
        assert capture_output is True
        assert text is True
        assert timeout == web_app.TMUX_TIMEOUT_SECONDS
        assert check is False
        calls.append(args)
        return subprocess.CompletedProcess(args=args, returncode=0, stdout="", stderr="")

    monkeypatch.setattr("grove_bridge.web_app.subprocess.run", fake_run)
    secret = "xoxb-" + ("s" * 44)
    text = f"please run {secret} /Users/chopin/private alice@example.com"

    response = client.post(
        "/api/nodes/worker/send",
        headers=auth_headers(client),
        json={"text": text},
    )
    limited = client.post(
        "/api/nodes/worker/send",
        headers=auth_headers(client),
        json={"text": "again"},
    )

    assert response.status_code == 200
    assert response.json() == {
        "ok": True,
        "project": "dev10",
        "node": "worker",
        "tmux_pane": "dev10:1.0",
    }
    assert limited.status_code == 429
    assert calls == [
        ["tmux", "send-keys", "-t", "dev10:1.0", "-l", "--", text],
        ["tmux", "send-keys", "-t", "dev10:1.0", "Enter"],
    ]
    audits = store.list_audit_events(board="dev10", action="node-send", node="worker")
    assert len(audits) == 1
    rendered = json.dumps(audits[0].payload)
    assert secret not in rendered
    assert "/Users/chopin" not in rendered
    assert "alice@example.com" not in rendered
    assert "[path]" in rendered
    assert "[pii]" in rendered


def test_node_send_rejects_viewer_and_other_project_pane(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    write_registry(
        tmp_path,
        "dev10",
        {"worker": {"name": "worker", "agent": "codex", "tmux_pane": "dev10:1.0"}},
    )
    write_registry(
        tmp_path,
        "dev11",
        {
            "worker": {"name": "worker", "agent": "codex", "tmux_pane": "dev10:1.0"},
            "other": {"name": "other", "agent": "codex", "tmux_pane": "dev11:1.0"},
        },
    )
    calls: list[list[str]] = []

    def fake_run(
        args: list[str],
        *,
        capture_output: bool,
        text: bool,
        timeout: float,
        check: bool,
    ) -> subprocess.CompletedProcess[str]:
        calls.append(args)
        return subprocess.CompletedProcess(args=args, returncode=0, stdout="", stderr="")

    monkeypatch.setattr("grove_bridge.web_app.subprocess.run", fake_run)
    write_team_member(tmp_path, secret="viewer-secret", role="viewer")
    viewer_client = make_client(
        tmp_path,
        SQLiteBoardStore(tmp_path / "board.db"),
        auth_mode=AuthMode.TEAM_COOKIE,
        node_input_enabled=True,
    )
    login = viewer_client.post("/api/login", json={"name": "alice", "secret": "viewer-secret"})
    csrf = str(login.json()["csrf"])
    viewer = viewer_client.post(
        "/api/nodes/worker/send",
        headers={CSRF_HEADER: csrf},
        json={"text": "hello"},
    )
    token_client = make_client(
        tmp_path,
        SQLiteBoardStore(tmp_path / "board.db"),
        node_input_enabled=True,
    )
    cross_project = token_client.post(
        "/api/nodes/worker/send",
        headers=auth_headers(token_client) | {"X-Grove-Project": "dev11"},
        json={"text": "hello"},
    )
    invalid = token_client.post(
        "/api/nodes/-bad/send",
        headers=auth_headers(token_client),
        json={"text": "hello"},
    )

    assert viewer.status_code == 403
    assert cross_project.status_code == 404
    assert invalid.status_code == 400
    assert calls == []


def test_node_connect_info_is_read_only_and_project_scoped(tmp_path: Path) -> None:
    store = SQLiteBoardStore(tmp_path / "board.db")
    write_registry(
        tmp_path,
        "dev10",
        {
            "lead": {"name": "lead", "agent": "claude", "tmux_pane": "dev10:0.0"},
            "worker": {"name": "worker", "agent": "codex", "tmux_pane": "dev10:2.0"},
        },
    )
    write_registry(
        tmp_path,
        "dev11",
        {"other": {"name": "other", "agent": "codex", "tmux_pane": "dev11:1.0"}},
    )
    client = make_client(tmp_path, store)
    before_events = store.list_events_after(cursor=0, limit=100)

    response = client.get("/api/nodes/worker/connect", headers=auth_headers(client))
    lead = client.get("/api/nodes/lead/connect", headers=auth_headers(client))
    scoped = client.get(
        "/api/nodes/worker/connect",
        headers=auth_headers(client) | {"X-Grove-Project": "dev11"},
    )

    assert response.status_code == 200
    assert response.json() == {
        "project": "dev10",
        "node": "worker",
        "tmux_target": "dev10:2.0",
        "commands": {
            "attach": "tmux attach -t dev10",
            "select_pane": "tmux select-pane -t dev10:2.0",
        },
    }
    assert lead.status_code == 404
    assert scoped.status_code == 404
    assert store.list_events_after(cursor=0, limit=100) == before_events


def test_node_autopickup_toggle_persists_and_audits(tmp_path: Path) -> None:
    db_path = tmp_path / "board.db"
    store = SQLiteBoardStore(db_path)
    write_registry(
        tmp_path,
        "dev10",
        {"worker": {"name": "worker", "agent": "codex", "tmux_pane": "dev10:1.0"}},
    )
    client = make_client(tmp_path, store)
    headers = auth_headers(client)

    missing_token = client.get("/api/nodes/worker/autopickup")
    initial = client.get("/api/nodes/worker/autopickup", headers=headers)
    enabled = client.post(
        "/api/nodes/worker/autopickup",
        headers=headers,
        json={"enabled": True},
    )
    persisted = SQLiteBoardStore(db_path).node_autopickup_state(board="dev10", node="worker")
    disabled = client.post(
        "/api/nodes/worker/autopickup",
        headers=headers,
        json={"enabled": False},
    )
    audits = store.list_audit_events(board="dev10", action="autopickup", node="worker")

    assert missing_token.status_code == 401
    assert initial.status_code == 200
    assert initial.json()["enabled"] is False
    assert initial.json()["configured"] is False
    assert enabled.status_code == 200
    assert enabled.json()["enabled"] is True
    assert persisted["enabled"] is True
    assert persisted["configured"] is True
    assert disabled.status_code == 200
    assert disabled.json()["enabled"] is False
    assert len(audits) == 2
    assert audits[0].kind == "audit.node.autopickup"
    assert audits[0].payload["target"] == {"type": "node", "id": "worker", "node": "worker"}
    assert audits[0].payload["enabled"] is True
    assert audits[1].payload["enabled"] is False


def test_node_autopickup_toggle_rejects_scope_invalid_and_global_off(
    tmp_path: Path,
) -> None:
    store = SQLiteBoardStore(tmp_path / "board.db")
    store.set_autopickup_global(board="dev10", enabled=False)
    write_registry(
        tmp_path,
        "dev10",
        {"worker": {"name": "worker", "agent": "codex", "tmux_pane": "dev10:1.0"}},
    )
    write_registry(
        tmp_path,
        "dev11",
        {"other": {"name": "other", "agent": "codex", "tmux_pane": "dev11:1.0"}},
    )
    client = make_client(tmp_path, store)
    headers = auth_headers(client)

    global_off = client.post(
        "/api/nodes/worker/autopickup",
        headers=headers,
        json={"enabled": True},
    )
    store.set_autopickup_global(board="dev10", enabled=True, kill_switch=True)
    kill_switched = client.post(
        "/api/nodes/worker/autopickup",
        headers=headers,
        json={"enabled": True},
    )
    disable_allowed = client.post(
        "/api/nodes/worker/autopickup",
        headers=headers,
        json={"enabled": False},
    )
    invalid = client.post(
        "/api/nodes/-bad/autopickup",
        headers=headers,
        json={"enabled": True},
    )
    wrong_project = client.post(
        "/api/nodes/worker/autopickup",
        headers=headers | {"X-Grove-Project": "dev11"},
        json={"enabled": False},
    )

    assert global_off.status_code == 409
    assert "global" in global_off.json()["detail"]
    assert kill_switched.status_code == 409
    assert "global" in kill_switched.json()["detail"]
    assert disable_allowed.status_code == 200
    assert invalid.status_code == 400
    assert wrong_project.status_code == 404
    assert store.node_autopickup_enabled(board="dev10", node="worker") is False


def test_node_autopickup_toggle_rejects_team_viewer(tmp_path: Path) -> None:
    write_registry(
        tmp_path,
        "dev10",
        {"worker": {"name": "worker", "agent": "codex", "tmux_pane": "dev10:1.0"}},
    )
    write_team_member(tmp_path, secret="viewer-secret", role="viewer")
    client = make_client(
        tmp_path,
        SQLiteBoardStore(tmp_path / "board.db"),
        auth_mode=AuthMode.TEAM_COOKIE,
    )
    login = client.post("/api/login", json={"name": "alice", "secret": "viewer-secret"})
    csrf = str(login.json()["csrf"])

    response = client.post(
        "/api/nodes/worker/autopickup",
        headers={CSRF_HEADER: csrf},
        json={"enabled": True},
    )

    assert login.status_code == 200
    assert response.status_code == 403


def test_execution_toggle_approval_status_and_abort_endpoints(tmp_path: Path) -> None:
    store = SQLiteBoardStore(tmp_path / "board.db")
    write_registry(
        tmp_path,
        "dev10",
        {"worker": {"name": "worker", "agent": "codex", "tmux_pane": "dev10:1.0"}},
    )
    task = store.create_task(board="dev10", title="Guarded", body=None, assignee="worker")
    claimed = store.claim_next(
        board="dev10",
        assignee="worker",
        node_id="worker",
        ttl_seconds=300,
        task_id=task.id,
    )
    assert claimed is not None
    store.begin_guarded_execution(
        board="dev10",
        task_id=task.id,
        run_id=claimed.run_id,
        node="worker",
    )
    client = make_client(tmp_path, store)
    headers = auth_headers(client)

    initial_gate = client.get("/api/execution", headers=headers)
    initial_node = client.get("/api/nodes/worker/execution", headers=headers)
    initial_task = client.get(f"/api/tasks/{task.id}/execution", headers=headers)
    blocked_approve = client.post(f"/api/tasks/{task.id}/approve", headers=headers)
    gate_enabled = client.post("/api/execution", headers=headers, json={"enabled": True})
    enabled = client.post(
        "/api/nodes/worker/execution",
        headers=headers,
        json={"enabled": True},
    )
    approved = client.post(f"/api/tasks/{task.id}/approve", headers=headers)
    status_after = client.get(f"/api/tasks/{task.id}/execution", headers=headers)
    aborted = client.post(
        f"/api/tasks/{task.id}/abort",
        headers=headers,
        json={"reason": "operator stop"},
    )
    audits = store.list_audit_events(board="dev10", task_id=task.id, limit=20)
    node_audits = store.list_audit_events(board="dev10", action="execution-toggle", node="worker")

    assert initial_gate.status_code == 200
    assert initial_gate.json()["enabled"] is False
    assert initial_node.status_code == 200
    assert initial_node.json()["enabled"] is False
    assert initial_task.status_code == 200
    assert initial_task.json()["state"] == "approval-pending"
    assert blocked_approve.status_code == 409
    assert gate_enabled.status_code == 200
    assert gate_enabled.json()["enabled"] is True
    assert enabled.status_code == 200
    assert enabled.json()["enabled"] is True
    assert approved.status_code == 200
    assert approved.json()["state"] == "approved"
    assert status_after.json()["gate"]["allowed"] is True
    assert aborted.status_code == 200
    assert aborted.json()["state"] == "abort"
    assert [event.payload["action"] for event in node_audits] == ["execution-toggle"]
    assert "approve" in [event.payload["action"] for event in audits]
    assert "abort" in [event.payload["action"] for event in audits]


def test_node_execution_toggle_rejects_global_gate_and_kill_switches(
    tmp_path: Path,
) -> None:
    store = SQLiteBoardStore(tmp_path / "board.db")
    write_registry(
        tmp_path,
        "dev10",
        {"worker": {"name": "worker", "agent": "codex", "tmux_pane": "dev10:1.0"}},
    )
    client = make_client(tmp_path, store)
    headers = auth_headers(client)

    global_off = client.post(
        "/api/nodes/worker/execution",
        headers=headers,
        json={"enabled": True},
    )
    store.set_execution_global(board="dev10", enabled=True, board_enabled=False)
    board_off = client.post(
        "/api/nodes/worker/execution",
        headers=headers,
        json={"enabled": True},
    )
    store.set_execution_global(
        board="dev10",
        enabled=True,
        kill_switch=True,
        board_enabled=True,
        board_kill_switch=False,
    )
    global_kill = client.post(
        "/api/nodes/worker/execution",
        headers=headers,
        json={"enabled": True},
    )
    store.set_execution_global(board="dev10", kill_switch=False, board_kill_switch=True)
    board_kill = client.post(
        "/api/nodes/worker/execution",
        headers=headers,
        json={"enabled": True},
    )
    store.set_execution_global(board="dev10", board_kill_switch=False)
    store.set_execution_kill_switch(board="dev10", level="node", node="worker", enabled=True)
    node_kill = client.post(
        "/api/nodes/worker/execution",
        headers=headers,
        json={"enabled": True},
    )
    store.set_node_execution_enabled(board="dev10", node="worker", enabled=True)
    disable_allowed = client.post(
        "/api/nodes/worker/execution",
        headers=headers,
        json={"enabled": False},
    )
    store.set_execution_kill_switch(board="dev10", level="node", node="worker", enabled=False)
    enabled = client.post(
        "/api/nodes/worker/execution",
        headers=headers,
        json={"enabled": True},
    )

    assert global_off.status_code == 409
    assert "execution" in global_off.json()["detail"]
    assert board_off.status_code == 409
    assert "execution" in board_off.json()["detail"]
    assert global_kill.status_code == 409
    assert "kill switch" in global_kill.json()["detail"]
    assert board_kill.status_code == 409
    assert "kill switch" in board_kill.json()["detail"]
    assert node_kill.status_code == 409
    assert "kill switch" in node_kill.json()["detail"]
    assert disable_allowed.status_code == 200
    assert disable_allowed.json()["enabled"] is False
    assert enabled.status_code == 200
    assert enabled.json()["enabled"] is True


def test_task_execution_payload_redacts_dispatch_lease_token(tmp_path: Path) -> None:
    store = SQLiteBoardStore(tmp_path / "board.db")
    write_registry(
        tmp_path,
        "dev10",
        {"worker": {"name": "worker", "agent": "codex", "tmux_pane": "dev10:1.0"}},
    )
    task = store.create_task(board="dev10", title="Guarded", body=None, assignee="worker")
    claimed = store.claim_next(
        board="dev10",
        assignee="worker",
        node_id="worker",
        ttl_seconds=300,
        task_id=task.id,
    )
    assert claimed is not None
    store.set_autopickup_global(board="dev10", enabled=True, kill_switch=False)
    store.set_node_autopickup_enabled(board="dev10", node="worker", enabled=True)
    store.set_execution_global(board="dev10", enabled=True)
    store.set_node_execution_enabled(board="dev10", node="worker", enabled=True)
    store.begin_guarded_execution(
        board="dev10",
        task_id=task.id,
        run_id=claimed.run_id,
        node="worker",
    )
    assert store.approve_execution(
        board="dev10",
        task_id=task.id,
        actor={"kind": "member", "id": "lead", "login": "lead", "role": "admin"},
    )
    token = store.issue_execution_dispatch_lease(
        board="dev10",
        task_id=task.id,
        run_id=claimed.run_id,
        node="worker",
    )
    assert token is not None
    assert token in str(store.task_execution_state(board="dev10", task_id=task.id))
    client = make_client(tmp_path, store)
    headers = auth_headers(client)

    response = client.get(f"/api/tasks/{task.id}/execution", headers=headers)
    payload = response.json()

    assert response.status_code == 200
    assert payload["state"] == "executing"
    assert payload["approved"] is True
    assert payload["execution"]["state"] == "executing"
    assert payload["execution"]["run_id"] == claimed.run_id
    assert "dispatch_lease" not in payload["execution"]
    assert token not in str(payload)


def test_execution_endpoints_reject_scope_viewer_and_invalid_node(tmp_path: Path) -> None:
    store = SQLiteBoardStore(tmp_path / "board.db")
    write_registry(
        tmp_path,
        "dev10",
        {"worker": {"name": "worker", "agent": "codex", "tmux_pane": "dev10:1.0"}},
    )
    write_registry(
        tmp_path,
        "dev11",
        {"other": {"name": "other", "agent": "codex", "tmux_pane": "dev11:1.0"}},
    )
    task = store.create_task(board="dev10", title="Scoped", body=None, assignee="worker")
    claimed = store.claim_next(
        board="dev10",
        assignee="worker",
        node_id="worker",
        ttl_seconds=300,
        task_id=task.id,
    )
    assert claimed is not None
    store.begin_guarded_execution(
        board="dev10",
        task_id=task.id,
        run_id=claimed.run_id,
        node="worker",
    )
    store.set_execution_global(board="dev10", enabled=True)
    store.set_node_execution_enabled(board="dev10", node="worker", enabled=True)
    client = make_client(tmp_path, store)
    headers = auth_headers(client)

    wrong_project_node = client.post(
        "/api/nodes/worker/execution",
        headers=headers | {"X-Grove-Project": "dev11"},
        json={"enabled": True},
    )
    wrong_project_task = client.post(
        f"/api/tasks/{task.id}/approve",
        headers=headers | {"X-Grove-Project": "dev11"},
    )
    invalid_node = client.post(
        "/api/nodes/-bad/execution",
        headers=headers,
        json={"enabled": True},
    )

    write_team_member(tmp_path, secret="viewer-secret", role="viewer")
    viewer = make_client(tmp_path, store, auth_mode=AuthMode.TEAM_COOKIE)
    login = viewer.post("/api/login", json={"name": "alice", "secret": "viewer-secret"})
    csrf = str(login.json()["csrf"])
    viewer_toggle = viewer.post(
        "/api/nodes/worker/execution",
        headers={CSRF_HEADER: csrf},
        json={"enabled": True},
    )
    viewer_gate = viewer.post(
        "/api/execution",
        headers={CSRF_HEADER: csrf},
        json={"enabled": True},
    )
    viewer_approve = viewer.post(f"/api/tasks/{task.id}/approve", headers={CSRF_HEADER: csrf})

    assert wrong_project_node.status_code == 404
    assert wrong_project_task.status_code == 404
    assert invalid_node.status_code == 400
    assert login.status_code == 200
    assert viewer_toggle.status_code == 403
    assert viewer_gate.status_code == 403
    assert viewer_approve.status_code == 403


def test_create_node_invokes_spawn_with_literal_argv(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls: list[dict[str, Any]] = []

    def fake_run(
        args: list[str],
        *,
        capture_output: bool,
        text: bool,
        timeout: float,
        check: bool,
    ) -> subprocess.CompletedProcess[str]:
        calls.append(
            {
                "args": args,
                "capture_output": capture_output,
                "text": text,
                "timeout": timeout,
                "check": check,
            }
        )
        return subprocess.CompletedProcess(
            args=args,
            returncode=0,
            stdout=json.dumps(
                {
                    "name": "worker-1",
                    "agent": "codex",
                    "description": "Builds API features.",
                }
            ),
            stderr="",
        )

    monkeypatch.setattr("grove_bridge.web_app.subprocess.run", fake_run)
    store = SQLiteBoardStore(tmp_path / "board.db")
    client = make_client(tmp_path, store)

    response = client.post(
        "/api/nodes",
        headers=auth_headers(client),
        json={
            "name": "worker-1",
            "agent": "codex",
            "role": "builder",
            "description": "Builds API features.",
            "parent": "lead_1",
            "group": "core",
            "window": 2,
        },
    )

    assert response.status_code == 200
    assert response.json() == {
        "name": "worker-1",
        "agent": "codex",
        "description": "Builds API features.",
    }
    assert calls == [
        {
            "args": [
                "grove",
                "spawn",
                "--name",
                "worker-1",
                "--agent",
                "codex",
                "--role",
                "builder",
                "--description",
                "Builds API features.",
                "--parent",
                "lead_1",
                "--group",
                "core",
                "--window",
                "2",
                "--session",
                "dev10",
                "--json",
            ],
            "capture_output": True,
            "text": True,
            "timeout": web_app.GROVE_SPAWN_TIMEOUT_SECONDS,
            "check": False,
        }
    ]
    audit_events = store.list_audit_events(board="dev10")
    assert audit_events[-1].kind == "audit.node.spawn"
    assert audit_events[-1].payload["actor"] == {
        "kind": "local",
        "id": "lead",
        "login": "lead",
        "role": "none",
    }
    assert audit_events[-1].payload["target"] == {
        "type": "node",
        "id": "worker-1",
        "node": "worker-1",
    }


@pytest.mark.parametrize(
    "stderr",
    [
        (
            "Traceback (most recent call last):\n"
            '  File "/Users/chopin/dev/grove/src/spawn.py", line 2\n'
            "RuntimeError: spawn failed"
        ),
        "failed opening /etc/grove/token.json",
        "failed reading /usr/local/bin/grove",
        "failed launching /Applications/Grove.app/Contents/MacOS/grove",
    ],
)
def test_create_node_sanitizes_spawn_failure_detail(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    stderr: str,
) -> None:
    def fake_run(
        args: list[str],
        *,
        capture_output: bool,
        text: bool,
        timeout: float,
        check: bool,
    ) -> subprocess.CompletedProcess[str]:
        return subprocess.CompletedProcess(args=args, returncode=1, stdout="", stderr=stderr)

    monkeypatch.setattr("grove_bridge.web_app.subprocess.run", fake_run)
    client = make_client(tmp_path, SQLiteBoardStore(tmp_path / "board.db"))

    response = client.post(
        "/api/nodes",
        headers=auth_headers(client),
        json={"name": "worker-1", "agent": "codex"},
    )

    assert response.status_code == 400
    assert response.json()["detail"] == "grove spawn failed"
    assert "/" not in response.json()["detail"]
    assert "Traceback" not in str(response.json())


def test_create_node_uses_project_header_session(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    write_registry(
        tmp_path,
        "dev11",
        {"worker": {"name": "worker", "agent": "codex", "tmux_pane": "dev11:1.0"}},
    )
    calls: list[list[str]] = []

    def fake_run(
        args: list[str],
        *,
        capture_output: bool,
        text: bool,
        timeout: float,
        check: bool,
    ) -> subprocess.CompletedProcess[str]:
        calls.append(args)
        return subprocess.CompletedProcess(
            args=args,
            returncode=0,
            stdout=json.dumps({"name": "new-worker", "agent": "codex"}),
            stderr="",
        )

    monkeypatch.setattr("grove_bridge.web_app.subprocess.run", fake_run)
    client = make_client(tmp_path, SQLiteBoardStore(tmp_path / "board.db"))

    response = client.post(
        "/api/nodes",
        headers=auth_headers(client) | {"X-Grove-Project": "dev11"},
        json={"name": "new-worker", "agent": "codex"},
    )

    assert response.status_code == 200
    assert calls == [
        [
            "grove",
            "spawn",
            "--name",
            "new-worker",
            "--agent",
            "codex",
            "--session",
            "dev11",
            "--json",
        ]
    ]


@pytest.mark.parametrize(
    "payload",
    [
        {"name": "bad;name", "agent": "codex"},
        {"name": "worker", "agent": "python"},
    ],
)
def test_create_node_rejects_invalid_input(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    payload: dict[str, str],
) -> None:
    monkeypatch.setattr(
        "grove_bridge.web_app.subprocess.run",
        lambda *args, **kwargs: pytest.fail("spawn should not run for invalid input"),
    )
    client = make_client(tmp_path, SQLiteBoardStore(tmp_path / "board.db"))

    response = client.post("/api/nodes", headers=auth_headers(client), json=payload)

    assert response.status_code == 400


def test_update_node_reparents_and_preserves_runtime_fields(tmp_path: Path) -> None:
    write_registry(
        tmp_path,
        "dev10",
        {
            "lead": {
                "name": "lead",
                "agent": "codex",
                "children": ["worker"],
                "tmux_pane": "dev10:1.0",
                "sessionId": "lead-session",
            },
            "worker": {
                "name": "worker",
                "agent": "claude",
                "parent": "lead",
                "children": [],
                "group": "core",
                "description": "Builds services.",
                "tmux_pane": "dev10:1.1",
                "sessionId": "worker-session",
                "transcript_path": "/tmp/transcript.log",
            },
            "qa": {
                "name": "qa",
                "agent": "antigravity",
                "children": [],
                "tmux_pane": "dev10:1.2",
            },
        },
    )
    client = make_client(tmp_path, SQLiteBoardStore(tmp_path / "board.db"))

    response = client.patch(
        "/api/nodes/worker",
        headers=auth_headers(client),
        json={"parent": "qa", "group": "verify", "description": "Verifies releases."},
    )

    assert response.status_code == 200
    assert response.json()["roots"] == ["lead", "qa"]
    worker_payload = next(node for node in response.json()["nodes"] if node["name"] == "worker")
    assert worker_payload["description"] == "Verifies releases."
    registry = read_registry(tmp_path, "dev10")
    nodes = cast(dict[str, dict[str, object]], registry["nodes"])
    assert nodes["lead"]["children"] == []
    assert nodes["qa"]["children"] == ["worker"]
    assert nodes["worker"]["parent"] == "qa"
    assert nodes["worker"]["group"] == "verify"
    assert nodes["worker"]["description"] == "Verifies releases."
    assert nodes["worker"]["tmux_pane"] == "dev10:1.1"
    assert nodes["worker"]["sessionId"] == "worker-session"
    assert nodes["worker"]["transcript_path"] == "/tmp/transcript.log"


def test_update_node_can_clear_parent_and_group(tmp_path: Path) -> None:
    write_registry(
        tmp_path,
        "dev10",
        {
            "lead": {
                "name": "lead",
                "agent": "codex",
                "children": ["worker"],
                "tmux_pane": "dev10:1.0",
            },
            "worker": {
                "name": "worker",
                "agent": "claude",
                "parent": "lead",
                "group": "core",
                "tmux_pane": "dev10:1.1",
            },
        },
    )
    client = make_client(tmp_path, SQLiteBoardStore(tmp_path / "board.db"))

    response = client.patch(
        "/api/nodes/worker",
        headers=auth_headers(client),
        json={"parent": None, "group": None},
    )

    assert response.status_code == 200
    registry = read_registry(tmp_path, "dev10")
    nodes = cast(dict[str, dict[str, object]], registry["nodes"])
    assert nodes["lead"]["children"] == []
    assert "parent" not in nodes["worker"]
    assert "group" not in nodes["worker"]


@pytest.mark.parametrize("parent", ["worker", "child"])
def test_update_node_rejects_cycles(tmp_path: Path, parent: str) -> None:
    write_registry(
        tmp_path,
        "dev10",
        {
            "lead": {
                "name": "lead",
                "agent": "codex",
                "children": ["worker"],
                "tmux_pane": "dev10:1.0",
            },
            "worker": {
                "name": "worker",
                "agent": "claude",
                "parent": "lead",
                "children": ["child"],
                "tmux_pane": "dev10:1.1",
            },
            "child": {
                "name": "child",
                "agent": "codex",
                "parent": "worker",
                "tmux_pane": "dev10:1.2",
            },
        },
    )
    client = make_client(tmp_path, SQLiteBoardStore(tmp_path / "board.db"))

    response = client.patch(
        "/api/nodes/worker",
        headers=auth_headers(client),
        json={"parent": parent},
    )

    assert response.status_code == 400


@pytest.mark.parametrize(
    ("path", "payload"),
    [
        ("/api/nodes/missing", {"parent": None}),
        ("/api/nodes/worker", {"parent": "missing"}),
    ],
)
def test_update_node_returns_404_for_missing_node_or_parent(
    tmp_path: Path,
    path: str,
    payload: dict[str, str | None],
) -> None:
    write_registry(
        tmp_path,
        "dev10",
        {
            "worker": {
                "name": "worker",
                "agent": "claude",
                "tmux_pane": "dev10:1.1",
            },
        },
    )
    client = make_client(tmp_path, SQLiteBoardStore(tmp_path / "board.db"))

    response = client.patch(path, headers=auth_headers(client), json=payload)

    assert response.status_code == 404


def test_slack_manifest_and_config_endpoints(tmp_path: Path) -> None:
    client = make_client(tmp_path, SQLiteBoardStore(tmp_path / "board.db"))
    headers = auth_headers(client)

    manifest = client.get("/api/slack/manifest", headers=headers)
    bad = client.post(
        "/api/slack/config",
        headers=headers,
        json={"app_token": "bad", "bot_token": "xoxb-good"},
    )
    saved = client.post(
        "/api/slack/config",
        headers=headers,
        json={
            "app_token": "xapp-123456",
            "bot_token": "xoxb-abcdef",
            "default_channel": "C123",
            "default_node": "grove-qa",
        },
    )
    test_response = client.post("/api/slack/test", headers=headers)
    status_response = client.get("/api/slack/config/status", headers=headers)

    assert manifest.status_code == 200
    manifest_json = manifest.json()
    assert manifest_json["settings"]["socket_mode_enabled"] is True
    bot_scopes = manifest_json["features"]["bot_user"]["oauth_scopes"]
    assert "chat:write" in bot_scopes
    assert "app_mentions:read" in bot_scopes
    assert "channels:history" in bot_scopes
    assert bad.status_code == 400
    assert saved.status_code == 200
    assert saved.json()["tokens"]["app_token"] == "xapp...3456"
    assert saved.json()["tokens"]["bot_token"] == "xoxb...cdef"
    assert test_response.json()["ok"] is True
    assert test_response.json()["status"] == "tokens_saved"
    assert status_response.json()["status"] == "tokens_saved"
    assert status_response.json()["intake"] == {"enabled": False}
    assert "state" not in status_response.json()
    assert status_response.json()["tokens"]["default_channel"] == "C123"

    enabled_client = make_client(
        tmp_path,
        SQLiteBoardStore(tmp_path / "enabled-board.db"),
        slack_intake_enabled=True,
    )
    enabled_status = enabled_client.get(
        "/api/slack/config/status",
        headers=auth_headers(enabled_client),
    )

    assert enabled_status.status_code == 200
    assert enabled_status.json()["intake"] == {"enabled": True}


def test_slack_threads_endpoint_lists_task_threads(tmp_path: Path) -> None:
    store = SQLiteBoardStore(tmp_path / "board.db")
    task = store.create_task(board="main", title="Blocked", body=None, assignee="grove-qa")
    store.upsert_slack_thread(
        board="main",
        task_id=task.id,
        team_id="T1",
        channel_id="C1",
        thread_ts="123.456",
        mode="human_gate",
        node="grove-qa",
    )
    client = make_client(tmp_path, store)

    response = client.get(
        f"/api/slack/threads?task_id={task.id}",
        headers=auth_headers(client),
    )

    assert response.status_code == 200
    assert response.json() == [
        {
            "task_id": task.id,
            "team_id": "T1",
            "channel_id": "C1",
            "thread_ts": "123.456",
            "mode": "human_gate",
            "node": "grove-qa",
        }
    ]


def test_ws_ticket_is_single_use_and_expires(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    now = 1000.0
    monkeypatch.setattr("grove_bridge.web_app.time.time", lambda: now)
    client = make_client(tmp_path, SQLiteBoardStore(tmp_path / "board.db"))
    ticket = ws_ticket(client)

    assert web_app._consume_ticket(ticket_store(client), ticket) is not None
    assert web_app._consume_ticket(ticket_store(client), ticket) is None

    expired = ws_ticket(client)
    now = 1031.0
    assert web_app._consume_ticket(ticket_store(client), expired) is None

    unused_expired = ws_ticket(client)
    now = 1062.0
    fresh = ws_ticket(client)
    tickets = ticket_store(client)._tickets
    assert unused_expired not in tickets
    assert fresh in tickets


def test_ws_ticket_binds_project_from_request_header(tmp_path: Path) -> None:
    write_registry(
        tmp_path,
        "dev11",
        {"worker": {"name": "worker", "agent": "codex", "tmux_pane": "dev11:2.0"}},
    )
    client = make_client(tmp_path, SQLiteBoardStore(tmp_path / "board.db"))

    response = client.post(
        "/api/ws-ticket",
        headers=auth_headers(client) | {"X-Grove-Project": "dev11"},
    )
    grant = web_app._consume_ticket(ticket_store(client), response.json()["ticket"])

    assert response.status_code == 200
    assert response.json()["project"] == "dev11"
    assert grant is not None
    assert grant.project.name == "dev11"
    assert grant.kind == "board"
    assert grant.pane_id is None


def test_ws_ticket_requires_team_operator(tmp_path: Path) -> None:
    write_team_member(tmp_path, name="viewer", secret="viewer-secret", role="viewer")
    write_team_member(
        tmp_path,
        name="operator",
        secret="operator-secret",
        role="operator",
        member_id="member-operator",
        append=True,
    )
    store = SQLiteBoardStore(tmp_path / "board.db")
    viewer = make_client(tmp_path, store, auth_mode=AuthMode.TEAM_COOKIE)
    operator = make_client(tmp_path, store, auth_mode=AuthMode.TEAM_COOKIE)
    viewer_login = viewer.post("/api/login", json={"name": "viewer", "secret": "viewer-secret"})
    operator_login = operator.post(
        "/api/login",
        json={"name": "operator", "secret": "operator-secret"},
    )

    viewer_response = viewer.post(
        "/api/ws-ticket",
        headers={CSRF_HEADER: str(viewer_login.json()["csrf"])},
        json={"kind": "board"},
    )
    operator_response = operator.post(
        "/api/ws-ticket",
        headers={CSRF_HEADER: str(operator_login.json()["csrf"])},
        json={"kind": "board"},
    )

    assert viewer_login.status_code == 200
    assert operator_login.status_code == 200
    assert viewer_response.status_code == 403
    assert operator_response.status_code == 200
    assert operator_response.json()["kind"] == "board"


def test_ws_ticket_uses_query_fallback_when_body_is_empty(tmp_path: Path) -> None:
    write_registry(
        tmp_path,
        "dev10",
        {"worker": {"name": "worker", "agent": "codex", "tmux_pane": "dev10:2.0"}},
    )
    client = make_client(tmp_path, SQLiteBoardStore(tmp_path / "board.db"))

    response = client.post(
        "/api/ws-ticket",
        headers=auth_headers(client),
        params={"kind": "terminal", "pane_id": "dev10:2.0"},
        json={},
    )
    grant = web_app._consume_ticket(ticket_store(client), response.json()["ticket"])

    assert response.status_code == 200
    assert grant is not None
    assert grant.kind == "terminal"
    assert grant.pane_id == "dev10:2.0"


def test_ws_ticket_rejects_kind_and_pane_mismatch(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    write_registry(
        tmp_path,
        "dev10",
        {
            "worker": {"name": "worker", "agent": "codex", "tmux_pane": "dev10:2.0"},
            "other": {"name": "other", "agent": "codex", "tmux_pane": "dev10:3.0"},
        },
    )
    store = SQLiteBoardStore(tmp_path / "board.db")
    store.create_task(board="dev10", title="Tail me", body=None, assignee="worker")
    client = make_client(tmp_path, store)
    monkeypatch.setattr(web_app, "_tmux_capture", lambda pane: b"selected")

    accepted_ticket = terminal_ticket(client, "dev10:2.0")
    with client.websocket_connect(f"/ws/terminal?ticket={accepted_ticket}&pane_id=dev10:2.0") as ws:
        assert ws.receive_json()["pane_id"] == "dev10:2.0"

    board_ticket = ws_ticket(client)
    with pytest.raises(WebSocketDisconnect) as exc:
        with client.websocket_connect(f"/ws/terminal?ticket={board_ticket}&pane_id=dev10:2.0"):
            pass
    assert exc.value.code == 1008

    terminal_ticket_value = terminal_ticket(client, "dev10:2.0")
    with pytest.raises(WebSocketDisconnect) as exc:
        with client.websocket_connect(
            f"/ws/terminal?ticket={terminal_ticket_value}&pane_id=dev10:3.0"
        ):
            pass
    assert exc.value.code == 1008

    terminal_board_ticket = terminal_ticket(client, "dev10:2.0")
    with pytest.raises(WebSocketDisconnect) as exc:
        with client.websocket_connect(f"/ws/board?ticket={terminal_board_ticket}"):
            pass
    assert exc.value.code == 1008


def test_terminal_allows_lead_pane_read_only_and_node_send_still_rejects(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    store = SQLiteBoardStore(tmp_path / "board.db")
    write_registry(
        tmp_path,
        "dev10",
        {
            "lead": {"name": "lead", "agent": "claude", "tmux_pane": "dev10:0.0"},
            "worker": {"name": "worker", "agent": "codex", "tmux_pane": "dev10:2.0"},
        },
    )
    client = make_client(tmp_path, store, node_input_enabled=True)
    captures: list[str] = []
    send_calls: list[str] = []

    def fake_capture(pane: str) -> bytes:
        captures.append(pane)
        return b"lead pane"

    monkeypatch.setattr(web_app, "_tmux_capture", fake_capture)
    monkeypatch.setattr(web_app, "_tmux_send_text", lambda pane, text: send_calls.append(pane))

    nodes_response = client.get("/api/nodes", headers=auth_headers(client))
    ticket_response = client.post(
        "/api/ws-ticket",
        headers=auth_headers(client),
        json={"kind": "terminal", "pane_id": "dev10:0.0"},
    )

    assert nodes_response.status_code == 200
    nodes = {node["name"]: node for node in nodes_response.json()}
    assert nodes["lead"]["exposed"] is True
    assert nodes["lead"]["terminal_allowed"] is True
    assert nodes["lead"]["input_allowed"] is False
    assert nodes["lead"]["unavailable_reason"] == ""
    assert ticket_response.status_code == 200

    with client.websocket_connect(
        f"/ws/terminal?ticket={ticket_response.json()['ticket']}&pane_id=dev10:0.0"
    ) as ws:
        frame = ws.receive_json()

    operator_send = client.post(
        "/api/nodes/lead/send",
        headers=auth_headers(client),
        json={"text": "do not inject"},
    )
    write_team_member(tmp_path, secret="viewer-secret", role="viewer")
    viewer_client = make_client(
        tmp_path,
        store,
        auth_mode=AuthMode.TEAM_COOKIE,
        node_input_enabled=True,
    )
    login = viewer_client.post("/api/login", json={"name": "alice", "secret": "viewer-secret"})
    viewer_send = viewer_client.post(
        "/api/nodes/lead/send",
        headers={CSRF_HEADER: str(login.json()["csrf"])},
        json={"text": "viewer cannot inject"},
    )

    assert frame["pane_id"] == "dev10:0.0"
    assert base64.b64decode(frame["bytes_base64"]) == b"lead pane"
    assert captures == ["dev10:0.0"]
    assert operator_send.status_code == 404
    assert viewer_send.status_code == 403
    assert send_calls == []
    assert web_app._pane_allowed("dev10:0.0", config=app_config(client))
    assert not web_app._pane_input_allowed("dev10:0.0", config=app_config(client))
    assert web_app._pane_input_allowed("dev10:2.0", config=app_config(client))


@pytest.mark.parametrize(
    "pane",
    ["dev10:00.00", "dev10:0.00", "dev10:00.0", "dev10:000.0"],
)
def test_terminal_rejects_lead_pane_aliases(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    pane: str,
) -> None:
    write_registry(
        tmp_path,
        "dev10",
        {
            "lead-alias": {"name": "lead-alias", "agent": "codex", "tmux_pane": pane},
            "worker": {"name": "worker", "agent": "codex", "tmux_pane": "dev10:2.0"},
        },
    )
    client = make_client(tmp_path, SQLiteBoardStore(tmp_path / "board.db"))
    monkeypatch.setattr(
        web_app,
        "_tmux_capture",
        lambda unsafe_pane: pytest.fail(f"capture should not run for {unsafe_pane}"),
    )
    response = client.post(
        "/api/ws-ticket",
        headers=auth_headers(client),
        json={"kind": "terminal", "pane_id": pane},
    )

    assert response.status_code == 400
    assert response.json()["detail"] == "pane not allowed"
    assert web_app._pane_allowed("dev10:2.0", config=app_config(client))
    assert not web_app._pane_allowed(pane, config=app_config(client))


@pytest.mark.parametrize(
    "pane",
    [
        "dev10:1.2; x",
        "dev10:1.2 -X",
        "../dev10:1.2",
        "dev10:1.2/../../0.0",
        "dev10:1.2 option",
        "dev10:beta",
        "other:1.2",
    ],
)
def test_terminal_rejects_injection_like_pane_values(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    pane: str,
) -> None:
    write_registry(
        tmp_path,
        "dev10",
        {"worker": {"name": "worker", "agent": "codex", "tmux_pane": "dev10:1.2"}},
    )
    client = make_client(tmp_path, SQLiteBoardStore(tmp_path / "board.db"))
    monkeypatch.setattr(
        web_app,
        "_tmux_capture",
        lambda unsafe_pane: pytest.fail(f"capture should not run for {unsafe_pane}"),
    )
    ticket = terminal_ticket(client, "dev10:1.2")

    with pytest.raises(WebSocketDisconnect) as exc:
        with client.websocket_connect(f"/ws/terminal?ticket={ticket}&pane_id={pane}"):
            pass

    assert exc.value.code == 1008


def test_terminal_streams_worker_pane_frame(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    write_registry(
        tmp_path,
        "dev10",
        {"worker": {"name": "worker", "agent": "codex", "tmux_pane": "dev10:2.0"}},
    )
    client = make_client(tmp_path, SQLiteBoardStore(tmp_path / "board.db"))
    monkeypatch.setattr(web_app, "POLL_INTERVAL_SECONDS", 0.01)
    captures: list[str] = []

    def fake_capture(pane: str) -> bytes:
        captures.append(pane)
        return b"pane text"

    monkeypatch.setattr(web_app, "_tmux_capture", fake_capture)
    ticket = terminal_ticket(client, "dev10:2.0")

    with client.websocket_connect(f"/ws/terminal?ticket={ticket}&pane_id=dev10:2.0") as ws:
        frame = ws.receive_json()

    assert frame["seq"] == 1
    assert frame["pane_id"] == "dev10:2.0"
    assert base64.b64decode(frame["bytes_base64"]) == b"pane text"
    assert captures == ["dev10:2.0"]


def test_terminal_uses_project_header_for_pane_allowlist(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    write_registry(
        tmp_path,
        "dev10",
        {"worker": {"name": "worker", "agent": "codex", "tmux_pane": "dev10:2.0"}},
    )
    write_registry(
        tmp_path,
        "dev11",
        {"worker": {"name": "worker", "agent": "codex", "tmux_pane": "dev11:2.0"}},
    )
    client = make_client(tmp_path, SQLiteBoardStore(tmp_path / "board.db"))
    monkeypatch.setattr(web_app, "_tmux_capture", lambda pane: b"selected")
    ticket = terminal_ticket(
        client,
        "dev11:2.0",
        headers={"X-Grove-Project": "dev11"},
    )

    with client.websocket_connect(f"/ws/terminal?ticket={ticket}&pane_id=dev11:2.0") as ws:
        frame = ws.receive_json()

    assert frame["pane_id"] == "dev11:2.0"

    rejected_ticket = terminal_ticket(
        client,
        "dev11:2.0",
        headers={"X-Grove-Project": "dev11"},
    )
    with pytest.raises(WebSocketDisconnect) as exc:
        with client.websocket_connect(f"/ws/terminal?ticket={rejected_ticket}&pane_id=dev10:2.0"):
            pass

    assert exc.value.code == 1008


def test_terminal_ignores_websocket_project_header_and_uses_ticket_project(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    write_registry(
        tmp_path,
        "dev10",
        {"worker": {"name": "worker", "agent": "codex", "tmux_pane": "dev10:2.0"}},
    )
    write_registry(
        tmp_path,
        "dev11",
        {"worker": {"name": "worker", "agent": "codex", "tmux_pane": "dev11:2.0"}},
    )
    client = make_client(tmp_path, SQLiteBoardStore(tmp_path / "board.db"))
    monkeypatch.setattr(web_app, "_tmux_capture", lambda pane: b"selected")
    ticket = terminal_ticket(client, "dev10:2.0")

    with pytest.raises(WebSocketDisconnect) as exc:
        with client.websocket_connect(
            f"/ws/terminal?ticket={ticket}&pane_id=dev11:2.0",
            headers={"X-Grove-Project": "dev11"},
        ):
            pass

    assert exc.value.code == 1008


def test_terminal_skips_unchanged_capture_frames(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    write_registry(
        tmp_path,
        "dev10",
        {"worker": {"name": "worker", "agent": "codex", "tmux_pane": "dev10:2.0"}},
    )
    client = make_client(tmp_path, SQLiteBoardStore(tmp_path / "board.db"))
    monkeypatch.setattr(web_app, "POLL_INTERVAL_SECONDS", 0.01)
    captures: list[str] = []
    payloads = [b"\x1b[32mfirst\x1b[0m", b"\x1b[32mfirst\x1b[0m", b"second"]

    def fake_capture(pane: str) -> bytes:
        captures.append(pane)
        return payloads[min(len(captures) - 1, len(payloads) - 1)]

    monkeypatch.setattr(web_app, "_tmux_capture", fake_capture)
    ticket = terminal_ticket(client, "dev10:2.0")

    with client.websocket_connect(f"/ws/terminal?ticket={ticket}&pane_id=dev10:2.0") as ws:
        first = ws.receive_json()
        second = ws.receive_json()

    assert first["seq"] == 1
    assert base64.b64decode(first["bytes_base64"]) == b"\x1b[32mfirst\x1b[0m"
    assert second["seq"] == 2
    assert base64.b64decode(second["bytes_base64"]) == b"second"
    assert captures == ["dev10:2.0", "dev10:2.0", "dev10:2.0"]


def test_terminal_reports_tmux_capture_timeout(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    write_registry(
        tmp_path,
        "dev10",
        {"worker": {"name": "worker", "agent": "codex", "tmux_pane": "dev10:2.0"}},
    )
    client = make_client(tmp_path, SQLiteBoardStore(tmp_path / "board.db"))

    def timeout_capture(pane: str) -> bytes:
        raise subprocess.TimeoutExpired(cmd=["tmux", "capture-pane", "-t", pane], timeout=5)

    monkeypatch.setattr(web_app, "_tmux_capture", timeout_capture)
    ticket = terminal_ticket(client, "dev10:2.0")

    with client.websocket_connect(f"/ws/terminal?ticket={ticket}&pane_id=dev10:2.0") as ws:
        frame = ws.receive_json()
        with pytest.raises(WebSocketDisconnect) as exc:
            ws.receive_json()

    assert frame == {
        "type": "error",
        "code": "tmux_capture_timeout",
        "pane_id": "dev10:2.0",
        "message": "tmux capture timed out",
        "ts": frame["ts"],
    }
    assert exc.value.code == 1011


def test_terminal_reports_tmux_capture_os_error(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    write_registry(
        tmp_path,
        "dev10",
        {"worker": {"name": "worker", "agent": "codex", "tmux_pane": "dev10:2.0"}},
    )
    client = make_client(tmp_path, SQLiteBoardStore(tmp_path / "board.db"))

    def failed_capture(_pane: str) -> bytes:
        raise OSError("tmux is unavailable")

    monkeypatch.setattr(web_app, "_tmux_capture", failed_capture)
    ticket = terminal_ticket(client, "dev10:2.0")

    with client.websocket_connect(f"/ws/terminal?ticket={ticket}&pane_id=dev10:2.0") as ws:
        frame = ws.receive_json()
        with pytest.raises(WebSocketDisconnect) as exc:
            ws.receive_json()

    assert frame == {
        "type": "error",
        "code": "tmux_capture_unavailable",
        "pane_id": "dev10:2.0",
        "message": "tmux capture unavailable",
        "ts": frame["ts"],
    }
    assert exc.value.code == 1011


def test_tmux_capture_uses_literal_argv_without_shell(monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[dict[str, Any]] = []

    def fake_run(
        args: list[str],
        *,
        capture_output: bool,
        timeout: float,
        check: bool,
    ) -> subprocess.CompletedProcess[bytes]:
        calls.append(
            {
                "args": args,
                "capture_output": capture_output,
                "timeout": timeout,
                "check": check,
            }
        )
        return subprocess.CompletedProcess(args=args, returncode=0, stdout=b"ok", stderr=b"")

    monkeypatch.setattr("grove_bridge.web_app.subprocess.run", fake_run)

    assert web_app._tmux_capture("dev10:2.0") == b"ok"
    assert calls == [
        {
            "args": ["tmux", "capture-pane", "-p", "-e", "-J", "-t", "dev10:2.0"],
            "capture_output": True,
            "timeout": web_app.TMUX_TIMEOUT_SECONDS,
            "check": False,
        }
    ]


def test_board_ws_tails_store_events(tmp_path: Path) -> None:
    store = SQLiteBoardStore(tmp_path / "board.db")
    client = make_client(tmp_path, store)
    store.create_task(board="dev10", title="Tail me", body=None, assignee="grove:codex")
    ticket = ws_ticket(client)

    with client.websocket_connect(f"/ws/board?ticket={ticket}") as ws:
        message = ws.receive_json()

    assert message["cursor"] >= 1
    assert message["type"] == "task.created"
    assert message["task_id"]


def test_board_ws_filters_events_by_ticket_project(tmp_path: Path) -> None:
    store = SQLiteBoardStore(tmp_path / "board.db")
    dev10 = store.create_task(board="dev10", title="Hidden", body=None, assignee="lead")
    dev11 = store.create_task(board="dev11", title="Visible", body=None, assignee="worker")
    write_registry(
        tmp_path,
        "dev11",
        {"worker": {"name": "worker", "agent": "codex", "tmux_pane": "dev11:2.0"}},
    )
    client = make_client(tmp_path, store)
    ticket = client.post(
        "/api/ws-ticket",
        headers=auth_headers(client) | {"X-Grove-Project": "dev11"},
    ).json()["ticket"]

    with client.websocket_connect(f"/ws/board?ticket={ticket}") as ws:
        message = ws.receive_json()

    assert message["task_id"] == dev11.id
    assert dev10.id not in str(message)


def test_board_ws_queries_events_with_project_scope_before_limit(tmp_path: Path) -> None:
    class RecordingStore(SQLiteBoardStore):
        def __init__(self, path: Path) -> None:
            super().__init__(path)
            self.seen_boards: list[str | None] = []

        def list_events_after(
            self,
            *,
            cursor: int = 0,
            limit: int = 100,
            board: str | None = None,
        ) -> list[BoardEvent]:
            self.seen_boards.append(board)
            return super().list_events_after(cursor=cursor, limit=limit, board=board)

    store = RecordingStore(tmp_path / "board.db")
    for index in range(125):
        store.create_task(board="dev10", title=f"Hidden {index}", body=None, assignee="lead")
    visible = store.create_task(board="dev11", title="Visible", body=None, assignee="worker")
    write_registry(
        tmp_path,
        "dev11",
        {"worker": {"name": "worker", "agent": "codex", "tmux_pane": "dev11:2.0"}},
    )
    client = make_client(tmp_path, store)
    ticket = client.post(
        "/api/ws-ticket",
        headers=auth_headers(client) | {"X-Grove-Project": "dev11"},
    ).json()["ticket"]

    with client.websocket_connect(f"/ws/board?ticket={ticket}") as ws:
        message = ws.receive_json()

    assert message["task_id"] == visible.id
    assert store.seen_boards[0] == "dev11"


def test_board_ws_rejects_missing_ticket(tmp_path: Path) -> None:
    client = make_client(tmp_path, SQLiteBoardStore(tmp_path / "board.db"))

    with pytest.raises(WebSocketDisconnect):
        with client.websocket_connect("/ws/board"):
            pass


def make_client(
    tmp_path: Path,
    store: SQLiteBoardStore,
    *,
    host: str = "127.0.0.1",
    port: int = 8765,
    unsafe_bind_token_bootstrap: bool = False,
    allowed_hosts: tuple[str, ...] = (),
    auth_mode: AuthMode = AuthMode.LOCAL_TOKEN,
    raise_server_exceptions: bool = True,
    summary_export_enabled: bool = False,
    summary_freshness_seconds: int = 300,
    summary_trusted_keys_path: Path | None = None,
    handoff_enabled: bool = False,
    handoff_ttl_seconds: int = 86_400,
    shared_access: bool = False,
    shared_join_role: team_auth.MemberRole = "operator",
    quota_enabled: bool = False,
    slack_intake_enabled: bool = False,
    retro_analytics_enabled: bool = False,
    usage_trend_enabled: bool = False,
    node_input_enabled: bool = False,
    assistant_client: AssistantLLMClient | None = None,
) -> TestClient:
    dist = tmp_path / "dist"
    dist.mkdir(exist_ok=True)
    (dist / "index.html").write_text(
        '<html><body><div id="app"></div><script src="/app.js"></script></body></html>',
        encoding="utf-8",
    )
    (dist / "app.js").write_text("window.loaded = true;", encoding="utf-8")
    config = WebAppConfig(
        dist_dir=dist,
        grove_home=tmp_path / ".grove",
        registry_session="dev10",
        board_db_path=tmp_path / "board.db",
        token="test-token",
        auth_required=True,
        host=host,
        port=port,
        unsafe_bind_token_bootstrap=unsafe_bind_token_bootstrap,
        allowed_hosts=allowed_hosts,
        auth_mode=auth_mode,
        summary_export_enabled=summary_export_enabled,
        summary_freshness_seconds=summary_freshness_seconds,
        summary_trusted_keys_path=summary_trusted_keys_path,
        handoff_enabled=handoff_enabled,
        handoff_ttl_seconds=handoff_ttl_seconds,
        shared_access=shared_access,
        shared_join_role=shared_join_role,
        quota_enabled=quota_enabled,
        slack_intake_enabled=slack_intake_enabled,
        retro_analytics_enabled=retro_analytics_enabled,
        usage_trend_enabled=usage_trend_enabled,
        node_input_enabled=node_input_enabled,
    )
    app = create_app(
        config=config,
        store=store,
        assistant_client=assistant_client or FakeAssistantLLMClient(),
    )
    return TestClient(
        app,
        base_url=f"http://{host}:{port}",
        raise_server_exceptions=raise_server_exceptions,
    )


def auth_headers(client: TestClient) -> dict[str, str]:
    return {"X-Grove-Session-Token": app_config(client).token}


def write_team_member(
    tmp_path: Path,
    *,
    name: str = "alice",
    secret: str = "opensesame",
    role: team_auth.MemberRole = "admin",
    member_id: str = "member-1",
    append: bool = False,
) -> TeamMember:
    member = TeamMember(
        id=member_id,
        name=name,
        role=role,
        secret_hash=hash_secret(secret, salt=b"0" * 16),
    )
    registry = MemberRegistry(members_path(tmp_path / ".grove", "dev10"))
    if append:
        members = registry.list_members()
        members.append(member)
        registry.save_members(members)
    else:
        registry.save_members([member])
    return member


def fastapi_app(client: TestClient) -> FastAPI:
    return cast(FastAPI, client.app)


def app_config(client: TestClient) -> WebAppConfig:
    return cast(WebAppConfig, fastapi_app(client).state.config)


def ticket_store(client: TestClient) -> web_app.TicketStore:
    return cast(web_app.TicketStore, fastapi_app(client).state.ticket_store)


def ws_ticket(
    client: TestClient,
    *,
    kind: str = "board",
    pane_id: str | None = None,
    headers: dict[str, str] | None = None,
) -> str:
    request_headers = auth_headers(client)
    if headers is not None:
        request_headers.update(headers)
    payload: dict[str, str] = {"kind": kind}
    if pane_id is not None:
        payload["pane_id"] = pane_id
    response = client.post("/api/ws-ticket", headers=request_headers, json=payload)
    assert response.status_code == 200
    return str(response.json()["ticket"])


def terminal_ticket(
    client: TestClient,
    pane_id: str,
    *,
    headers: dict[str, str] | None = None,
) -> str:
    return ws_ticket(client, kind="terminal", pane_id=pane_id, headers=headers)


def write_registry(
    tmp_path: Path,
    session: str,
    nodes: dict[str, dict[str, object]],
    *,
    workspace: str | None = None,
    display_name: str | None = None,
) -> None:
    registry = {
        "session": session,
        "nodes": nodes,
    }
    if workspace is not None:
        registry["workspace"] = workspace
    if display_name is not None:
        registry["display_name"] = display_name
    path = tmp_path / ".grove" / session / "registry.json"
    path.parent.mkdir(parents=True)
    path.write_text(json.dumps(registry), encoding="utf-8")


def complete_run_at(
    store: SQLiteBoardStore,
    db_path: Path,
    *,
    board: str,
    node: str,
    metadata: dict[str, object],
    started_at: int,
    created_by: str | None = None,
) -> None:
    task = store.create_task(
        board=board,
        title=f"{node} usage",
        body=None,
        assignee=node,
        created_by=created_by,
    )
    claim = store.claim_next(board=board, assignee=node, node_id=node, ttl_seconds=30)
    assert claim is not None
    assert store.complete(
        board=board,
        task_id=task.id,
        run_id=claim.run_id,
        claim_lock=claim.claim_lock,
        result="done",
        summary="done",
        metadata=metadata,
    )
    with sqlite3.connect(db_path) as conn:
        conn.execute(
            "UPDATE runs SET started_at = ?, ended_at = ? WHERE id = ?",
            (started_at, started_at + 60, claim.run_id),
        )


def read_registry(tmp_path: Path, session: str) -> dict[str, object]:
    path = tmp_path / ".grove" / session / "registry.json"
    loaded = json.loads(path.read_text(encoding="utf-8"))
    return cast(dict[str, object], loaded)
