# grove 팀모드 인증 설계

> Status: historical v1.2 design.
> Current live auth is documented in `docs/design/AUTH_AND_PROJECTS.md`.
> The notes below preserve the original team-auth design discussion and may
> contain stale line references or legacy token/bootstrap terminology.

## v1.2 당시 기준

- 대시보드는 현재 `X-Grove-Session-Token` 단일 헤더로 REST를 보호한다. 토큰 이름은 `bridge/src/grove_bridge/web_app.py:31`, 검증은 `bridge/src/grove_bridge/web_app.py:680`에 있다.
- 토큰은 세션별 `~/.grove/<session>/dashboard-token`에 생성·저장된다. 생성 경로는 `bridge/src/grove_bridge/web_app.py:564`, 파일 권한은 `bridge/src/grove_bridge/web_app.py:588`이다.
- HTML 부트스트랩 토큰 주입은 loopback 또는 `--unsafe-bind`에서만 허용된다. 조건은 `bridge/src/grove_bridge/web_app.py:884`와 `bridge/src/grove_bridge/web_app.py:892`, CLI 플래그는 `bridge/src/grove_bridge/web_app.py:1508`이다.
- 상태 변경은 토큰 검증 뒤 Host/Origin allowlist를 통과해야 한다. 현재 gate는 `bridge/src/grove_bridge/web_app.py:685`와 `bridge/src/grove_bridge/web_app.py:690`, CLI 설정은 `bridge/src/grove_bridge/web_app.py:1516`이다.
- WebSocket은 REST로 발급한 30초 1회용 ticket을 소비한다. TTL은 `bridge/src/grove_bridge/web_app.py:39`, 발급은 `bridge/src/grove_bridge/web_app.py:453`, 소비는 `bridge/src/grove_bridge/web_app.py:477`과 `bridge/src/grove_bridge/web_app.py:521`이다.
- 사용자 가이드는 현재 REST 토큰과 프로젝트 바인딩 ticket 모델을 문서화한다. `docs/USER_GUIDE.md:195`부터 `docs/USER_GUIDE.md:207`까지가 기준이다.
- Tailscale Serve는 tailnet 요청에 `Tailscale-User-Login`, `Tailscale-User-Name`, `Tailscale-User-Profile-Pic` identity header를 붙이고, spoof 방지를 위해 같은 이름의 incoming header를 제거한다. 단, backend는 localhost에만 listen해야 header 신뢰가 안전하다. 참고: Tailscale Serve docs, Identity headers.

## 위협 모델

전제는 Mac mini 한 대에 대시보드가 있고, 코파운더 3명이 Tailscale 사설망으로 접속하는 소규모 신뢰팀이다. 목표는 인터넷 서비스급 인증 제품을 만드는 것이 아니라, 실수와 브라우저 기반 공격면을 줄이고 멤버별 책임 추적을 가능하게 하는 것이다.

막아야 할 것:

- `--host 0.0.0.0` 또는 non-loopback bind가 잘못 열려 우발적으로 민감 API가 노출되는 상황.
- HTML에 주입된 공유 토큰, 화면 공유, 브라우저 확장, 로그 복사 등으로 단일 토큰이 유출되어 모든 사람이 같은 주체로 보이는 상황.
- 팀원의 브라우저가 악성 페이지를 연 상태에서 사설망 주소로 POST를 보내는 CSRF.
- 누가 task 생성, node spawn, Slack token 저장, terminal view ticket 발급, project load 같은 동작을 했는지 모르는 운영 불투명성.
- Tailscale identity header를 직접 backend에 위조해서 보내는 상황.
- 퇴사·장비 분실·토큰 실수 공유 후 특정 멤버만 회수하지 못하는 상황.

명시적으로 과설계하지 않을 것:

- Mac mini의 local admin 또는 root가 악의적인 경우.
- 팀원 장비가 완전히 침해된 경우.
- 공개 인터넷 서비스, 다중 조직, 결제, 기업형 SSO, 세밀한 ABAC.
- 세 명 사이에서 terminal 내용 자체를 엄격히 분리하는 모델. v1.2는 멤버 식별과 기본 role만 다룬다.

## 옵션표

| 옵션                           | 보안                                                                                                              | 구현비용 | UX                                                                   | 판단                                                                             |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------- | -------- | -------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| 공유 토큰 유지+강화            | 우발 노출과 CSRF는 Host/Origin으로 일부 완화되지만 멤버 식별·회수·audit이 약하다.                                 | S        | 이미 동작한다.                                                       | loopback 기본값과 emergency fallback으로만 유지한다. 팀모드 기본으로는 부족하다. |
| per-member 토큰/키             | 멤버별 회수와 최소 audit이 가능하다. 토큰이 유출되면 해당 멤버로 가장된다.                                        | M        | 첫 설정 때 키 배포가 필요하지만 로그인 UI는 단순하다.                | v1.2 bootstrap 수단으로 적합하다. 단, 장기 세션은 cookie로 바꿔야 한다.          |
| 쿠키 세션 + 로그인 + CSRF      | HttpOnly cookie, 서버 세션, CSRF header, logout, idle TTL, audit를 한 모델로 묶을 수 있다.                        | M/L      | 한 번 로그인하면 자연스럽다. password/passkey UX는 추가 작업이 든다. | v1.2 권장 코어. 비밀번호/패스키는 v1.3로 미뤄도 된다.                            |
| Tailscale identity header 활용 | Tailscale Serve 뒤에서는 멤버 식별 UX가 가장 좋고 별도 비밀번호가 없다. 직접 bind에서는 header spoof 위험이 있다. | M        | Serve URL 접속 시 자동 로그인에 가깝다.                              | v1.2 보조 provider로 설계한다. backend가 localhost-only일 때만 신뢰한다.         |

## 권장 단계

권장안은 “명시적 team-auth 모드 = 쿠키 세션 + CSRF + 멤버 registry + audit”이고, 로그인 provider는 두 개를 허용한다.

1. **loopback 모드 유지**: `127.0.0.1`/`localhost` 접속은 현재 단일 토큰 부트스트랩을 유지한다. 로컬 1인 사용자는 로그인 화면을 보지 않는다.
2. **team-auth 모드 추가**: non-loopback 또는 Tailscale 공유는 명시적으로 team-auth를 켠다. 이 모드에서는 HTML에 세션 토큰을 주입하지 않고, SPA는 `/api/me`로 로그인 상태와 CSRF token을 받는다.
3. **per-member bootstrap**: v1.2 최소 구현은 `members.json` 또는 sqlite에 멤버별 login key hash를 저장하고, 사용자는 한 번 로그인해 HttpOnly cookie 세션을 받는다. 원문 key는 저장하지 않는다.
4. **Tailscale Serve provider**: `--trust-tailscale-serve`가 켜지고 backend bind가 `127.0.0.1`일 때만 `Tailscale-User-Login`을 신뢰한다. 직접 `--host 100.x` bind에서는 header provider를 비활성화한다.
5. **v1.3+ 확장**: passkey, 로컬 비밀번호 변경, 역할별 권한, session 관리 UI, Tailscale app capabilities, 더 세밀한 audit 검색을 추가한다.

## 세션, 쿠키, CSRF, Origin 모델

- Cookie: `grove_session=<opaque-id>`를 HttpOnly로 발급한다. HTTPS Serve 뒤에서는 `Secure`; loopback HTTP fallback에서는 Secure 없이 허용한다.
- SameSite: team-auth에서는 `SameSite=Strict`를 기본으로 한다. cross-site redirect provider가 생기면 해당 flow에만 일시적으로 `Lax`를 검토한다.
- Session store: server-side `session_id_hash`, `member_id`, `csrf_secret_hash`, `created_at`, `last_seen_at`, `expires_at`, `user_agent_hash`, `peer_hint`, `revoked_at`을 저장한다.
- TTL: 소규모 팀 UX를 고려해 idle 24시간, absolute 7일을 기본값으로 둔다. 민감 작업이 늘어나면 admin action에 재인증을 붙인다.
- CSRF: 모든 `POST`, `PATCH`, `PUT`, `DELETE`와 `/api/ws-ticket`은 `X-Grove-CSRF` header를 요구한다. token은 `/api/me` 또는 `/api/csrf`의 JSON 응답으로만 내려준다.
- Origin/Host: 현재 `_require_allowed_origin` 계약을 유지한다. team-auth에서도 Host가 loopback 또는 allowlist에 없으면 거부하고, non-loopback 상태 변경은 Origin이 반드시 있어야 한다.
- WebSocket: 브라우저 WS에 custom header를 기대하지 않는다. 기존처럼 REST에서 ticket을 발급하되, ticket payload에 `member_id`, `session_id_hash`, `project`, `kind`, `pane_id`를 묶는다. WS 연결은 cookie를 다시 보지 않고 ticket만 소비한다.
- Token compatibility: 기존 `X-Grove-Session-Token`은 local-token 모드에서만 허용한다. team-auth 모드에서는 admin이 명시한 break-glass token을 제외하고 API 인증 수단으로 쓰지 않는다.

## 멤버 식별과 audit

멤버 record:

```text
member_id
login
display_name
role: admin | operator | viewer
provider: local_key | tailscale
enabled
created_at
updated_at
last_login_at
```

v1.2 role은 작게 시작한다.

- `admin`: 멤버 관리, Slack config, project create/load, node spawn/despawn, 모든 operator 권한.
- `operator`: task/comment/board action, node send/ask/spawn, terminal view.
- `viewer`: board/org/node/terminal read, comment는 v1.3에서 별도 `commenter`로 분리 검토.

최소 audit event:

```text
ts
request_id
member_id
member_login
role
method
route
project
action
target_type
target_id
status
remote_hint
user_agent_hash
```

기록 대상은 state change 전체, `/api/ws-ticket` 발급, Slack token 저장·테스트, project create/load, node spawn/update/despawn, task create/comment/block/unblock/complete, role/member 변경이다. terminal stream 내용과 secret 원문은 audit에 절대 쓰지 않는다.

저장은 v1.2에서 `~/.grove/audit.jsonl` 또는 board sqlite의 `audit_events` table 중 하나로 시작한다. 구현 단순성은 JSONL이 낫고, dashboard 검색은 sqlite가 낫다. v1.2는 JSONL + 최근 500개 API로 충분하다.

## 로그아웃과 회전

- `POST /api/logout`: 현재 session을 revoke하고 cookie를 만료한다. CSRF 필요.
- `POST /api/sessions/revoke`: admin이 특정 멤버의 session을 끊는다.
- 멤버 key 회전: 새 key hash를 추가한 뒤 기존 key hash를 disable한다. 이미 발급된 session까지 끊을지 선택 가능해야 한다.
- session signing secret은 `~/.grove/team-auth/session-secret`에 0600으로 저장한다. 회전하면 모든 session이 로그아웃된다.
- Tailscale provider는 header login이 member registry에 있고 enabled일 때만 session을 발급한다. tailnet에 있다고 자동으로 신규 멤버가 생기면 안 된다.

## 기존 계약과의 정합

- `--unsafe-bind`의 의미는 축소한다. team-auth에서는 이 플래그가 HTML token 주입을 다시 켜면 안 된다. 대신 “legacy local-token remote bootstrap” 경고용으로만 남긴다.
- `--allow-host`는 계속 필요하다. Tailscale Serve URL, MagicDNS host, Mac mini tailnet IP를 명시적으로 넣어야 상태 변경이 통과한다.
- `/api/health`는 계속 public으로 두되 project/session/token/member 정보를 내보내지 않는다.
- `/api/auth-status`, `/api/projects`, `/api/boards`, `/api/nodes`, `/api/org`, `/api/ws-ticket`은 AuthContext를 요구한다.
- SPA bootstrap에는 `window.__GROVE_AUTH_REQUIRED__`와 auth mode 정도만 주입한다. secret, session id, CSRF token은 HTML에 넣지 않는다.
- 기존 e2e의 “토큰 없으면 401”, “ws-ticket 단발·프로젝트 바인딩”, “secret 미노출”은 team-auth variant로 확장한다.

## v1.2 실행 항목

1. `AuthMode` 설계 반영: `local-token` 기본, `team-cookie` 명시 옵션. loopback은 기본 `local-token`, non-loopback 권장 runbook은 `team-cookie`.
2. team-auth config: `~/.grove/team-auth/members.json`, `~/.grove/team-auth/session-secret`, `~/.grove/team-auth/audit.jsonl` 경로를 정한다. 파일 권한은 0600, directory는 0700.
3. auth middleware: 요청마다 `AuthContext`를 만들고 기존 `_require_token` 호출부를 `_require_auth`와 `_require_state_change_auth`로 대체하는 설계를 준비한다.
4. endpoints: `GET /api/me`, `POST /api/login`, `POST /api/logout`, `POST /api/csrf`, `GET /api/audit/recent`를 추가한다.
5. CSRF: unsafe method와 `/api/ws-ticket`에 `X-Grove-CSRF`를 요구한다. Origin/Host gate는 현재 로직을 재사용한다.
6. WS ticket: issue 시 member identity를 ticket에 넣고, consume 후 audit event를 남긴다.
7. UI: 401이면 login screen, 성공하면 member chip과 logout button, CSRF 자동 header 주입을 구현한다.
8. Tailscale Serve: `--trust-tailscale-serve`는 backend host가 loopback일 때만 허용하고, `Tailscale-User-Login`이 등록 멤버와 일치할 때 session을 발급한다.
9. tests: loopback local-token regression, team-cookie login/logout, CSRF missing/invalid, Host/Origin reject, ws-ticket member binding, audit redaction, header spoof direct-bind rejection.
10. docs: Tailscale Serve 권장 runbook과 직접 bind fallback runbook을 분리한다.

## v1.3+ 확장

- Passkey 또는 로컬 비밀번호 기반 로그인.
- role별 action policy full matrix와 viewer/commenter/operator/admin 분리.
- session 관리 UI: 현재 접속, revoke, last_seen, device hint.
- audit timeline UI와 export.
- Tailscale app capabilities header로 role hint를 받아 registry role과 교차 검증.
- 멤버 초대 wizard와 key rotation UX.
- team read-only share preset: terminal read-only, board read-only, Slack config hidden.

## 오픈 퀘스천

- 팀이 실제로 Tailscale Serve URL로 접속할지, 아니면 Mac mini의 tailnet IP에 직접 접속할지. identity header provider는 Serve가 아니면 신뢰하지 않는 쪽이 맞다.
- v1.2에서 local login key를 어느 채널로 배포할지. 대시보드 최초 admin 화면, CLI 생성, 수동 파일 편집 중 선택이 필요하다.
- viewer에게 terminal 내용을 보여줄지, board/org만 보여줄지. 작은 팀 기본값은 terminal read 허용이지만 제품 기본값은 더 보수적일 수 있다.
- Slack token 저장과 project load/create를 admin-only로 바로 묶을지, operator에게 일부 허용할지.
- audit store를 JSONL로 먼저 둘지 sqlite table로 시작할지. v1.2 구현 속도는 JSONL이 빠르고, dashboard 검색은 sqlite가 낫다.
