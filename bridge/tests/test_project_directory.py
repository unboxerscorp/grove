from __future__ import annotations

import json
from pathlib import Path

from grove_bridge.project_directory import ProjectDirectory


def _write(home: Path, board: str, **keys: object) -> None:
    directory = home / board
    directory.mkdir(parents=True, exist_ok=True)
    (directory / "registry.json").write_text(
        json.dumps({"session": board, "nodes": {}, **keys}), encoding="utf-8"
    )


def test_list_projects_renders_display_names_and_hides_internal(tmp_path: Path) -> None:
    _write(tmp_path, "dev10")  # default session → grove-dev
    _write(tmp_path, "base-web-admin", display_name="Base Web Admin")
    _write(tmp_path, "dev11")  # no display_name → board name
    _write(tmp_path, ".master")  # internal — hidden
    _write(tmp_path, "_scratch")  # internal — hidden

    directory = ProjectDirectory(tmp_path, default_session="dev10")
    got = [(e.display_name, e.board) for e in directory.list_projects()]

    assert got == sorted(got)  # sorted by display_name
    assert ("grove-dev", "dev10") in got
    assert ("Base Web Admin", "base-web-admin") in got
    assert ("dev11", "dev11") in got
    assert all(board not in (".master", "_scratch") for _, board in got)


def test_resolve_by_display_or_board_else_none(tmp_path: Path) -> None:
    _write(tmp_path, "dev10")
    directory = ProjectDirectory(tmp_path, default_session="dev10")

    assert directory.resolve("grove-dev") == "dev10"  # display → internal board
    assert directory.resolve("dev10") == "dev10"  # board ref also resolves
    assert directory.resolve("nope") is None  # unknown → None (scope-guard rejects)
    assert directory.resolve("") is None


def test_display_name_default_registry_and_fallback(tmp_path: Path) -> None:
    _write(tmp_path, "dev10")
    _write(tmp_path, "alpha", display_name="Alpha")
    directory = ProjectDirectory(tmp_path, default_session="dev10")

    assert directory.display_name("dev10") == "grove-dev"  # default-session migration label
    assert directory.display_name("alpha") == "Alpha"  # registry display_name wins
    assert (
        directory.display_name("dev99") == "dev99"
    )  # no registry → board name (never leaks "project")


def test_missing_grove_home_is_empty(tmp_path: Path) -> None:
    directory = ProjectDirectory(tmp_path / "absent", default_session="dev10")
    assert directory.list_projects() == []
    assert directory.resolve("grove-dev") is None
