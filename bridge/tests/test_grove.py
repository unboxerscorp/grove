from __future__ import annotations

import io
import subprocess
import sys
from collections.abc import Mapping
from pathlib import Path
from typing import cast

import pytest

from grove_bridge import prepared_dispatch
from grove_bridge.config import LaneConfig
from grove_bridge.grove import (
    GroveRunResult,
    SubprocessGroveRunner,
    ensure_runner,
    first_failure_line,
    summarize_stdout,
)
from grove_bridge.store import SQLiteBoardStore


class PreparedStdin:
    def __init__(self) -> None:
        self.value = ""
        self.closed = False

    def write(self, value: str) -> int:
        self.value += value
        return len(value)

    def close(self) -> None:
        self.closed = True


class SuccessfulProcess:
    returncode = 0

    def __init__(self) -> None:
        self.prepared_stdin = PreparedStdin()
        self.stdin: PreparedStdin | None = self.prepared_stdin

    def communicate(self, timeout: float | None = None) -> tuple[str, str]:
        _ = timeout
        return "task stdout", ""


def test_subprocess_runner_invokes_grove_ask_and_probes_session(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    popen_calls: list[dict[str, object]] = []
    run_calls: list[dict[str, object]] = []
    process = SuccessfulProcess()

    def fake_popen(
        args: list[str],
        *,
        stdin: object,
        stdout: object,
        stderr: object,
        text: bool,
        env: Mapping[str, str],
    ) -> SuccessfulProcess:
        popen_calls.append(
            {
                "args": args,
                "stdin": stdin,
                "stdout": stdout,
                "stderr": stderr,
                "text": text,
                "env": dict(env),
            }
        )
        return process

    def fake_run(
        args: list[str],
        *,
        stdout: object,
        stderr: object,
        text: bool,
        env: dict[str, str],
        timeout: float,
        check: bool,
    ) -> subprocess.CompletedProcess[str]:
        run_calls.append(
            {
                "args": args,
                "stdout": stdout,
                "stderr": stderr,
                "text": text,
                "env": env,
                "timeout": timeout,
                "check": check,
            }
        )
        return subprocess.CompletedProcess(
            args=args,
            returncode=0,
            stdout='{"sessionId":"sess-1","transcript":"/tmp/transcript.jsonl"}',
            stderr="",
        )

    monkeypatch.setattr("grove_bridge.grove.subprocess.Popen", fake_popen)
    monkeypatch.setattr("grove_bridge.grove.subprocess.run", fake_run)
    runner = SubprocessGroveRunner(
        grove_binary="grove-bin",
        heartbeat_interval_seconds=10,
        session_probe_timeout_seconds=2.5,
    )

    result = runner.run_task(
        node="worker",
        prompt="do the task",
        env={"GROVE_BOARD_TASK": "task-1"},
        lane=LaneConfig(
            assignee="worker",
            nodes=("worker",),
            grove_config="fleet.grove.yaml",
            timeout="15m",
        ),
        heartbeat=lambda: True,
    )

    assert result.returncode == 0
    assert result.stdout == "task stdout"
    assert result.session_id == "sess-1"
    assert result.transcript_path == "/tmp/transcript.jsonl"
    popen_args = cast(list[str], popen_calls[0]["args"])
    assert popen_args[:3] == [sys.executable, "-m", "grove_bridge.prepared_dispatch"]
    assert popen_args[3:] == [
        "--grove-binary",
        "grove-bin",
        "--node",
        "worker",
        "--timeout",
        "15m",
        "--config",
        "fleet.grove.yaml",
    ]
    assert "do the task" not in popen_args
    assert process.prepared_stdin.value == "do the task"
    assert process.prepared_stdin.closed is True
    assert cast(dict[str, str], popen_calls[0]["env"])["GROVE_BOARD_TASK"] == "task-1"
    assert run_calls[0]["args"] == [
        "grove-bin",
        "session",
        "worker",
        "--config",
        "fleet.grove.yaml",
    ]
    assert run_calls[0]["timeout"] == 2.5


def test_subprocess_runner_checks_dispatch_gate_before_popen(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    popen_calls = 0

    def fake_popen(*args: object, **kwargs: object) -> SuccessfulProcess:
        nonlocal popen_calls
        popen_calls += 1
        return SuccessfulProcess()

    monkeypatch.setattr("grove_bridge.grove.subprocess.Popen", fake_popen)
    runner = SubprocessGroveRunner(grove_binary="grove-bin")

    result = runner.run_task(
        node="worker",
        prompt="do the task",
        env={},
        lane=LaneConfig(assignee="worker", nodes=("worker",)),
        heartbeat=lambda: True,
        dispatch_gate=lambda: False,
    )

    assert popen_calls == 0
    assert result.lease_lost is True
    assert result.stderr == "dispatch gate blocked before start"


def test_subprocess_runner_passes_dispatch_gate_env_to_helper(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    process = SuccessfulProcess()
    popen_env: dict[str, str] = {}

    def fake_popen(*args: object, **kwargs: object) -> SuccessfulProcess:
        _ = args
        raw_env = kwargs["env"]
        assert isinstance(raw_env, Mapping)
        popen_env.update(cast(Mapping[str, str], raw_env))
        return process

    env: dict[str, str] = {"GROVE_BOARD_TASK": "task-1"}

    def dispatch_gate() -> bool:
        env["GROVE_EXECUTION_DISPATCH_LEASE"] = "run-1:nonce"
        return True

    monkeypatch.setattr("grove_bridge.grove.subprocess.Popen", fake_popen)
    monkeypatch.setattr(
        "grove_bridge.grove.subprocess.run",
        lambda *args, **kwargs: subprocess.CompletedProcess(
            args=args,
            returncode=0,
            stdout="{}",
            stderr="",
        ),
    )
    runner = SubprocessGroveRunner(grove_binary="grove-bin")

    result = runner.run_task(
        node="worker",
        prompt="do the task",
        env=env,
        lane=LaneConfig(assignee="worker", nodes=("worker",)),
        heartbeat=lambda: True,
        dispatch_gate=dispatch_gate,
    )

    assert result.lease_lost is False
    assert popen_env["GROVE_EXECUTION_DISPATCH_LEASE"] == "run-1:nonce"
    assert popen_env["GROVE_PREPARED_DISPATCH_GUARDED"] == "1"
    assert popen_env["GROVE_BOARD_TASK"] == "task-1"
    assert process.prepared_stdin.value == "do the task"


def _prepared_dispatch_lease(
    tmp_path: Path,
    *,
    ttl_seconds: int = 30,
) -> tuple[SQLiteBoardStore, str, str, str]:
    store = SQLiteBoardStore(tmp_path / "board.db")
    task = store.create_task(
        board="main",
        title="Prepared dispatch",
        body=None,
        assignee="codex-a",
        metadata={"role": "maker"},
    )
    claimed = store.claim_next(
        board="main",
        assignee="codex-a",
        node_id="codex-a",
        ttl_seconds=300,
        task_id=task.id,
    )
    assert claimed is not None
    store.set_autopickup_global(board="main", enabled=True, kill_switch=False)
    store.set_node_autopickup_enabled(board="main", node="codex-a", enabled=True)
    store.set_execution_global(board="main", enabled=True)
    store.set_node_execution_enabled(board="main", node="codex-a", enabled=True)
    store.begin_guarded_execution(
        board="main",
        task_id=task.id,
        run_id=claimed.run_id,
        node="codex-a",
    )
    assert store.approve_execution(
        board="main",
        task_id=task.id,
        actor={"kind": "member", "id": "lead", "login": "lead", "role": "admin"},
    )
    token = store.issue_execution_dispatch_lease(
        board="main",
        task_id=task.id,
        run_id=claimed.run_id,
        node="codex-a",
        ttl_seconds=ttl_seconds,
    )
    assert token is not None
    return store, task.id, claimed.run_id, token


def _set_prepared_dispatch_env(
    monkeypatch: pytest.MonkeyPatch,
    *,
    store: SQLiteBoardStore,
    task_id: str,
    run_id: str,
    token: str | None,
) -> None:
    monkeypatch.setenv("GROVE_BOARD_DB", str(store.db_path()))
    monkeypatch.setenv("GROVE_BOARD_BOARD", "main")
    monkeypatch.setenv("GROVE_BOARD_TASK", task_id)
    monkeypatch.setenv("GROVE_BOARD_RUN_ID", run_id)
    monkeypatch.setenv("GROVE_PREPARED_DISPATCH_GUARDED", "1")
    if token is not None:
        monkeypatch.setenv("GROVE_EXECUTION_DISPATCH_LEASE", token)


def test_prepared_dispatch_revalidates_after_stdin_read_before_exec(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    store, task_id, run_id, token = _prepared_dispatch_lease(tmp_path)
    _set_prepared_dispatch_env(
        monkeypatch,
        store=store,
        task_id=task_id,
        run_id=run_id,
        token=token,
    )

    class KillOnRead(io.StringIO):
        def read(self, size: int | None = -1) -> str:
            value = super().read(size)
            store.set_execution_kill_switch(board="main", level="global", enabled=True)
            return value

    monkeypatch.setattr("grove_bridge.prepared_dispatch.sys.stdin", KillOnRead("prompt"))
    monkeypatch.setattr(
        "grove_bridge.prepared_dispatch.os.execvpe",
        lambda *args, **kwargs: pytest.fail("helper must not exec after kill flip"),
    )

    result = prepared_dispatch.main(
        ["--grove-binary", "grove-bin", "--node", "codex-a", "--timeout", "15m"]
    )

    assert result == prepared_dispatch.ABORT_EXIT_CODE
    assert store.task_execution_state(board="main", task_id=task_id)["state"] == "abort"


def test_prepared_dispatch_rejects_expired_lease(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    store, task_id, run_id, token = _prepared_dispatch_lease(tmp_path, ttl_seconds=0)
    _set_prepared_dispatch_env(
        monkeypatch,
        store=store,
        task_id=task_id,
        run_id=run_id,
        token=token,
    )
    monkeypatch.setattr("grove_bridge.prepared_dispatch.sys.stdin", io.StringIO("prompt"))
    monkeypatch.setattr(
        "grove_bridge.prepared_dispatch.os.execvpe",
        lambda *args, **kwargs: pytest.fail("helper must not exec with expired lease"),
    )

    result = prepared_dispatch.main(
        ["--grove-binary", "grove-bin", "--node", "codex-a", "--timeout", "15m"]
    )

    assert result == prepared_dispatch.ABORT_EXIT_CODE
    assert store.task_execution_state(board="main", task_id=task_id)["state"] == "abort"


def test_prepared_dispatch_rejects_missing_token_for_guarded_dispatch(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    store, task_id, run_id, _token = _prepared_dispatch_lease(tmp_path)
    _set_prepared_dispatch_env(
        monkeypatch,
        store=store,
        task_id=task_id,
        run_id=run_id,
        token=None,
    )
    monkeypatch.setattr("grove_bridge.prepared_dispatch.sys.stdin", io.StringIO("prompt"))
    monkeypatch.setattr(
        "grove_bridge.prepared_dispatch.os.execvpe",
        lambda *args, **kwargs: pytest.fail("helper must not exec without guarded token"),
    )

    result = prepared_dispatch.main(
        ["--grove-binary", "grove-bin", "--node", "codex-a", "--timeout", "15m"]
    )

    assert result == prepared_dispatch.ABORT_EXIT_CODE
    assert store.task_execution_state(board="main", task_id=task_id)["state"] == "abort"


def test_prepared_dispatch_consumes_lease_once(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    store, task_id, run_id, token = _prepared_dispatch_lease(tmp_path)
    _set_prepared_dispatch_env(
        monkeypatch,
        store=store,
        task_id=task_id,
        run_id=run_id,
        token=token,
    )

    assert store.consume_execution_dispatch_lease(
        board="main",
        task_id=task_id,
        run_id=run_id,
        node="codex-a",
        token=token,
    )
    monkeypatch.setattr("grove_bridge.prepared_dispatch.sys.stdin", io.StringIO("prompt"))
    monkeypatch.setattr(
        "grove_bridge.prepared_dispatch.os.execvpe",
        lambda *args, **kwargs: pytest.fail("helper must not reuse consumed lease"),
    )

    result = prepared_dispatch.main(
        ["--grove-binary", "grove-bin", "--node", "codex-a", "--timeout", "15m"]
    )

    assert result == prepared_dispatch.ABORT_EXIT_CODE
    state = store.task_execution_state(board="main", task_id=task_id)
    assert state["state"] == "abort"
    abort_reason = state["abort_reason"]
    assert isinstance(abort_reason, str)
    assert "dispatch-lease-consumed" in abort_reason


def test_prepared_dispatch_execs_after_valid_final_lease_check(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    store, task_id, run_id, token = _prepared_dispatch_lease(tmp_path)
    _set_prepared_dispatch_env(
        monkeypatch,
        store=store,
        task_id=task_id,
        run_id=run_id,
        token=token,
    )
    captured: dict[str, object] = {}

    class ExecCalled(Exception):
        pass

    def fake_execvpe(file: str, args: list[str], env: Mapping[str, str]) -> None:
        captured["file"] = file
        captured["args"] = args
        captured["env"] = dict(env)
        raise ExecCalled

    monkeypatch.setattr("grove_bridge.prepared_dispatch.sys.stdin", io.StringIO("prompt"))
    monkeypatch.setattr("grove_bridge.prepared_dispatch.os.execvpe", fake_execvpe)

    with pytest.raises(ExecCalled):
        prepared_dispatch.main(
            [
                "--grove-binary",
                "grove-bin",
                "--node",
                "codex-a",
                "--timeout",
                "15m",
                "--config",
                "fleet.grove.yaml",
            ]
        )

    assert captured["file"] == "grove-bin"
    assert captured["args"] == [
        "grove-bin",
        "ask",
        "codex-a",
        "prompt",
        "--config",
        "fleet.grove.yaml",
        "--timeout",
        "15m",
    ]
    state = store.task_execution_state(board="main", task_id=task_id)
    assert state["state"] == "executing"
    lease = state["dispatch_lease"]
    assert isinstance(lease, dict)
    assert isinstance(lease["consumed_at"], int)


class LeaseLostProcess:
    returncode: int | None = None

    def __init__(self) -> None:
        self.terminated = False
        self.prepared_stdin = PreparedStdin()
        self.stdin: PreparedStdin | None = self.prepared_stdin

    def communicate(self, timeout: float | None = None) -> tuple[str, str]:
        if not self.terminated:
            raise subprocess.TimeoutExpired(cmd="grove", timeout=timeout or 0.0)
        self.returncode = -15
        return "terminated stdout", "terminated stderr"

    def terminate(self) -> None:
        self.terminated = True

    def kill(self) -> None:
        self.returncode = -9


class PreparedAbortProcess:
    returncode: int | None = prepared_dispatch.ABORT_EXIT_CODE

    def __init__(self) -> None:
        self.prepared_stdin = PreparedStdin()
        self.stdin: PreparedStdin | None = self.prepared_stdin

    def communicate(self, timeout: float | None = None) -> tuple[str, str]:
        _ = timeout
        return "", f"{prepared_dispatch.ABORT_SENTINEL}: dispatch lease rejected"


def test_subprocess_runner_treats_helper_abort_as_lost_lease(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    process = PreparedAbortProcess()
    monkeypatch.setattr("grove_bridge.grove.subprocess.Popen", lambda *args, **kwargs: process)
    monkeypatch.setattr(
        "grove_bridge.grove.subprocess.run",
        lambda *args, **kwargs: pytest.fail("aborted helper must not probe session"),
    )

    result = SubprocessGroveRunner(grove_binary="grove-bin").run_task(
        node="worker",
        prompt="do the task",
        env={"GROVE_EXECUTION_DISPATCH_LEASE": "run:token"},
        lane=LaneConfig(assignee="worker", nodes=("worker",)),
        heartbeat=lambda: True,
    )

    assert result.lease_lost is True
    assert result.returncode == prepared_dispatch.ABORT_EXIT_CODE
    assert process.prepared_stdin.value == "do the task"


def test_runner_stops_process_when_heartbeat_reports_lost_lease() -> None:
    runner = SubprocessGroveRunner(heartbeat_interval_seconds=0)
    process = LeaseLostProcess()

    stdout, stderr, lease_lost = runner._communicate_with_heartbeat(
        cast(subprocess.Popen[str], process),
        lambda: False,
    )

    assert lease_lost is True
    assert stdout == "terminated stdout"
    assert stderr == "terminated stderr"
    assert process.terminated is True


class KillAfterTerminateProcess:
    returncode: int | None = None

    def __init__(self) -> None:
        self.terminated = False
        self.killed = False

    def communicate(self, timeout: float | None = None) -> tuple[str, str]:
        _ = timeout
        if not self.killed:
            raise subprocess.TimeoutExpired(cmd="grove", timeout=0.0)
        return "killed stdout", ""

    def terminate(self) -> None:
        self.terminated = True

    def kill(self) -> None:
        self.killed = True
        self.returncode = -9


def test_runner_kills_process_when_termination_timeout_expires() -> None:
    runner = SubprocessGroveRunner()
    process = KillAfterTerminateProcess()

    stdout, stderr = runner._terminate_after_lost_lease(cast(subprocess.Popen[str], process))

    assert stdout == "killed stdout"
    assert stderr == ""
    assert process.terminated is True
    assert process.killed is True


@pytest.mark.parametrize(
    "completed",
    [
        subprocess.CompletedProcess(args=["grove"], returncode=1, stdout="{}", stderr=""),
        subprocess.CompletedProcess(args=["grove"], returncode=0, stdout="not-json", stderr=""),
        subprocess.CompletedProcess(args=["grove"], returncode=0, stdout="[]", stderr=""),
        subprocess.CompletedProcess(
            args=["grove"],
            returncode=0,
            stdout='{"sessionId":123,"transcript":{}}',
            stderr="",
        ),
    ],
)
def test_probe_session_returns_none_for_invalid_session_payloads(
    monkeypatch: pytest.MonkeyPatch,
    completed: subprocess.CompletedProcess[str],
) -> None:
    monkeypatch.setattr("grove_bridge.grove.subprocess.run", lambda *args, **kwargs: completed)

    assert SubprocessGroveRunner()._probe_session(
        "worker", LaneConfig("worker", ("worker",)), {}
    ) == (None, None)


def test_probe_session_returns_none_on_subprocess_errors(monkeypatch: pytest.MonkeyPatch) -> None:
    def fail_run(*args: object, **kwargs: object) -> subprocess.CompletedProcess[str]:
        _ = (args, kwargs)
        raise OSError("missing grove")

    monkeypatch.setattr("grove_bridge.grove.subprocess.run", fail_run)

    assert SubprocessGroveRunner()._probe_session(
        "worker", LaneConfig("worker", ("worker",)), {}
    ) == (None, None)


def test_grove_result_helpers_cover_empty_and_failure_text() -> None:
    empty = GroveRunResult(
        node="worker",
        returncode=7,
        stdout="",
        stderr="",
        session_id=None,
        transcript_path=None,
        turn_id=None,
        tmux_pane=None,
    )
    failed = GroveRunResult(
        node="worker",
        returncode=2,
        stdout="stdout line",
        stderr="stderr first\nstderr second",
        session_id=None,
        transcript_path=None,
        turn_id=None,
        tmux_pane=None,
    )

    assert first_failure_line(empty) == "exit 7"
    assert first_failure_line(failed) == "stderr first"
    assert summarize_stdout("") == "grove ask completed with no output"
    assert summarize_stdout("  ok\n") == "ok"
    assert ensure_runner(object()) is not None
