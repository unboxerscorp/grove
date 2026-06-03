"""Subprocess runner for handing claimed board tasks to grove nodes."""

from __future__ import annotations

import json
import os
import subprocess
import sys
import time
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from typing import Protocol, cast

from grove_bridge.config import LaneConfig
from grove_bridge.prepared_dispatch import ABORT_EXIT_CODE, ABORT_SENTINEL


@dataclass(frozen=True)
class GroveRunResult:
    node: str
    returncode: int
    stdout: str
    stderr: str
    session_id: str | None
    transcript_path: str | None
    turn_id: str | None
    tmux_pane: str | None
    lease_lost: bool = False


class GroveRunnerProtocol(Protocol):
    def run_task(
        self,
        *,
        node: str,
        prompt: str,
        env: Mapping[str, str],
        lane: LaneConfig,
        heartbeat: Callable[[], bool],
        dispatch_gate: Callable[[], bool] | None = None,
    ) -> GroveRunResult: ...


class SubprocessGroveRunner:
    """Run ``grove ask`` and emit heartbeats while the subprocess is active."""

    def __init__(
        self,
        *,
        grove_binary: str = "grove",
        heartbeat_interval_seconds: int = 60,
        session_probe_timeout_seconds: float = 5.0,
    ) -> None:
        self.grove_binary = grove_binary
        self.heartbeat_interval_seconds = heartbeat_interval_seconds
        self.session_probe_timeout_seconds = session_probe_timeout_seconds

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
        cmd = self._prepared_dispatch_command(node=node, lane=lane)

        if dispatch_gate is not None and not dispatch_gate():
            return _lost_dispatch_result(node=node, stderr="dispatch gate blocked before start")
        merged_env = os.environ.copy()
        merged_env.update(env)
        if dispatch_gate is not None:
            merged_env["GROVE_PREPARED_DISPATCH_GUARDED"] = "1"
        proc = subprocess.Popen(
            cmd,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            env=merged_env,
        )
        self._release_prepared_dispatch(proc, prompt)
        stdout, stderr, lease_lost = self._communicate_with_heartbeat(proc, heartbeat)
        if _prepared_dispatch_aborted(proc.returncode, stderr):
            return GroveRunResult(
                node=node,
                returncode=proc.returncode if proc.returncode is not None else ABORT_EXIT_CODE,
                stdout=stdout,
                stderr=stderr,
                session_id=None,
                transcript_path=None,
                turn_id=None,
                tmux_pane=None,
                lease_lost=True,
            )
        if lease_lost:
            return GroveRunResult(
                node=node,
                returncode=proc.returncode if proc.returncode is not None else 1,
                stdout=stdout,
                stderr=stderr,
                session_id=None,
                transcript_path=None,
                turn_id=None,
                tmux_pane=None,
                lease_lost=True,
            )
        session_id, transcript_path = self._probe_session(node, lane, merged_env)
        return GroveRunResult(
            node=node,
            returncode=proc.returncode if proc.returncode is not None else 1,
            stdout=stdout,
            stderr=stderr,
            session_id=session_id,
            transcript_path=transcript_path,
            turn_id=None,
            tmux_pane=None,
        )

    def _communicate_with_heartbeat(
        self,
        proc: subprocess.Popen[str],
        heartbeat: Callable[[], bool],
    ) -> tuple[str, str, bool]:
        next_heartbeat = time.monotonic() + self.heartbeat_interval_seconds
        while True:
            timeout = max(0.1, min(1.0, next_heartbeat - time.monotonic()))
            try:
                stdout, stderr = proc.communicate(timeout=timeout)
                return stdout, stderr, False
            except subprocess.TimeoutExpired:
                if time.monotonic() >= next_heartbeat:
                    if not heartbeat():
                        stdout, stderr = self._terminate_after_lost_lease(proc)
                        return stdout, stderr, True
                    next_heartbeat = time.monotonic() + self.heartbeat_interval_seconds

    def _terminate_after_lost_lease(self, proc: subprocess.Popen[str]) -> tuple[str, str]:
        proc.terminate()
        try:
            return proc.communicate(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()
            return proc.communicate()

    def _probe_session(
        self,
        node: str,
        lane: LaneConfig,
        env: Mapping[str, str],
    ) -> tuple[str | None, str | None]:
        cmd = [self.grove_binary, "session", node]
        if lane.grove_config is not None:
            cmd.extend(["--config", lane.grove_config])
        try:
            proc = subprocess.run(
                cmd,
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
                text=True,
                env=dict(env),
                timeout=self.session_probe_timeout_seconds,
                check=False,
            )
        except (OSError, subprocess.SubprocessError):
            return None, None
        if proc.returncode != 0:
            return None, None
        try:
            payload = json.loads(proc.stdout)
        except json.JSONDecodeError:
            return None, None
        if not isinstance(payload, dict):
            return None, None
        session_id = payload.get("sessionId")
        transcript = payload.get("transcript")
        return (
            session_id if isinstance(session_id, str) else None,
            transcript if isinstance(transcript, str) else None,
        )

    def _prepared_dispatch_command(self, *, node: str, lane: LaneConfig) -> list[str]:
        return [
            sys.executable,
            "-m",
            "grove_bridge.prepared_dispatch",
            "--grove-binary",
            self.grove_binary,
            "--node",
            node,
            "--timeout",
            lane.timeout,
            *(["--config", lane.grove_config] if lane.grove_config is not None else []),
        ]

    def _release_prepared_dispatch(self, proc: subprocess.Popen[str], prompt: str) -> None:
        if proc.stdin is None:
            raise RuntimeError("prepared grove dispatch missing stdin pipe")
        proc.stdin.write(prompt)
        proc.stdin.close()
        proc.stdin = None


def _lost_dispatch_result(*, node: str, stderr: str) -> GroveRunResult:
    return GroveRunResult(
        node=node,
        returncode=1,
        stdout="",
        stderr=stderr,
        session_id=None,
        transcript_path=None,
        turn_id=None,
        tmux_pane=None,
        lease_lost=True,
    )


def _prepared_dispatch_aborted(returncode: int | None, stderr: str) -> bool:
    return returncode == ABORT_EXIT_CODE and ABORT_SENTINEL in stderr


def grove_metadata(result: GroveRunResult) -> dict[str, object]:
    return {
        "node": result.node,
        "returncode": result.returncode,
        "session": result.session_id,
        "grove_session_id": result.session_id,
        "transcript": result.transcript_path,
        "transcript_path": result.transcript_path,
        "turn_id": result.turn_id,
        "tmux_pane": result.tmux_pane,
        "lease_lost": result.lease_lost,
    }


def first_failure_line(result: GroveRunResult) -> str:
    text = result.stderr.strip() or result.stdout.strip()
    if not text:
        return f"exit {result.returncode}"
    return text.splitlines()[0][:400]


def summarize_stdout(stdout: str) -> str:
    stripped = stdout.strip()
    if stripped:
        return stripped
    return "grove ask completed with no output"


def ensure_runner(value: object) -> GroveRunnerProtocol:
    return cast(GroveRunnerProtocol, value)
