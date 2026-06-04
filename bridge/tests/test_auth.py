from __future__ import annotations

from collections.abc import Sequence

from grove_bridge.auth import (
    Account,
    AuthContext,
    AuthDecisionReason,
    AuthSession,
    AuthSurface,
    DashboardPermission,
    DashboardRole,
    LoginCredentials,
    LoginFailureReason,
    LoginResult,
    ProjectIdentity,
    ProjectLifecycleAction,
    SessionIssueRequest,
    authorize_permission,
    authorize_project_lifecycle,
    csrf_token_matches,
    login,
    normalize_login,
    verify_session,
)


class FakeAccountStore:
    def __init__(self, accounts: Sequence[Account]) -> None:
        self.accounts = {normalize_login(account.login): account for account in accounts}

    def find_by_login(self, login: str) -> Account | None:
        return self.accounts.get(normalize_login(login))

    def find_by_id(self, account_id: str) -> Account | None:
        for account in self.accounts.values():
            if account.id == account_id:
                return account
        return None

    def list_accounts(self) -> Sequence[Account]:
        return tuple(self.accounts.values())


class FakeCredentialVerifier:
    def __init__(self, *, allowed_secret: str = "correct") -> None:
        self.allowed_secret = allowed_secret
        self.calls: list[tuple[str, str]] = []

    def verify(self, credentials: LoginCredentials, account: Account) -> bool:
        self.calls.append((credentials.login, account.id))
        return credentials.secret == self.allowed_secret


class FakeSessionManager:
    def __init__(self, verified: AuthContext | None = None) -> None:
        self.verified = verified
        self.issue_requests: list[SessionIssueRequest] = []

    def issue(self, request: SessionIssueRequest) -> LoginResult:
        self.issue_requests.append(request)
        session = AuthSession(
            id="session-1",
            account_id=request.account.id,
            csrf_token="csrf-1",
            issued_at=10,
            expires_at=20,
            last_activity_at=10,
        )
        return LoginResult(
            account=request.account,
            session=session,
            cookie_value="cookie-1",
            csrf_token=session.csrf_token,
        )

    def verify(self, cookie_value: str, *, surface: AuthSurface) -> AuthContext | None:
        assert cookie_value == "cookie-1"
        assert surface == AuthSurface.API
        return self.verified

    def revoke(self, session_id: str) -> None:
        raise AssertionError(f"unexpected revoke: {session_id}")


def auth_context(role: DashboardRole, *, enabled: bool = True) -> AuthContext:
    account = Account(
        id=f"{role.value}-1",
        login=role.value,
        display_name=role.value.title(),
        role=role,
        enabled=enabled,
    )
    session = AuthSession(
        id=f"{role.value}-session",
        account_id=account.id,
        csrf_token="csrf",
        issued_at=1,
        expires_at=2,
        last_activity_at=1,
    )
    return AuthContext(account=account, session=session, surface=AuthSurface.API)


def test_login_normalizes_account_and_issues_session_without_exposing_secrets() -> None:
    account = Account(
        id="account-1",
        login="alice",
        display_name="Alice",
        role=DashboardRole.OPERATOR,
    )
    sessions = FakeSessionManager()
    verifier = FakeCredentialVerifier()

    outcome = login(
        credentials=LoginCredentials(login="  Alice  ", secret="correct", metadata={}),
        account_store=FakeAccountStore([account]),
        credential_verifier=verifier,
        session_manager=sessions,
        surface=AuthSurface.DASHBOARD,
        metadata={"user_agent": "pytest"},
    )

    assert outcome.authenticated is True
    assert outcome.result is not None
    assert outcome.result.account.to_payload() == {
        "id": "account-1",
        "login": "alice",
        "display_name": "Alice",
        "role": "operator",
        "enabled": True,
    }
    assert verifier.calls == [("Alice", "account-1")]
    assert sessions.issue_requests[0].account == account
    assert "correct" not in repr(outcome)
    assert "cookie-1" not in repr(outcome)


def test_login_denies_missing_disabled_and_invalid_credentials() -> None:
    disabled = Account(
        id="disabled-1",
        login="disabled",
        display_name="Disabled",
        role=DashboardRole.OPERATOR,
        enabled=False,
    )
    valid = Account(
        id="viewer-1",
        login="viewer",
        display_name="Viewer",
        role=DashboardRole.VIEWER,
    )

    assert (
        login(
            credentials=LoginCredentials(login="missing", secret="correct", metadata={}),
            account_store=FakeAccountStore([valid]),
            credential_verifier=FakeCredentialVerifier(),
            session_manager=FakeSessionManager(),
            surface=AuthSurface.API,
        ).failure_reason
        == LoginFailureReason.UNKNOWN_ACCOUNT
    )
    assert (
        login(
            credentials=LoginCredentials(login="disabled", secret="correct", metadata={}),
            account_store=FakeAccountStore([disabled]),
            credential_verifier=FakeCredentialVerifier(),
            session_manager=FakeSessionManager(),
            surface=AuthSurface.API,
        ).failure_reason
        == LoginFailureReason.DISABLED_ACCOUNT
    )
    assert (
        login(
            credentials=LoginCredentials(login="viewer", secret="wrong", metadata={}),
            account_store=FakeAccountStore([valid]),
            credential_verifier=FakeCredentialVerifier(),
            session_manager=FakeSessionManager(),
            surface=AuthSurface.API,
        ).failure_reason
        == LoginFailureReason.INVALID_CREDENTIALS
    )


def test_permissions_keep_viewers_read_only_and_operator_mutating() -> None:
    viewer_read = authorize_permission(
        auth_context(DashboardRole.VIEWER),
        DashboardPermission.CONNECT_READ,
        metadata={},
    )
    viewer_mutate = authorize_permission(
        auth_context(DashboardRole.VIEWER),
        DashboardPermission.PROJECT_MUTATE,
        metadata={},
    )
    operator_mutate = authorize_permission(
        auth_context(DashboardRole.OPERATOR),
        DashboardPermission.PROJECT_MUTATE,
        metadata={},
    )

    assert viewer_read.allowed is True
    assert viewer_mutate.allowed is False
    assert viewer_mutate.reason == AuthDecisionReason.INSUFFICIENT_ROLE
    assert operator_mutate.allowed is True


def test_project_lifecycle_requires_operator_and_one_to_one_identity() -> None:
    valid = ProjectIdentity(project="alpha", session="alpha", board="alpha")
    invalid = ProjectIdentity(project="alpha", session="alpha", board="beta")

    viewer = authorize_project_lifecycle(
        context=auth_context(DashboardRole.VIEWER),
        action=ProjectLifecycleAction.CREATE,
        identity=valid,
        metadata={},
    )
    operator = authorize_project_lifecycle(
        context=auth_context(DashboardRole.OPERATOR),
        action=ProjectLifecycleAction.CREATE,
        identity=valid,
        metadata={},
    )
    mismatch = authorize_project_lifecycle(
        context=auth_context(DashboardRole.OPERATOR),
        action=ProjectLifecycleAction.CREATE,
        identity=invalid,
        metadata={},
    )

    assert valid.is_one_to_one is True
    assert invalid.is_one_to_one is False
    assert viewer.allowed is False
    assert operator.allowed is True
    assert mismatch.reason == AuthDecisionReason.INVALID_PROJECT_IDENTITY


def test_verify_session_rejects_disabled_accounts_and_csrf_compares_safely() -> None:
    disabled = verify_session(
        cookie_value="cookie-1",
        session_manager=FakeSessionManager(
            verified=auth_context(DashboardRole.OPERATOR, enabled=False)
        ),
        surface=AuthSurface.API,
    )
    context = auth_context(DashboardRole.OPERATOR)

    assert disabled is None
    assert csrf_token_matches(context=context, supplied_token="csrf") is True
    assert csrf_token_matches(context=context, supplied_token="csrf-x") is False
    assert csrf_token_matches(context=context, supplied_token="csrf-\u2603") is False
