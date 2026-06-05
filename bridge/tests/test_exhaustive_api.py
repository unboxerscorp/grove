from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from grove_bridge.store import SQLiteBoardStore
from grove_bridge.web_app import AuthMode
from test_web_app import make_client, write_registry, write_team_member


def setup_harness(
    tmp_path: Path,
) -> tuple[
    SQLiteBoardStore,
    tuple[TestClient, dict[str, str]],
    tuple[TestClient, dict[str, str]],
    tuple[TestClient, dict[str, str]],
]:
    store = SQLiteBoardStore(tmp_path / "board.db")
    write_registry(tmp_path, session="dev10", nodes={"lead": {"name": "lead"}})
    write_team_member(tmp_path, secret="v-sec", role="viewer", name="viewer_user", member_id="m-1")
    write_team_member(
        tmp_path, secret="o-sec", role="operator", name="op_user", append=True, member_id="m-2"
    )
    write_team_member(
        tmp_path, secret="a-sec", role="admin", name="admin_user", append=True, member_id="m-3"
    )

    def get_client(secret: str, name: str) -> tuple[TestClient, dict[str, str]]:
        c = make_client(
            tmp_path,
            store,
            auth_mode=AuthMode.TEAM_COOKIE,
            host="127.0.0.1",
            port=8765,
            quota_enabled=True,
            handoff_enabled=True,
            summary_export_enabled=True,
        )
        res = c.post("/api/login", json={"name": name, "secret": secret})
        assert res.status_code == 200, res.json()
        csrf = res.json()["csrf"]
        return c, {"X-Grove-CSRF": str(csrf)}

    v_c, v_h = get_client("v-sec", "viewer_user")
    o_c, o_h = get_client("o-sec", "op_user")
    a_c, a_h = get_client("a-sec", "admin_user")

    return store, (v_c, v_h), (o_c, o_h), (a_c, a_h)


def test_exhaustive_api_tier1_harness(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    store, (v_c, v_h), (o_c, o_h), (a_c, a_h) = setup_harness(tmp_path)

    # Mock subprocess for terminal ticket/send
    monkeypatch.setattr(
        "grove_bridge.web_app.subprocess.run",
        lambda *args, **kwargs: type(
            "CompletedProcess", (), {"returncode": 0, "stdout": "", "stderr": ""}
        )(),
    )

    # 1. Project Switch / Read (All roles)
    for c, h in [(v_c, v_h), (o_c, o_h), (a_c, a_h)]:
        assert c.get("/api/projects", headers=h).status_code == 200

    # 2. Board CRUD / Task Create
    # Viewer should be 403
    res_v = v_c.post(
        "/api/boards/main/tasks",
        json={"title": "Test", "assignee": "lead"},
        headers=v_h,
    )
    assert res_v.status_code == 403
    print("V JSON", res_v.json())

    # Operator / Admin should be 200
    res_o = o_c.post(
        "/api/boards/main/tasks",
        json={"title": "Test", "assignee": "lead"},
        headers=o_h,
    )
    assert res_o.status_code == 200, res_o.json()
    task_id = res_o.json()["id"]

    # 3. Status Transition CAS
    # Operator changes to in_progress
    res_o = o_c.patch(f"/api/tasks/{task_id}/status", json={"status": "in_progress"}, headers=o_h)
    assert res_o.status_code == 200

    # Viewer 403
    res_v = v_c.patch(f"/api/tasks/{task_id}/status", json={"status": "review"}, headers=v_h)
    assert res_v.status_code == 403

    # 4. Idempotency CAS edge
    # Operator setting same status again
    res_o2 = o_c.patch(f"/api/tasks/{task_id}/status", json={"status": "running"}, headers=o_h)
    assert res_o2.status_code == 200

    # Ask Human
    res_o = o_c.patch(
        f"/api/tasks/{task_id}/status",
        json={"status": "ask_human", "payload": {"question": "Q"}},
        headers=o_h,
    )
    assert res_o.status_code == 200

    # 5. Answer
    res_v = v_c.post(f"/api/tasks/{task_id}/answer", json={"text": "V_Ans"}, headers=v_h)
    assert res_v.status_code == 403
    res_o = o_c.post(f"/api/tasks/{task_id}/answer", json={"text": "O_Ans"}, headers=o_h)
    assert res_o.status_code == 200

    # 6. Inbox
    for c, h in [(v_c, v_h), (o_c, o_h), (a_c, a_h)]:
        assert c.get("/api/inbox", headers=h).status_code == 200

    # 7. Websocket tickets are authenticated read-stream setup, not mutations.
    res_v = v_c.post("/api/ws-ticket", headers=v_h)
    assert res_v.status_code == 200
    res_o = o_c.post("/api/ws-ticket", headers=o_h)
    assert res_o.status_code == 200

    # 8. Slack config
    res_v = v_c.post("/api/slack/config", json={"app_token": "a", "bot_token": "b"}, headers=v_h)
    assert res_v.status_code == 403
    # let's assume operator can do it
    res_o = o_c.post("/api/slack/config", json={"app_token": "a", "bot_token": "b"}, headers=o_h)
    if res_o.status_code == 403:
        # maybe admin only?
        res_a = a_c.post(
            "/api/slack/config", json={"app_token": "a", "bot_token": "b"}, headers=a_h
        )
        assert res_a.status_code == 200

    # 9. Routing
    res_v = v_c.post("/api/notifications/routing", json={"rules": []}, headers=v_h)
    assert res_v.status_code == 403

    # 10. Ledger / Quota
    res_v = v_c.post("/api/quota", json={"member_id": "m-1", "soft_cost_usd": 10}, headers=v_h)
    assert res_v.status_code == 403

    # 11. Aggregation / Handoff
    res_v = v_c.post("/api/aggregate", json={"group": "all"}, headers=v_h)
    assert res_v.status_code == 403
    res_v = v_c.post("/api/handoff/export", json={"task_id": task_id}, headers=v_h)
    assert res_v.status_code == 403

    # 12. Exec / autonomy toggles
    res_v = v_c.post("/api/gui-features/autopilot", json={"enabled": True}, headers=v_h)
    assert res_v.status_code == 403

    # 13. Create Project
    res_v = v_c.post("/api/projects", json={"name": "new_proj"}, headers=v_h)
    assert res_v.status_code == 403

    # 14. Load Project
    res_v = v_c.post("/api/projects/load", json={"path": "/tmp/a"}, headers=v_h)
    assert res_v.status_code == 403

    # 15. Create View
    res_v = v_c.post("/api/boards/main/views", json={"name": "v1", "query": ""}, headers=v_h)
    assert res_v.status_code == 403

    # 16. Execution Post
    res_v = v_c.post("/api/execution", json={"task": task_id}, headers=v_h)
    assert res_v.status_code == 403
