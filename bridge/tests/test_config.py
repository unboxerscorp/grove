from __future__ import annotations

from collections.abc import Callable
from pathlib import Path

import pytest

from grove_bridge.config import BridgeConfig, LaneConfig, load_bridge_config


def test_load_bridge_config_supports_legacy_lane_tables(tmp_path: Path) -> None:
    config_path = tmp_path / "bridge.toml"
    config_path.write_text(
        """
boards = ["main"]

[lanes.review]
nodes = ["codex-a", "codex-b"]
grove_config = "review.grove.yaml"
timeout = "10m"
""".strip(),
        encoding="utf-8",
    )

    config = load_bridge_config(config_path)

    assert config.boards == ("main",)
    assert sorted(config.lanes) == ["codex-a", "codex-b"]
    assert config.lanes["codex-a"].assignee == "codex-a"
    assert config.lanes["codex-a"].nodes == ("codex-a",)
    assert config.lanes["codex-a"].grove_config == "review.grove.yaml"
    assert config.lanes["codex-a"].timeout == "10m"
    assert config.notifier.enabled is False


@pytest.mark.parametrize(
    ("factory", "message"),
    [
        (lambda: LaneConfig(assignee=" ", nodes=("codex-a",)), "lane assignee"),
        (lambda: LaneConfig(assignee="codex-a", nodes=()), "at least one node"),
        (lambda: LaneConfig(assignee="codex-a", nodes=(" ",)), "empty node name"),
        (
            lambda: BridgeConfig(boards=(), lanes={"codex-a": LaneConfig("codex-a", ("codex-a",))}),
            "at least one board",
        ),
        (
            lambda: BridgeConfig(boards=("main",), lanes={}),
            "at least one lane",
        ),
        (
            lambda: BridgeConfig(
                boards=("main",),
                lanes={"codex-a": LaneConfig("codex-a", ("codex-a",))},
                claim_ttl_seconds=0,
            ),
            "claim_ttl_seconds",
        ),
        (
            lambda: BridgeConfig(
                boards=("main",),
                lanes={"codex-a": LaneConfig("codex-a", ("codex-a",))},
                heartbeat_interval_seconds=0,
            ),
            "heartbeat_interval_seconds",
        ),
        (
            lambda: BridgeConfig(
                boards=("main",),
                lanes={"codex-a": LaneConfig("codex-a", ("codex-a",))},
                poll_interval_seconds=0,
            ),
            "poll_interval_seconds",
        ),
        (
            lambda: BridgeConfig(
                boards=("main",),
                lanes={"codex-a": LaneConfig("codex-a", ("codex-a",))},
                max_tasks_per_tick=0,
            ),
            "max_tasks_per_tick",
        ),
        (
            lambda: BridgeConfig(
                boards=("main",),
                lanes={"codex-a": LaneConfig("codex-a", ("codex-a",))},
                grove_binary=" ",
            ),
            "grove_binary",
        ),
    ],
)
def test_config_dataclasses_reject_invalid_runtime_values(
    factory: Callable[[], object],
    message: str,
) -> None:
    with pytest.raises(ValueError, match=message):
        factory()


@pytest.mark.parametrize(
    ("body", "message"),
    [
        ('boards = ["main"]', "nodes array or lanes table"),
        ('boards = ["main"]\nnodes = "codex-a"', "nodes must be a string array"),
        ('boards = ["main"]\nnodes = []', "nodes must not be empty"),
        ('boards = ["main"]\nnodes = [" "]', "nodes must contain"),
        ('boards = ["main"]\nnodes = ["codex-a"]\nboard_db_path = ""', "board_db_path"),
        ('boards = ["main"]\nnodes = ["codex-a"]\nclaim_ttl_seconds = false', "positive integer"),
        (
            'boards = ["main"]\nnodes = ["codex-a"]\npoll_interval_seconds = false',
            "positive number",
        ),
        ('boards = ["main"]\nnodes = ["codex-a"]\nnotifier = "bad"', "notifier must be a table"),
        (
            'boards = ["main"]\nnodes = ["codex-a"]\n[notifier]\nenabled = "yes"',
            "notifier.enabled",
        ),
        ('boards = ["main"]\nlanes = "bad"', "lanes table"),
        ('boards = ["main"]\n[lanes.codex]\nnodes = "bad"', "lanes.codex.nodes"),
    ],
)
def test_load_bridge_config_rejects_invalid_toml(
    tmp_path: Path,
    body: str,
    message: str,
) -> None:
    config_path = tmp_path / "bridge.toml"
    config_path.write_text(body, encoding="utf-8")

    with pytest.raises(ValueError, match=message):
        load_bridge_config(config_path)
