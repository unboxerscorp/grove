"""Team cookie authentication primitives for grove-web."""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import secrets
import threading
import time
from collections.abc import Mapping
from dataclasses import dataclass, replace
from pathlib import Path
from typing import Literal, cast

TEAM_SESSION_COOKIE = "grove_team_session"
CSRF_HEADER = "X-Grove-CSRF"
TEAM_SESSION_TTL_SECONDS = 7 * 24 * 60 * 60
SECRET_HASH_ITERATIONS = 200_000
SECRET_HASH_ALGORITHM = "pbkdf2_sha256"
MEMBER_ROLES = frozenset({"admin", "operator", "viewer"})
MemberRole = Literal["admin", "operator", "viewer"]


@dataclass(frozen=True)
class TeamMember:
    id: str
    name: str
    role: MemberRole
    secret_hash: str
    enabled: bool = True

    def to_payload(self) -> dict[str, object]:
        return {"id": self.id, "name": self.name, "role": self.role}


@dataclass(frozen=True)
class VerifiedSession:
    sid: str
    member: TeamMember
    csrf_token: str
    expires_at: int


@dataclass(frozen=True)
class IssuedSession:
    sid: str
    cookie_value: str
    csrf_token: str
    issued_at: int
    expires_at: int
    member: TeamMember


@dataclass(frozen=True)
class TeamSessionRecord:
    sid: str
    member_id: str
    issued_at: int
    expires_at: int
    last_activity_at: int


@dataclass(frozen=True)
class JoinCodeRecord:
    code: str
    role: MemberRole
    issued_at: int
    expires_at: int


class MemberRegistry:
    def __init__(self, path: Path) -> None:
        self.path = path.expanduser()

    def list_members(self) -> list[TeamMember]:
        if not self.path.is_file():
            return []
        loaded = json.loads(self.path.read_text(encoding="utf-8"))
        if not isinstance(loaded, dict):
            raise ValueError("invalid members registry")
        raw_members = loaded.get("members")
        if not isinstance(raw_members, list):
            raise ValueError("invalid members registry")
        members: list[TeamMember] = []
        for raw_member in raw_members:
            if not isinstance(raw_member, dict):
                raise ValueError("invalid members registry")
            members.append(_member_from_mapping(cast(dict[str, object], raw_member)))
        self.path.chmod(0o600)
        return members

    def find_by_id(self, member_id: str) -> TeamMember | None:
        for member in self.list_members():
            if member.id == member_id:
                return member
        return None

    def authenticate(self, name: str, secret: str) -> TeamMember | None:
        clean_name = name.strip()
        candidate: TeamMember | None = None
        for member in self.list_members():
            if member.enabled and member.name == clean_name:
                candidate = member
                break
        if candidate is None:
            verify_secret(secret, DUMMY_SECRET_HASH)
            return None
        if verify_secret(secret, candidate.secret_hash):
            return candidate
        return None

    def save_members(self, members: list[TeamMember]) -> None:
        payload = {
            "members": [
                {
                    "id": member.id,
                    "name": member.name,
                    "role": member.role,
                    "enabled": member.enabled,
                    "secret_hash": member.secret_hash,
                }
                for member in members
            ]
        }
        _write_json_secret_file(self.path, payload)

    def add_member(self, member: TeamMember) -> None:
        members = self.list_members()
        if any(existing.id == member.id for existing in members):
            raise ValueError("member id already exists")
        members.append(member)
        self.save_members(members)


class SessionSigner:
    def __init__(self, secret_path: Path) -> None:
        self.secret_path = secret_path.expanduser()
        self.secret = _load_or_create_secret(self.secret_path)

    def issue(self, member: TeamMember, *, now: int | None = None) -> IssuedSession:
        issued_at = int(time.time()) if now is None else now
        expires_at = issued_at + TEAM_SESSION_TTL_SECONDS
        sid = secrets.token_urlsafe(24)
        csrf_token = secrets.token_urlsafe(24)
        payload = {
            "v": 1,
            "sid": sid,
            "member_id": member.id,
            "csrf": csrf_token,
            "exp": expires_at,
        }
        cookie_value = _encode_signed_payload(payload, self.secret)
        return IssuedSession(
            sid=sid,
            cookie_value=cookie_value,
            csrf_token=csrf_token,
            issued_at=issued_at,
            expires_at=expires_at,
            member=member,
        )

    def verify(
        self,
        cookie_value: str,
        registry: MemberRegistry,
        *,
        now: int | None = None,
    ) -> VerifiedSession | None:
        payload = _decode_signed_payload(cookie_value, self.secret)
        if payload is None:
            return None
        expires_at = payload.get("exp")
        member_id = payload.get("member_id")
        csrf_token = payload.get("csrf")
        sid = payload.get("sid")
        if not isinstance(expires_at, int) or not isinstance(member_id, str):
            return None
        if not isinstance(sid, str) or not sid:
            return None
        if not isinstance(csrf_token, str) or not csrf_token:
            return None
        current_time = int(time.time()) if now is None else now
        if expires_at <= current_time:
            return None
        member = registry.find_by_id(member_id)
        if member is None or not member.enabled:
            return None
        return VerifiedSession(
            sid=sid,
            member=member,
            csrf_token=csrf_token,
            expires_at=expires_at,
        )


class TeamSessionStore:
    def __init__(self) -> None:
        self._sessions: dict[str, TeamSessionRecord] = {}
        self._lock = threading.Lock()

    def add(self, issued: IssuedSession) -> None:
        record = TeamSessionRecord(
            sid=issued.sid,
            member_id=issued.member.id,
            issued_at=issued.issued_at,
            expires_at=issued.expires_at,
            last_activity_at=issued.issued_at,
        )
        with self._lock:
            self._cleanup_expired_locked(int(time.time()))
            self._sessions[issued.sid] = record

    def revoke(self, sid: str) -> None:
        with self._lock:
            self._sessions.pop(sid, None)

    def contains(
        self,
        *,
        sid: str,
        member_id: str,
        now: int | None = None,
    ) -> bool:
        current_time = int(time.time()) if now is None else now
        with self._lock:
            self._cleanup_expired_locked(current_time)
            record = self._sessions.get(sid)
            if record is None:
                return False
            if record.member_id != member_id or record.expires_at <= current_time:
                return False
            self._sessions[sid] = replace(record, last_activity_at=current_time)
            return True

    def active_sessions(
        self,
        *,
        within_seconds: int,
        now: int | None = None,
    ) -> list[TeamSessionRecord]:
        current_time = int(time.time()) if now is None else now
        cutoff = current_time - within_seconds
        with self._lock:
            self._cleanup_expired_locked(current_time)
            return sorted(
                [record for record in self._sessions.values() if record.last_activity_at >= cutoff],
                key=lambda record: (record.last_activity_at, record.member_id),
                reverse=True,
            )

    def _cleanup_expired_locked(self, now: int) -> None:
        expired = [sid for sid, record in self._sessions.items() if record.expires_at <= now]
        for sid in expired:
            self._sessions.pop(sid, None)


class TeamJoinCodeStore:
    def __init__(
        self,
        *,
        ttl_seconds: int = 10 * 60,
        rate_limit_attempts: int = 5,
        rate_limit_window_seconds: int = 5 * 60,
    ) -> None:
        self.ttl_seconds = ttl_seconds
        self.rate_limit_attempts = rate_limit_attempts
        self.rate_limit_window_seconds = rate_limit_window_seconds
        self._codes: dict[str, JoinCodeRecord] = {}
        self._attempts: dict[str, list[int]] = {}
        self._lock = threading.Lock()

    def issue(self, *, role: MemberRole, now: int | None = None) -> JoinCodeRecord:
        current_time = int(time.time()) if now is None else now
        code = secrets.token_urlsafe(18)
        record = JoinCodeRecord(
            code=code,
            role=role,
            issued_at=current_time,
            expires_at=current_time + self.ttl_seconds,
        )
        with self._lock:
            self._cleanup_locked(current_time)
            self._codes[code] = record
        return record

    def consume(
        self,
        code: str,
        *,
        client_key: str,
        now: int | None = None,
    ) -> tuple[JoinCodeRecord | None, str | None]:
        current_time = int(time.time()) if now is None else now
        clean_code = code.strip()
        with self._lock:
            if self._rate_limited_locked(client_key, current_time):
                return None, "rate_limited"
            record = self._codes.get(clean_code)
            if record is None:
                self._cleanup_locked(current_time)
                self._record_attempt_locked(client_key, current_time)
                return None, "invalid"
            if record.expires_at <= current_time:
                self._codes.pop(clean_code, None)
                self._record_attempt_locked(client_key, current_time)
                return None, "expired"
            self._codes.pop(clean_code, None)
            self._attempts.pop(client_key, None)
            return record, None

    def _rate_limited_locked(self, client_key: str, now: int) -> bool:
        attempts = [
            ts
            for ts in self._attempts.get(client_key, [])
            if now - ts < self.rate_limit_window_seconds
        ]
        self._attempts[client_key] = attempts
        return len(attempts) >= self.rate_limit_attempts

    def _record_attempt_locked(self, client_key: str, now: int) -> None:
        attempts = [
            ts
            for ts in self._attempts.get(client_key, [])
            if now - ts < self.rate_limit_window_seconds
        ]
        attempts.append(now)
        self._attempts[client_key] = attempts

    def _cleanup_locked(self, now: int) -> None:
        expired = [code for code, record in self._codes.items() if record.expires_at <= now]
        for code in expired:
            self._codes.pop(code, None)
        stale_clients = [
            client_key
            for client_key, attempts in self._attempts.items()
            if all(now - ts >= self.rate_limit_window_seconds for ts in attempts)
        ]
        for client_key in stale_clients:
            self._attempts.pop(client_key, None)


def members_path(grove_home: Path, session: str) -> Path:
    return grove_home / session / "members.json"


def session_secret_path(grove_home: Path, session: str) -> Path:
    return grove_home / session / "team-session-secret"


def hash_secret(secret: str, *, salt: bytes | None = None) -> str:
    if not secret:
        raise ValueError("member secret is required")
    raw_salt = secrets.token_bytes(16) if salt is None else salt
    digest = hashlib.pbkdf2_hmac(
        "sha256",
        secret.encode("utf-8"),
        raw_salt,
        SECRET_HASH_ITERATIONS,
    )
    return "$".join(
        (
            SECRET_HASH_ALGORITHM,
            str(SECRET_HASH_ITERATIONS),
            _b64encode(raw_salt),
            _b64encode(digest),
        )
    )


def verify_secret(secret: str, encoded_hash: str) -> bool:
    parts = encoded_hash.split("$")
    if len(parts) != 4 or parts[0] != SECRET_HASH_ALGORITHM:
        return False
    try:
        iterations = int(parts[1])
        salt = _b64decode(parts[2])
        expected = _b64decode(parts[3])
    except (ValueError, TypeError):
        return False
    actual = hashlib.pbkdf2_hmac("sha256", secret.encode("utf-8"), salt, iterations)
    return hmac.compare_digest(actual, expected)


def bootstrap_hint(path: Path) -> str:
    return (
        "Create the first admin in members.json with fields "
        "id, name, role=admin, enabled=true, secret_hash. "
        f"members_path={path}"
    )


def _member_from_mapping(raw: dict[str, object]) -> TeamMember:
    member_id = raw.get("id")
    name = raw.get("name")
    role = raw.get("role")
    secret_hash = raw.get("secret_hash")
    enabled = raw.get("enabled", True)
    if not isinstance(member_id, str) or not member_id.strip():
        raise ValueError("member id is required")
    if not isinstance(name, str) or not name.strip():
        raise ValueError("member name is required")
    if not isinstance(role, str) or role not in MEMBER_ROLES:
        raise ValueError("member role is invalid")
    if not isinstance(secret_hash, str) or not secret_hash.strip():
        raise ValueError("member secret_hash is required")
    if not isinstance(enabled, bool):
        raise ValueError("member enabled must be boolean")
    return TeamMember(
        id=member_id.strip(),
        name=name.strip(),
        role=cast(MemberRole, role),
        secret_hash=secret_hash.strip(),
        enabled=enabled,
    )


def _load_or_create_secret(path: Path) -> bytes:
    try:
        encoded = path.read_text(encoding="utf-8").strip()
    except FileNotFoundError:
        encoded = ""
    if encoded:
        path.chmod(0o600)
        return _b64decode(encoded)
    secret = secrets.token_bytes(32)
    try:
        _write_secret_file_exclusive(path, _b64encode(secret) + "\n")
    except FileExistsError:
        return _b64decode(path.read_text(encoding="utf-8").strip())
    return secret


def _encode_signed_payload(payload: dict[str, object], secret: bytes) -> str:
    raw_payload = json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8")
    encoded_payload = _b64encode(raw_payload)
    signature = hmac.new(secret, encoded_payload.encode("ascii"), hashlib.sha256).digest()
    return f"{encoded_payload}.{_b64encode(signature)}"


def _decode_signed_payload(cookie_value: str, secret: bytes) -> dict[str, object] | None:
    try:
        encoded_payload, encoded_signature = cookie_value.split(".", 1)
        signature = _b64decode(encoded_signature)
    except ValueError:
        return None
    expected = hmac.new(secret, encoded_payload.encode("ascii"), hashlib.sha256).digest()
    if not hmac.compare_digest(signature, expected):
        return None
    try:
        payload = json.loads(_b64decode(encoded_payload).decode("utf-8"))
    except (json.JSONDecodeError, UnicodeDecodeError):
        return None
    if not isinstance(payload, dict):
        return None
    return cast(dict[str, object], payload)


def _write_json_secret_file(path: Path, payload: Mapping[str, object]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.parent.chmod(0o700)
    tmp_path = path.with_name(f".{path.name}.{os.getpid()}.{secrets.token_hex(6)}.tmp")
    try:
        _write_secret_file_exclusive(
            tmp_path,
            json.dumps(payload, indent=2, sort_keys=True) + "\n",
        )
        os.replace(tmp_path, path)
        path.chmod(0o600)
    finally:
        try:
            tmp_path.unlink()
        except FileNotFoundError:
            pass


def _write_secret_file_exclusive(path: Path, value: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.parent.chmod(0o700)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            fd = -1
            handle.write(value)
    except Exception:
        if fd >= 0:
            os.close(fd)
        raise


def _b64encode(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).decode("ascii").rstrip("=")


def _b64decode(value: str) -> bytes:
    padding = "=" * (-len(value) % 4)
    return base64.urlsafe_b64decode(value + padding)


DUMMY_SECRET_HASH = hash_secret("dummy-member-secret", salt=b"grove-dummy-salt")
