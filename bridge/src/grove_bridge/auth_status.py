"""Developer tool authentication status checks."""

from __future__ import annotations

import json
import os
import re
import subprocess
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol

AUTH_STATUS_TIMEOUT_SECONDS = 3.0
CF_KEYCHAIN_SERVICE = "base-voca"
CF_KEYCHAIN_ACCOUNT = "cloudflare-api-token"
TOKEN_RE = re.compile(
    r"(?i)\b(?:"
    r"xox[baprs]-[A-Za-z0-9-]+|"
    r"gh[pousr]_[A-Za-z0-9_]+|"
    r"sk-[A-Za-z0-9_-]+|"
    r"[A-Za-z0-9_-]{40,}"
    r")\b"
)


class CommandRunner(Protocol):
    def __call__(
        self,
        args: Sequence[str],
        *,
        capture_output: bool,
        text: bool,
        timeout: float,
        check: bool,
    ) -> subprocess.CompletedProcess[str]: ...


@dataclass(frozen=True)
class ToolAuthStatus:
    tool: str
    label: str
    authed: bool
    detail: str
    login_hint: str

    def to_payload(self) -> dict[str, object]:
        return {
            "tool": self.tool,
            "label": self.label,
            "authed": self.authed,
            "detail": self.detail,
            "login_hint": self.login_hint,
        }


@dataclass(frozen=True)
class CommandOutcome:
    found: bool
    returncode: int
    stdout: str
    stderr: str
    error: str | None = None


class AuthStatusChecker:
    def __init__(
        self,
        *,
        env: Mapping[str, str] | None = None,
        home: Path | None = None,
        command_runner: CommandRunner | None = None,
        keychain_checker: object | None = None,
    ) -> None:
        self.env = env if env is not None else os.environ
        self.home = (home or Path.home()).expanduser()
        self.command_runner = command_runner or _run_command
        self.keychain_checker = keychain_checker or keychain_cloudflare_token_exists

    def check_all(self) -> list[ToolAuthStatus]:
        return [
            self.check_codex(),
            self.check_claude(),
            self.check_agy(),
            self.check_gh(),
            self.check_cf(),
        ]

    def check_gh(self) -> ToolAuthStatus:
        outcome = self._run(["gh", "auth", "status"])
        authed = outcome.found and outcome.returncode == 0
        return ToolAuthStatus(
            tool="gh",
            label="GitHub CLI",
            authed=authed,
            detail=_outcome_detail(outcome, fallback="not authenticated"),
            login_hint="gh auth login",
        )

    def check_codex(self) -> ToolAuthStatus:
        outcome = self._run(["codex", "auth", "status"])
        if outcome.found and outcome.returncode == 0:
            return ToolAuthStatus(
                tool="codex",
                label="Codex CLI",
                authed=True,
                detail=_outcome_detail(outcome, fallback="codex CLI authenticated"),
                login_hint="codex login",
            )
        if _env_present(self.env, "OPENAI_API_KEY"):
            return ToolAuthStatus(
                tool="codex",
                label="Codex CLI",
                authed=True,
                detail="OPENAI_API_KEY env present",
                login_hint="codex login",
            )
        if _codex_auth_file_present(self.env, self.home):
            return ToolAuthStatus(
                tool="codex",
                label="Codex CLI",
                authed=True,
                detail="auth.json present",
                login_hint="codex login",
            )
        return ToolAuthStatus(
            tool="codex",
            label="Codex CLI",
            authed=False,
            detail=_outcome_detail(outcome, fallback="codex auth not found"),
            login_hint="codex login",
        )

    def check_claude(self) -> ToolAuthStatus:
        outcome = self._run(["claude", "auth", "status"])
        if outcome.found and outcome.returncode == 0:
            return ToolAuthStatus(
                tool="claude",
                label="Claude CLI",
                authed=True,
                detail=_outcome_detail(outcome, fallback="claude CLI authenticated"),
                login_hint="claude login",
            )
        if _env_present(self.env, "ANTHROPIC_API_KEY"):
            return ToolAuthStatus(
                tool="claude",
                label="Claude CLI",
                authed=True,
                detail="ANTHROPIC_API_KEY env present",
                login_hint="claude login",
            )
        if _any_auth_file_present(
            [
                self.home / ".claude.json",
                self.home / ".claude" / "auth.json",
                self.home / ".claude" / ".credentials.json",
            ]
        ):
            return ToolAuthStatus(
                tool="claude",
                label="Claude CLI",
                authed=True,
                detail="credentials file present",
                login_hint="claude login",
            )
        return ToolAuthStatus(
            tool="claude",
            label="Claude CLI",
            authed=False,
            detail=_outcome_detail(outcome, fallback="claude auth not found"),
            login_hint="claude login",
        )

    def check_agy(self) -> ToolAuthStatus:
        outcome = self._run(["agy", "auth", "status"])
        if outcome.found and outcome.returncode == 0:
            return ToolAuthStatus(
                tool="agy",
                label="Antigravity",
                authed=True,
                detail=_outcome_detail(outcome, fallback="agy OAuth authenticated"),
                login_hint="Run `agy` for OAuth login or set an API key",
            )
        for key in ("ANTIGRAVITY_API_KEY", "GEMINI_API_KEY"):
            if _env_present(self.env, key):
                return ToolAuthStatus(
                    tool="agy",
                    label="Antigravity",
                    authed=True,
                    detail=f"{key} env present",
                    login_hint="Run `agy` for OAuth login or set an API key",
                )
        if _any_auth_file_present(
            [
                self.home / ".agy" / "auth.json",
                self.home / ".config" / "agy" / "auth.json",
            ]
        ):
            return ToolAuthStatus(
                tool="agy",
                label="Antigravity",
                authed=True,
                detail="OAuth credentials present",
                login_hint="Run `agy` for OAuth login or set an API key",
            )
        return ToolAuthStatus(
            tool="agy",
            label="Antigravity",
            authed=False,
            detail=_outcome_detail(outcome, fallback="agy auth not found"),
            login_hint="Run `agy` for OAuth login or set an API key",
        )

    def check_cf(self) -> ToolAuthStatus:
        if _env_present(self.env, "CLOUDFLARE_API_TOKEN"):
            return ToolAuthStatus(
                tool="cf",
                label="Cloudflare",
                authed=True,
                detail="CLOUDFLARE_API_TOKEN env present",
                login_hint="Set CLOUDFLARE_API_TOKEN or save base-voca/cloudflare-api-token",
            )
        if _call_keychain_checker(self.keychain_checker):
            return ToolAuthStatus(
                tool="cf",
                label="Cloudflare",
                authed=True,
                detail="macOS Keychain token present",
                login_hint="Set CLOUDFLARE_API_TOKEN or save base-voca/cloudflare-api-token",
            )
        return ToolAuthStatus(
            tool="cf",
            label="Cloudflare",
            authed=False,
            detail="token not found",
            login_hint="Set CLOUDFLARE_API_TOKEN or save base-voca/cloudflare-api-token",
        )

    def _run(self, args: Sequence[str]) -> CommandOutcome:
        try:
            proc = self.command_runner(
                args,
                capture_output=True,
                text=True,
                timeout=AUTH_STATUS_TIMEOUT_SECONDS,
                check=False,
            )
        except FileNotFoundError:
            return CommandOutcome(
                found=False,
                returncode=127,
                stdout="",
                stderr="",
                error="not found",
            )
        except subprocess.TimeoutExpired:
            return CommandOutcome(
                found=True,
                returncode=124,
                stdout="",
                stderr="",
                error="timed out",
            )
        except OSError as exc:
            return CommandOutcome(
                found=False,
                returncode=127,
                stdout="",
                stderr="",
                error=str(exc),
            )
        return CommandOutcome(
            found=True,
            returncode=proc.returncode,
            stdout=proc.stdout or "",
            stderr=proc.stderr or "",
        )


def collect_auth_status() -> list[ToolAuthStatus]:
    return AuthStatusChecker().check_all()


def keychain_cloudflare_token_exists() -> bool:
    try:
        proc = subprocess.run(
            [
                "security",
                "find-generic-password",
                "-s",
                CF_KEYCHAIN_SERVICE,
                "-a",
                CF_KEYCHAIN_ACCOUNT,
            ],
            capture_output=True,
            text=True,
            timeout=AUTH_STATUS_TIMEOUT_SECONDS,
            check=False,
        )
    except (FileNotFoundError, subprocess.TimeoutExpired, OSError):
        return False
    return proc.returncode == 0


def _run_command(
    args: Sequence[str],
    *,
    capture_output: bool,
    text: bool,
    timeout: float,
    check: bool,
) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        list(args),
        capture_output=capture_output,
        text=text,
        timeout=timeout,
        check=check,
    )


def _call_keychain_checker(checker: object) -> bool:
    if callable(checker):
        return bool(checker())
    return False


def _outcome_detail(outcome: CommandOutcome, *, fallback: str) -> str:
    if outcome.error is not None:
        return _sanitize_detail(outcome.error) or fallback
    return _sanitize_detail("\n".join((outcome.stdout, outcome.stderr))) or fallback


def _sanitize_detail(value: str) -> str:
    lines = [line.strip() for line in value.replace("\r", "\n").splitlines() if line.strip()]
    clean = re.sub(r"\s+", " ", "; ".join(lines))
    clean = TOKEN_RE.sub("[redacted]", clean)
    return clean[:300]


def _env_present(env: Mapping[str, str], key: str) -> bool:
    return bool(env.get(key, "").strip())


def _codex_auth_file_present(env: Mapping[str, str], home: Path) -> bool:
    configured_home = env.get("CODEX_HOME")
    paths = [home / ".codex" / "auth.json"]
    if configured_home is not None and configured_home.strip():
        paths.insert(0, Path(configured_home).expanduser() / "auth.json")
    return _any_auth_file_present(paths)


def _any_auth_file_present(paths: Sequence[Path]) -> bool:
    return any(_auth_file_has_content(path) for path in paths)


def _auth_file_has_content(path: Path) -> bool:
    if not path.is_file():
        return False
    try:
        raw = path.read_text(encoding="utf-8").strip()
    except OSError:
        return False
    if not raw:
        return False
    try:
        loaded = json.loads(raw)
    except json.JSONDecodeError:
        return True
    return _json_has_value(loaded)


def _json_has_value(value: object) -> bool:
    if isinstance(value, str):
        return bool(value.strip())
    if isinstance(value, bool | int | float):
        return True
    if isinstance(value, list):
        return any(_json_has_value(item) for item in value)
    if isinstance(value, dict):
        return any(_json_has_value(item) for item in value.values())
    return False
