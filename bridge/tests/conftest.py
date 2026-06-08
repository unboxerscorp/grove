"""Shared pytest fixtures for the bridge test suite."""

from __future__ import annotations

import pytest


@pytest.fixture(autouse=True)
def _isolate_home_from_real_grove(
    monkeypatch: pytest.MonkeyPatch, tmp_path_factory: pytest.TempPathFactory
) -> None:
    """Point ``HOME`` at a fresh, empty per-test tmp dir so anything resolving
    ``~/.grove`` reads an **empty** home — never the operator's real ``~/.grove``.

    Bridge components resolve ``Path("~/.grove").expanduser()`` for the registry / persona /
    board. Without this isolation a test could read or mutate the operator's real
    ``~/.grove`` (live registry, board, config), causing flakiness and non-determinism.
    A *distinct* tmp dir
    (not the test's own ``tmp_path``) is used so it never collides with a test's fixtures.
    Tests that need a populated home set ``HOME`` themselves (which overrides this).
    """
    monkeypatch.setenv("HOME", str(tmp_path_factory.mktemp("home")))
