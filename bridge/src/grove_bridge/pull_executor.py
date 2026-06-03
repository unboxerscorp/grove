"""Pull ready Legacy kanban tasks into grove node pools."""

from __future__ import annotations

import argparse
import os
import time
from collections.abc import Callable, Generator, Mapping, Sequence
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol, cast, runtime_checkable

from grove_bridge.config import BridgeConfig, LaneConfig, load_bridge_config
from grove_bridge.grove import (
    GroveRunnerProtocol,
    GroveRunResult,
    SubprocessGroveRunner,
    first_failure_line,
    grove_metadata,
    summarize_stdout,
)
from grove_bridge.legacy import KanbanDbProtocol, KanbanTask, load_kanban_db


@runtime_checkable
class Closeable(Protocol):
    def close(self) -> None: ...


@dataclass
class TickResult:
    stale_released: int = 0
    scanned: int = 0
    claimed: int = 0
    claim_conflicts: int = 0
    completed: int = 0
    blocked: int = 0
    terminal_conflicts: int = 0
    runner_errors: int = 0


class NodePool:
    """Round-robin node selection for each assignee lane."""

    def __init__(self, lanes: Mapping[str, LaneConfig]) -> None:
        self._lanes = lanes
        self._next_index = {assignee: 0 for assignee in lanes}

    def acquire(self, lane: LaneConfig) -> str:
        index = self._next_index[lane.assignee] % len(lane.nodes)
        self._next_index[lane.assignee] = index + 1
        return lane.nodes[index]


class PullExecutor:
    """Single-process pull executor for grove-owned Legacy kanban lanes."""

    def __init__(
        self,
        *,
        config: BridgeConfig,
        kanban_db: object | None = None,
        grove_runner: GroveRunnerProtocol | None = None,
    ) -> None:
        self.config = config
        self.kanban_db = (
            load_kanban_db() if kanban_db is None else cast(KanbanDbProtocol, kanban_db)
        )
        self.grove_runner = grove_runner or SubprocessGroveRunner(
            grove_binary=config.grove_binary,
            heartbeat_interval_seconds=config.heartbeat_interval_seconds,
        )
        self.node_pool = NodePool(config.lanes)

    def run_once(self) -> TickResult:
        result = TickResult()
        remaining = self.config.max_tasks_per_tick
        for board in self.config.boards:
            if remaining <= 0:
                break
            with self._connect(board) as conn:
                result.stale_released += self.kanban_db.release_stale_claims(conn)
                for lane in self.config.lanes.values():
                    if remaining <= 0:
                        break
                    candidates = self.kanban_db.list_tasks(
                        conn,
                        assignee=lane.assignee,
                        status="ready",
                        limit=remaining,
                    )
                    result.scanned += len(candidates)
                    for candidate in candidates:
                        if remaining <= 0:
                            break
                        claimed = self.kanban_db.claim_task(
                            conn,
                            candidate.id,
                            ttl_seconds=self.config.claim_ttl_seconds,
                            claimer=self._claimer(task_id=candidate.id),
                        )
                        if claimed is None:
                            result.claim_conflicts += 1
                            continue
                        node = self.node_pool.acquire(lane)
                        result.claimed += 1
                        remaining -= 1
                        self._execute_claimed(
                            conn=conn,
                            board=board,
                            lane=lane,
                            node=node,
                            task=claimed,
                            tick=result,
                        )
        return result

    def run_forever(self, stop: Callable[[], bool] | None = None) -> None:
        should_stop = stop or (lambda: False)
        while not should_stop():
            self.run_once()
            time.sleep(self.config.poll_interval_seconds)

    @contextmanager
    def _connect(self, board: str) -> Generator[object, None, None]:
        conn = self.kanban_db.connect(board=board)
        try:
            yield conn
        finally:
            if isinstance(conn, Closeable):
                conn.close()

    def _execute_claimed(
        self,
        *,
        conn: object,
        board: str,
        lane: LaneConfig,
        node: str,
        task: KanbanTask,
        tick: TickResult,
    ) -> None:
        try:
            workspace = self._resolve_workspace(task, board=board)
            env = self._task_env(task, board=board, workspace=workspace)
            prompt = build_task_prompt(task, board=board, workspace=workspace, env=env)
            run = self.grove_runner.run_task(
                node=node,
                prompt=prompt,
                env=env,
                lane=lane,
                heartbeat=lambda: self._heartbeat(conn, task=task, node=node),
            )
        except Exception as exc:
            tick.runner_errors += 1
            self._block_after_failure(
                conn=conn,
                task=task,
                reason=f"grove bridge runner error for {node}: {exc}",
                comment=str(exc),
                tick=tick,
            )
            return

        if run.lease_lost:
            tick.terminal_conflicts += 1
            return

        if run.returncode == 0:
            summary = summarize_stdout(run.stdout)
            completed = self.kanban_db.complete_task(
                conn,
                task.id,
                result=run.stdout,
                summary=summary,
                metadata=grove_metadata(run),
                expected_run_id=task.current_run_id,
            )
            if completed:
                tick.completed += 1
            else:
                tick.terminal_conflicts += 1
            return

        failure_line = first_failure_line(run)
        self._block_after_failure(
            conn=conn,
            task=task,
            reason=f"grove ask failed for {node}: {failure_line}",
            comment=_failure_comment(run),
            tick=tick,
        )

    def _block_after_failure(
        self,
        *,
        conn: object,
        task: KanbanTask,
        reason: str,
        comment: str,
        tick: TickResult,
    ) -> None:
        blocked = self.kanban_db.block_task(
            conn,
            task.id,
            reason=reason,
            expected_run_id=task.current_run_id,
        )
        if blocked:
            self.kanban_db.add_comment(conn, task.id, "grove-bridge", comment)
            tick.blocked += 1
        else:
            tick.terminal_conflicts += 1

    def _heartbeat(self, conn: object, *, task: KanbanTask, node: str) -> bool:
        claim_ok = self.kanban_db.heartbeat_claim(
            conn,
            task.id,
            ttl_seconds=self.config.claim_ttl_seconds,
            claimer=task.claim_lock,
        )
        worker_ok = self.kanban_db.heartbeat_worker(
            conn,
            task.id,
            note=f"grove bridge running {node}",
            expected_run_id=task.current_run_id,
        )
        return claim_ok and worker_ok

    def _resolve_workspace(self, task: KanbanTask, *, board: str) -> Path:
        resolver = getattr(self.kanban_db, "resolve_workspace", None)
        if callable(resolver):
            resolved = cast(Callable[..., object], resolver)(task, board=board)
            if isinstance(resolved, Path):
                return resolved
            if isinstance(resolved, str):
                return Path(resolved)
            raise TypeError("resolve_workspace must return str or Path")
        if task.workspace_path is not None:
            return Path(task.workspace_path)
        return Path.cwd() / ".worktrees" / task.id

    def _task_env(self, task: KanbanTask, *, board: str, workspace: Path) -> dict[str, str]:
        env = {
            "LEGACY_KANBAN_TASK": task.id,
            "LEGACY_KANBAN_BOARD": board,
            "LEGACY_KANBAN_WORKSPACE": str(workspace),
            "LEGACY_KANBAN_ASSIGNEE": task.assignee or "",
            "LEGACY_KANBAN_WORKSPACE_KIND": task.workspace_kind,
        }
        if task.current_run_id is not None:
            env["LEGACY_KANBAN_RUN_ID"] = str(task.current_run_id)
        if task.claim_lock is not None:
            env["LEGACY_KANBAN_CLAIM_LOCK"] = task.claim_lock
        db_path = self._kanban_db_path(board)
        if db_path is not None:
            env["LEGACY_KANBAN_DB"] = db_path
        return env

    def _kanban_db_path(self, board: str) -> str | None:
        path_fn = getattr(self.kanban_db, "kanban_db_path", None)
        if not callable(path_fn):
            return None
        path = cast(Callable[..., object], path_fn)(board=board)
        return str(path)

    def _claimer(self, *, task_id: str) -> str:
        return f"grove-bridge:{os.getpid()}:{task_id}"


def build_task_prompt(
    task: KanbanTask,
    *,
    board: str,
    workspace: Path,
    env: Mapping[str, str],
) -> str:
    env_lines = "\n".join(f"{key}={value}" for key, value in sorted(env.items()))
    body = task.body.strip() if task.body else "(no body)"
    return (
        "You are executing a Legacy kanban task through grove.\n\n"
        f"Task: {task.id}\n"
        f"Board: {board}\n"
        f"Assignee lane: {task.assignee or '(unassigned)'}\n"
        f"Workspace: {workspace}\n\n"
        f"Title:\n{task.title}\n\n"
        f"Body:\n{body}\n\n"
        "Legacy environment values for this task:\n"
        f"{env_lines}\n\n"
        "Work in the resolved workspace when applicable. Return a concise handoff summary "
        "including changed files, verification commands, and remaining risks."
    )


def _failure_comment(run: GroveRunResult) -> str:
    parts = [f"grove node: {run.node}", f"exit code: {run.returncode}"]
    if run.stdout.strip():
        parts.append(f"stdout:\n{run.stdout.strip()}")
    if run.stderr.strip():
        parts.append(f"stderr:\n{run.stderr.strip()}")
    return "\n\n".join(parts)


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Run the grove Legacy kanban pull executor.")
    parser.add_argument("--config", required=True, help="path to bridge TOML config")
    parser.add_argument("--once", action="store_true", help="run one polling tick and exit")
    parser.add_argument(
        "--legacy-agent-path",
        help="optional path that contains legacy_cli/kanban_db.py",
    )
    args = parser.parse_args(argv)

    config = load_bridge_config(args.config)
    kanban_db = load_kanban_db(args.legacy_agent_path)
    executor = PullExecutor(config=config, kanban_db=kanban_db)
    if args.once:
        executor.run_once()
    else:
        executor.run_forever()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
