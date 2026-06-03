from __future__ import annotations

import subprocess
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from pathlib import Path

from pytest import MonkeyPatch

from grove_bridge.config import BridgeConfig, LaneConfig, load_bridge_config
from grove_bridge.grove import GroveRunResult, SubprocessGroveRunner
from grove_bridge.pull_executor import PullExecutor


@dataclass
class FakeTask:
    id: str
    title: str
    body: str | None
    assignee: str | None
    status: str
    workspace_kind: str = "scratch"
    workspace_path: str | None = None
    claim_lock: str | None = None
    claim_expires: int | None = None
    current_run_id: int | None = None


class FakeConn:
    def __init__(self, board: str | None) -> None:
        self.board = board
        self.closed = False

    def close(self) -> None:
        self.closed = True


class FakeKanbanDb:
    def __init__(self, tasks: list[FakeTask]) -> None:
        self.tasks = tasks
        self.connected_boards: list[str | None] = []
        self.list_calls: list[tuple[str | None, str | None]] = []
        self.claim_calls: list[tuple[str, int | None, str | None]] = []
        self.heartbeats: list[tuple[str, int | None, str | None]] = []
        self.worker_heartbeats: list[tuple[str, str | None, int | None]] = []
        self.completed: list[tuple[str, str | None, str | None, dict[str, object], int | None]] = []
        self.comments: list[tuple[str, str, str]] = []
        self.blocked: list[tuple[str, str | None, int | None]] = []
        self.release_calls = 0
        self.release_count = 0
        self.complete_result = True
        self.block_result = True
        self.heartbeat_claim_result = True
        self.heartbeat_worker_result = True
        self.claim_losers: set[str] = set()
        self.operation_order: list[str] = []

    def connect(self, *, board: str | None = None) -> FakeConn:
        self.connected_boards.append(board)
        return FakeConn(board)

    def list_tasks(
        self,
        conn: FakeConn,
        *,
        assignee: str | None = None,
        status: str | None = None,
        limit: int | None = None,
    ) -> list[FakeTask]:
        self.list_calls.append((assignee, status))
        matches = [
            task for task in self.tasks if task.assignee == assignee and task.status == status
        ]
        return matches[:limit] if limit is not None else matches

    def claim_task(
        self,
        conn: FakeConn,
        task_id: str,
        *,
        ttl_seconds: int | None = None,
        claimer: str | None = None,
    ) -> FakeTask | None:
        self.claim_calls.append((task_id, ttl_seconds, claimer))
        if task_id in self.claim_losers:
            return None
        for task in self.tasks:
            if task.id == task_id and task.status == "ready":
                task.status = "running"
                task.claim_lock = claimer
                task.current_run_id = 7001
                return task
        return None

    def heartbeat_claim(
        self,
        conn: FakeConn,
        task_id: str,
        *,
        ttl_seconds: int | None = None,
        claimer: str | None = None,
    ) -> bool:
        self.heartbeats.append((task_id, ttl_seconds, claimer))
        return self.heartbeat_claim_result

    def heartbeat_worker(
        self,
        conn: FakeConn,
        task_id: str,
        *,
        note: str | None = None,
        expected_run_id: int | None = None,
    ) -> bool:
        self.worker_heartbeats.append((task_id, note, expected_run_id))
        return self.heartbeat_worker_result

    def complete_task(
        self,
        conn: FakeConn,
        task_id: str,
        *,
        result: str | None = None,
        summary: str | None = None,
        metadata: dict[str, object] | None = None,
        expected_run_id: int | None = None,
    ) -> bool:
        self.completed.append((task_id, result, summary, metadata or {}, expected_run_id))
        return self.complete_result

    def add_comment(self, conn: FakeConn, task_id: str, author: str, body: str) -> int:
        self.operation_order.append("comment")
        self.comments.append((task_id, author, body))
        return len(self.comments)

    def block_task(
        self,
        conn: FakeConn,
        task_id: str,
        *,
        reason: str | None = None,
        expected_run_id: int | None = None,
    ) -> bool:
        self.operation_order.append("block")
        self.blocked.append((task_id, reason, expected_run_id))
        return self.block_result

    def release_stale_claims(self, conn: FakeConn) -> int:
        self.release_calls += 1
        return self.release_count

    def resolve_workspace(self, task: FakeTask, *, board: str | None = None) -> Path:
        if task.workspace_path is not None:
            return Path(task.workspace_path)
        return Path("/tmp/legacy") / (board or "default") / "workspaces" / task.id

    def kanban_db_path(self, *, board: str | None = None) -> Path:
        return Path("/tmp/legacy") / (board or "default") / "kanban.db"


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
    ) -> GroveRunResult:
        self.calls.append((node, prompt, env, lane))
        heartbeat()
        return self.result


class HeartbeatAwareFakeRunner:
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
    ) -> GroveRunResult:
        self.calls.append(node)
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


class FakeProcess:
    def __init__(self) -> None:
        self.returncode: int | None = None
        self.terminated = False
        self.communicate_calls = 0

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


def test_load_bridge_config_maps_lanes_to_node_pools(tmp_path: Path) -> None:
    config_path = tmp_path / "bridge.toml"
    config_path.write_text(
        """
boards = ["default", "cockpit"]
poll_interval_seconds = 2.5
claim_ttl_seconds = 120
heartbeat_interval_seconds = 30
max_tasks_per_tick = 3

[lanes."grove:codex"]
nodes = ["codex-a", "codex-b"]
grove_config = "cockpit.grove.yaml"
timeout = "45m"

[lanes."grove:claude"]
nodes = ["claude-a"]
""".strip(),
        encoding="utf-8",
    )

    config = load_bridge_config(config_path)

    assert config.boards == ("default", "cockpit")
    assert config.poll_interval_seconds == 2.5
    assert config.claim_ttl_seconds == 120
    assert config.heartbeat_interval_seconds == 30
    assert config.max_tasks_per_tick == 3
    assert config.lanes["grove:codex"].nodes == ("codex-a", "codex-b")
    assert config.lanes["grove:codex"].grove_config == "cockpit.grove.yaml"
    assert config.lanes["grove:codex"].timeout == "45m"
    assert config.lanes["grove:claude"].nodes == ("claude-a",)


def test_run_once_claims_lane_task_and_completes_with_grove_metadata() -> None:
    task = FakeTask(
        id="t_123",
        title="Implement S1a",
        body="Wire Legacy kanban to grove.",
        assignee="grove:codex",
        status="ready",
    )
    kanban = FakeKanbanDb([task])
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
        boards=("default",),
        lanes={
            "grove:codex": LaneConfig(
                assignee="grove:codex",
                nodes=("codex-a",),
                grove_config="cockpit.grove.yaml",
                timeout="30m",
            )
        },
        claim_ttl_seconds=600,
        heartbeat_interval_seconds=60,
        poll_interval_seconds=5,
        max_tasks_per_tick=1,
    )

    result = PullExecutor(config=config, kanban_db=kanban, grove_runner=runner).run_once()

    assert result.claimed == 1
    assert result.completed == 1
    assert kanban.release_calls == 1
    assert kanban.list_calls == [("grove:codex", "ready")]
    assert kanban.claim_calls[0][0] == "t_123"
    assert kanban.claim_calls[0][1] == 600
    assert kanban.claim_calls[0][2] is not None
    assert runner.calls[0][0] == "codex-a"
    prompt = runner.calls[0][1]
    assert "Implement S1a" in prompt
    assert "Wire Legacy kanban to grove." in prompt
    assert "LEGACY_KANBAN_TASK=t_123" in prompt
    assert "LEGACY_KANBAN_RUN_ID=7001" in prompt
    assert "LEGACY_KANBAN_BOARD=default" in prompt
    assert "LEGACY_KANBAN_WORKSPACE=/tmp/legacy/default/workspaces/t_123" in prompt
    env = runner.calls[0][2]
    assert env["LEGACY_KANBAN_TASK"] == "t_123"
    assert env["LEGACY_KANBAN_RUN_ID"] == "7001"
    assert kanban.heartbeats == [("t_123", 600, kanban.claim_calls[0][2])]
    assert kanban.worker_heartbeats == [("t_123", "grove bridge running codex-a", 7001)]
    completed = kanban.completed[0]
    assert completed[0] == "t_123"
    assert completed[1] == "implemented bridge"
    assert completed[2] == "implemented bridge"
    assert completed[3]["grove_session_id"] == "sess-1"
    assert completed[3]["transcript_path"] == "/tmp/transcript.jsonl"
    assert completed[3]["turn_id"] is None
    assert completed[3]["tmux_pane"] is None
    assert completed[3]["node"] == "codex-a"
    assert completed[4] == 7001
    assert kanban.blocked == []


def test_run_once_blocks_task_when_grove_execution_fails() -> None:
    task = FakeTask(
        id="t_fail",
        title="Needs clarification",
        body=None,
        assignee="grove:claude",
        status="ready",
    )
    kanban = FakeKanbanDb([task])
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
    config = BridgeConfig(
        boards=("default",),
        lanes={"grove:claude": LaneConfig(assignee="grove:claude", nodes=("claude-a",))},
        claim_ttl_seconds=300,
        heartbeat_interval_seconds=60,
        poll_interval_seconds=5,
        max_tasks_per_tick=1,
    )

    result = PullExecutor(config=config, kanban_db=kanban, grove_runner=runner).run_once()

    assert result.claimed == 1
    assert result.blocked == 1
    assert kanban.completed == []
    assert kanban.comments[0][0] == "t_fail"
    assert kanban.comments[0][1] == "grove-bridge"
    assert "missing input" in kanban.comments[0][2]
    assert kanban.blocked == [("t_fail", "grove ask failed for claude-a: missing input", 7001)]


def test_run_once_skips_candidate_when_cas_claim_loses() -> None:
    task = FakeTask(
        id="t_claimed_elsewhere",
        title="Already claimed",
        body=None,
        assignee="grove:codex",
        status="ready",
    )
    kanban = FakeKanbanDb([task])
    kanban.claim_losers.add("t_claimed_elsewhere")
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
        boards=("default",),
        lanes={"grove:codex": LaneConfig(assignee="grove:codex", nodes=("codex-a",))},
        claim_ttl_seconds=300,
        heartbeat_interval_seconds=60,
        poll_interval_seconds=5,
        max_tasks_per_tick=1,
    )

    result = PullExecutor(config=config, kanban_db=kanban, grove_runner=runner).run_once()

    assert result.claimed == 0
    assert result.claim_conflicts == 1
    assert result.completed == 0
    assert runner.calls == []
    assert kanban.completed == []
    assert kanban.blocked == []


def test_run_once_acquires_node_only_after_successful_claim() -> None:
    first = FakeTask(
        id="t_claimed_elsewhere",
        title="Already claimed",
        body=None,
        assignee="grove:codex",
        status="ready",
    )
    second = FakeTask(
        id="t_available",
        title="Available",
        body=None,
        assignee="grove:codex",
        status="ready",
    )
    kanban = FakeKanbanDb([first, second])
    kanban.claim_losers.add("t_claimed_elsewhere")
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
        boards=("default",),
        lanes={
            "grove:codex": LaneConfig(
                assignee="grove:codex",
                nodes=("codex-a", "codex-b"),
            )
        },
        claim_ttl_seconds=300,
        heartbeat_interval_seconds=60,
        poll_interval_seconds=5,
        max_tasks_per_tick=2,
    )

    result = PullExecutor(config=config, kanban_db=kanban, grove_runner=runner).run_once()

    assert result.claim_conflicts == 1
    assert result.claimed == 1
    assert [call[0] for call in kanban.claim_calls] == [
        "t_claimed_elsewhere",
        "t_available",
    ]
    assert runner.calls[0][0] == "codex-a"


def test_run_once_counts_terminal_conflict_when_expected_run_id_no_longer_matches() -> None:
    task = FakeTask(
        id="t_done_elsewhere",
        title="Concurrent finish",
        body=None,
        assignee="grove:codex",
        status="ready",
    )
    kanban = FakeKanbanDb([task])
    kanban.complete_result = False
    runner = FakeRunner(
        GroveRunResult(
            node="codex-a",
            returncode=0,
            stdout="completed by grove",
            stderr="",
            session_id=None,
            transcript_path=None,
            turn_id=None,
            tmux_pane=None,
        )
    )
    config = BridgeConfig(
        boards=("default",),
        lanes={"grove:codex": LaneConfig(assignee="grove:codex", nodes=("codex-a",))},
        claim_ttl_seconds=300,
        heartbeat_interval_seconds=60,
        poll_interval_seconds=5,
        max_tasks_per_tick=1,
    )

    result = PullExecutor(config=config, kanban_db=kanban, grove_runner=runner).run_once()

    assert result.claimed == 1
    assert result.completed == 0
    assert result.terminal_conflicts == 1
    assert kanban.completed[0][4] == 7001
    assert kanban.comments == []
    assert kanban.blocked == []


def test_run_once_skips_terminal_writes_when_heartbeat_loses_lease() -> None:
    task = FakeTask(
        id="t_lease_lost",
        title="Lease lost",
        body=None,
        assignee="grove:codex",
        status="ready",
    )
    kanban = FakeKanbanDb([task])
    kanban.heartbeat_claim_result = False
    runner = HeartbeatAwareFakeRunner()
    config = BridgeConfig(
        boards=("default",),
        lanes={"grove:codex": LaneConfig(assignee="grove:codex", nodes=("codex-a",))},
        claim_ttl_seconds=300,
        heartbeat_interval_seconds=60,
        poll_interval_seconds=5,
        max_tasks_per_tick=1,
    )

    result = PullExecutor(config=config, kanban_db=kanban, grove_runner=runner).run_once()

    assert result.claimed == 1
    assert result.terminal_conflicts == 1
    assert result.completed == 0
    assert result.blocked == 0
    assert kanban.completed == []
    assert kanban.comments == []
    assert kanban.blocked == []


def test_run_once_adds_failure_comment_only_after_block_succeeds() -> None:
    task = FakeTask(
        id="t_concurrent_done",
        title="Concurrent terminal",
        body=None,
        assignee="grove:claude",
        status="ready",
    )
    kanban = FakeKanbanDb([task])
    kanban.block_result = False
    runner = FakeRunner(
        GroveRunResult(
            node="claude-a",
            returncode=2,
            stdout="partial",
            stderr="failed",
            session_id=None,
            transcript_path=None,
            turn_id=None,
            tmux_pane=None,
        )
    )
    config = BridgeConfig(
        boards=("default",),
        lanes={"grove:claude": LaneConfig(assignee="grove:claude", nodes=("claude-a",))},
        claim_ttl_seconds=300,
        heartbeat_interval_seconds=60,
        poll_interval_seconds=5,
        max_tasks_per_tick=1,
    )

    result = PullExecutor(config=config, kanban_db=kanban, grove_runner=runner).run_once()

    assert result.blocked == 0
    assert result.terminal_conflicts == 1
    assert kanban.operation_order == ["block"]
    assert kanban.comments == []


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


def test_run_once_releases_stale_claims_before_ready_scan() -> None:
    kanban = FakeKanbanDb([])
    kanban.release_count = 2
    runner = FakeRunner(
        GroveRunResult(
            node="codex-a",
            returncode=0,
            stdout="unused",
            stderr="",
            session_id=None,
            transcript_path=None,
            turn_id=None,
            tmux_pane=None,
        )
    )
    config = BridgeConfig(
        boards=("default", "cockpit"),
        lanes={"grove:codex": LaneConfig(assignee="grove:codex", nodes=("codex-a",))},
        claim_ttl_seconds=300,
        heartbeat_interval_seconds=60,
        poll_interval_seconds=5,
        max_tasks_per_tick=1,
    )

    result = PullExecutor(config=config, kanban_db=kanban, grove_runner=runner).run_once()

    assert kanban.release_calls == 2
    assert result.stale_released == 4
