"""Configuration for the grove board pull executor."""

from __future__ import annotations

import tomllib
from collections.abc import Mapping
from dataclasses import dataclass, field
from pathlib import Path
from typing import cast

from grove_bridge.notifier import NotifierConfig


def default_board_db_path() -> Path:
    return Path("~/.grove/boards/board.db").expanduser()


@dataclass(frozen=True)
class LaneConfig:
    """Execution target for one board assignee node."""

    assignee: str
    nodes: tuple[str, ...]
    grove_config: str | None = None
    timeout: str = "30m"

    def __post_init__(self) -> None:
        if not self.assignee.strip():
            raise ValueError("lane assignee is required")
        if not self.nodes:
            raise ValueError(f"lane {self.assignee!r} must define at least one node")
        for node in self.nodes:
            if not node.strip():
                raise ValueError(f"lane {self.assignee!r} contains an empty node name")


@dataclass(frozen=True)
class AutoPickupNodeConfig:
    enabled: bool = False
    kill_switch: bool = False
    roles: tuple[str, ...] = ()
    capabilities: tuple[str, ...] = ()


@dataclass(frozen=True)
class AutonomousPickupConfig:
    enabled: bool = False
    kill_switch: bool = False
    cooldown_seconds: int = 300
    nodes: Mapping[str, AutoPickupNodeConfig] = field(default_factory=dict)

    def __post_init__(self) -> None:
        if self.cooldown_seconds < 0:
            raise ValueError("autonomous_pickup.cooldown_seconds must be non-negative")


@dataclass(frozen=True)
class BridgeConfig:
    """Runtime settings for one pull-executor daemon."""

    boards: tuple[str, ...]
    lanes: Mapping[str, LaneConfig]
    board_db_path: Path = field(default_factory=default_board_db_path)
    claim_ttl_seconds: int = 15 * 60
    heartbeat_interval_seconds: int = 60
    poll_interval_seconds: float = 5.0
    max_tasks_per_tick: int = 1
    grove_binary: str = "grove"
    notifier: NotifierConfig = field(default_factory=NotifierConfig)
    autonomous_pickup: AutonomousPickupConfig = field(default_factory=AutonomousPickupConfig)

    def __post_init__(self) -> None:
        if not self.boards:
            raise ValueError("at least one board is required")
        if not self.lanes:
            raise ValueError("at least one lane is required")
        if self.claim_ttl_seconds <= 0:
            raise ValueError("claim_ttl_seconds must be positive")
        if self.heartbeat_interval_seconds <= 0:
            raise ValueError("heartbeat_interval_seconds must be positive")
        if self.poll_interval_seconds <= 0:
            raise ValueError("poll_interval_seconds must be positive")
        if self.max_tasks_per_tick <= 0:
            raise ValueError("max_tasks_per_tick must be positive")
        if not self.grove_binary.strip():
            raise ValueError("grove_binary is required")
        object.__setattr__(self, "board_db_path", self.board_db_path.expanduser())


def load_bridge_config(path: str | Path) -> BridgeConfig:
    """Load bridge settings from a TOML file."""

    config_path = Path(path)
    with config_path.open("rb") as handle:
        raw = cast(dict[str, object], tomllib.load(handle))

    boards = _string_tuple(raw.get("boards", ["default"]), field="boards")
    lanes = _execution_targets(raw)

    return BridgeConfig(
        boards=boards,
        lanes=lanes,
        board_db_path=_path(
            raw.get("board_db_path", default_board_db_path()),
            field="board_db_path",
        ),
        claim_ttl_seconds=_positive_int(
            raw.get("claim_ttl_seconds", BridgeConfig.claim_ttl_seconds),
            field="claim_ttl_seconds",
        ),
        heartbeat_interval_seconds=_positive_int(
            raw.get("heartbeat_interval_seconds", BridgeConfig.heartbeat_interval_seconds),
            field="heartbeat_interval_seconds",
        ),
        poll_interval_seconds=_positive_float(
            raw.get("poll_interval_seconds", BridgeConfig.poll_interval_seconds),
            field="poll_interval_seconds",
        ),
        max_tasks_per_tick=_positive_int(
            raw.get("max_tasks_per_tick", BridgeConfig.max_tasks_per_tick),
            field="max_tasks_per_tick",
        ),
        grove_binary=_string(
            raw.get("grove_binary", BridgeConfig.grove_binary),
            field="grove_binary",
        ),
        notifier=_notifier_config(raw.get("notifier")),
        autonomous_pickup=_autonomous_pickup_config(raw.get("autonomous_pickup")),
    )


def _execution_targets(raw: Mapping[str, object]) -> dict[str, LaneConfig]:
    if raw.get("nodes") is not None:
        return _node_configs(
            raw.get("nodes"),
            grove_config=_optional_string(raw.get("grove_config"), field="grove_config"),
            timeout=_string(raw.get("timeout", "30m"), field="timeout"),
        )
    if raw.get("lanes") is not None:
        return _legacy_lane_configs(raw.get("lanes"))
    raise ValueError("nodes array or lanes table is required")


def _node_configs(
    value: object,
    *,
    grove_config: str | None,
    timeout: str,
) -> dict[str, LaneConfig]:
    nodes = _string_tuple(value, field="nodes")
    return {
        node: LaneConfig(
            assignee=node,
            nodes=(node,),
            grove_config=grove_config,
            timeout=timeout,
        )
        for node in nodes
    }


def _legacy_lane_configs(value: object) -> dict[str, LaneConfig]:
    if not isinstance(value, dict):
        raise ValueError("lanes table is required")

    lanes: dict[str, LaneConfig] = {}
    lane_items = cast(Mapping[str, object], value)
    for assignee, lane_value in lane_items.items():
        if not isinstance(lane_value, dict):
            raise ValueError(f"lane {assignee!r} must be a table")
        lane_raw = cast(Mapping[str, object], lane_value)
        for node in _string_tuple(lane_raw.get("nodes"), field=f"lanes.{assignee}.nodes"):
            lanes[node] = LaneConfig(
                assignee=node,
                nodes=(node,),
                grove_config=_optional_string(
                    lane_raw.get("grove_config"), field=f"lanes.{assignee}.grove_config"
                ),
                timeout=_string(
                    lane_raw.get("timeout", "30m"),
                    field=f"lanes.{assignee}.timeout",
                ),
            )
    return lanes


def _notifier_config(value: object) -> NotifierConfig:
    if value is None:
        return NotifierConfig()
    if not isinstance(value, dict):
        raise ValueError("notifier must be a table")
    raw = cast(Mapping[str, object], value)
    return NotifierConfig(
        enabled=_bool(raw.get("enabled", NotifierConfig.enabled), field="notifier.enabled"),
        dry_run=_bool(raw.get("dry_run", NotifierConfig.dry_run), field="notifier.dry_run"),
        channel_kind=_string(
            raw.get("channel_kind", NotifierConfig.channel_kind),
            field="notifier.channel_kind",
        ),
        room_id=_optional_string(raw.get("room_id"), field="notifier.room_id"),
    )


def _autonomous_pickup_config(value: object) -> AutonomousPickupConfig:
    if value is None:
        return AutonomousPickupConfig()
    if not isinstance(value, dict):
        raise ValueError("autonomous_pickup must be a table")
    raw = cast(Mapping[str, object], value)
    return AutonomousPickupConfig(
        enabled=_bool(
            raw.get("enabled", AutonomousPickupConfig.enabled),
            field="autonomous_pickup.enabled",
        ),
        kill_switch=_bool(
            raw.get("kill_switch", AutonomousPickupConfig.kill_switch),
            field="autonomous_pickup.kill_switch",
        ),
        cooldown_seconds=_non_negative_int(
            raw.get("cooldown_seconds", AutonomousPickupConfig.cooldown_seconds),
            field="autonomous_pickup.cooldown_seconds",
        ),
        nodes=_autonomous_node_configs(raw.get("nodes")),
    )


def _autonomous_node_configs(value: object) -> dict[str, AutoPickupNodeConfig]:
    if value is None:
        return {}
    if not isinstance(value, dict):
        raise ValueError("autonomous_pickup.nodes must be a table")
    raw_nodes = cast(Mapping[str, object], value)
    nodes: dict[str, AutoPickupNodeConfig] = {}
    for node, raw_config in raw_nodes.items():
        if not isinstance(raw_config, dict):
            raise ValueError(f"autonomous_pickup.nodes.{node} must be a table")
        raw = cast(Mapping[str, object], raw_config)
        nodes[node] = AutoPickupNodeConfig(
            enabled=_bool(
                raw.get("enabled", AutoPickupNodeConfig.enabled),
                field=f"{node}.enabled",
            ),
            kill_switch=_bool(
                raw.get("kill_switch", AutoPickupNodeConfig.kill_switch),
                field=f"{node}.kill_switch",
            ),
            roles=_optional_string_tuple(raw.get("roles"), field=f"{node}.roles"),
            capabilities=_optional_string_tuple(
                raw.get("capabilities"),
                field=f"{node}.capabilities",
            ),
        )
    return nodes


def _string_tuple(value: object, *, field: str) -> tuple[str, ...]:
    if not isinstance(value, list):
        raise ValueError(f"{field} must be a string array")
    items: list[str] = []
    for item in value:
        if not isinstance(item, str) or not item.strip():
            raise ValueError(f"{field} must contain only non-empty strings")
        items.append(item.strip())
    if not items:
        raise ValueError(f"{field} must not be empty")
    return tuple(items)


def _optional_string_tuple(value: object, *, field: str) -> tuple[str, ...]:
    if value is None:
        return ()
    return _string_tuple(value, field=field)


def _string(value: object, *, field: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{field} must be a non-empty string")
    return value.strip()


def _optional_string(value: object, *, field: str) -> str | None:
    if value is None:
        return None
    return _string(value, field=field)


def _path(value: object, *, field: str) -> Path:
    if isinstance(value, Path):
        return value.expanduser()
    if isinstance(value, str) and value.strip():
        return Path(value).expanduser()
    raise ValueError(f"{field} must be a non-empty path")


def _positive_int(value: object, *, field: str) -> int:
    if not isinstance(value, int) or isinstance(value, bool) or value <= 0:
        raise ValueError(f"{field} must be a positive integer")
    return value


def _non_negative_int(value: object, *, field: str) -> int:
    if not isinstance(value, int) or isinstance(value, bool) or value < 0:
        raise ValueError(f"{field} must be a non-negative integer")
    return value


def _positive_float(value: object, *, field: str) -> float:
    if not isinstance(value, (int, float)) or isinstance(value, bool) or value <= 0:
        raise ValueError(f"{field} must be a positive number")
    return float(value)


def _bool(value: object, *, field: str) -> bool:
    if not isinstance(value, bool):
        raise ValueError(f"{field} must be a boolean")
    return value
