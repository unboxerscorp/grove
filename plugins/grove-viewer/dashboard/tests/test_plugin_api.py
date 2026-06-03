from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from pytest import MonkeyPatch
from starlette.websockets import WebSocketDisconnect

import plugin_api


@dataclass(frozen=True)
class FakeTask:
    id: str
    title: str
    status: str
    created_at: int
    started_at: int | None = None


class FakeConn:
    def __init__(self, board: str | None) -> None:
        self.board = board
        self.closed = False

    def close(self) -> None:
        self.closed = True


@dataclass(frozen=True)
class FakeCompletedProcess:
    returncode: int
    stdout: str = ""
    stderr: str = ""


class FakeKanbanDb:
    DEFAULT_BOARD = "default"
    VALID_STATUSES = {
        "triage",
        "todo",
        "scheduled",
        "ready",
        "running",
        "blocked",
        "review",
        "done",
        "archived",
    }

    def __init__(self, tasks: list[FakeTask]) -> None:
        self.tasks = tasks
        self.init_boards: list[str | None] = []
        self.connected_boards: list[str | None] = []
        self.list_calls: list[tuple[bool, int | None, str | None]] = []

    def init_db(self, *, board: str | None = None) -> None:
        self.init_boards.append(board)

    def connect(self, *, board: str | None = None) -> FakeConn:
        self.connected_boards.append(board)
        return FakeConn(board)

    def list_tasks(
        self,
        conn: FakeConn,
        *,
        include_archived: bool = False,
        limit: int | None = None,
        order_by: str | None = None,
    ) -> list[FakeTask]:
        self.list_calls.append((include_archived, limit, order_by))
        tasks = [task for task in self.tasks if include_archived or task.status != "archived"]
        if order_by == "updated":
            tasks = sorted(tasks, key=lambda task: task.started_at or task.created_at, reverse=True)
        return tasks[:limit] if limit is not None else tasks


@pytest.fixture(autouse=True)
def clear_plugin_env(monkeypatch: MonkeyPatch) -> None:
    monkeypatch.delenv("GROVE_HOME", raising=False)
    monkeypatch.delenv("GROVE_VIEWER_SESSION", raising=False)
    monkeypatch.delenv("GROVE_VIEWER_BOARD", raising=False)


def test_nodes_parse_fake_registry(tmp_path: Path, monkeypatch: MonkeyPatch) -> None:
    write_registry(
        tmp_path,
        session="dev10",
        nodes={
            "alpha": {
                "name": "alpha",
                "agent": "codex",
                "sessionId": "sess-alpha",
                "tmux_pane": "dev10:0.1",
                "pending": {"submittedAt": "now"},
            },
            "beta": {
                "name": "beta",
                "agent": "claude",
                "sessionId": "sess-beta",
                "transcript": "/tmp/beta.jsonl",
                "tmux_pane": "dev10:2.0",
            },
        },
    )
    monkeypatch.setenv("GROVE_HOME", str(tmp_path / ".grove"))
    monkeypatch.setenv("GROVE_VIEWER_SESSION", "dev10")

    response = make_client().get("/api/plugins/grove-viewer/nodes")

    assert response.status_code == 200
    assert response.json() == [
        {
            "name": "alpha",
            "agent": "codex",
            "tmux_pane": "dev10:0.1",
            "session_id": "sess-alpha",
            "status": "running",
        },
        {
            "name": "beta",
            "agent": "claude",
            "tmux_pane": "dev10:2.0",
            "session_id": "sess-beta",
            "status": "idle",
        },
    ]


def test_registry_nodes_without_explicit_panes_cannot_expose_lead_or_pane_targets(
    tmp_path: Path,
    monkeypatch: MonkeyPatch,
) -> None:
    write_registry(
        tmp_path,
        session="dev10",
        nodes={
            "0.0": {"name": "0.0", "agent": "codex"},
            "foo.1": {"name": "foo.1", "agent": "codex"},
            "safe-worker": {"name": "safe-worker", "agent": "codex"},
            "explicit-worker": {
                "name": "explicit-worker",
                "agent": "codex",
                "tmux_pane": "dev10:1.2",
            },
            "explicit-pane-zero-worker": {
                "name": "explicit-pane-zero-worker",
                "agent": "codex",
                "tmux_pane": "dev10:2.0",
            },
            "explicit-lead": {
                "name": "explicit-lead",
                "agent": "codex",
                "tmux_pane": "dev10:0.0",
            },
        },
    )
    monkeypatch.setenv("GROVE_HOME", str(tmp_path / ".grove"))

    response = make_client().get("/api/plugins/grove-viewer/nodes")

    assert response.status_code == 200
    assert response.json() == [
        {
            "name": "explicit-pane-zero-worker",
            "agent": "codex",
            "tmux_pane": "dev10:2.0",
            "session_id": "",
            "status": "idle",
        },
        {
            "name": "explicit-worker",
            "agent": "codex",
            "tmux_pane": "dev10:1.2",
            "session_id": "",
            "status": "idle",
        },
    ]
    assert plugin_api._allowed_panes() == {"dev10:1.2", "dev10:2.0"}
    assert not plugin_api._pane_allowed("dev10:0.0")
    assert not plugin_api._pane_allowed("dev10:foo.1")
    assert plugin_api._pane_allowed("dev10:1.2")
    assert plugin_api._pane_allowed("dev10:2.0")


@pytest.mark.parametrize("alias", ["dev10:00.00", "dev10:0.00", "dev10:00.0", "dev10:000.0"])
def test_lead_numeric_aliases_are_not_exposed(
    tmp_path: Path,
    monkeypatch: MonkeyPatch,
    alias: str,
) -> None:
    write_registry(
        tmp_path,
        session="dev10",
        nodes={
            "lead-alias": {
                "name": "lead-alias",
                "agent": "codex",
                "tmux_pane": alias,
            },
            "worker": {
                "name": "worker",
                "agent": "codex",
                "tmux_pane": "dev10:2.0",
            },
        },
    )
    monkeypatch.setenv("GROVE_HOME", str(tmp_path / ".grove"))

    response = make_client().get("/api/plugins/grove-viewer/nodes")

    assert response.status_code == 200
    assert response.json() == [
        {
            "name": "worker",
            "agent": "codex",
            "tmux_pane": "dev10:2.0",
            "session_id": "",
            "status": "idle",
        }
    ]
    assert plugin_api._valid_tmux_pane(alias)
    assert not plugin_api._valid_exposed_tmux_pane(alias)
    assert not plugin_api._pane_allowed(alias)
    assert plugin_api._pane_allowed("dev10:2.0")


def test_board_summary_uses_fake_kanban_db(monkeypatch: MonkeyPatch) -> None:
    fake = FakeKanbanDb(
        [
            FakeTask(id="t_ready", title="Ready task", status="ready", created_at=10),
            FakeTask(id="t_blocked", title="Blocked task", status="blocked", created_at=20),
            FakeTask(id="t_done", title="Done task", status="done", created_at=30),
            FakeTask(id="t_archived", title="Archived task", status="archived", created_at=40),
        ]
    )
    monkeypatch.setenv("GROVE_VIEWER_BOARD", "grove")
    monkeypatch.setattr(plugin_api, "_kanban_db_module", lambda: fake)

    response = make_client().get("/api/plugins/grove-viewer/board-summary")

    assert response.status_code == 200
    payload = response.json()
    assert payload["board"] == "grove"
    assert payload["url"] == "/kanban?board=grove"
    assert fake.init_boards == ["grove"]
    assert fake.connected_boards == ["grove"]
    assert fake.list_calls == [(False, None, None), (False, 6, "updated")]
    counts = {column["key"]: column["count"] for column in payload["columns"]}
    assert counts["ready"] == 1
    assert counts["blocked"] == 1
    assert counts["done"] == 1
    assert "t_archived" not in [task["id"] for task in payload["recent"]]


def test_term_streams_fake_tmux_frames(
    tmp_path: Path,
    monkeypatch: MonkeyPatch,
) -> None:
    write_registry(
        tmp_path,
        session="dev10",
        nodes={"alpha": {"name": "alpha", "agent": "codex", "tmux_pane": "dev10:1.2"}},
    )
    monkeypatch.setenv("GROVE_HOME", str(tmp_path / ".grove"))
    monkeypatch.setattr(plugin_api, "POLL_INTERVAL_SECONDS", 0.01)
    monkeypatch.setattr(plugin_api, "_ws_auth_ok", allow_ws)
    captures: list[str] = []

    def fake_capture(pane: str) -> str:
        captures.append(pane)
        return f"frame {len(captures)}"

    monkeypatch.setattr(plugin_api, "_tmux_capture", fake_capture)

    with make_client().websocket_connect(
        "/api/plugins/grove-viewer/term?pane=dev10:1.2&ticket=ok"
    ) as ws:
        assert ws.receive_text() == "frame 1"
        assert ws.receive_text() == "frame 2"

    assert captures[:2] == ["dev10:1.2", "dev10:1.2"]


@pytest.mark.parametrize(
    "pane",
    [
        "dev10:1.2; x",
        "dev10:1.2 -X",
        "dev10:1.2 -t dev10:0.0",
        "../dev10:1.2",
        "dev10:1.2/../../0.0",
        "dev10:1.2 option",
        "dev10:beta",
        "other:1.2",
    ],
)
def test_term_rejects_injection_like_pane_values(
    tmp_path: Path,
    monkeypatch: MonkeyPatch,
    pane: str,
) -> None:
    write_registry(
        tmp_path,
        session="dev10",
        nodes={"alpha": {"name": "alpha", "agent": "codex", "tmux_pane": "dev10:1.2"}},
    )
    monkeypatch.setenv("GROVE_HOME", str(tmp_path / ".grove"))
    monkeypatch.setattr(plugin_api, "_ws_auth_ok", allow_ws)
    monkeypatch.setattr(
        plugin_api,
        "_tmux_capture",
        lambda unsafe_pane: pytest.fail(f"capture should not run for {unsafe_pane}"),
    )

    with pytest.raises(WebSocketDisconnect) as exc:
        with make_client().websocket_connect(
            f"/api/plugins/grove-viewer/term?pane={pane}&ticket=ok"
        ):
            pass

    assert exc.value.code == 1008


def test_term_rejects_invalid_ticket(tmp_path: Path, monkeypatch: MonkeyPatch) -> None:
    write_registry(
        tmp_path,
        session="dev10",
        nodes={"alpha": {"name": "alpha", "agent": "codex", "tmux_pane": "dev10:1.2"}},
    )
    monkeypatch.setenv("GROVE_HOME", str(tmp_path / ".grove"))
    monkeypatch.setattr(plugin_api, "_ws_auth_ok", deny_ws)

    with pytest.raises(WebSocketDisconnect) as exc:
        with make_client().websocket_connect(
            "/api/plugins/grove-viewer/term?pane=dev10:1.2&ticket=bad"
        ):
            pass

    assert exc.value.code == 4401


def test_term_rejects_pane_outside_allowlist(
    tmp_path: Path,
    monkeypatch: MonkeyPatch,
) -> None:
    write_registry(
        tmp_path,
        session="dev10",
        nodes={"alpha": {"name": "alpha", "agent": "codex", "tmux_pane": "dev10:1.2"}},
    )
    monkeypatch.setenv("GROVE_HOME", str(tmp_path / ".grove"))
    monkeypatch.setattr(plugin_api, "_ws_auth_ok", allow_ws)

    with pytest.raises(WebSocketDisconnect) as exc:
        with make_client().websocket_connect(
            "/api/plugins/grove-viewer/term?pane=dev10:0.99&ticket=ok"
        ):
            pass

    assert exc.value.code == 1008


def test_send_allows_only_registry_panes(tmp_path: Path, monkeypatch: MonkeyPatch) -> None:
    write_registry(
        tmp_path,
        session="dev10",
        nodes={"alpha": {"name": "alpha", "agent": "codex", "tmux_pane": "dev10:2.0"}},
    )
    monkeypatch.setenv("GROVE_HOME", str(tmp_path / ".grove"))
    sends: list[tuple[str, str]] = []

    def fake_send(pane: str, data: str) -> None:
        sends.append((pane, data))

    monkeypatch.setattr(plugin_api, "_tmux_send", fake_send)
    client = make_client()

    ok = client.post(
        "/api/plugins/grove-viewer/send",
        json={"pane": "dev10:2.0", "data": "hello"},
    )
    blocked = client.post(
        "/api/plugins/grove-viewer/send",
        json={"pane": "dev10:0.99", "data": "nope"},
    )

    assert ok.status_code == 200
    assert ok.json() == {"ok": True}
    assert blocked.status_code == 403
    assert sends == [("dev10:2.0", "hello")]


def test_tmux_capture_uses_literal_argv_without_shell(monkeypatch: MonkeyPatch) -> None:
    calls: list[dict[str, Any]] = []

    def fake_run(
        args: list[str],
        *,
        capture_output: bool,
        text: bool,
        timeout: float,
        check: bool,
    ) -> FakeCompletedProcess:
        calls.append(
            {
                "args": args,
                "capture_output": capture_output,
                "text": text,
                "timeout": timeout,
                "check": check,
            }
        )
        return FakeCompletedProcess(returncode=0, stdout="pane text")

    monkeypatch.setattr("plugin_api.subprocess.run", fake_run)

    assert plugin_api._tmux_capture("dev10:2.0") == "pane text"
    assert calls == [
        {
            "args": ["tmux", "capture-pane", "-t", "dev10:2.0", "-p"],
            "capture_output": True,
            "text": True,
            "timeout": plugin_api.TMUX_TIMEOUT_SECONDS,
            "check": False,
        }
    ]


def test_tmux_send_uses_literal_argv_and_literal_data(monkeypatch: MonkeyPatch) -> None:
    calls: list[dict[str, Any]] = []

    def fake_run(
        args: list[str],
        *,
        capture_output: bool,
        text: bool,
        timeout: float,
        check: bool,
    ) -> FakeCompletedProcess:
        calls.append(
            {
                "args": args,
                "capture_output": capture_output,
                "text": text,
                "timeout": timeout,
                "check": check,
            }
        )
        return FakeCompletedProcess(returncode=0)

    monkeypatch.setattr("plugin_api.subprocess.run", fake_run)

    plugin_api._tmux_send("dev10:2.0", "hello; rm -rf /")

    assert calls == [
        {
            "args": [
                "tmux",
                "send-keys",
                "-t",
                "dev10:2.0",
                "-l",
                "--",
                "hello; rm -rf /",
            ],
            "capture_output": True,
            "text": True,
            "timeout": plugin_api.TMUX_TIMEOUT_SECONDS,
            "check": False,
        }
    ]


def make_client() -> TestClient:
    app = FastAPI()
    app.include_router(plugin_api.router, prefix="/api/plugins/grove-viewer")
    return TestClient(app)


def write_registry(
    tmp_path: Path,
    *,
    session: str,
    nodes: dict[str, dict[str, object]],
) -> None:
    registry = {
        "session": session,
        "cwd": str(tmp_path),
        "nodes": nodes,
        "updatedAt": "2026-06-03T00:00:00.000Z",
    }
    path = tmp_path / ".grove" / session / "registry.json"
    path.parent.mkdir(parents=True)
    path.write_text(json.dumps(registry), encoding="utf-8")


def allow_ws(websocket: object) -> bool:
    return True


def deny_ws(websocket: object) -> bool:
    return False
