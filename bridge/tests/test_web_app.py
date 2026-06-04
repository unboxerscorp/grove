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
from pathlib import Path
from typing import Any, cast

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

import grove_bridge.team_auth as team_auth
import grove_bridge.web_app as web_app
from grove_bridge.auth_status import ToolAuthStatus
from grove_bridge.store import SQLiteBoardStore
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
    csrf = str(login_payload["csrf"])

    me = client.get("/api/me")
    assert me.status_code == 200
    assert me.json()["member"]["name"] == "alice"
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
    assert joined_create.status_code == 200
    assert calls == [["grove", "new-project", "joined-project", "--json"]]
    audits = store.list_audit_events(board="dev10", action="create")
    assert len(audits) == 1
    assert audits[0].kind == "audit.project.create"
    audit_actor = cast(dict[str, object], audits[0].payload["actor"])
    assert audit_actor["login"] == "operator-bob"
    assert audit_actor["role"] == "operator"


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
        board="main",
        title="Ready task",
        body="Task body",
        assignee="grove:codex",
    )
    store.create_task(
        board="main",
        title="Blocked task",
        body=None,
        assignee="grove:codex",
        status="blocked",
    )
    store.add_comment(board="main", task_id=first.id, author="maker", body="hello")
    client = make_client(tmp_path, store)
    headers = auth_headers(client)

    assert client.get("/api/health").json()["ok"] is True
    assert client.get("/api/status").status_code == 401
    assert client.get("/api/status", headers=headers).json()["ok"] is True
    assert client.get("/api/boards").status_code == 401
    boards = client.get("/api/boards", headers=headers).json()
    assert boards == [{"id": "main", "name": "main", "task_count": 2}]
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
    assert [node["name"] for node in org.json()["nodes"]] == ["worker"]
    assert [node["name"] for node in nodes.json()] == ["worker"]
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
            "assignee": "grove:codex",
            "status": "blocked",
            "priority": 7,
        },
    )

    assert created.status_code == 200
    task = created.json()
    assert task["title"] == "New task"
    assert task["body"] == "Task details"
    assert task["assignee"] == "grove:codex"
    assert task["status"] == "blocked"
    assert store.get_task(board="main", task_id=task["id"]).priority == 7


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
    assert "999" not in rendered
    assert invalid.status_code == 400
    assert missing.status_code == 404


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
    rendered = json.dumps(payload)
    assert "999" not in rendered


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
        {"name": "dev10", "workspace": "/repo/dev10", "node_count": 2, "status": "running"},
        {"name": "stopped", "workspace": "/repo/stopped", "node_count": 1, "status": "stopped"},
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


def test_create_project_invokes_new_project_with_literal_argv(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls: list[dict[str, object]] = []

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
                    "name": "new-dev",
                    "workspace": "/repo/new-dev",
                    "node_count": 0,
                    "status": "stopped",
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
        "workspace": "/repo/new-dev",
        "node_count": 0,
        "status": "stopped",
    }
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


def test_nodes_parse_fake_registry_with_explicit_panes_only(tmp_path: Path) -> None:
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
            "lead": {"name": "lead", "agent": "lead", "tmux_pane": "dev10:0.0"},
        },
    )
    client = make_client(tmp_path, SQLiteBoardStore(tmp_path / "board.db"))

    response = client.get("/api/nodes", headers=auth_headers(client))

    assert response.status_code == 200
    assert response.json() == [
        {
            "name": "alpha",
            "agent": "codex",
            "tmux_pane": "dev10:1.2",
            "session_id": "sess-a",
            "status": "running",
            "description": "",
        }
    ]


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
    assert response.json() == {
        "session": "dev10",
        "roots": ["lead"],
        "groups": [
            {"name": "core", "nodes": ["lead", "worker"]},
            {"name": "verify", "nodes": ["qa"]},
        ],
        "nodes": [
            {
                "name": "lead",
                "agent": "codex",
                "role": "lead",
                "parent": "",
                "children": ["qa", "worker"],
                "group": "core",
                "tmux_pane": "dev10:1.0",
                "session_id": "sess-lead",
                "status": "idle",
                "description": "Coordinates the project.",
            },
            {
                "name": "qa",
                "agent": "antigravity",
                "role": "qa",
                "parent": "lead",
                "children": [],
                "group": "verify",
                "tmux_pane": "dev10:2.0",
                "session_id": "",
                "status": "idle",
                "description": "",
            },
            {
                "name": "worker",
                "agent": "claude",
                "role": "builder",
                "parent": "lead",
                "children": [],
                "group": "core",
                "tmux_pane": "dev10:1.1",
                "session_id": "",
                "status": "running",
                "description": "",
            },
        ],
    }


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
    assert "state" not in status_response.json()
    assert status_response.json()["tokens"]["default_channel"] == "C123"


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


@pytest.mark.parametrize(
    "pane",
    ["dev10:0.0", "dev10:00.00", "dev10:0.00", "dev10:00.0", "dev10:000.0"],
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
    ticket = terminal_ticket(client, "dev10:2.0")

    with pytest.raises(WebSocketDisconnect) as exc:
        with client.websocket_connect(f"/ws/terminal?ticket={ticket}&pane_id={pane}"):
            pass

    assert exc.value.code == 1008
    assert web_app._pane_allowed("dev10:2.0", config=app_config(client))


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
    )
    return TestClient(
        create_app(config=config, store=store),
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
) -> None:
    registry = {
        "session": session,
        "nodes": nodes,
    }
    if workspace is not None:
        registry["workspace"] = workspace
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
) -> None:
    task = store.create_task(board=board, title=f"{node} usage", body=None, assignee=node)
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
