from __future__ import annotations

import runpy

import pytest

import grove_bridge.pull_executor as pull_executor


def test_python_module_entrypoint_delegates_to_pull_executor_main(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(pull_executor, "main", lambda: 7)

    with pytest.raises(SystemExit) as exc:
        runpy.run_module("grove_bridge.__main__", run_name="__main__")

    assert exc.value.code == 7
