from pathlib import Path

import pytest

from grove_bridge.store import SQLiteBoardStore
from grove_bridge.web_app import AuthMode
from test_web_app import auth_headers, make_client, write_team_member


def test_live_journey_endpoints(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    store = SQLiteBoardStore(tmp_path / "board.db")
    client = make_client(tmp_path, store)
    headers = auth_headers(client)

    monkeypatch.setattr(
        "grove_bridge.web_app.subprocess.run",
        lambda *args, **kwargs: type(
            "CompletedProcess", (), {"returncode": 0, "stdout": "", "stderr": ""}
        )(),
    )

    # 1. me / presence
    me = client.get("/api/me", headers=headers)
    assert me.status_code == 200

    pres = client.get("/api/presence", headers=headers)
    assert pres.status_code == 200

    # 2. task create
    task_res = client.post(
        "/api/boards/sample/tasks",
        json={"title": "Test item", "assignee": "lead"},
        headers=headers,
    )
    assert task_res.status_code == 200
    task_id = task_res.json()["id"]

    # 3. task status
    status_res = client.patch(
        f"/api/tasks/{task_id}/status", json={"status": "in_progress"}, headers=headers
    )
    assert status_res.status_code == 200
    assert status_res.json()["status"] == "running"

    # 4. task comment
    comment_res = client.post(
        f"/api/tasks/{task_id}/comments",
        json={"author": "local:lead", "body": "A comment"},
        headers=headers,
    )
    assert comment_res.status_code == 200

    # 5. task answer
    status_res = client.patch(
        f"/api/tasks/{task_id}/status", json={"status": "blocked"}, headers=headers
    )
    ans_res = client.post(
        f"/api/tasks/{task_id}/answer", json={"text": "Here is an answer"}, headers=headers
    )
    assert ans_res.status_code == 200

    # 6. soft-delete? (done)
    del_res = client.patch(f"/api/tasks/{task_id}/status", json={"status": "done"}, headers=headers)
    assert del_res.status_code == 200
    assert del_res.json()["status"] == "done"

    # 7. master-chat
    chat_res = client.post("/api/master/chat", json={"message": "Summary?"}, headers=headers)
    assert chat_res.status_code == 200

    # 8. slack config/status
    slack_res = client.get("/api/slack/config/status", headers=headers)
    assert slack_res.status_code == 200

    # 9. ws-ticket terminal/board
    ticket_res = client.post("/api/ws-ticket", headers=headers)
    assert ticket_res.status_code == 200

    # 10. node connect/send
    pass


def test_live_journey_viewer_auth(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    store = SQLiteBoardStore(tmp_path / "board.db")
    write_team_member(tmp_path, secret="viewer-secret", role="viewer")

    # 1. viewer client
    viewer = make_client(tmp_path, store, auth_mode=AuthMode.TEAM_COOKIE)
    login_res = viewer.post("/api/login", json={"name": "alice", "secret": "viewer-secret"})
    assert login_res.status_code == 200
    csrf = str(login_res.json()["csrf"])

    headers = {"X-CSRF-Token": csrf}

    # viewer can access read-only
    assert viewer.get("/api/boards/sample/tasks").status_code == 200

    # viewer cannot create task
    task_res = viewer.post(
        "/api/boards/sample/tasks",
        json={"title": "Test item", "assignee": "lead"},
        headers=headers,
    )
    assert task_res.status_code == 403

    # Factual MASTER chat turns are read-only; action preview remains operator gated.
    chat_res = viewer.post("/api/master/chat", json={"message": "Summary?"}, headers=headers)
    assert chat_res.status_code == 200
    assert chat_res.json()["response_type"] == "answer"
    action_res = viewer.post(
        "/api/master/chat", json={"message": "새 프로젝트 만들어줘"}, headers=headers
    )
    assert action_res.status_code == 403
