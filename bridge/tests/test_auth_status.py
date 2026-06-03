from __future__ import annotations

import subprocess
from collections.abc import Sequence
from pathlib import Path

import pytest

from grove_bridge.auth_status import (
    AUTH_STATUS_TIMEOUT_SECONDS,
    AuthStatusChecker,
    ToolAuthStatus,
    _auth_file_has_content,
    _call_keychain_checker,
    keychain_cloudflare_token_exists,
    redact_secret_text,
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


def test_auth_status_cli_success_paths_redact_secret_output(tmp_path: Path) -> None:
    def fake_run(
        args: Sequence[str],
        *,
        capture_output: bool,
        text: bool,
        timeout: float,
        check: bool,
    ) -> subprocess.CompletedProcess[str]:
        _ = (capture_output, text, timeout, check)
        token = "xapp-" + ("a" * 44)
        return subprocess.CompletedProcess(
            args=list(args),
            returncode=0,
            stdout=f"{args[0]} authenticated {token}\n",
            stderr="",
        )

    statuses = AuthStatusChecker(
        env={},
        home=tmp_path,
        command_runner=fake_run,
        keychain_checker=lambda: True,
    ).check_all()
    by_tool = {status.tool: status for status in statuses}
    rendered = str([status.to_payload() for status in statuses])

    assert by_tool["codex"].authed is True
    assert by_tool["claude"].authed is True
    assert by_tool["agy"].authed is True
    assert by_tool["gh"].authed is True
    assert by_tool["cf"].authed is True
    assert "[redacted]" in rendered
    assert "xapp-" not in rendered


def test_auth_status_env_and_file_fallbacks(tmp_path: Path) -> None:
    (tmp_path / ".claude").mkdir()
    (tmp_path / ".claude" / "auth.json").write_text('{"token":"claude"}', encoding="utf-8")
    (tmp_path / ".config" / "agy").mkdir(parents=True)
    (tmp_path / ".config" / "agy" / "auth.json").write_text(
        '{"oauth":{"refresh":"agy"}}',
        encoding="utf-8",
    )

    def missing_run(
        args: Sequence[str],
        *,
        capture_output: bool,
        text: bool,
        timeout: float,
        check: bool,
    ) -> subprocess.CompletedProcess[str]:
        _ = (capture_output, text, timeout, check)
        raise FileNotFoundError(args[0])

    env_statuses = AuthStatusChecker(
        env={"OPENAI_API_KEY": "sk-secret", "ANTHROPIC_API_KEY": "claude-secret"},
        home=tmp_path,
        command_runner=missing_run,
        keychain_checker=object(),
    ).check_all()
    file_statuses = AuthStatusChecker(
        env={},
        home=tmp_path,
        command_runner=missing_run,
        keychain_checker=object(),
    ).check_all()
    env_by_tool = {status.tool: status for status in env_statuses}
    file_by_tool = {status.tool: status for status in file_statuses}

    assert env_by_tool["codex"].detail == "OPENAI_API_KEY env present"
    assert env_by_tool["claude"].detail == "ANTHROPIC_API_KEY env present"
    assert env_by_tool["cf"].authed is False
    assert file_by_tool["claude"].detail == "credentials file present"
    assert file_by_tool["agy"].detail == "OAuth credentials present"


def test_auth_status_handles_timeout_oserror_keychain_and_file_shapes(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    bad_json = tmp_path / "bad.json"
    bad_json.write_text("{not-json", encoding="utf-8")
    empty_json = tmp_path / "empty.json"
    empty_json.write_text('{"token": ""}', encoding="utf-8")
    list_json = tmp_path / "list.json"
    list_json.write_text('["", {"nested": "value"}]', encoding="utf-8")

    def mixed_run(
        args: Sequence[str],
        *,
        capture_output: bool,
        text: bool,
        timeout: float,
        check: bool,
    ) -> subprocess.CompletedProcess[str]:
        _ = (capture_output, text, check)
        if args[0] == "gh":
            raise subprocess.TimeoutExpired(cmd=list(args), timeout=timeout)
        if args[0] == "codex":
            raise OSError("socket failed")
        raise FileNotFoundError(args[0])

    checker = AuthStatusChecker(
        env={},
        home=tmp_path,
        command_runner=mixed_run,
        keychain_checker=object(),
    )

    assert checker.check_gh().detail == "timed out"
    assert checker.check_codex().detail == "socket failed"
    assert _call_keychain_checker(object()) is False
    assert _auth_file_has_content(bad_json) is True
    assert _auth_file_has_content(empty_json) is False
    assert _auth_file_has_content(list_json) is True
    assert redact_secret_text("xoxb-" + ("b" * 44)) == "[redacted]"

    def missing_security(*args: object, **kwargs: object) -> subprocess.CompletedProcess[str]:
        _ = (args, kwargs)
        raise FileNotFoundError("security")

    monkeypatch.setattr("grove_bridge.auth_status.subprocess.run", missing_security)
    assert keychain_cloudflare_token_exists() is False
