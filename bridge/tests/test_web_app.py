from __future__ import annotations

import base64
import json
import logging
import os
import subprocess
from pathlib import Path
from typing import Any, cast

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

import grove_bridge.web_app as web_app
from grove_bridge.auth_status import ToolAuthStatus
from grove_bridge.store import SQLiteBoardStore
from grove_bridge.web_app import WebAppConfig, create_app


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

    assert missing.status_code == 401
    assert response.status_code == 200
    assert response.json()["nodes"] == {
        "total": 4,
        "running": 1,
        "stale": 1,
        "idle": 1,
        "error": 1,
    }


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
    client = make_client(tmp_path, SQLiteBoardStore(tmp_path / "board.db"))

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
    client = make_client(tmp_path, SQLiteBoardStore(tmp_path / "board.db"))

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
    client = make_client(tmp_path, SQLiteBoardStore(tmp_path / "board.db"))

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
    client = make_client(tmp_path, SQLiteBoardStore(tmp_path / "board.db"))

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
    client = make_client(tmp_path, SQLiteBoardStore(tmp_path / "board.db"))

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
    unsafe_bind_token_bootstrap: bool = False,
    allowed_hosts: tuple[str, ...] = (),
    raise_server_exceptions: bool = True,
) -> TestClient:
    dist = tmp_path / "dist"
    dist.mkdir()
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
        unsafe_bind_token_bootstrap=unsafe_bind_token_bootstrap,
        allowed_hosts=allowed_hosts,
    )
    return TestClient(
        create_app(config=config, store=store),
        base_url=f"http://{host}:8765",
        raise_server_exceptions=raise_server_exceptions,
    )


def auth_headers(client: TestClient) -> dict[str, str]:
    return {"X-Grove-Session-Token": app_config(client).token}


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


def read_registry(tmp_path: Path, session: str) -> dict[str, object]:
    path = tmp_path / ".grove" / session / "registry.json"
    loaded = json.loads(path.read_text(encoding="utf-8"))
    return cast(dict[str, object], loaded)
