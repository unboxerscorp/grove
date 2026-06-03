"""Pull ready grove board tasks into grove node pools."""

from __future__ import annotations

import argparse
import json
import os
import re
import time
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol

from grove_bridge.auth_status import redact_secret_text
from grove_bridge.config import BridgeConfig, LaneConfig, default_board_db_path, load_bridge_config
from grove_bridge.grove import (
    GroveRunnerProtocol,
    GroveRunResult,
    SubprocessGroveRunner,
    first_failure_line,
    grove_metadata,
    summarize_stdout,
)
from grove_bridge.notifier import NotifierProtocol, build_notifier
from grove_bridge.store import ClaimedTask, NotifySub, SQLiteBoardStore, Task

DEFAULT_SESSION = "dev10"
TMUX_PANE_RE = re.compile(r"^(?P<session>[A-Za-z0-9_.-]+):(?P<window>[0-9]+)\.(?P<pane>[0-9]+)$")


class BoardStoreProtocol(Protocol):
    def release_stale(
        self,
        *,
        board: str,
        now: int | None = None,
        limit: int | None = None,
    ) -> int: ...

    def list_tasks(
        self,
        *,
        board: str,
        status: str | None = None,
        assignee: str | None = None,
        limit: int | None = None,
    ) -> list[Task]: ...

    def claim_next(
        self,
        *,
        board: str,
        assignee: str,
        node_id: str,
        ttl_seconds: int,
    ) -> ClaimedTask | None: ...

    def resolve_workspace(self, *, board: str, task: Task) -> Path: ...

    def db_path(self) -> Path: ...

    def heartbeat(
        self,
        *,
        board: str,
        task_id: str,
        run_id: str,
        claim_lock: str,
        ttl_seconds: int,
    ) -> bool: ...

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
    ) -> bool: ...

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
    ) -> bool: ...

    def add_comment(
        self,
        *,
        board: str,
        task_id: str,
        author: str,
        body: str,
        metadata: Mapping[str, object] | None = None,
    ) -> object: ...

    def add_notify_sub(
        self,
        *,
        board: str,
        task_id: str,
        channel_kind: str,
        room_id: str,
        thread_id: str = "",
        user_id: str | None = None,
    ) -> NotifySub: ...


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

    def peek(self, lane: LaneConfig) -> str:
        index = self._next_index[lane.assignee] % len(lane.nodes)
        return lane.nodes[index]

    def advance(self, lane: LaneConfig) -> None:
        index = self._next_index[lane.assignee] % len(lane.nodes)
        self._next_index[lane.assignee] = index + 1


class PullExecutor:
    """Single-process pull executor for grove-owned board lanes."""

    def __init__(
        self,
        *,
        config: BridgeConfig,
        store: BoardStoreProtocol | None = None,
        grove_runner: GroveRunnerProtocol | None = None,
        notifier: NotifierProtocol | None = None,
    ) -> None:
        self.config = config
        self.store: BoardStoreProtocol = store or SQLiteBoardStore(config.board_db_path)
        self.grove_runner = grove_runner or SubprocessGroveRunner(
            grove_binary=config.grove_binary,
            heartbeat_interval_seconds=config.heartbeat_interval_seconds,
        )
        self.notifier = notifier or build_notifier(config.notifier)

    def run_once(self) -> TickResult:
        result = TickResult()
        remaining = self.config.max_tasks_per_tick
        for board in self.config.boards:
            if remaining <= 0:
                break
            result.stale_released += self.store.release_stale(board=board)
            for lane in self.config.lanes.values():
                if remaining <= 0:
                    break
                candidates = self.store.list_tasks(
                    board=board,
                    assignee=lane.assignee,
                    status="ready",
                    limit=remaining,
                )
                result.scanned += len(candidates)
                for _candidate in candidates:
                    if remaining <= 0:
                        break
                    node = _execution_node(lane)
                    claimed = self.store.claim_next(
                        board=board,
                        assignee=lane.assignee,
                        node_id=node,
                        ttl_seconds=self.config.claim_ttl_seconds,
                    )
                    if claimed is None:
                        result.claim_conflicts += 1
                        continue
                    result.claimed += 1
                    remaining -= 1
                    self._execute_claimed(
                        board=board,
                        lane=lane,
                        node=node,
                        claimed=claimed,
                        tick=result,
                    )
        return result

    def run_forever(self, stop: Callable[[], bool] | None = None) -> None:
        should_stop = stop or (lambda: False)
        while not should_stop():
            self.run_once()
            time.sleep(self.config.poll_interval_seconds)

    def _execute_claimed(
        self,
        *,
        board: str,
        lane: LaneConfig,
        node: str,
        claimed: ClaimedTask,
        tick: TickResult,
    ) -> None:
        task = claimed.task
        try:
            workspace = self.store.resolve_workspace(board=board, task=task)
            env = self._task_env(
                board=board,
                task=task,
                run_id=claimed.run_id,
                claim_lock=claimed.claim_lock,
                workspace=workspace,
            )
            prompt = build_task_prompt(task, board=board, workspace=workspace, env=env)
            run = self.grove_runner.run_task(
                node=node,
                prompt=prompt,
                env=env,
                lane=lane,
                heartbeat=lambda: self._heartbeat(board=board, claimed=claimed),
            )
        except Exception as exc:
            tick.runner_errors += 1
            safe_error = redact_secret_text(str(exc))
            self._block_after_failure(
                board=board,
                claimed=claimed,
                reason=f"grove runner error for {node}: {safe_error}",
                comment=safe_error,
                metadata={"node": node, "error": safe_error},
                tick=tick,
            )
            return

        if run.lease_lost:
            tick.terminal_conflicts += 1
            return

        if run.returncode == 0:
            safe_stdout = redact_secret_text(run.stdout)
            summary = summarize_stdout(safe_stdout)
            completed = self.store.complete(
                board=board,
                task_id=task.id,
                run_id=claimed.run_id,
                claim_lock=claimed.claim_lock,
                result=safe_stdout,
                summary=summary,
                metadata=grove_metadata(run),
            )
            if completed:
                tick.completed += 1
            else:
                tick.terminal_conflicts += 1
            return

        failure_line = redact_secret_text(first_failure_line(run))
        self._block_after_failure(
            board=board,
            claimed=claimed,
            reason=f"grove ask failed for {node}: {failure_line}",
            comment=_failure_comment(run),
            metadata=grove_metadata(run),
            tick=tick,
        )

    def _block_after_failure(
        self,
        *,
        board: str,
        claimed: ClaimedTask,
        reason: str,
        comment: str,
        metadata: Mapping[str, object],
        tick: TickResult,
    ) -> None:
        task = claimed.task
        needs_human = self.notifier.enabled
        blocked = self.store.block(
            board=board,
            task_id=task.id,
            run_id=claimed.run_id,
            claim_lock=claimed.claim_lock,
            reason=reason,
            metadata=metadata,
            needs_human=needs_human,
        )
        if blocked:
            self.store.add_comment(
                board=board,
                task_id=task.id,
                author="grove-bridge",
                body=comment,
            )
            if needs_human:
                sub = self.store.add_notify_sub(
                    board=board,
                    task_id=task.id,
                    channel_kind=self.notifier.channel_kind,
                    room_id=self.notifier.room_id,
                )
                self.notifier.notify_blocked(task=task, sub=sub)
            tick.blocked += 1
        else:
            tick.terminal_conflicts += 1

    def _heartbeat(self, *, board: str, claimed: ClaimedTask) -> bool:
        return self.store.heartbeat(
            board=board,
            task_id=claimed.task.id,
            run_id=claimed.run_id,
            claim_lock=claimed.claim_lock,
            ttl_seconds=self.config.claim_ttl_seconds,
        )

    def _task_env(
        self,
        *,
        board: str,
        task: Task,
        run_id: str,
        claim_lock: str,
        workspace: Path,
    ) -> dict[str, str]:
        return {
            "GROVE_BOARD_TASK": task.id,
            "GROVE_BOARD_RUN_ID": run_id,
            "GROVE_BOARD_BOARD": board,
            "GROVE_BOARD_WORKSPACE": str(workspace),
            "GROVE_BOARD_ASSIGNEE": task.assignee or "",
            "GROVE_BOARD_WORKSPACE_KIND": task.workspace_kind,
            "GROVE_BOARD_CLAIM_LOCK": claim_lock,
            "GROVE_BOARD_DB": str(self.store.db_path()),
        }


def build_task_prompt(
    task: Task,
    *,
    board: str,
    workspace: Path,
    env: Mapping[str, str],
) -> str:
    env_lines = "\n".join(f"{key}={value}" for key, value in sorted(env.items()))
    body = task.body.strip() if task.body else "(no body)"
    return (
        "You are executing a grove board task.\n\n"
        f"Task: {task.id}\n"
        f"Board: {board}\n"
        f"Assignee node: {task.assignee or '(unassigned)'}\n"
        f"Workspace: {workspace}\n\n"
        f"Title:\n{task.title}\n\n"
        f"Body:\n{body}\n\n"
        "Environment values for this task:\n"
        f"{env_lines}\n\n"
        "Work in the resolved workspace when applicable. Return a concise handoff summary "
        "including changed files, verification commands, and remaining risks."
    )


def _failure_comment(run: GroveRunResult) -> str:
    parts = [f"grove node: {run.node}", f"exit code: {run.returncode}"]
    if run.stdout.strip():
        parts.append(f"stdout:\n{redact_secret_text(run.stdout.strip())}")
    if run.stderr.strip():
        parts.append(f"stderr:\n{redact_secret_text(run.stderr.strip())}")
    return "\n\n".join(parts)


def _execution_node(lane: LaneConfig) -> str:
    return lane.nodes[0]


def build_session_config(
    *,
    session: str,
    boards: Sequence[str],
    board_db_path: Path,
    grove_home: Path,
    nodes: Sequence[str] | None = None,
    grove_config: str | None = None,
    claim_ttl_seconds: int = BridgeConfig.claim_ttl_seconds,
    heartbeat_interval_seconds: int = BridgeConfig.heartbeat_interval_seconds,
    poll_interval_seconds: float = BridgeConfig.poll_interval_seconds,
    max_tasks_per_tick: int = BridgeConfig.max_tasks_per_tick,
    grove_binary: str = BridgeConfig.grove_binary,
    timeout: str = "30m",
) -> BridgeConfig:
    selected_nodes = (
        tuple(nodes) if nodes is not None else _registry_node_names(grove_home, session)
    )
    if not selected_nodes:
        raise ValueError(f"no executable grove nodes found for session {session!r}")
    return BridgeConfig(
        boards=tuple(boards),
        lanes={
            node: LaneConfig(
                assignee=node,
                nodes=(node,),
                grove_config=grove_config,
                timeout=timeout,
            )
            for node in selected_nodes
        },
        board_db_path=board_db_path,
        claim_ttl_seconds=claim_ttl_seconds,
        heartbeat_interval_seconds=heartbeat_interval_seconds,
        poll_interval_seconds=poll_interval_seconds,
        max_tasks_per_tick=max_tasks_per_tick,
        grove_binary=grove_binary,
    )


def _registry_node_names(grove_home: Path, session: str) -> tuple[str, ...]:
    registry_path = grove_home.expanduser() / session / "registry.json"
    loaded = json.loads(registry_path.read_text(encoding="utf-8"))
    if not isinstance(loaded, dict):
        raise ValueError("invalid grove registry")
    raw_nodes = loaded.get("nodes")
    if not isinstance(raw_nodes, dict):
        raise ValueError("invalid grove registry")
    names: list[str] = []
    for key, value in raw_nodes.items():
        if not isinstance(key, str) or not isinstance(value, dict):
            continue
        raw_node = value
        name = raw_node.get("name")
        node_name = name if isinstance(name, str) and name.strip() else key
        pane = raw_node.get("tmux_pane")
        if isinstance(pane, str) and _is_lead_pane(pane, session=session):
            continue
        if isinstance(pane, str) and pane.strip():
            names.append(node_name.strip())
    return tuple(sorted(set(names)))


def _is_lead_pane(pane: str, *, session: str) -> bool:
    match = TMUX_PANE_RE.fullmatch(pane)
    if match is None or match.group("session") != session:
        return False
    return int(match.group("window")) == 0 and int(match.group("pane")) == 0


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Run the grove board pull executor.")
    parser.add_argument("--config", help="path to bridge TOML config")
    parser.add_argument(
        "--session",
        default=os.environ.get("GROVE_VIEWER_SESSION", DEFAULT_SESSION),
        help="grove tmux session whose registry supplies executable nodes",
    )
    parser.add_argument(
        "--board",
        action="append",
        dest="boards",
        help="board slug to poll; may be repeated",
    )
    parser.add_argument(
        "--board-db-path",
        type=Path,
        default=default_board_db_path(),
        help="path to grove board sqlite database",
    )
    parser.add_argument(
        "--grove-home",
        type=Path,
        default=Path(os.environ.get("GROVE_HOME", "~/.grove")).expanduser(),
        help="path to grove home containing session registries",
    )
    parser.add_argument("--node", action="append", dest="nodes", help="restrict to one node")
    parser.add_argument("--grove-config", help="grove CLI config passed to ask/session")
    parser.add_argument("--timeout", default="30m", help="timeout passed to grove ask")
    parser.add_argument("--once", action="store_true", help="run one polling tick and exit")
    args = parser.parse_args(argv)

    if args.config is not None:
        config = load_bridge_config(args.config)
    else:
        config = build_session_config(
            session=args.session,
            boards=tuple(args.boards or ["default"]),
            board_db_path=args.board_db_path,
            grove_home=args.grove_home,
            nodes=args.nodes,
            grove_config=args.grove_config,
            timeout=args.timeout,
        )
    store = SQLiteBoardStore(config.board_db_path)
    executor = PullExecutor(config=config, store=store, notifier=build_notifier(config.notifier))
    if args.once:
        executor.run_once()
    else:
        executor.run_forever()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
