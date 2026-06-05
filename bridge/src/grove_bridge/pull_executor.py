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
from typing import Protocol, cast

from grove_bridge.auth_status import redact_secret_text
from grove_bridge.config import (
    AutoPickupNodeConfig,
    BridgeConfig,
    LaneConfig,
    default_board_db_path,
    load_bridge_config,
)
from grove_bridge.context_pack import (
    ContextPackNode,
    context_pack_nodes_from_registry,
    prepend_grove_context_pack,
)
from grove_bridge.grove import (
    GroveRunnerProtocol,
    GroveRunResult,
    SubprocessGroveRunner,
    first_failure_line,
    grove_metadata,
    summarize_stdout,
)
from grove_bridge.notification_rules import (
    NotificationRoutingConfig,
    NotificationRuleRunner,
    notification_routing_config_from_mapping,
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
        assignee: str | None,
        node_id: str,
        ttl_seconds: int,
        task_id: str | None = None,
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

    def notification_routing_state(self, *, board: str) -> dict[str, object]: ...

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
    ) -> object: ...

    def last_autopickup_at(self, *, board: str, node: str) -> int | None: ...

    def node_autopickup_enabled(self, *, board: str, node: str) -> bool | None: ...

    def autopickup_global_state(self, *, board: str) -> Mapping[str, bool]: ...

    def execution_gate_state(
        self,
        *,
        board: str,
        node: str,
        task_id: str | None,
    ) -> Mapping[str, object]: ...

    def guarded_dispatch_gate_state(
        self,
        *,
        board: str,
        node: str,
        task_id: str | None,
    ) -> Mapping[str, object]: ...

    def begin_guarded_execution(
        self,
        *,
        board: str,
        task_id: str,
        run_id: str,
        node: str,
    ) -> Mapping[str, object]: ...

    def abort_execution(
        self,
        *,
        board: str,
        task_id: str,
        actor: Mapping[str, object],
        reason: str,
    ) -> bool: ...

    def hold_execution_for_gate(
        self,
        *,
        board: str,
        task_id: str,
        actor: Mapping[str, object],
        reason: str,
    ) -> bool: ...

    def try_mark_execution_executing(
        self,
        *,
        board: str,
        task_id: str,
        run_id: str,
        node: str,
    ) -> bool: ...

    def issue_execution_dispatch_lease(
        self,
        *,
        board: str,
        task_id: str,
        run_id: str,
        node: str,
        ttl_seconds: int = 30,
    ) -> str | None: ...

    def mark_execution_verify(
        self,
        *,
        board: str,
        task_id: str,
        run_id: str,
        node: str,
        passed: bool,
        summary: str | None = None,
    ) -> bool: ...


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
    autopicked: int = 0


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
        self.notification_rules = NotificationRuleRunner(
            store=cast(SQLiteBoardStore, self.store),
            notifier=self.notifier,
        )
        self._autopickup_last_at: dict[tuple[str, str], float] = {}

    def run_once(self) -> TickResult:
        result = TickResult()
        remaining = self.config.max_tasks_per_tick
        for board in self.config.boards:
            if remaining <= 0:
                break
            result.stale_released += self.store.release_stale(board=board)
            remaining = self._run_approved_guarded_executions(
                board=board,
                remaining=remaining,
                tick=result,
            )
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
                    if self._node_has_current_wip(board=board, node=node):
                        continue
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
                    self.store.begin_guarded_execution(
                        board=board,
                        task_id=claimed.task.id,
                        run_id=claimed.run_id,
                        node=node,
                    )
            remaining = self._run_autonomous_pickups(board=board, remaining=remaining, tick=result)
            self._poll_notifications(board=board)
        return result

    def _run_autonomous_pickups(
        self,
        *,
        board: str,
        remaining: int,
        tick: TickResult,
    ) -> int:
        pickup = self.config.autonomous_pickup
        if remaining <= 0 or not pickup.enabled or pickup.kill_switch:
            return remaining
        global_state = self.store.autopickup_global_state(board=board)
        if not global_state["enabled"] or global_state["kill_switch"]:
            return remaining
        now = time.time()
        ready_tasks = self.store.list_tasks(board=board, status="ready")
        for node, rule in pickup.nodes.items():
            if remaining <= 0:
                break
            lane = self.config.lanes.get(node)
            if lane is None:
                continue
            if not self._autopickup_node_allowed(board=board, node=node, rule=rule, now=now):
                continue
            for task in ready_tasks:
                if task.assignee is not None:
                    continue
                if not _autopickup_task_allowed(task, rule):
                    continue
                claimed = self.store.claim_next(
                    board=board,
                    assignee=None,
                    node_id=node,
                    ttl_seconds=self.config.claim_ttl_seconds,
                    task_id=task.id,
                )
                if claimed is None:
                    tick.claim_conflicts += 1
                    continue
                self.store.add_audit_event(
                    board=board,
                    kind="audit.task.autopickup",
                    actor={"kind": "node", "id": node, "login": node, "role": "none"},
                    action="autopickup",
                    target={"type": "task", "id": task.id, "node": node},
                    task_id=task.id,
                    run_id=claimed.run_id,
                    payload={
                        "roles": list(rule.roles),
                        "capabilities": list(rule.capabilities),
                    },
                    summary=task.title,
                )
                self._autopickup_last_at[(board, node)] = now
                tick.claimed += 1
                tick.autopicked += 1
                remaining -= 1
                self.store.begin_guarded_execution(
                    board=board,
                    task_id=claimed.task.id,
                    run_id=claimed.run_id,
                    node=node,
                )
                break
        return remaining

    def _run_approved_guarded_executions(
        self,
        *,
        board: str,
        remaining: int,
        tick: TickResult,
    ) -> int:
        if remaining <= 0:
            return remaining
        for task in self.store.list_tasks(board=board, status="running"):
            if remaining <= 0:
                break
            execution = _task_execution(task.metadata)
            if execution.get("state") != "approved" or execution.get("approved") is not True:
                continue
            node = _execution_metadata_node(execution, fallback=task.assignee)
            if node is None:
                continue
            lane = self.config.lanes.get(node)
            if lane is None or task.current_run_id is None or task.claim_lock is None:
                continue
            if not self._dispatch_gate_clear(board=board, node=node, task=task):
                continue
            claimed = ClaimedTask(
                task=task,
                run_id=task.current_run_id,
                claim_lock=task.claim_lock,
            )
            remaining -= 1
            self._execute_claimed(
                board=board,
                lane=lane,
                node=node,
                claimed=claimed,
                tick=tick,
            )
        return remaining

    def _dispatch_gate_blockers(self, *, board: str, node: str, task: Task) -> list[str]:
        gate = self.store.guarded_dispatch_gate_state(
            board=board,
            node=node,
            task_id=task.id,
        )
        blocked_by = list(_config_autopickup_blockers(self.config, board=board, node=node))
        raw_blocked = gate.get("blocked_by")
        if isinstance(raw_blocked, Sequence) and not isinstance(raw_blocked, str):
            blocked_by.extend(str(item) for item in raw_blocked)
        return blocked_by

    def _dispatch_gate_clear(self, *, board: str, node: str, task: Task) -> bool:
        if not _guarded_task(task):
            return True
        blocked_by = self._dispatch_gate_blockers(board=board, node=node, task=task)
        if not blocked_by:
            return True
        reason = "dispatch gate blocked: " + ",".join(blocked_by)
        actor = {"kind": "node", "id": node, "login": node, "role": "none"}
        if _blocked_by_kill_switch(blocked_by):
            self.store.abort_execution(
                board=board,
                task_id=task.id,
                actor=actor,
                reason=reason,
            )
        else:
            self.store.hold_execution_for_gate(
                board=board,
                task_id=task.id,
                actor=actor,
                reason=reason,
            )
        return False

    def _dispatch_start_clear(
        self,
        *,
        board: str,
        node: str,
        task: Task,
        claimed: ClaimedTask,
        env: dict[str, str],
    ) -> bool:
        if not self._dispatch_gate_clear(board=board, node=node, task=task):
            return False
        token = self.store.issue_execution_dispatch_lease(
            board=board,
            task_id=task.id,
            run_id=claimed.run_id,
            node=node,
            ttl_seconds=max(1, min(30, self.config.claim_ttl_seconds)),
        )
        if token is None:
            return False
        env["GROVE_EXECUTION_DISPATCH_LEASE"] = token
        return True

    def _autopickup_node_allowed(
        self,
        *,
        board: str,
        node: str,
        rule: AutoPickupNodeConfig,
        now: float,
    ) -> bool:
        configured_enabled = self.store.node_autopickup_enabled(board=board, node=node)
        enabled = configured_enabled if configured_enabled is not None else rule.enabled
        if not enabled or rule.kill_switch:
            return False
        if not rule.roles and not rule.capabilities:
            return False
        key = (board, node)
        last = self._autopickup_last_at.get(key)
        persisted = self.store.last_autopickup_at(board=board, node=node)
        if persisted is not None and (last is None or persisted > last):
            last = float(persisted)
            self._autopickup_last_at[key] = last
        if last is not None and now - last < self.config.autonomous_pickup.cooldown_seconds:
            return False
        return not self._node_has_current_wip(board=board, node=node)

    def _node_has_current_wip(self, *, board: str, node: str) -> bool:
        running = self.store.list_tasks(board=board, status="running", assignee=node, limit=10)
        return any(
            task.current_run_id is not None and task.claim_lock is not None for task in running
        )

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
            prompt_context = _prompt_context_for_lane(
                lane,
                fallback_project=board,
                target_node=task.assignee,
            )
            prompt = build_task_prompt(
                task,
                board=board,
                workspace=workspace,
                env=env,
                nodes=prompt_context.nodes,
                project=prompt_context.project,
                target_role=prompt_context.target_role,
            )
            if not self._dispatch_gate_clear(board=board, node=node, task=task):
                return
            run = self.grove_runner.run_task(
                node=node,
                prompt=prompt,
                env=env,
                lane=lane,
                heartbeat=lambda: self._heartbeat_guarded(
                    board=board,
                    node=node,
                    claimed=claimed,
                ),
                dispatch_gate=lambda: self._dispatch_start_clear(
                    board=board,
                    node=node,
                    task=task,
                    claimed=claimed,
                    env=env,
                ),
            )
        except Exception as exc:
            tick.runner_errors += 1
            safe_error = redact_secret_text(str(exc))
            if _guarded_task(task):
                self.store.mark_execution_verify(
                    board=board,
                    task_id=task.id,
                    run_id=claimed.run_id,
                    node=node,
                    passed=False,
                    summary=safe_error,
                )
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
            if _guarded_task(task):
                self.store.mark_execution_verify(
                    board=board,
                    task_id=task.id,
                    run_id=claimed.run_id,
                    node=node,
                    passed=True,
                    summary=summary,
                )
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
                if _guarded_task(task):
                    self.store.add_audit_event(
                        board=board,
                        kind="audit.execution.complete",
                        actor={"kind": "node", "id": node, "login": node, "role": "none"},
                        action="complete",
                        target={"type": "task", "id": task.id, "node": node},
                        task_id=task.id,
                        run_id=claimed.run_id,
                        summary=summary,
                    )
            else:
                tick.terminal_conflicts += 1
            return

        failure_line = redact_secret_text(first_failure_line(run))
        if _guarded_task(task):
            self.store.mark_execution_verify(
                board=board,
                task_id=task.id,
                run_id=claimed.run_id,
                node=node,
                passed=False,
                summary=failure_line,
            )
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
            self._poll_notifications(board=board)
            tick.blocked += 1
        else:
            tick.terminal_conflicts += 1

    def _poll_notifications(self, *, board: str) -> int:
        routing = self._notification_routing_config(board=board)
        return self.notification_rules.poll_board(board, routing=routing)

    def _notification_routing_config(
        self,
        *,
        board: str,
    ) -> NotificationRoutingConfig | None:
        state = self.store.notification_routing_state(board=board)
        if state.get("configured") is not True:
            return None
        return notification_routing_config_from_mapping(state)

    def _heartbeat(self, *, board: str, claimed: ClaimedTask) -> bool:
        return self.store.heartbeat(
            board=board,
            task_id=claimed.task.id,
            run_id=claimed.run_id,
            claim_lock=claimed.claim_lock,
            ttl_seconds=self.config.claim_ttl_seconds,
        )

    def _heartbeat_guarded(self, *, board: str, node: str, claimed: ClaimedTask) -> bool:
        if _guarded_task(claimed.task):
            blocked_by = self._dispatch_gate_blockers(board=board, node=node, task=claimed.task)
            if blocked_by:
                reason = "guarded heartbeat gate blocked: " + ",".join(blocked_by)
                self.store.abort_execution(
                    board=board,
                    task_id=claimed.task.id,
                    actor={"kind": "node", "id": node, "login": node, "role": "none"},
                    reason=reason,
                )
                return False
        return self._heartbeat(board=board, claimed=claimed)

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
    nodes: Sequence[ContextPackNode] = (),
    project: str | None = None,
    target_role: str | None = None,
) -> str:
    env_lines = "\n".join(f"{key}={value}" for key, value in sorted(env.items()))
    body = task.body.strip() if task.body else "(no body)"
    prompt = (
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
    return prepend_grove_context_pack(
        prompt,
        caller_node="grove pull executor",
        nodes=nodes,
        project=project or board,
        target_node=task.assignee,
        target_role=target_role,
    )


@dataclass(frozen=True)
class PromptContext:
    project: str
    nodes: tuple[ContextPackNode, ...] = ()
    target_role: str | None = None


def _prompt_context_for_lane(
    lane: LaneConfig,
    *,
    fallback_project: str,
    target_node: str | None,
) -> PromptContext:
    loaded = _load_prompt_registry(lane.grove_config)
    if loaded is None:
        return PromptContext(project=fallback_project)
    project, nodes = loaded
    return PromptContext(
        nodes=nodes,
        project=project or fallback_project,
        target_role=_prompt_target_role(nodes, target_node),
    )


def _prompt_target_role(
    nodes: Sequence[ContextPackNode],
    target_node: str | None,
) -> str | None:
    if target_node is None:
        return None
    for node in nodes:
        if node.name == target_node:
            return node.role
    return None


def _load_prompt_registry(
    grove_config: str | None,
) -> tuple[str, tuple[ContextPackNode, ...]] | None:
    if grove_config is None or not grove_config.strip():
        return None
    config_path = Path(grove_config).expanduser()
    session = _session_from_grove_config(config_path)
    candidates: list[Path] = []
    if config_path.is_file():
        candidates.append(config_path.with_name("registry.json"))
    if session is not None:
        candidates.append(Path("~/.grove").expanduser() / session / "registry.json")
    for registry_path in candidates:
        loaded = _load_prompt_registry_file(registry_path)
        if loaded is not None:
            registry_session, nodes = loaded
            return registry_session or session or "", nodes
    return None


def _session_from_grove_config(config_path: Path) -> str | None:
    try:
        text = config_path.read_text(encoding="utf-8")
    except OSError:
        return None
    match = re.search(r"(?m)^\s*session\s*:\s*['\"]?([A-Za-z0-9_-]+)['\"]?\s*$", text)
    return None if match is None else match.group(1)


def _load_prompt_registry_file(
    registry_path: Path,
) -> tuple[str, tuple[ContextPackNode, ...]] | None:
    try:
        loaded = json.loads(registry_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    if not isinstance(loaded, Mapping):
        return None
    raw_nodes = loaded.get("nodes")
    if not isinstance(raw_nodes, Mapping):
        return None
    raw_session = loaded.get("session")
    session = raw_session if isinstance(raw_session, str) else ""
    return session, context_pack_nodes_from_registry(raw_nodes)


def _failure_comment(run: GroveRunResult) -> str:
    parts = [f"grove node: {run.node}", f"exit code: {run.returncode}"]
    if run.stdout.strip():
        parts.append(f"stdout:\n{redact_secret_text(run.stdout.strip())}")
    if run.stderr.strip():
        parts.append(f"stderr:\n{redact_secret_text(run.stderr.strip())}")
    return "\n\n".join(parts)


def _execution_node(lane: LaneConfig) -> str:
    return lane.nodes[0]


def _autopickup_task_allowed(task: Task, rule: AutoPickupNodeConfig) -> bool:
    if _truthy_metadata(task.metadata, "despawn") or _truthy_metadata(task.metadata, "repair"):
        return False
    roles = _metadata_values(task.metadata, "role", "roles")
    capabilities = _metadata_values(task.metadata, "capability", "capabilities")
    return bool(set(rule.roles) & roles or set(rule.capabilities) & capabilities)


def _task_execution(metadata: Mapping[str, object]) -> Mapping[str, object]:
    raw = metadata.get("execution")
    return raw if isinstance(raw, Mapping) else {}


def _guarded_task(task: Task) -> bool:
    return bool(_task_execution(task.metadata))


def _execution_metadata_node(
    execution: Mapping[str, object],
    *,
    fallback: str | None,
) -> str | None:
    node = execution.get("node")
    if isinstance(node, str) and node.strip():
        return node.strip()
    if fallback is not None and fallback.strip():
        return fallback.strip()
    return None


def _config_autopickup_blockers(
    config: BridgeConfig,
    *,
    board: str,
    node: str,
) -> tuple[str, ...]:
    del board
    pickup = config.autonomous_pickup
    blocked: list[str] = []
    if not pickup.enabled:
        blocked.append("autopickup-config-disabled")
    if pickup.kill_switch:
        blocked.append("autopickup-config-kill-switch")
    rule = pickup.nodes.get(node)
    if rule is None:
        blocked.append("autopickup-node-unconfigured")
    elif rule.kill_switch:
        blocked.append("autopickup-node-kill-switch")
    return tuple(blocked)


def _blocked_by_kill_switch(blocked_by: Sequence[str]) -> bool:
    return any("kill-switch" in item for item in blocked_by)


def _truthy_metadata(metadata: Mapping[str, object], key: str) -> bool:
    value = metadata.get(key)
    return isinstance(value, bool) and value


def _metadata_values(metadata: Mapping[str, object], *keys: str) -> set[str]:
    values: set[str] = set()
    for key in keys:
        value = metadata.get(key)
        if isinstance(value, str) and value.strip():
            values.add(value.strip())
        elif isinstance(value, Sequence) and not isinstance(value, str):
            for item in value:
                if isinstance(item, str) and item.strip():
                    values.add(item.strip())
    return values


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
