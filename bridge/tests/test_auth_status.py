from __future__ import annotations

import subprocess
from collections.abc import Sequence
from pathlib import Path

import pytest

from grove_bridge.auth_status import (
    AUTH_STATUS_TIMEOUT_SECONDS,
    AuthStatusChecker,
    ToolAuthStatus,
    keychain_cloudflare_token_exists,
)


def test_auth_status_checker_reports_cli_env_and_file_states(tmp_path: Path) -> None:
    calls: list[list[str]] = []
    codex_home = tmp_path / ".codex"
    codex_home.mkdir()
    (codex_home / "auth.json").write_text('{"refresh_token":"codex-secret"}', encoding="utf-8")

    def fake_run(
        args: Sequence[str],
        *,
        capture_output: bool,
        text: bool,
        timeout: float,
        check: bool,
    ) -> subprocess.CompletedProcess[str]:
        calls.append(list(args))
        assert capture_output is True
        assert text is True
        assert timeout == AUTH_STATUS_TIMEOUT_SECONDS
        assert check is False
        if list(args) == ["gh", "auth", "status"]:
            return subprocess.CompletedProcess(
                args=list(args),
                returncode=0,
                stdout="github.com\n  Logged in to github.com account chopin\n",
                stderr="",
            )
        if list(args) == ["claude", "auth", "status"]:
            return subprocess.CompletedProcess(
                args=list(args),
                returncode=1,
                stdout="",
                stderr="not logged in",
            )
        raise FileNotFoundError(args[0])

    checker = AuthStatusChecker(
        env={"ANTIGRAVITY_API_KEY": "agy-secret", "CLOUDFLARE_API_TOKEN": "cf-secret"},
        home=tmp_path,
        command_runner=fake_run,
        keychain_checker=lambda: False,
    )

    statuses = checker.check_all()
    by_tool = {status.tool: status for status in statuses}
    rendered = str([status.to_payload() for status in statuses])

    assert [status.tool for status in statuses] == ["codex", "claude", "agy", "gh", "cf"]
    assert by_tool["gh"].authed is True
    assert "github.com" in by_tool["gh"].detail
    assert "chopin" in by_tool["gh"].detail
    assert by_tool["codex"].authed is True
    assert by_tool["codex"].detail == "auth.json present"
    assert by_tool["claude"].authed is False
    assert by_tool["claude"].login_hint == "claude login"
    assert by_tool["agy"].authed is True
    assert by_tool["agy"].detail == "ANTIGRAVITY_API_KEY env present"
    assert by_tool["cf"].authed is True
    assert by_tool["cf"].detail == "CLOUDFLARE_API_TOKEN env present"
    assert ["gh", "auth", "status"] in calls
    assert ["claude", "auth", "status"] in calls
    assert "agy-secret" not in rendered
    assert "cf-secret" not in rendered
    assert "codex-secret" not in rendered


def test_cloudflare_keychain_check_uses_literal_argv_without_exposing_secret(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls: list[dict[str, object]] = []

    def fake_run(
        args: list[str],
        *,
        capture_output: bool,
        text: bool,
        timeout: float,
        check: bool,
    ) -> subprocess.CompletedProcess[str]:
        calls.append(
            {
                "args": args,
                "capture_output": capture_output,
                "text": text,
                "timeout": timeout,
                "check": check,
            }
        )
        return subprocess.CompletedProcess(
            args=args,
            returncode=0,
            stdout='password: "cf-secret"',
            stderr="",
        )

    monkeypatch.setattr("grove_bridge.auth_status.subprocess.run", fake_run)

    assert keychain_cloudflare_token_exists()
    assert calls == [
        {
            "args": [
                "security",
                "find-generic-password",
                "-s",
                "base-voca",
                "-a",
                "cloudflare-api-token",
            ],
            "capture_output": True,
            "text": True,
            "timeout": AUTH_STATUS_TIMEOUT_SECONDS,
            "check": False,
        }
    ]


def test_tool_auth_status_payload_shape() -> None:
    status = ToolAuthStatus(
        tool="gh",
        label="GitHub CLI",
        authed=True,
        detail="github.com account chopin",
        login_hint="gh auth login",
    )

    assert status.to_payload() == {
        "tool": "gh",
        "label": "GitHub CLI",
        "authed": True,
        "detail": "github.com account chopin",
        "login_hint": "gh auth login",
    }
