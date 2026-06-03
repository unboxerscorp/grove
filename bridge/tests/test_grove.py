from __future__ import annotations

import subprocess
from collections.abc import Mapping
from typing import cast

import pytest

from grove_bridge.config import LaneConfig
from grove_bridge.grove import (
    GroveRunResult,
    SubprocessGroveRunner,
    ensure_runner,
    first_failure_line,
    summarize_stdout,
)


class SuccessfulProcess:
    returncode = 0

    def communicate(self, timeout: float | None = None) -> tuple[str, str]:
        _ = timeout
        return "task stdout", ""


def test_subprocess_runner_invokes_grove_ask_and_probes_session(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    popen_calls: list[dict[str, object]] = []
    run_calls: list[dict[str, object]] = []

    def fake_popen(
        args: list[str],
        *,
        stdout: object,
        stderr: object,
        text: bool,
        env: Mapping[str, str],
    ) -> SuccessfulProcess:
        popen_calls.append(
            {
                "args": args,
                "stdout": stdout,
                "stderr": stderr,
                "text": text,
                "env": dict(env),
            }
        )
        return SuccessfulProcess()

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
    assert popen_calls[0]["args"] == [
        "grove-bin",
        "ask",
        "worker",
        "do the task",
        "--config",
        "fleet.grove.yaml",
        "--timeout",
        "15m",
    ]
    assert cast(dict[str, str], popen_calls[0]["env"])["GROVE_BOARD_TASK"] == "task-1"
    assert run_calls[0]["args"] == [
        "grove-bin",
        "session",
        "worker",
        "--config",
        "fleet.grove.yaml",
    ]
    assert run_calls[0]["timeout"] == 2.5


class LeaseLostProcess:
    returncode: int | None = None

    def __init__(self) -> None:
        self.terminated = False

    def communicate(self, timeout: float | None = None) -> tuple[str, str]:
        if not self.terminated:
            raise subprocess.TimeoutExpired(cmd="grove", timeout=timeout or 0.0)
        self.returncode = -15
        return "terminated stdout", "terminated stderr"

    def terminate(self) -> None:
        self.terminated = True

    def kill(self) -> None:
        self.returncode = -9


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
