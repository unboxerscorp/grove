from __future__ import annotations

import subprocess
from collections.abc import Callable, Mapping
from pathlib import Path

import pytest
from pytest import MonkeyPatch

import grove_bridge.pull_executor as pull_executor_module
from grove_bridge.config import (
    AutonomousPickupConfig,
    AutoPickupNodeConfig,
    BridgeConfig,
    LaneConfig,
    load_bridge_config,
)
from grove_bridge.grove import GroveRunResult, SubprocessGroveRunner
from grove_bridge.notifier import NotifierConfig, NotifierProtocol
from grove_bridge.pull_executor import PullExecutor
from grove_bridge.store import ClaimedTask, NotifySub, SQLiteBoardStore, Task


class FakeRunner:
    def __init__(self, result: GroveRunResult) -> None:
        self.result = result
        self.calls: list[tuple[str, str, Mapping[str, str], LaneConfig]] = []

    def run_task(
        self,
        *,
        node: str,
        prompt: str,
        env: Mapping[str, str],
        lane: LaneConfig,
        heartbeat: Callable[[], bool],
        dispatch_gate: Callable[[], bool] | None = None,
    ) -> GroveRunResult:
        self.calls.append((node, prompt, env, lane))
        if dispatch_gate is not None and not dispatch_gate():
            return GroveRunResult(
                node=node,
                returncode=1,
                stdout="",
                stderr="dispatch blocked",
                session_id=None,
                transcript_path=None,
                turn_id=None,
                tmux_pane=None,
                lease_lost=True,
            )
        heartbeat()
        return self.result


class LeaseLossRunner:
    def __init__(self) -> None:
        self.calls: list[str] = []

    def run_task(
        self,
        *,
        node: str,
        prompt: str,
        env: Mapping[str, str],
        lane: LaneConfig,
        heartbeat: Callable[[], bool],
        dispatch_gate: Callable[[], bool] | None = None,
    ) -> GroveRunResult:
        self.calls.append(node)
        if dispatch_gate is not None and not dispatch_gate():
            lease_lost = True
        else:
            lease_lost = not heartbeat()
        return GroveRunResult(
            node=node,
            returncode=0,
            stdout="finished after lease loss",
            stderr="",
            session_id=None,
            transcript_path=None,
            turn_id=None,
            tmux_pane=None,
            lease_lost=lease_lost,
        )


class RecordingNotifier:
    enabled = True
    channel_kind = "inbox"
    room_id = "ops"

    def __init__(self) -> None:
        self.calls: list[tuple[str, NotifySub]] = []

    def notify_blocked(self, *, task: Task, sub: NotifySub) -> None:
        self.calls.append((task.id, sub))


class ClaimConflictStore:
    def __init__(self) -> None:
        self.claim_calls: list[str | None] = []
        self.node_ids: list[str] = []
        self.completed: list[str] = []
        self.blocked: list[str] = []
        self.task = Task(
            id="t_available",
            board_id="b_main",
            title="Available",
            body=None,
            assignee="codex-a",
            status="ready",
            priority=0,
            workspace_kind="scratch",
            workspace_path=None,
            branch_name=None,
            claim_lock=None,
            claim_expires=None,
            current_run_id=None,
            last_heartbeat_at=None,
            result=None,
            metadata={},
            created_by=None,
            created_at=1,
            updated_at=1,
        )

    def release_stale(self, *, board: str, now: int | None = None, limit: int | None = None) -> int:
        return 0

    def list_tasks(
        self,
        *,
        board: str,
        status: str | None = None,
        assignee: str | None = None,
        limit: int | None = None,
    ) -> list[Task]:
        if assignee != self.task.assignee:
            return []
        count = 1 if limit is None else limit
        return [self.task for _index in range(count)]

    def claim_next(
        self,
        *,
        board: str,
        assignee: str | None,
        node_id: str,
        ttl_seconds: int,
        task_id: str | None = None,
    ) -> ClaimedTask | None:
        self.claim_calls.append(assignee)
        self.node_ids.append(node_id)
        if len(self.claim_calls) == 1:
            return None
        claimed_task = self.task.with_claim(
            status="running",
            claim_lock="lock-1",
            claim_expires=100,
            current_run_id="run-1",
        )
        return ClaimedTask(task=claimed_task, run_id="run-1", claim_lock="lock-1")

    def resolve_workspace(self, *, board: str, task: Task) -> Path:
        return Path("/tmp/grove-board") / board / task.id

    def db_path(self) -> Path:
        return Path("/tmp/grove-board/board.db")

    def heartbeat(
        self,
        *,
        board: str,
        task_id: str,
        run_id: str,
        claim_lock: str,
        ttl_seconds: int,
    ) -> bool:
        return True

    def complete(
        self,
        *,
        board: str,
        task_id: str,
        run_id: str,
        claim_lock: str,
        result: str,
        summary: str,
        metadata: Mapping[str, object],
    ) -> bool:
        self.completed.append(task_id)
        return True

    def block(
        self,
        *,
        board: str,
        task_id: str,
        run_id: str,
        claim_lock: str,
        reason: str,
        metadata: Mapping[str, object] | None = None,
        needs_human: bool = False,
    ) -> bool:
        self.blocked.append(task_id)
        return True

    def add_comment(
        self,
        *,
        board: str,
        task_id: str,
        author: str,
        body: str,
        metadata: Mapping[str, object] | None = None,
    ) -> object:
        return object()

    def add_notify_sub(
        self,
        *,
        board: str,
        task_id: str,
        channel_kind: str,
        room_id: str,
        thread_id: str = "",
        user_id: str | None = None,
    ) -> NotifySub:
        return NotifySub(
            board_id="b_main",
            task_id=task_id,
            channel_kind=channel_kind,
            room_id=room_id,
            thread_id=thread_id,
            user_id=user_id,
            last_event_id=None,
            created_at=1,
        )

    def notification_routing_state(self, *, board: str) -> dict[str, object]:
        return {"configured": False, "enabled": False, "dry_run": True, "rules": []}

    def add_audit_event(
        self,
        *,
        board: str,
        kind: str,
        actor: Mapping[str, object],
        action: str,
        target: Mapping[str, object],
        task_id: str | None = None,
        run_id: str | None = None,
        status: str = "ok",
        summary: str | None = None,
        payload: Mapping[str, object] | None = None,
    ) -> object:
        return object()

    def last_autopickup_at(self, *, board: str, node: str) -> int | None:
        return None

    def node_autopickup_enabled(self, *, board: str, node: str) -> bool | None:
        return None

    def autopickup_global_state(self, *, board: str) -> Mapping[str, bool]:
        return {"enabled": True, "kill_switch": False}

    def execution_gate_state(
        self,
        *,
        board: str,
        node: str,
        task_id: str | None,
    ) -> Mapping[str, object]:
        return {"allowed": True, "blocked_by": []}

    def guarded_dispatch_gate_state(
        self,
        *,
        board: str,
        node: str,
        task_id: str | None,
    ) -> Mapping[str, object]:
        return {"allowed": True, "blocked_by": []}

    def begin_guarded_execution(
        self,
        *,
        board: str,
        task_id: str,
        run_id: str,
        node: str,
    ) -> Mapping[str, object]:
        return {"state": "approval-pending", "node": node, "run_id": run_id}

    def abort_execution(
        self,
        *,
        board: str,
        task_id: str,
        actor: Mapping[str, object],
        reason: str,
    ) -> bool:
        return True

    def hold_execution_for_gate(
        self,
        *,
        board: str,
        task_id: str,
        actor: Mapping[str, object],
        reason: str,
    ) -> bool:
        return True

    def try_mark_execution_executing(
        self,
        *,
        board: str,
        task_id: str,
        run_id: str,
        node: str,
    ) -> bool:
        return True

    def issue_execution_dispatch_lease(
        self,
        *,
        board: str,
        task_id: str,
        run_id: str,
        node: str,
        ttl_seconds: int = 30,
    ) -> str | None:
        return f"{run_id}:stub"

    def mark_execution_verify(
        self,
        *,
        board: str,
        task_id: str,
        run_id: str,
        node: str,
        passed: bool,
        summary: str | None = None,
    ) -> bool:
        return True


class FakeProcessStdin:
    def __init__(self) -> None:
        self.value = ""
        self.closed = False

    def write(self, value: str) -> int:
        self.value += value
        return len(value)

    def close(self) -> None:
        self.closed = True


class FakeProcess:
    def __init__(self) -> None:
        self.returncode: int | None = None
        self.terminated = False
        self.communicate_calls = 0
        self.prepared_stdin = FakeProcessStdin()
        self.stdin: FakeProcessStdin | None = self.prepared_stdin

    def communicate(self, timeout: float | None = None) -> tuple[str, str]:
        self.communicate_calls += 1
        if self.communicate_calls == 1:
            raise subprocess.TimeoutExpired(cmd="grove", timeout=timeout or 0.0)
        self.returncode = -15 if self.terminated else 0
        return ("stopped", "")

    def terminate(self) -> None:
        self.terminated = True

    def kill(self) -> None:
        self.returncode = -9


def test_load_bridge_config_maps_nodes_store_and_notifier(tmp_path: Path) -> None:
    config_path = tmp_path / "bridge.toml"
    db_path = tmp_path / "board.db"
    config_path.write_text(
        f"""
boards = ["main", "cockpit"]
nodes = ["codex-a", "claude-a"]
board_db_path = "{db_path}"
poll_interval_seconds = 2.5
claim_ttl_seconds = 120
heartbeat_interval_seconds = 30
max_tasks_per_tick = 3
grove_config = "cockpit.grove.yaml"
timeout = "45m"

[notifier]
enabled = true
dry_run = true
channel_kind = "inbox"
room_id = "ops"
""".strip(),
        encoding="utf-8",
    )

    config = load_bridge_config(config_path)

    assert config.boards == ("main", "cockpit")
    assert config.board_db_path == db_path
    assert config.poll_interval_seconds == 2.5
    assert config.claim_ttl_seconds == 120
    assert config.heartbeat_interval_seconds == 30
    assert config.max_tasks_per_tick == 3
    assert config.notifier.enabled is True
    assert config.notifier.dry_run is True
    assert config.notifier.channel_kind == "inbox"
    assert config.notifier.room_id == "ops"
    assert config.lanes["codex-a"].assignee == "codex-a"
    assert config.lanes["codex-a"].nodes == ("codex-a",)
    assert config.lanes["codex-a"].grove_config == "cockpit.grove.yaml"
    assert config.lanes["codex-a"].timeout == "45m"
    assert config.lanes["claude-a"].assignee == "claude-a"
    assert config.lanes["claude-a"].nodes == ("claude-a",)


def test_main_uses_native_store_from_config(
    tmp_path: Path,
    monkeypatch: MonkeyPatch,
) -> None:
    config_path = tmp_path / "bridge.toml"
    db_path = tmp_path / "board.db"
    config_path.write_text(
        f"""
boards = ["main"]
nodes = ["codex-a"]
board_db_path = "{db_path}"
""".strip(),
        encoding="utf-8",
    )
    captured: dict[str, object] = {}

    class MainFakeExecutor:
        def __init__(
            self,
            *,
            config: BridgeConfig,
            store: object | None = None,
            grove_runner: object | None = None,
            notifier: NotifierProtocol | None = None,
        ) -> None:
            captured["config"] = config
            captured["store"] = store
            captured["notifier"] = notifier

        def run_once(self) -> None:
            captured["ran_once"] = True

        def run_forever(self) -> None:
            raise AssertionError("main should run only once in this test")

    monkeypatch.setattr(pull_executor_module, "PullExecutor", MainFakeExecutor)

    exit_code = pull_executor_module.main(["--config", str(config_path), "--once"])

    assert exit_code == 0
    assert isinstance(captured["store"], SQLiteBoardStore)
    assert captured["ran_once"] is True
    assert captured["notifier"] is not None


def test_run_once_claims_assignee_node_task_and_completes_with_grove_metadata(
    tmp_path: Path,
) -> None:
    store = SQLiteBoardStore(tmp_path / "board.db")
    task = store.create_task(
        board="main",
        title="Implement native board",
        body="Wire grove board tasks to grove.",
        assignee="codex-a",
    )
    runner = FakeRunner(
        GroveRunResult(
            node="codex-a",
            returncode=0,
            stdout="implemented bridge",
            stderr="",
            session_id="sess-1",
            transcript_path="/tmp/transcript.jsonl",
            turn_id=None,
            tmux_pane=None,
        )
    )
    config = BridgeConfig(
        boards=("main",),
        lanes={
            "codex-a": LaneConfig(
                assignee="codex-a",
                nodes=("codex-a",),
                grove_config="cockpit.grove.yaml",
                timeout="30m",
            )
        },
        board_db_path=tmp_path / "board.db",
        claim_ttl_seconds=600,
        heartbeat_interval_seconds=60,
        poll_interval_seconds=5,
        max_tasks_per_tick=1,
        autonomous_pickup=AutonomousPickupConfig(
            enabled=True,
            nodes={"codex-a": AutoPickupNodeConfig(enabled=True)},
        ),
    )

    executor = PullExecutor(config=config, store=store, grove_runner=runner)
    claimed_result = executor.run_once()
    store.set_autopickup_global(board="main", enabled=True, kill_switch=False)
    store.set_node_autopickup_enabled(board="main", node="codex-a", enabled=True)
    store.set_execution_global(board="main", enabled=True)
    store.set_node_execution_enabled(board="main", node="codex-a", enabled=True)
    assert store.approve_execution(
        board="main",
        task_id=task.id,
        actor={"kind": "member", "id": "lead", "login": "lead", "role": "admin"},
    )
    result = executor.run_once()

    assert claimed_result.claimed == 1
    assert claimed_result.completed == 0
    assert result.completed == 1
    assert runner.calls[0][0] == "codex-a"
    prompt = runner.calls[0][1]
    assert "Implement native board" in prompt
    assert "Wire grove board tasks to grove." in prompt
    assert "Assignee node: codex-a" in prompt
    assert "GROVE_BOARD_TASK=" in prompt
    assert "GROVE_BOARD_RUN_ID=" in prompt
    assert "GROVE_BOARD_DB=" in prompt
    env = runner.calls[0][2]
    assert env["GROVE_BOARD_TASK"] == task.id
    assert env["GROVE_BOARD_BOARD"] == "main"
    assert env["GROVE_BOARD_ASSIGNEE"] == "codex-a"
    completed = store.get_task(board="main", task_id=task.id)
    assert completed.status == "done"
    assert completed.result == "implemented bridge"
    assert completed.metadata["grove_session_id"] == "sess-1"
    assert completed.metadata["session"] == "sess-1"
    assert completed.metadata["transcript_path"] == "/tmp/transcript.jsonl"
    assert completed.metadata["transcript"] == "/tmp/transcript.jsonl"
    assert completed.metadata["node"] == "codex-a"
    execution = completed.metadata["execution"]
    assert isinstance(execution, dict)
    assert execution["state"] == "complete"


def test_approved_execution_requires_autopickup_gate(tmp_path: Path) -> None:
    store = SQLiteBoardStore(tmp_path / "board.db")
    task = store.create_task(
        board="main",
        title="Autopickup must be on",
        body=None,
        assignee="codex-a",
    )
    runner = FakeRunner(
        GroveRunResult(
            node="codex-a",
            returncode=0,
            stdout="should not run",
            stderr="",
            session_id=None,
            transcript_path=None,
            turn_id=None,
            tmux_pane=None,
        )
    )
    config = BridgeConfig(
        boards=("main",),
        lanes={"codex-a": LaneConfig(assignee="codex-a", nodes=("codex-a",))},
        board_db_path=tmp_path / "board.db",
        max_tasks_per_tick=1,
    )
    executor = PullExecutor(config=config, store=store, grove_runner=runner)

    claimed = executor.run_once()
    store.set_execution_global(board="main", enabled=True)
    store.set_node_execution_enabled(board="main", node="codex-a", enabled=True)
    assert store.approve_execution(
        board="main",
        task_id=task.id,
        actor={"kind": "member", "id": "lead", "login": "lead", "role": "admin"},
    )
    executed = executor.run_once()
    task_after = store.get_task(board="main", task_id=task.id)

    assert claimed.claimed == 1
    assert executed.completed == 0
    assert runner.calls == []
    assert task_after.status == "running"
    assert store.task_execution_state(board="main", task_id=task.id)["state"] == "approval-pending"


def test_run_once_blocks_failed_task_and_notifies_after_block(tmp_path: Path) -> None:
    store = SQLiteBoardStore(tmp_path / "board.db")
    task = store.create_task(
        board="main",
        title="Needs input",
        body=None,
        assignee="claude-a",
    )
    runner = FakeRunner(
        GroveRunResult(
            node="claude-a",
            returncode=2,
            stdout="partial output",
            stderr="missing input",
            session_id=None,
            transcript_path=None,
            turn_id=None,
            tmux_pane=None,
        )
    )
    notifier = RecordingNotifier()
    config = BridgeConfig(
        boards=("main",),
        lanes={"claude-a": LaneConfig(assignee="claude-a", nodes=("claude-a",))},
        board_db_path=tmp_path / "board.db",
        notifier=NotifierConfig(enabled=True, dry_run=False, channel_kind="inbox", room_id="ops"),
        claim_ttl_seconds=300,
        heartbeat_interval_seconds=60,
        poll_interval_seconds=5,
        max_tasks_per_tick=1,
        autonomous_pickup=AutonomousPickupConfig(
            enabled=True,
            nodes={"claude-a": AutoPickupNodeConfig(enabled=True)},
        ),
    )

    executor = PullExecutor(
        config=config,
        store=store,
        grove_runner=runner,
        notifier=notifier,
    )
    claimed_result = executor.run_once()
    store.set_autopickup_global(board="main", enabled=True, kill_switch=False)
    store.set_node_autopickup_enabled(board="main", node="claude-a", enabled=True)
    store.set_execution_global(board="main", enabled=True)
    store.set_node_execution_enabled(board="main", node="claude-a", enabled=True)
    assert store.approve_execution(
        board="main",
        task_id=task.id,
        actor={"kind": "member", "id": "lead", "login": "lead", "role": "admin"},
    )
    result = executor.run_once()

    assert claimed_result.claimed == 1
    assert claimed_result.blocked == 0
    assert result.blocked == 1
    blocked = store.get_task(board="main", task_id=task.id)
    assert blocked.status == "blocked"
    execution = blocked.metadata["execution"]
    assert isinstance(execution, dict)
    assert execution["state"] == "rollback"
    assert store.list_comments(board="main", task_id=task.id)[0].author == "grove-bridge"
    assert "missing input" in store.list_comments(board="main", task_id=task.id)[0].body
    subs = store.list_notify_subs(board="main", task_id=task.id)
    assert len(subs) == 1
    assert subs[0].channel_kind == "inbox"
    assert subs[0].room_id == "ops"
    assert notifier.calls == [(task.id, subs[0])]


def test_run_once_uses_stored_notification_routing_config(tmp_path: Path) -> None:
    store = SQLiteBoardStore(tmp_path / "board.db")
    task = store.create_task(
        board="main",
        title="Needs routed escalation",
        body=None,
        assignee="claude-a",
    )
    store.set_notification_routing(
        board="main",
        state={
            "enabled": True,
            "dry_run": False,
            "rules": [
                {
                    "name": "human-gate",
                    "event_type": "ask_human_pending",
                    "node": "claude-a",
                    "target": {"channel_kind": "inbox", "room_id": "route-ops"},
                    "escalate_after_seconds": 0,
                    "escalation_targets": [{"channel_kind": "inbox", "room_id": "route-lead"}],
                    "max_escalations": 1,
                }
            ],
        },
    )
    runner = FakeRunner(
        GroveRunResult(
            node="claude-a",
            returncode=2,
            stdout="partial output",
            stderr="missing input",
            session_id=None,
            transcript_path=None,
            turn_id=None,
            tmux_pane=None,
        )
    )
    notifier = RecordingNotifier()
    config = BridgeConfig(
        boards=("main",),
        lanes={"claude-a": LaneConfig(assignee="claude-a", nodes=("claude-a",))},
        board_db_path=tmp_path / "board.db",
        notifier=NotifierConfig(
            enabled=True,
            dry_run=False,
            channel_kind="inbox",
            room_id="legacy-ops",
        ),
        max_tasks_per_tick=1,
        autonomous_pickup=AutonomousPickupConfig(
            enabled=True,
            nodes={"claude-a": AutoPickupNodeConfig(enabled=True)},
        ),
    )
    executor = PullExecutor(config=config, store=store, grove_runner=runner, notifier=notifier)

    executor.run_once()
    store.set_autopickup_global(board="main", enabled=True, kill_switch=False)
    store.set_node_autopickup_enabled(board="main", node="claude-a", enabled=True)
    store.set_execution_global(board="main", enabled=True)
    store.set_node_execution_enabled(board="main", node="claude-a", enabled=True)
    assert store.approve_execution(
        board="main",
        task_id=task.id,
        actor={"kind": "member", "id": "lead", "login": "lead", "role": "admin"},
    )

    result = executor.run_once()

    assert result.blocked == 1
    subs = store.list_notify_subs(board="main", task_id=task.id)
    assert [sub.room_id for _, sub in notifier.calls] == ["route-ops", "route-lead"]
    assert all(sub.room_id != "legacy-ops" for sub in subs)
    subs_by_thread = {sub.thread_id: sub for sub in subs}
    assert subs_by_thread[f"route:human-gate:ask_human_pending:{task.id}:0"].room_id == (
        "route-ops"
    )
    assert subs_by_thread[f"route:human-gate:ask_human_pending:{task.id}:1"].room_id == (
        "route-lead"
    )


def test_run_once_notification_routing_dry_run_sends_nothing(tmp_path: Path) -> None:
    store = SQLiteBoardStore(tmp_path / "board.db")
    task = store.create_task(
        board="main",
        title="Dry-run blocked",
        body=None,
        assignee="codex-a",
        status="blocked",
        metadata={"needs_human": True},
    )
    store.set_notification_routing(
        board="main",
        state={
            "enabled": True,
            "dry_run": True,
            "rules": [
                {
                    "name": "dry-run",
                    "event_type": "ask_human_pending",
                    "target": {"channel_kind": "inbox", "room_id": "ops"},
                }
            ],
        },
    )
    notifier = RecordingNotifier()
    config = BridgeConfig(
        boards=("main",),
        lanes={"codex-a": LaneConfig(assignee="codex-a", nodes=("codex-a",))},
        board_db_path=tmp_path / "board.db",
        notifier=NotifierConfig(enabled=True, dry_run=False, channel_kind="inbox", room_id="ops"),
    )

    result = PullExecutor(config=config, store=store, notifier=notifier).run_once()

    assert result.claimed == 0
    assert notifier.calls == []
    assert store.list_notify_subs(board="main", task_id=task.id) == []


def test_run_once_notification_config_absent_keeps_default_notifier_path(
    tmp_path: Path,
) -> None:
    store = SQLiteBoardStore(tmp_path / "board.db")
    task = store.create_task(
        board="main",
        title="Legacy blocked",
        body=None,
        assignee="codex-a",
        status="blocked",
        metadata={"needs_human": True},
    )
    notifier = RecordingNotifier()
    config = BridgeConfig(
        boards=("main",),
        lanes={"codex-a": LaneConfig(assignee="codex-a", nodes=("codex-a",))},
        board_db_path=tmp_path / "board.db",
        notifier=NotifierConfig(enabled=True, dry_run=False, channel_kind="inbox", room_id="ops"),
    )

    result = PullExecutor(config=config, store=store, notifier=notifier).run_once()

    assert result.claimed == 0
    subs = store.list_notify_subs(board="main", task_id=task.id)
    assert len(subs) == 1
    assert subs[0].room_id == "ops"
    assert subs[0].thread_id == f"ask_human_pending:{task.id}"
    assert notifier.calls == [(task.id, subs[0])]


def test_run_once_skips_terminal_writes_when_heartbeat_loses_lease(
    tmp_path: Path,
    monkeypatch: MonkeyPatch,
) -> None:
    store = SQLiteBoardStore(tmp_path / "board.db")
    task = store.create_task(
        board="main",
        title="Lease lost",
        body=None,
        assignee="codex-a",
    )

    def deny_heartbeat(
        *,
        board: str,
        task_id: str,
        run_id: str,
        claim_lock: str,
        ttl_seconds: int,
    ) -> bool:
        return False

    monkeypatch.setattr(store, "heartbeat", deny_heartbeat)
    runner = LeaseLossRunner()
    config = BridgeConfig(
        boards=("main",),
        lanes={"codex-a": LaneConfig(assignee="codex-a", nodes=("codex-a",))},
        board_db_path=tmp_path / "board.db",
        claim_ttl_seconds=300,
        heartbeat_interval_seconds=60,
        poll_interval_seconds=5,
        max_tasks_per_tick=1,
        autonomous_pickup=AutonomousPickupConfig(
            enabled=True,
            nodes={"codex-a": AutoPickupNodeConfig(enabled=True)},
        ),
    )

    executor = PullExecutor(config=config, store=store, grove_runner=runner)
    claimed_result = executor.run_once()
    store.set_autopickup_global(board="main", enabled=True, kill_switch=False)
    store.set_node_autopickup_enabled(board="main", node="codex-a", enabled=True)
    store.set_execution_global(board="main", enabled=True)
    store.set_node_execution_enabled(board="main", node="codex-a", enabled=True)
    assert store.approve_execution(
        board="main",
        task_id=task.id,
        actor={"kind": "member", "id": "lead", "login": "lead", "role": "admin"},
    )
    result = executor.run_once()

    assert claimed_result.claimed == 1
    assert result.terminal_conflicts == 1
    assert result.completed == 0
    assert result.blocked == 0
    assert store.get_task(board="main", task_id=task.id).status == "running"
    assert store.list_comments(board="main", task_id=task.id) == []


def test_run_once_claims_node_assignee_without_consuming_other_nodes_on_conflict() -> None:
    store = ClaimConflictStore()
    runner = FakeRunner(
        GroveRunResult(
            node="unused",
            returncode=0,
            stdout="ok",
            stderr="",
            session_id=None,
            transcript_path=None,
            turn_id=None,
            tmux_pane=None,
        )
    )
    config = BridgeConfig(
        boards=("main",),
        lanes={
            "codex-a": LaneConfig(assignee="codex-a", nodes=("codex-a",)),
            "codex-b": LaneConfig(assignee="codex-b", nodes=("codex-b",)),
        },
        max_tasks_per_tick=2,
    )

    result = PullExecutor(config=config, store=store, grove_runner=runner).run_once()

    assert result.claim_conflicts == 1
    assert result.claimed == 1
    assert store.node_ids == ["codex-a", "codex-a"]
    assert runner.calls == []


def test_autonomous_pickup_default_off_leaves_unassigned_ready_task(tmp_path: Path) -> None:
    store = SQLiteBoardStore(tmp_path / "board.db")
    task = store.create_task(
        board="main",
        title="Unassigned",
        body=None,
        assignee=None,
        metadata={"role": "maker"},
    )
    runner = FakeRunner(
        GroveRunResult(
            node="codex-a",
            returncode=0,
            stdout="done",
            stderr="",
            session_id=None,
            transcript_path=None,
            turn_id=None,
            tmux_pane=None,
        )
    )
    config = BridgeConfig(
        boards=("main",),
        lanes={"codex-a": LaneConfig(assignee="codex-a", nodes=("codex-a",))},
        board_db_path=tmp_path / "board.db",
    )

    result = PullExecutor(config=config, store=store, grove_runner=runner).run_once()

    assert result.claimed == 0
    assert result.autopicked == 0
    assert runner.calls == []
    assert store.get_task(board="main", task_id=task.id).status == "ready"
    assert store.get_task(board="main", task_id=task.id).assignee is None


def test_autonomous_pickup_claims_matching_unassigned_task_and_audits(
    tmp_path: Path,
) -> None:
    store = SQLiteBoardStore(tmp_path / "board.db")
    task = store.create_task(
        board="main",
        title="Pick me up",
        body=None,
        assignee=None,
        metadata={"role": "maker"},
    )
    runner = FakeRunner(
        GroveRunResult(
            node="codex-a",
            returncode=0,
            stdout="done",
            stderr="",
            session_id=None,
            transcript_path=None,
            turn_id=None,
            tmux_pane=None,
        )
    )
    config = BridgeConfig(
        boards=("main",),
        lanes={"codex-a": LaneConfig(assignee="codex-a", nodes=("codex-a",))},
        board_db_path=tmp_path / "board.db",
        autonomous_pickup=AutonomousPickupConfig(
            enabled=True,
            cooldown_seconds=300,
            nodes={"codex-a": AutoPickupNodeConfig(enabled=True, roles=("maker",))},
        ),
    )

    result = PullExecutor(config=config, store=store, grove_runner=runner).run_once()
    audits = store.list_audit_events(board="main", action="autopickup", limit=10)

    assert result.claimed == 1
    assert result.autopicked == 1
    assert result.completed == 0
    assert runner.calls == []
    claimed = store.get_task(board="main", task_id=task.id)
    assert claimed.status == "running"
    assert claimed.assignee == "codex-a"
    assert store.task_execution_state(board="main", task_id=task.id)["state"] == "approval-pending"
    assert len(audits) == 1
    assert audits[0].kind == "audit.task.autopickup"
    assert audits[0].payload["actor"] == {
        "kind": "node",
        "id": "codex-a",
        "login": "codex-a",
        "role": "none",
    }
    assert audits[0].payload["target"] == {"type": "task", "id": task.id, "node": "codex-a"}
    execution_audits = store.list_audit_events(board="main", task_id=task.id, limit=10)
    actions = [event.payload["action"] for event in execution_audits]
    assert "claim" in actions
    assert "preflight" in actions
    assert "approval-pending" in actions


def test_guarded_execution_requires_approval_then_dispatches(tmp_path: Path) -> None:
    store = SQLiteBoardStore(tmp_path / "board.db")
    task = store.create_task(
        board="main",
        title="Guarded work",
        body=None,
        assignee=None,
        metadata={"role": "maker"},
    )
    store.set_autopickup_global(board="main", enabled=True, kill_switch=False)
    store.set_node_autopickup_enabled(board="main", node="codex-a", enabled=True)
    store.set_execution_global(board="main", enabled=True)
    store.set_node_execution_enabled(board="main", node="codex-a", enabled=True)
    runner = FakeRunner(
        GroveRunResult(
            node="codex-a",
            returncode=0,
            stdout="guarded done",
            stderr="",
            session_id="session-1",
            transcript_path="/tmp/transcript.jsonl",
            turn_id="turn-1",
            tmux_pane="dev10:1.0",
        )
    )
    config = BridgeConfig(
        boards=("main",),
        lanes={"codex-a": LaneConfig(assignee="codex-a", nodes=("codex-a",))},
        board_db_path=tmp_path / "board.db",
        autonomous_pickup=AutonomousPickupConfig(
            enabled=True,
            nodes={"codex-a": AutoPickupNodeConfig(enabled=True, roles=("maker",))},
        ),
    )
    executor = PullExecutor(config=config, store=store, grove_runner=runner)

    first = executor.run_once()
    blocked = executor.run_once()
    approved = store.approve_execution(
        board="main",
        task_id=task.id,
        actor={"kind": "member", "id": "lead", "login": "lead", "role": "admin"},
    )
    executed = executor.run_once()
    completed = store.get_task(board="main", task_id=task.id)
    audits = store.list_audit_events(board="main", task_id=task.id, limit=20)
    actions = [event.payload["action"] for event in audits]

    assert first.autopicked == 1
    assert blocked.completed == 0
    assert approved is True
    assert executed.completed == 1
    assert runner.calls[0][0] == "codex-a"
    assert completed.status == "done"
    execution = completed.metadata["execution"]
    assert isinstance(execution, dict)
    assert execution["state"] == "complete"
    assert actions == [
        "claim",
        "autopickup",
        "claim",
        "preflight",
        "approval-pending",
        "approve",
        "execute",
        "verify",
        "complete",
        "complete",
    ]


def test_autonomous_pickup_cooldown_limits_repeated_claims(
    tmp_path: Path,
    monkeypatch: MonkeyPatch,
) -> None:
    store = SQLiteBoardStore(tmp_path / "board.db")
    first = store.create_task(
        board="main",
        title="First",
        body=None,
        assignee=None,
        metadata={"capability": "python"},
    )
    second = store.create_task(
        board="main",
        title="Second",
        body=None,
        assignee=None,
        metadata={"capability": "python"},
    )
    now = 1000.0
    monkeypatch.setattr("time.time", lambda: now)
    runner = FakeRunner(
        GroveRunResult(
            node="codex-a",
            returncode=0,
            stdout="done",
            stderr="",
            session_id=None,
            transcript_path=None,
            turn_id=None,
            tmux_pane=None,
        )
    )
    config = BridgeConfig(
        boards=("main",),
        lanes={"codex-a": LaneConfig(assignee="codex-a", nodes=("codex-a",))},
        board_db_path=tmp_path / "board.db",
        max_tasks_per_tick=2,
        autonomous_pickup=AutonomousPickupConfig(
            enabled=True,
            cooldown_seconds=300,
            nodes={"codex-a": AutoPickupNodeConfig(enabled=True, capabilities=("python",))},
        ),
    )
    executor = PullExecutor(config=config, store=store, grove_runner=runner)

    first_result = executor.run_once()
    picked = next(
        task
        for task in (first, second)
        if store.get_task(board="main", task_id=task.id).status == "running"
    )
    store.set_autopickup_global(board="main", enabled=True, kill_switch=False)
    store.set_node_autopickup_enabled(board="main", node="codex-a", enabled=True)
    store.set_execution_global(board="main", enabled=True)
    store.set_node_execution_enabled(board="main", node="codex-a", enabled=True)
    assert store.approve_execution(
        board="main",
        task_id=picked.id,
        actor={"kind": "member", "id": "lead", "login": "lead", "role": "admin"},
    )
    execution_result = executor.run_once()
    second_result = executor.run_once()
    now = 1400.0
    third_result = executor.run_once()

    assert first_result.autopicked == 1
    assert execution_result.completed == 1
    assert second_result.autopicked == 0
    assert third_result.autopicked == 1
    statuses = {
        store.get_task(board="main", task_id=first.id).status,
        store.get_task(board="main", task_id=second.id).status,
    }
    pending = next(
        task
        for task in (first, second)
        if store.get_task(board="main", task_id=task.id).status == "running"
    )
    assert statuses == {"done", "running"}
    assert store.task_execution_state(board="main", task_id=pending.id)["state"] == (
        "approval-pending"
    )


def test_autonomous_pickup_cooldown_persists_across_executor_restart(
    tmp_path: Path,
    monkeypatch: MonkeyPatch,
) -> None:
    store = SQLiteBoardStore(tmp_path / "board.db")
    first = store.create_task(
        board="main",
        title="First",
        body=None,
        assignee=None,
        metadata={"role": "maker"},
    )
    second = store.create_task(
        board="main",
        title="Second",
        body=None,
        assignee=None,
        metadata={"role": "maker"},
    )
    now = 1000.0
    monkeypatch.setattr("time.time", lambda: now)
    runner = FakeRunner(
        GroveRunResult(
            node="codex-a",
            returncode=0,
            stdout="done",
            stderr="",
            session_id=None,
            transcript_path=None,
            turn_id=None,
            tmux_pane=None,
        )
    )
    config = BridgeConfig(
        boards=("main",),
        lanes={"codex-a": LaneConfig(assignee="codex-a", nodes=("codex-a",))},
        board_db_path=tmp_path / "board.db",
        max_tasks_per_tick=2,
        autonomous_pickup=AutonomousPickupConfig(
            enabled=True,
            cooldown_seconds=300,
            nodes={"codex-a": AutoPickupNodeConfig(enabled=True, roles=("maker",))},
        ),
    )

    first_result = PullExecutor(config=config, store=store, grove_runner=runner).run_once()
    picked = next(
        task
        for task in (first, second)
        if store.get_task(board="main", task_id=task.id).status == "running"
    )
    store.set_autopickup_global(board="main", enabled=True, kill_switch=False)
    store.set_node_autopickup_enabled(board="main", node="codex-a", enabled=True)
    store.set_execution_global(board="main", enabled=True)
    store.set_node_execution_enabled(board="main", node="codex-a", enabled=True)
    assert store.approve_execution(
        board="main",
        task_id=picked.id,
        actor={"kind": "member", "id": "lead", "login": "lead", "role": "admin"},
    )
    execution_result = PullExecutor(config=config, store=store, grove_runner=runner).run_once()
    now = 1001.0
    second_result = PullExecutor(config=config, store=store, grove_runner=runner).run_once()
    now = 1400.0
    third_result = PullExecutor(config=config, store=store, grove_runner=runner).run_once()

    assert first_result.autopicked == 1
    assert execution_result.completed == 1
    assert second_result.autopicked == 0
    assert third_result.autopicked == 1
    statuses = {
        store.get_task(board="main", task_id=first.id).status,
        store.get_task(board="main", task_id=second.id).status,
    }
    assert statuses == {"done", "running"}


def test_autonomous_pickup_uses_persisted_node_toggle(tmp_path: Path) -> None:
    store = SQLiteBoardStore(tmp_path / "board.db")
    task = store.create_task(
        board="main",
        title="Runtime opt in",
        body=None,
        assignee=None,
        metadata={"role": "maker"},
    )
    store.set_node_autopickup_enabled(board="main", node="codex-a", enabled=True)
    runner = FakeRunner(
        GroveRunResult(
            node="codex-a",
            returncode=0,
            stdout="done",
            stderr="",
            session_id=None,
            transcript_path=None,
            turn_id=None,
            tmux_pane=None,
        )
    )
    config = BridgeConfig(
        boards=("main",),
        lanes={"codex-a": LaneConfig(assignee="codex-a", nodes=("codex-a",))},
        board_db_path=tmp_path / "board.db",
        autonomous_pickup=AutonomousPickupConfig(
            enabled=True,
            nodes={"codex-a": AutoPickupNodeConfig(enabled=False, roles=("maker",))},
        ),
    )

    result = PullExecutor(config=config, store=store, grove_runner=runner).run_once()

    assert result.autopicked == 1
    assert runner.calls == []
    assert store.get_task(board="main", task_id=task.id).status == "running"
    assert store.task_execution_state(board="main", task_id=task.id)["state"] == (
        "approval-pending"
    )


def _approved_guarded_claim(
    store: SQLiteBoardStore,
    *,
    title: str = "Guarded",
    node: str = "codex-a",
) -> ClaimedTask:
    task = store.create_task(board="main", title=title, body=None, assignee=node)
    claimed = store.claim_next(
        board="main",
        assignee=node,
        node_id=node,
        ttl_seconds=300,
        task_id=task.id,
    )
    assert claimed is not None
    store.begin_guarded_execution(
        board="main",
        task_id=task.id,
        run_id=claimed.run_id,
        node=node,
    )
    store.set_autopickup_global(board="main", enabled=True, kill_switch=False)
    store.set_node_autopickup_enabled(board="main", node=node, enabled=True)
    store.set_execution_global(board="main", enabled=True)
    store.set_node_execution_enabled(board="main", node=node, enabled=True)
    assert store.approve_execution(
        board="main",
        task_id=task.id,
        actor={"kind": "member", "id": "lead", "login": "lead", "role": "admin"},
    )
    return claimed


def test_guarded_execution_rejects_second_concurrent_task(tmp_path: Path) -> None:
    store = SQLiteBoardStore(tmp_path / "board.db")
    first = _approved_guarded_claim(store, title="First")
    second = _approved_guarded_claim(store, title="Second")

    assert store.try_mark_execution_executing(
        board="main",
        task_id=first.task.id,
        run_id=first.run_id,
        node="codex-a",
    )
    assert not store.try_mark_execution_executing(
        board="main",
        task_id=second.task.id,
        run_id=second.run_id,
        node="codex-a",
    )
    assert store.task_execution_state(board="main", task_id=second.task.id)["state"] == "approved"


def test_store_execution_transition_requires_autopickup_node_gate(tmp_path: Path) -> None:
    store = SQLiteBoardStore(tmp_path / "board.db")
    task = store.create_task(board="main", title="No node gate", body=None, assignee="codex-a")
    claimed = store.claim_next(
        board="main",
        assignee="codex-a",
        node_id="codex-a",
        ttl_seconds=300,
        task_id=task.id,
    )
    assert claimed is not None
    store.begin_guarded_execution(
        board="main",
        task_id=task.id,
        run_id=claimed.run_id,
        node="codex-a",
    )
    store.set_autopickup_global(board="main", enabled=True, kill_switch=False)
    store.set_execution_global(board="main", enabled=True)
    store.set_node_execution_enabled(board="main", node="codex-a", enabled=True)
    assert store.approve_execution(
        board="main",
        task_id=task.id,
        actor={"kind": "member", "id": "lead", "login": "lead", "role": "admin"},
    )

    assert not store.try_mark_execution_executing(
        board="main",
        task_id=task.id,
        run_id=claimed.run_id,
        node="codex-a",
    )
    state = store.task_execution_state(board="main", task_id=task.id)
    assert state["state"] == "approval-pending"
    assert state["approved"] is False


@pytest.mark.parametrize(
    ("level", "kwargs"),
    [
        ("global", {}),
        ("board", {}),
        ("node", {"node": "codex-a"}),
        ("task", {"task_id": "TASK"}),
    ],
)
def test_guarded_execution_kill_switch_blocks_every_level(
    tmp_path: Path,
    level: str,
    kwargs: dict[str, str],
) -> None:
    store = SQLiteBoardStore(tmp_path / "board.db")
    claimed = _approved_guarded_claim(store)
    if kwargs.get("task_id") == "TASK":
        kwargs = {"task_id": claimed.task.id}
    store.set_execution_kill_switch(board="main", level=level, enabled=True, **kwargs)

    assert not store.try_mark_execution_executing(
        board="main",
        task_id=claimed.task.id,
        run_id=claimed.run_id,
        node="codex-a",
    )
    assert store.task_execution_state(board="main", task_id=claimed.task.id)["state"] == "abort"
    abort_audits = store.list_audit_events(board="main", action="abort", task_id=claimed.task.id)
    assert abort_audits


def test_guarded_execution_approval_bypass_and_rollback(tmp_path: Path) -> None:
    store = SQLiteBoardStore(tmp_path / "board.db")
    ready = store.create_task(board="main", title="Ready", body=None, assignee="codex-a")

    assert not store.approve_execution(
        board="main",
        task_id=ready.id,
        actor={"kind": "member", "id": "lead", "login": "lead", "role": "admin"},
    )

    claimed = _approved_guarded_claim(store, title="Verify failure")
    assert store.try_mark_execution_executing(
        board="main",
        task_id=claimed.task.id,
        run_id=claimed.run_id,
        node="codex-a",
    )
    assert store.mark_execution_verify(
        board="main",
        task_id=claimed.task.id,
        run_id=claimed.run_id,
        node="codex-a",
        passed=False,
        summary="verify failed",
    )
    assert store.task_execution_state(board="main", task_id=claimed.task.id)["state"] == "rollback"
    actions = [
        event.payload["action"]
        for event in store.list_audit_events(board="main", task_id=claimed.task.id)
    ]
    assert "verify" in actions
    assert "rollback" in actions


def test_guarded_dispatch_pre_start_kill_aborts_without_start(tmp_path: Path) -> None:
    store = SQLiteBoardStore(tmp_path / "board.db")
    task = store.create_task(
        board="main",
        title="Kill before start",
        body=None,
        assignee=None,
        metadata={"role": "maker"},
    )
    store.set_autopickup_global(board="main", enabled=True, kill_switch=False)
    store.set_node_autopickup_enabled(board="main", node="codex-a", enabled=True)
    store.set_execution_global(board="main", enabled=True)
    store.set_node_execution_enabled(board="main", node="codex-a", enabled=True)

    class PreStartKillRunner:
        def __init__(self) -> None:
            self.started = False

        def run_task(
            self,
            *,
            node: str,
            prompt: str,
            env: Mapping[str, str],
            lane: LaneConfig,
            heartbeat: Callable[[], bool],
            dispatch_gate: Callable[[], bool] | None = None,
        ) -> GroveRunResult:
            store.set_execution_kill_switch(board="main", level="global", enabled=True)
            if dispatch_gate is not None and not dispatch_gate():
                return GroveRunResult(
                    node=node,
                    returncode=1,
                    stdout="",
                    stderr="dispatch blocked",
                    session_id=None,
                    transcript_path=None,
                    turn_id=None,
                    tmux_pane=None,
                    lease_lost=True,
                )
            self.started = True
            return GroveRunResult(
                node=node,
                returncode=0,
                stdout="should not run",
                stderr="",
                session_id=None,
                transcript_path=None,
                turn_id=None,
                tmux_pane=None,
            )

    runner = PreStartKillRunner()
    config = BridgeConfig(
        boards=("main",),
        lanes={"codex-a": LaneConfig(assignee="codex-a", nodes=("codex-a",))},
        board_db_path=tmp_path / "board.db",
        autonomous_pickup=AutonomousPickupConfig(
            enabled=True,
            nodes={"codex-a": AutoPickupNodeConfig(enabled=True, roles=("maker",))},
        ),
    )
    executor = PullExecutor(config=config, store=store, grove_runner=runner)

    executor.run_once()
    assert store.approve_execution(
        board="main",
        task_id=task.id,
        actor={"kind": "member", "id": "lead", "login": "lead", "role": "admin"},
    )
    result = executor.run_once()

    assert runner.started is False
    assert result.terminal_conflicts == 1
    assert store.task_execution_state(board="main", task_id=task.id)["state"] == "abort"
    assert store.list_audit_events(board="main", action="execute", task_id=task.id) == []


def test_guarded_execution_kill_switch_flip_mid_flight_aborts(tmp_path: Path) -> None:
    store = SQLiteBoardStore(tmp_path / "board.db")
    task = store.create_task(
        board="main",
        title="Kill mid flight",
        body=None,
        assignee=None,
        metadata={"role": "maker"},
    )
    store.set_autopickup_global(board="main", enabled=True, kill_switch=False)
    store.set_node_autopickup_enabled(board="main", node="codex-a", enabled=True)
    store.set_execution_global(board="main", enabled=True)
    store.set_node_execution_enabled(board="main", node="codex-a", enabled=True)

    class MidFlightKillRunner:
        def __init__(self) -> None:
            self.calls = 0

        def run_task(
            self,
            *,
            node: str,
            prompt: str,
            env: Mapping[str, str],
            lane: LaneConfig,
            heartbeat: Callable[[], bool],
            dispatch_gate: Callable[[], bool] | None = None,
        ) -> GroveRunResult:
            self.calls += 1
            store.set_execution_kill_switch(board="main", level="global", enabled=True)
            lease_lost = not dispatch_gate() if dispatch_gate is not None else not heartbeat()
            return GroveRunResult(
                node=node,
                returncode=0,
                stdout="should not complete",
                stderr="",
                session_id=None,
                transcript_path=None,
                turn_id=None,
                tmux_pane=None,
                lease_lost=lease_lost,
            )

    runner = MidFlightKillRunner()
    config = BridgeConfig(
        boards=("main",),
        lanes={"codex-a": LaneConfig(assignee="codex-a", nodes=("codex-a",))},
        board_db_path=tmp_path / "board.db",
        autonomous_pickup=AutonomousPickupConfig(
            enabled=True,
            nodes={"codex-a": AutoPickupNodeConfig(enabled=True, roles=("maker",))},
        ),
    )
    executor = PullExecutor(config=config, store=store, grove_runner=runner)

    executor.run_once()
    assert store.approve_execution(
        board="main",
        task_id=task.id,
        actor={"kind": "member", "id": "lead", "login": "lead", "role": "admin"},
    )
    result = executor.run_once()

    assert runner.calls == 1
    assert result.terminal_conflicts == 1
    assert store.task_execution_state(board="main", task_id=task.id)["state"] == "abort"


def test_guarded_heartbeat_autopickup_kill_flip_aborts(tmp_path: Path) -> None:
    store = SQLiteBoardStore(tmp_path / "board.db")
    task = store.create_task(
        board="main",
        title="Autopickup kill during heartbeat",
        body=None,
        assignee=None,
        metadata={"role": "maker"},
    )
    store.set_autopickup_global(board="main", enabled=True, kill_switch=False)
    store.set_node_autopickup_enabled(board="main", node="codex-a", enabled=True)
    store.set_execution_global(board="main", enabled=True)
    store.set_node_execution_enabled(board="main", node="codex-a", enabled=True)

    class HeartbeatAutopickupKillRunner:
        def __init__(self) -> None:
            self.calls = 0

        def run_task(
            self,
            *,
            node: str,
            prompt: str,
            env: Mapping[str, str],
            lane: LaneConfig,
            heartbeat: Callable[[], bool],
            dispatch_gate: Callable[[], bool] | None = None,
        ) -> GroveRunResult:
            _ = (prompt, env, lane)
            self.calls += 1
            assert dispatch_gate is None or dispatch_gate()
            store.set_autopickup_global(board="main", enabled=True, kill_switch=True)
            lease_lost = not heartbeat()
            return GroveRunResult(
                node=node,
                returncode=0,
                stdout="should not complete",
                stderr="",
                session_id=None,
                transcript_path=None,
                turn_id=None,
                tmux_pane=None,
                lease_lost=lease_lost,
            )

    runner = HeartbeatAutopickupKillRunner()
    config = BridgeConfig(
        boards=("main",),
        lanes={"codex-a": LaneConfig(assignee="codex-a", nodes=("codex-a",))},
        board_db_path=tmp_path / "board.db",
        autonomous_pickup=AutonomousPickupConfig(
            enabled=True,
            nodes={"codex-a": AutoPickupNodeConfig(enabled=True, roles=("maker",))},
        ),
    )
    executor = PullExecutor(config=config, store=store, grove_runner=runner)

    executor.run_once()
    assert store.approve_execution(
        board="main",
        task_id=task.id,
        actor={"kind": "member", "id": "lead", "login": "lead", "role": "admin"},
    )
    result = executor.run_once()

    assert runner.calls == 1
    assert result.terminal_conflicts == 1
    state = store.task_execution_state(board="main", task_id=task.id)
    assert state["state"] == "abort"
    abort_reason = state["abort_reason"]
    assert isinstance(abort_reason, str)
    assert "autopickup-global-kill-switch" in abort_reason


@pytest.mark.parametrize(
    ("enabled", "kill_switch"),
    [
        (False, False),
        (True, True),
    ],
)
def test_autonomous_pickup_runtime_global_gate_blocks_persisted_node_toggle(
    tmp_path: Path,
    enabled: bool,
    kill_switch: bool,
) -> None:
    store = SQLiteBoardStore(tmp_path / "board.db")
    task = store.create_task(
        board="main",
        title="Runtime global gate",
        body=None,
        assignee=None,
        metadata={"role": "maker"},
    )
    store.set_node_autopickup_enabled(board="main", node="codex-a", enabled=True)
    store.set_autopickup_global(board="main", enabled=enabled, kill_switch=kill_switch)
    runner = FakeRunner(
        GroveRunResult(
            node="codex-a",
            returncode=0,
            stdout="done",
            stderr="",
            session_id=None,
            transcript_path=None,
            turn_id=None,
            tmux_pane=None,
        )
    )
    config = BridgeConfig(
        boards=("main",),
        lanes={"codex-a": LaneConfig(assignee="codex-a", nodes=("codex-a",))},
        board_db_path=tmp_path / "board.db",
        autonomous_pickup=AutonomousPickupConfig(
            enabled=True,
            nodes={"codex-a": AutoPickupNodeConfig(enabled=False, roles=("maker",))},
        ),
    )

    result = PullExecutor(config=config, store=store, grove_runner=runner).run_once()

    assert result.autopicked == 0
    assert store.get_task(board="main", task_id=task.id).status == "ready"
    assert runner.calls == []


def test_autonomous_pickup_respects_inflight_and_kill_switches(tmp_path: Path) -> None:
    inflight_store = SQLiteBoardStore(tmp_path / "inflight.db")
    running = inflight_store.create_task(
        board="main",
        title="Already running",
        body=None,
        assignee="codex-a",
    )
    assert inflight_store.claim_next(
        board="main",
        assignee="codex-a",
        node_id="codex-a",
        ttl_seconds=300,
        task_id=running.id,
    )
    ready = inflight_store.create_task(
        board="main",
        title="Ready unassigned",
        body=None,
        assignee=None,
        metadata={"role": "maker"},
    )
    runner = FakeRunner(
        GroveRunResult(
            node="codex-a",
            returncode=0,
            stdout="done",
            stderr="",
            session_id=None,
            transcript_path=None,
            turn_id=None,
            tmux_pane=None,
        )
    )
    config = BridgeConfig(
        boards=("main",),
        lanes={"codex-a": LaneConfig(assignee="codex-a", nodes=("codex-a",))},
        board_db_path=tmp_path / "board.db",
        autonomous_pickup=AutonomousPickupConfig(
            enabled=True,
            kill_switch=False,
            nodes={"codex-a": AutoPickupNodeConfig(enabled=True, roles=("maker",))},
        ),
    )

    inflight = PullExecutor(config=config, store=inflight_store, grove_runner=runner).run_once()
    assert inflight.autopicked == 0
    assert inflight_store.get_task(board="main", task_id=ready.id).status == "ready"

    global_store = SQLiteBoardStore(tmp_path / "global-kill.db")
    global_ready = global_store.create_task(
        board="main",
        title="Global kill",
        body=None,
        assignee=None,
        metadata={"role": "maker"},
    )
    global_kill = PullExecutor(
        config=BridgeConfig(
            boards=("main",),
            lanes={"codex-a": LaneConfig(assignee="codex-a", nodes=("codex-a",))},
            board_db_path=tmp_path / "board.db",
            autonomous_pickup=AutonomousPickupConfig(
                enabled=True,
                kill_switch=True,
                nodes={"codex-a": AutoPickupNodeConfig(enabled=True, roles=("maker",))},
            ),
        ),
        store=global_store,
        grove_runner=runner,
    ).run_once()

    node_store = SQLiteBoardStore(tmp_path / "node-kill.db")
    node_ready = node_store.create_task(
        board="main",
        title="Node kill",
        body=None,
        assignee=None,
        metadata={"role": "maker"},
    )
    node_kill = PullExecutor(
        config=BridgeConfig(
            boards=("main",),
            lanes={"codex-a": LaneConfig(assignee="codex-a", nodes=("codex-a",))},
            board_db_path=tmp_path / "board.db",
            autonomous_pickup=AutonomousPickupConfig(
                enabled=True,
                nodes={
                    "codex-a": AutoPickupNodeConfig(
                        enabled=True,
                        kill_switch=True,
                        roles=("maker",),
                    )
                },
            ),
        ),
        store=node_store,
        grove_runner=runner,
    ).run_once()

    assert global_kill.autopicked == 0
    assert node_kill.autopicked == 0
    assert global_store.get_task(board="main", task_id=global_ready.id).status == "ready"
    assert node_store.get_task(board="main", task_id=node_ready.id).status == "ready"
    assert runner.calls == []


def test_autonomous_pickup_ignores_rule_mismatch_and_repair_tasks(tmp_path: Path) -> None:
    store = SQLiteBoardStore(tmp_path / "board.db")
    mismatch = store.create_task(
        board="main",
        title="Mismatch",
        body=None,
        assignee=None,
        metadata={"role": "reviewer"},
    )
    repair = store.create_task(
        board="main",
        title="Repair",
        body=None,
        assignee=None,
        metadata={"role": "maker", "repair": True},
    )
    runner = FakeRunner(
        GroveRunResult(
            node="codex-a",
            returncode=0,
            stdout="done",
            stderr="",
            session_id=None,
            transcript_path=None,
            turn_id=None,
            tmux_pane=None,
        )
    )
    config = BridgeConfig(
        boards=("main",),
        lanes={"codex-a": LaneConfig(assignee="codex-a", nodes=("codex-a",))},
        board_db_path=tmp_path / "board.db",
        autonomous_pickup=AutonomousPickupConfig(
            enabled=True,
            nodes={"codex-a": AutoPickupNodeConfig(enabled=True, roles=("maker",))},
        ),
    )

    result = PullExecutor(config=config, store=store, grove_runner=runner).run_once()

    assert result.autopicked == 0
    assert store.get_task(board="main", task_id=mismatch.id).status == "ready"
    assert store.get_task(board="main", task_id=repair.id).status == "ready"
    assert runner.calls == []


def test_main_builds_session_board_config_from_registry(
    tmp_path: Path,
    monkeypatch: MonkeyPatch,
) -> None:
    grove_home = tmp_path / ".grove"
    registry_path = grove_home / "dev10" / "registry.json"
    registry_path.parent.mkdir(parents=True)
    registry_path.write_text(
        """
{
  "nodes": {
    "lead": {"name": "lead", "tmux_pane": "dev10:0.0"},
    "fe": {"name": "fe", "agent": "codex", "tmux_pane": "dev10:1.1"},
    "qa": {"name": "qa", "agent": "claude", "tmux_pane": "dev10:1.2"}
  }
}
""".strip(),
        encoding="utf-8",
    )
    captured: dict[str, object] = {}

    class SessionFakeExecutor:
        def __init__(
            self,
            *,
            config: BridgeConfig,
            store: object | None = None,
            grove_runner: object | None = None,
            notifier: NotifierProtocol | None = None,
        ) -> None:
            captured["config"] = config
            captured["store"] = store

        def run_once(self) -> None:
            captured["ran_once"] = True

        def run_forever(self) -> None:
            raise AssertionError("main should run only once in this test")

    monkeypatch.setattr(pull_executor_module, "PullExecutor", SessionFakeExecutor)
    monkeypatch.setenv("GROVE_HOME", str(grove_home))

    exit_code = pull_executor_module.main(
        [
            "--session",
            "dev10",
            "--board",
            "live",
            "--grove-config",
            "cockpit.grove.yaml",
            "--once",
        ]
    )

    assert exit_code == 0
    config = captured["config"]
    assert isinstance(config, BridgeConfig)
    assert config.boards == ("live",)
    assert sorted(config.lanes) == ["fe", "qa"]
    assert config.lanes["fe"].assignee == "fe"
    assert config.lanes["fe"].nodes == ("fe",)
    assert config.lanes["fe"].grove_config == "cockpit.grove.yaml"
    assert isinstance(captured["store"], SQLiteBoardStore)
    assert captured["ran_once"] is True


def test_subprocess_runner_aborts_when_heartbeat_reports_lost_lease(
    monkeypatch: MonkeyPatch,
) -> None:
    fake_proc = FakeProcess()

    monkeypatch.setattr("subprocess.Popen", lambda *args, **kwargs: fake_proc)
    monkeypatch.setattr("time.monotonic", lambda: 1000.0)

    runner = SubprocessGroveRunner(
        grove_binary="grove",
        heartbeat_interval_seconds=0,
    )
    result = runner.run_task(
        node="codex-a",
        prompt="task",
        env={},
        lane=LaneConfig(assignee="grove:codex", nodes=("codex-a",)),
        heartbeat=lambda: False,
    )

    assert result.lease_lost is True
    assert fake_proc.terminated is True
    assert result.returncode == -15
    assert result.stdout == "stopped"
