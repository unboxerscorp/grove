from pathlib import Path

from fastapi.testclient import TestClient

from grove_bridge.store import SQLiteBoardStore
from grove_bridge.web_app import AuthMode
from test_web_app import make_client, write_registry, write_team_member


def setup_harness(tmp_path: Path) -> tuple[SQLiteBoardStore, TestClient, str]:
    store = SQLiteBoardStore(tmp_path / "board.db")

    # We will use sample as default board, and proj_b as another project
    write_registry(tmp_path, session="sample", nodes={"sample-node": {"name": "sample-node"}})
    write_registry(tmp_path, session="proj_b", nodes={"proj_b-node": {"name": "proj_b-node"}})

    # Setup team member and registries
    write_team_member(tmp_path, secret="op-sec", role="operator", name="op_user", member_id="m-1")

    client = make_client(
        tmp_path,
        store,
        auth_mode=AuthMode.TEAM_COOKIE,
        port=8765,
        quota_enabled=True,
        handoff_enabled=True,
    )
    res = client.post("/api/login", json={"name": "op_user", "secret": "op-sec"})
    assert res.status_code == 200
    csrf = str(res.json()["csrf"])

    return store, client, csrf


def test_skeleton_board_task_crud_and_status(tmp_path: Path) -> None:
    store, client, csrf = setup_harness(tmp_path)
    headers = {"X-Grove-CSRF": csrf}

    # Create task
    res = client.post(
        "/api/boards/sample/tasks",
        json={"title": "Test CRUD", "assignee": "sample-node"},
        headers=headers,
    )
    assert res.status_code == 200
    task_id = res.json()["id"]

    # Read task
    res = client.get("/api/boards/sample/tasks", headers=headers)
    assert res.status_code == 200
    tasks = res.json()
    assert any(t["id"] == task_id for t in tasks)

    # Status transitions: ready -> running -> review -> done
    # 1. ready -> running
    res = client.patch(f"/api/tasks/{task_id}/status", json={"status": "running"}, headers=headers)
    assert res.status_code == 200

    # 2. running -> review
    res = client.patch(f"/api/tasks/{task_id}/status", json={"status": "review"}, headers=headers)
    assert res.status_code == 200

    # 3. review -> done
    res = client.patch(f"/api/tasks/{task_id}/status", json={"status": "done"}, headers=headers)
    assert res.status_code == 200

    # Check it's preserved (immortal)
    res = client.get("/api/boards/sample/tasks", headers=headers)
    assert res.status_code == 200
    task = next(t for t in res.json() if t["id"] == task_id)
    assert task["status"] == "done"


def test_skeleton_project_scoping_isolation(tmp_path: Path) -> None:
    store, client, csrf = setup_harness(tmp_path)
    headers = {"X-Grove-CSRF": csrf}

    # Create task in sample
    res = client.post(
        "/api/boards/sample/tasks", json={"title": "T1", "assignee": "sample-node"}, headers=headers
    )
    assert res.status_code == 200
    t1_id = res.json()["id"]

    # Create task in proj_b via X-Grove-Project
    headers_b = {"X-Grove-CSRF": csrf, "X-Grove-Project": "proj_b"}
    res = client.post(
        "/api/boards/proj_b/tasks",
        json={"title": "T2", "assignee": "proj_b-node"},
        headers=headers_b,
    )
    assert res.status_code == 200
    t2_id = res.json()["id"]

    # Check sample human-facing items
    res = client.get("/api/boards/sample/tasks", headers=headers)
    assert res.status_code == 200
    sample_ids = [t["id"] for t in res.json()]
    assert t1_id in sample_ids
    assert t2_id not in sample_ids

    # Check proj_b human-facing items
    res = client.get("/api/boards/proj_b/tasks", headers=headers_b)
    assert res.status_code == 200
    proj_b_ids = [t["id"] for t in res.json()]
    assert t2_id in proj_b_ids
    assert t1_id not in proj_b_ids


def test_skeleton_health_auth(tmp_path: Path) -> None:
    store, client, csrf = setup_harness(tmp_path)
    headers = {"X-Grove-CSRF": csrf}

    # Without token
    client.cookies.clear()
    res = client.get("/api/boards/sample/tasks")
    assert res.status_code == 401

    # With token (requires relogin to get cookie back for test client)
    client.post("/api/login", json={"name": "op_user", "secret": "op-sec"})
    res = client.get("/api/boards/sample/tasks", headers=headers)
    assert res.status_code == 200


def test_skeleton_idempotency_cas(tmp_path: Path) -> None:
    store, client, csrf = setup_harness(tmp_path)
    headers = {"X-Grove-CSRF": csrf}

    # Create task
    res = client.post(
        "/api/boards/sample/tasks",
        json={"title": "Test CAS", "assignee": "sample-node"},
        headers=headers,
    )
    assert res.status_code == 200
    task_id = res.json()["id"]

    # Duplicate claim / CAS: set status to running
    res = client.patch(f"/api/tasks/{task_id}/status", json={"status": "running"}, headers=headers)
    assert res.status_code == 200

    # Set to running again (should be idempotent / succeed without side effects)
    res = client.patch(f"/api/tasks/{task_id}/status", json={"status": "running"}, headers=headers)
    assert res.status_code == 200

    # Attempting to ask_human while running should work
    res = client.patch(
        f"/api/tasks/{task_id}/status",
        json={"status": "ask_human", "payload": {"question": "Q"}},
        headers=headers,
    )
    assert res.status_code == 200

    # Attempting to ask_human again with different payload should work (or fail if strict CAS,
    # but currently idempotent/overwrites)
    res = client.patch(
        f"/api/tasks/{task_id}/status",
        json={"status": "ask_human", "payload": {"question": "Q2"}},
        headers=headers,
    )
    assert res.status_code == 200
