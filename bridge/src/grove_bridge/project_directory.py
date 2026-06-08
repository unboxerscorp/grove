"""Single source of project identity for the Python web/chat/API layer.

`board` is the internal registry/session routing key (e.g. "dev10") — the value
behind X-Grove-Project, the tmux session, and the registry path. `display_name`
is the user-facing project identity (e.g. "grove-dev"). Only display_name is ever
shown to a human; the board name must never surface as the project name (that was
the "dev10 프로젝트" chatbot leak).

Low-level: depends only on the filesystem + registry JSON, so web_app, slack,
pull_executor, and assistant can all consume it without import cycles.
"""

from __future__ import annotations

import json
from collections.abc import Iterator, Mapping
from dataclasses import dataclass
from pathlib import Path

_DISPLAY_KEYS = ("display_name", "displayName", "title")


@dataclass(frozen=True)
class ProjectEntry:
    """A visible project. `board` = internal routing key; `display_name` = the
    user-facing identity (the only field shown to humans)."""

    board: str
    display_name: str


class ProjectDirectory:
    def __init__(self, grove_home: Path, *, default_session: str) -> None:
        self._grove_home = grove_home
        self._default_session = default_session

    def list_projects(self) -> list[ProjectEntry]:
        """Visible projects as (display_name, board), sorted by display_name.
        Internal registries (.master, dot/underscore-prefixed) are excluded."""
        if not self._grove_home.is_dir():
            return []
        entries = [
            ProjectEntry(board=board, display_name=self._display_for(board, registry))
            for board, registry in self._iter_registries()
        ]
        return sorted(entries, key=lambda entry: entry.display_name)

    def resolve(self, ref: str) -> str | None:
        """display_name (or board) → internal board, or None when unknown / not
        visible. Callers reject None as out of scope."""
        cleaned = (ref or "").strip()
        if not cleaned:
            return None
        for entry in self.list_projects():
            if cleaned in (entry.display_name, entry.board):
                return entry.board
        return None

    def display_name(self, board: str) -> str:
        """Internal board/session → user-facing display name."""
        return self._display_for(board, self._load_registry(board))

    # --- internals -----------------------------------------------------------
    def _iter_registries(self) -> Iterator[tuple[str, Mapping[str, object]]]:
        for path in self._grove_home.glob("*/registry.json"):
            board = path.parent.name
            if _is_visible_board(board):
                yield board, _load_registry_path(path)

    def _load_registry(self, board: str) -> Mapping[str, object]:
        return _load_registry_path(self._grove_home / board / "registry.json")

    def _display_for(self, board: str, registry: Mapping[str, object]) -> str:
        explicit = _display_from_mapping(registry)
        if explicit is not None:
            return explicit
        nested = registry.get("project")
        if isinstance(nested, Mapping):
            explicit = _display_from_mapping(nested)
            if explicit is not None:
                return explicit
        # Migration label for the default session until its registry carries a
        # display_name; every other project falls back to its board name (never
        # the literal word "project").
        if board == self._default_session:
            return "grove-dev"
        return board


def _is_visible_board(board: str) -> bool:
    return bool(board) and not board.startswith((".", "_"))


def _load_registry_path(path: Path) -> Mapping[str, object]:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, Mapping) else {}


def _display_from_mapping(mapping: Mapping[str, object]) -> str | None:
    for key in _DISPLAY_KEYS:
        value = mapping.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return None
