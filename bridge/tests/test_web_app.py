from __future__ import annotations

import base64
import json
import subprocess
from pathlib import Path
from typing import Any, cast

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

import grove_bridge.web_app as web_app
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

    assert client.get("/api/status").json()["ok"] is True
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


def test_rest_rejects_empty_task_title(tmp_path: Path) -> None:
    client = make_client(tmp_path, SQLiteBoardStore(tmp_path / "board.db"))

    created = client.post(
        "/api/boards/main/tasks",
        headers=auth_headers(client),
        json={"title": "   "},
    )

    assert created.status_code == 400


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
            stdout=json.dumps({"name": "worker-1", "agent": "codex"}),
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
            "parent": "lead_1",
            "group": "core",
            "window": 2,
        },
    )

    assert response.status_code == 200
    assert response.json() == {"name": "worker-1", "agent": "codex"}
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
        json={"parent": "qa", "group": "verify"},
    )

    assert response.status_code == 200
    assert response.json()["roots"] == ["lead", "qa"]
    registry = read_registry(tmp_path, "dev10")
    nodes = cast(dict[str, dict[str, object]], registry["nodes"])
    assert nodes["lead"]["children"] == []
    assert nodes["qa"]["children"] == ["worker"]
    assert nodes["worker"]["parent"] == "qa"
    assert nodes["worker"]["group"] == "verify"
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


def test_ws_ticket_is_single_use_and_expires(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    now = 1000.0
    monkeypatch.setattr("grove_bridge.web_app.time.time", lambda: now)
    client = make_client(tmp_path, SQLiteBoardStore(tmp_path / "board.db"))
    ticket = client.post("/api/ws-ticket", headers=auth_headers(client)).json()["ticket"]

    assert web_app._consume_ticket(ticket_store(client), ticket)
    assert not web_app._consume_ticket(ticket_store(client), ticket)

    expired = client.post("/api/ws-ticket", headers=auth_headers(client)).json()["ticket"]
    now = 1031.0
    assert not web_app._consume_ticket(ticket_store(client), expired)


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
    ticket = ws_ticket(client)

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
    ticket = ws_ticket(client)

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
    ticket = ws_ticket(client)

    with client.websocket_connect(f"/ws/terminal?ticket={ticket}&pane_id=dev10:2.0") as ws:
        frame = ws.receive_json()

    assert frame["seq"] == 1
    assert frame["pane_id"] == "dev10:2.0"
    assert base64.b64decode(frame["bytes_base64"]) == b"pane text"
    assert captures == ["dev10:2.0"]


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
    ticket = ws_ticket(client)

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
    store.create_task(board="main", title="Tail me", body=None, assignee="grove:codex")
    ticket = ws_ticket(client)

    with client.websocket_connect(f"/ws/board?ticket={ticket}") as ws:
        message = ws.receive_json()

    assert message["cursor"] >= 1
    assert message["type"] == "task.created"
    assert message["task_id"]


def make_client(tmp_path: Path, store: SQLiteBoardStore) -> TestClient:
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
    )
    return TestClient(create_app(config=config, store=store))


def auth_headers(client: TestClient) -> dict[str, str]:
    return {"X-Grove-Session-Token": app_config(client).token}


def fastapi_app(client: TestClient) -> FastAPI:
    return cast(FastAPI, client.app)


def app_config(client: TestClient) -> WebAppConfig:
    return cast(WebAppConfig, fastapi_app(client).state.config)


def ticket_store(client: TestClient) -> web_app.TicketStore:
    return cast(web_app.TicketStore, fastapi_app(client).state.ticket_store)


def ws_ticket(client: TestClient) -> str:
    return str(client.post("/api/ws-ticket", headers=auth_headers(client)).json()["ticket"])


def write_registry(tmp_path: Path, session: str, nodes: dict[str, dict[str, object]]) -> None:
    registry = {
        "session": session,
        "nodes": nodes,
    }
    path = tmp_path / ".grove" / session / "registry.json"
    path.parent.mkdir(parents=True)
    path.write_text(json.dumps(registry), encoding="utf-8")


def read_registry(tmp_path: Path, session: str) -> dict[str, object]:
    path = tmp_path / ".grove" / session / "registry.json"
    loaded = json.loads(path.read_text(encoding="utf-8"))
    return cast(dict[str, object], loaded)
