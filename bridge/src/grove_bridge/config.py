"""Configuration for the Legacy kanban to grove bridge."""

from __future__ import annotations

import tomllib
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import cast


@dataclass(frozen=True)
class LaneConfig:
    """Mapping from one Legacy assignee lane to a grove node pool."""

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
class BridgeConfig:
    """Runtime settings for one pull-executor daemon."""

    boards: tuple[str, ...]
    lanes: Mapping[str, LaneConfig]
    claim_ttl_seconds: int = 15 * 60
    heartbeat_interval_seconds: int = 60
    poll_interval_seconds: float = 5.0
    max_tasks_per_tick: int = 1
    grove_binary: str = "grove"

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


def load_bridge_config(path: str | Path) -> BridgeConfig:
    """Load bridge settings from a TOML file."""

    config_path = Path(path)
    with config_path.open("rb") as handle:
        raw = cast(dict[str, object], tomllib.load(handle))

    boards = _string_tuple(raw.get("boards", ["default"]), field="boards")
    lanes = _lane_configs(raw.get("lanes"))

    return BridgeConfig(
        boards=boards,
        lanes=lanes,
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
    )


def _lane_configs(value: object) -> dict[str, LaneConfig]:
    if not isinstance(value, dict):
        raise ValueError("lanes table is required")

    lanes: dict[str, LaneConfig] = {}
    lane_items = cast(Mapping[str, object], value)
    for assignee, lane_value in lane_items.items():
        if not isinstance(lane_value, dict):
            raise ValueError(f"lane {assignee!r} must be a table")
        lane_raw = cast(Mapping[str, object], lane_value)
        lanes[assignee] = LaneConfig(
            assignee=assignee,
            nodes=_string_tuple(lane_raw.get("nodes"), field=f"lanes.{assignee}.nodes"),
            grove_config=_optional_string(
                lane_raw.get("grove_config"), field=f"lanes.{assignee}.grove_config"
            ),
            timeout=_string(lane_raw.get("timeout", "30m"), field=f"lanes.{assignee}.timeout"),
        )
    return lanes


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


def _string(value: object, *, field: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{field} must be a non-empty string")
    return value.strip()


def _optional_string(value: object, *, field: str) -> str | None:
    if value is None:
        return None
    return _string(value, field=field)


def _positive_int(value: object, *, field: str) -> int:
    if not isinstance(value, int) or isinstance(value, bool) or value <= 0:
        raise ValueError(f"{field} must be a positive integer")
    return value


def _positive_float(value: object, *, field: str) -> float:
    if not isinstance(value, (int, float)) or isinstance(value, bool) or value <= 0:
        raise ValueError(f"{field} must be a positive number")
    return float(value)
