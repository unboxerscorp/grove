"""Dashboard account and session authentication interfaces."""

from __future__ import annotations

import hmac
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field, replace
from enum import StrEnum
from typing import Protocol, TypedDict


class DashboardRole(StrEnum):
    VIEWER = "viewer"
    OPERATOR = "operator"
    ADMIN = "admin"


class DashboardPermission(StrEnum):
    PROJECT_READ = "project.read"
    PROJECT_MUTATE = "project.mutate"
    BOARD_READ = "board.read"
    BOARD_MUTATE = "board.mutate"
    TASK_READ = "task.read"
    TASK_MUTATE = "task.mutate"
    NODE_READ = "node.read"
    NODE_MUTATE = "node.mutate"
    NODE_INPUT = "node.input"
    CONNECT_READ = "connect.read"
    TERMINAL_READ = "terminal.read"
    AUDIT_READ = "audit.read"
    COST_READ = "cost.read"
    QUOTA_MUTATE = "quota.mutate"
    AUTH_MANAGE = "auth.manage"


class AuthSurface(StrEnum):
    DASHBOARD = "dashboard"
    API = "api"
    WEBSOCKET = "websocket"


class AuthDecisionReason(StrEnum):
    ALLOWED = "allowed"
    MISSING_SESSION = "missing_session"
    INVALID_SESSION = "invalid_session"
    EXPIRED_SESSION = "expired_session"
    DISABLED_ACCOUNT = "disabled_account"
    INSUFFICIENT_ROLE = "insufficient_role"
    INVALID_PROJECT_IDENTITY = "invalid_project_identity"


class LoginFailureReason(StrEnum):
    UNKNOWN_ACCOUNT = "unknown_account"
    INVALID_CREDENTIALS = "invalid_credentials"
    DISABLED_ACCOUNT = "disabled_account"


class ProjectLifecycleAction(StrEnum):
    CREATE = "create"
    LOAD = "load"
    REPAIR = "repair"


class AccountPayload(TypedDict):
    id: str
    login: str
    display_name: str
    role: str
    enabled: bool


class ActorPayload(TypedDict):
    kind: str
    id: str
    login: str
    role: str


class PasswordHashPayload(TypedDict):
    algorithm: str
    value: str
    parameters: dict[str, object]


VIEWER_PERMISSIONS: frozenset[DashboardPermission] = frozenset(
    {
        DashboardPermission.PROJECT_READ,
        DashboardPermission.BOARD_READ,
        DashboardPermission.TASK_READ,
        DashboardPermission.NODE_READ,
        DashboardPermission.CONNECT_READ,
        DashboardPermission.TERMINAL_READ,
    }
)
OPERATOR_PERMISSIONS: frozenset[DashboardPermission] = VIEWER_PERMISSIONS | frozenset(
    {
        DashboardPermission.PROJECT_MUTATE,
        DashboardPermission.BOARD_MUTATE,
        DashboardPermission.TASK_MUTATE,
        DashboardPermission.NODE_MUTATE,
        DashboardPermission.NODE_INPUT,
        DashboardPermission.AUDIT_READ,
        DashboardPermission.COST_READ,
        DashboardPermission.QUOTA_MUTATE,
    }
)
ADMIN_PERMISSIONS: frozenset[DashboardPermission] = OPERATOR_PERMISSIONS | frozenset(
    {DashboardPermission.AUTH_MANAGE}
)
ROLE_PERMISSIONS: Mapping[DashboardRole, frozenset[DashboardPermission]] = {
    DashboardRole.VIEWER: VIEWER_PERMISSIONS,
    DashboardRole.OPERATOR: OPERATOR_PERMISSIONS,
    DashboardRole.ADMIN: ADMIN_PERMISSIONS,
}
PERMISSION_REQUIRED_ROLE: Mapping[DashboardPermission, DashboardRole] = (
    {permission: DashboardRole.VIEWER for permission in VIEWER_PERMISSIONS}
    | {
        permission: DashboardRole.OPERATOR
        for permission in OPERATOR_PERMISSIONS - VIEWER_PERMISSIONS
    }
    | {DashboardPermission.AUTH_MANAGE: DashboardRole.ADMIN}
)
ROLE_RANK: Mapping[DashboardRole, int] = {
    DashboardRole.VIEWER: 0,
    DashboardRole.OPERATOR: 1,
    DashboardRole.ADMIN: 2,
}


def normalize_login(login: str) -> str:
    return login.strip().casefold()


@dataclass(frozen=True)
class Account:
    id: str
    login: str
    display_name: str
    role: DashboardRole
    enabled: bool = True

    def to_payload(self) -> AccountPayload:
        return {
            "id": self.id,
            "login": self.login,
            "display_name": self.display_name,
            "role": self.role.value,
            "enabled": self.enabled,
        }


@dataclass(frozen=True)
class PasswordHash:
    algorithm: str
    value: str = field(repr=False)
    parameters: Mapping[str, object] = field(default_factory=dict)

    def to_redacted_payload(self) -> PasswordHashPayload:
        return {
            "algorithm": self.algorithm,
            "value": "[redacted]",
            "parameters": dict(self.parameters),
        }


@dataclass(frozen=True)
class LoginCredentials:
    login: str
    secret: str = field(repr=False)
    metadata: Mapping[str, object] = field(default_factory=dict)


@dataclass(frozen=True)
class SessionIssueRequest:
    account: Account
    surface: AuthSurface
    user_agent: str | None
    remote_addr: str | None
    metadata: Mapping[str, object]


@dataclass(frozen=True)
class AuthSession:
    id: str = field(repr=False)
    account_id: str = ""
    csrf_token: str = field(default="", repr=False)
    issued_at: int = 0
    expires_at: int = 0
    last_activity_at: int = 0


@dataclass(frozen=True)
class LoginResult:
    account: Account
    session: AuthSession = field(repr=False)
    cookie_value: str = field(repr=False)
    csrf_token: str = field(repr=False)


@dataclass(frozen=True)
class AuthContext:
    account: Account
    session: AuthSession
    surface: AuthSurface

    @property
    def is_operator(self) -> bool:
        return role_satisfies(self.account.role, DashboardRole.OPERATOR)

    def actor_payload(self) -> ActorPayload:
        return {
            "kind": "account",
            "id": self.account.id,
            "login": self.account.login,
            "role": self.account.role.value,
        }


@dataclass(frozen=True)
class AuthDecision:
    allowed: bool
    reason: AuthDecisionReason
    permission: DashboardPermission | None
    required_role: DashboardRole | None
    account_id: str | None
    metadata: Mapping[str, object]


@dataclass(frozen=True)
class LoginOutcome:
    result: LoginResult | None = field(repr=False)
    failure_reason: LoginFailureReason | None
    metadata: Mapping[str, object]

    @property
    def authenticated(self) -> bool:
        return self.result is not None and self.failure_reason is None


@dataclass(frozen=True)
class ProjectIdentity:
    project: str
    session: str
    board: str

    @property
    def is_one_to_one(self) -> bool:
        project = self.project.strip()
        session = self.session.strip()
        board = self.board.strip()
        return bool(project) and project == session == board

    def to_payload(self) -> dict[str, str]:
        return {"project": self.project, "session": self.session, "board": self.board}


class AccountStore(Protocol):
    def find_by_login(self, login: str) -> Account | None: ...

    def find_by_id(self, account_id: str) -> Account | None: ...

    def list_accounts(self) -> Sequence[Account]: ...


class CredentialVerifier(Protocol):
    def verify(self, credentials: LoginCredentials, account: Account) -> bool: ...


class PasswordHasher(Protocol):
    def hash_password(self, raw_password: str) -> PasswordHash: ...

    def verify_password(self, raw_password: str, password_hash: PasswordHash) -> bool: ...


class SessionTokenCodec(Protocol):
    def encode(self, session: AuthSession) -> str: ...

    def decode(self, cookie_value: str) -> AuthSession | None: ...


class SessionManager(Protocol):
    def issue(self, request: SessionIssueRequest) -> LoginResult: ...

    def verify(self, cookie_value: str, *, surface: AuthSurface) -> AuthContext | None: ...

    def revoke(self, session_id: str) -> None: ...


class Authenticator(Protocol):
    def login(self, credentials: LoginCredentials, *, surface: AuthSurface) -> LoginOutcome: ...

    def verify_session(self, cookie_value: str, *, surface: AuthSurface) -> AuthContext | None: ...

    def logout(self, session_id: str) -> None: ...


def login(
    *,
    credentials: LoginCredentials,
    account_store: AccountStore,
    credential_verifier: CredentialVerifier,
    session_manager: SessionManager,
    surface: AuthSurface,
    metadata: Mapping[str, object] | None = None,
) -> LoginOutcome:
    login_metadata = {} if metadata is None else dict(metadata)
    normalized_login = normalize_login(credentials.login)
    account = account_store.find_by_login(normalized_login)
    if account is None:
        return LoginOutcome(
            result=None,
            failure_reason=LoginFailureReason.UNKNOWN_ACCOUNT,
            metadata=login_metadata,
        )
    if not account.enabled:
        return LoginOutcome(
            result=None,
            failure_reason=LoginFailureReason.DISABLED_ACCOUNT,
            metadata=login_metadata,
        )
    clean_credentials = replace(credentials, login=credentials.login.strip())
    if not credential_verifier.verify(clean_credentials, account):
        return LoginOutcome(
            result=None,
            failure_reason=LoginFailureReason.INVALID_CREDENTIALS,
            metadata=login_metadata,
        )
    result = session_manager.issue(
        SessionIssueRequest(
            account=account,
            surface=surface,
            user_agent=_optional_metadata_string(login_metadata, "user_agent"),
            remote_addr=_optional_metadata_string(login_metadata, "remote_addr"),
            metadata=login_metadata,
        )
    )
    return LoginOutcome(result=result, failure_reason=None, metadata=login_metadata)


def verify_session(
    *,
    cookie_value: str,
    session_manager: SessionManager,
    surface: AuthSurface,
) -> AuthContext | None:
    clean_cookie = cookie_value.strip()
    if not clean_cookie:
        return None
    context = session_manager.verify(clean_cookie, surface=surface)
    if context is None or not context.account.enabled:
        return None
    return context


def logout(*, session_id: str, session_manager: SessionManager) -> None:
    session_manager.revoke(session_id)


def role_satisfies(actual: DashboardRole, required: DashboardRole) -> bool:
    return ROLE_RANK[actual] >= ROLE_RANK[required]


def permissions_for_role(role: DashboardRole) -> frozenset[DashboardPermission]:
    return ROLE_PERMISSIONS[role]


def authorize_permission(
    context: AuthContext | None,
    permission: DashboardPermission,
    *,
    metadata: Mapping[str, object],
) -> AuthDecision:
    required_role = PERMISSION_REQUIRED_ROLE[permission]
    if context is None:
        return AuthDecision(
            allowed=False,
            reason=AuthDecisionReason.MISSING_SESSION,
            permission=permission,
            required_role=required_role,
            account_id=None,
            metadata=metadata,
        )
    account = context.account
    if not account.enabled:
        return AuthDecision(
            allowed=False,
            reason=AuthDecisionReason.DISABLED_ACCOUNT,
            permission=permission,
            required_role=required_role,
            account_id=account.id,
            metadata=metadata,
        )
    allowed = permission in permissions_for_role(account.role)
    return AuthDecision(
        allowed=allowed,
        reason=AuthDecisionReason.ALLOWED if allowed else AuthDecisionReason.INSUFFICIENT_ROLE,
        permission=permission,
        required_role=required_role,
        account_id=account.id,
        metadata=metadata,
    )


def authorize_role(
    *,
    context: AuthContext | None,
    required_role: DashboardRole,
    metadata: Mapping[str, object],
) -> AuthDecision:
    if context is None:
        return AuthDecision(
            allowed=False,
            reason=AuthDecisionReason.MISSING_SESSION,
            permission=None,
            required_role=required_role,
            account_id=None,
            metadata=metadata,
        )
    account = context.account
    if not account.enabled:
        return AuthDecision(
            allowed=False,
            reason=AuthDecisionReason.DISABLED_ACCOUNT,
            permission=None,
            required_role=required_role,
            account_id=account.id,
            metadata=metadata,
        )
    allowed = role_satisfies(account.role, required_role)
    return AuthDecision(
        allowed=allowed,
        reason=AuthDecisionReason.ALLOWED if allowed else AuthDecisionReason.INSUFFICIENT_ROLE,
        permission=None,
        required_role=required_role,
        account_id=account.id,
        metadata=metadata,
    )


def authorize_project_lifecycle(
    *,
    context: AuthContext | None,
    action: ProjectLifecycleAction,
    identity: ProjectIdentity,
    metadata: Mapping[str, object],
) -> AuthDecision:
    lifecycle_metadata: dict[str, object] = {
        **dict(metadata),
        "action": action.value,
        "identity": identity.to_payload(),
    }
    if not identity.is_one_to_one:
        return AuthDecision(
            allowed=False,
            reason=AuthDecisionReason.INVALID_PROJECT_IDENTITY,
            permission=DashboardPermission.PROJECT_MUTATE,
            required_role=DashboardRole.OPERATOR,
            account_id=context.account.id if context is not None else None,
            metadata=lifecycle_metadata,
        )
    return authorize_permission(
        context,
        DashboardPermission.PROJECT_MUTATE,
        metadata=lifecycle_metadata,
    )


def csrf_token_matches(*, context: AuthContext, supplied_token: str | None) -> bool:
    if supplied_token is None:
        return False
    try:
        expected = context.session.csrf_token.encode("ascii")
        supplied = supplied_token.encode("ascii")
    except UnicodeEncodeError:
        return False
    return hmac.compare_digest(expected, supplied)


def _optional_metadata_string(metadata: Mapping[str, object], key: str) -> str | None:
    value = metadata.get(key)
    return value if isinstance(value, str) and value.strip() else None


__all__ = [
    "ADMIN_PERMISSIONS",
    "Account",
    "AccountPayload",
    "AccountStore",
    "ActorPayload",
    "AuthContext",
    "AuthDecision",
    "AuthDecisionReason",
    "AuthSession",
    "AuthSurface",
    "Authenticator",
    "CredentialVerifier",
    "DashboardPermission",
    "DashboardRole",
    "LoginCredentials",
    "LoginFailureReason",
    "LoginOutcome",
    "LoginResult",
    "OPERATOR_PERMISSIONS",
    "PasswordHash",
    "PasswordHashPayload",
    "PasswordHasher",
    "ProjectIdentity",
    "ProjectLifecycleAction",
    "ROLE_PERMISSIONS",
    "SessionIssueRequest",
    "SessionManager",
    "SessionTokenCodec",
    "VIEWER_PERMISSIONS",
    "authorize_permission",
    "authorize_project_lifecycle",
    "authorize_role",
    "csrf_token_matches",
    "login",
    "logout",
    "normalize_login",
    "permissions_for_role",
    "role_satisfies",
    "verify_session",
]
