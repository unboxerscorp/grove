# Changelog

All notable changes to grove are documented here. grove is the standalone,
self-contained dev-room / team-OS product (kanban board + channels + live-terminal
web), driving a tree of real codex / claude / antigravity (agy) CLI sessions in tmux.

## [0.5.0] — v1.4 (2026-06-04)

Team-facing surfaces for the v1.3 backend. Auto-started after v1.3.0.

### Dashboard

- **Audit drawer** — read-only audit lane over /api/audit (action/node filters +
  cursor paging; actor/action/target/time).
- **OrgChart delegation-edge overlay** — toggle-able who-delegated-to-whom edges
  (from audit assign/delegate), distinct from parent/group edges, width by frequency.
- **Node-status detail** — per-node idle/error/blocked/dead + last-seen, with an
  inferred/confidence badge.
- **Cost/credit panel** — per-agent (codex/claude/agy) tokens + cost; estimates clearly
  marked (badge + provenance); agy credit shows unknown + warning when there's no local
  source (never fabricated).

### Backend

- **/api/cost** — best-effort per-agent cost from registry + run metadata + transcript
  parsing; every number tagged source/confidence; last_seen validated (no path/token
  leak); transcript failures graceful (no 500); viewer 403 + project-scoped.

### Safety

- `grove delegate` refuses sending the bearer token to a non-loopback URL by default
  (`--allow-remote` opt-in).

### Quality

- Aligned all v1.4 surfaces to the **real** backend contracts and made the web mock
  mirror the real backend, so `verify` now catches FE↔backend drift (the gap that let
  the assumed-shape panels pass). Stabilized the flaky tmux focus-restore test.

### Deferred (→ v1.5)

- Real-server e2e (api.mjs) coverage for /api/audit, /api/status?detail=1, /api/cost
  (close the mock-only gap systemically); node-status using backend idle/error directly;
  board event cursor replay.

## [0.4.0] — v1.3 (2026-06-04)

The multi-orchestrator team OS made real — delegation as a command + real team
auth + an audit lane. Auto-started after v1.2.0 per the standing 24/7 directive.

### Multi-orchestrator

- **`grove delegate <node> "<title>" [--body|--board|--session|--json]`** — board-as-
  delegation as a command: any orchestrator node creates a board task assigned to a
  child via the local grove-web API, and the pull executor runs it. URL/token discovery
  via `~/.grove/<session>/web.json` + the stable dashboard-token. Live-verified
  end-to-end (node delegate → task on board). grove-web now writes web.json on startup.

### Team auth

- **Real team auth** (`--team-auth` opt-in; loopback stays local-token frictionless):
  member registry (PBKDF2-SHA256, roles admin/operator/viewer, no plaintext, 0600),
  HttpOnly+SameSite signed cookie session with a **server-side session store
  (logout revokes; a stolen cookie is dead after logout)**, CSRF on state-change,
  `/api/me|login|logout|csrf`, constant-time-ish login (no member-existence oracle).
  Team mode never bootstraps the HTML token.

### Audit & observability

- **Audit lane** — board mutations (claim/complete/block + create-task assignee + node
  spawn/update) record audit events with the resolved **actor**; read-only `/api/audit`
  (token + role gated, project-scoped, SQL-filtered cursor pagination).
- `/api/status?detail=1` — per-node detail (status running/idle/error/blocked/dead,
  last_seen, reason) tagged source/confidence (never mixing estimate with fact).

### Reliability / polish

- Stabilized the flaky tmux focus-restore test (deterministic execFile mock; 5×
  consecutive green).

### Docs

- `docs/DESIGN_delegate.md`, `docs/DESIGN_audit_and_cost.md`, `docs/ROADMAP_v1.3.md`.

### Deferred (→ v1.4)

- FE team surfaces: audit drawer, org-graph delegation edges, cost/credit view
  (esp. agy credit); best-effort `/api/cost` implementation; non-loopback
  `GROVE_WEB_URL` token-egress guard.

## [0.3.0] — v1.2 (2026-06-04)

Reliability core + observability + resilience + team-mode design. Auto-started
right after v1.1.0 per the standing 24/7 directive (no user gate between versions).

### Reliability

- **Event-driven turn detection** — `fs.watch` wake-ups replace the fixed 1.5s
  poll in the wait path (ops/tail/fanin): near-instant on transcript append, with a
  deadline-bounded safety fallback (can never hang). Durable submit baseline
  preserved; a bound session with a missing or empty (size 0) transcript fails fast
  with a rebind/repair hint instead of timing out. Live-verified on the dev10 fleet.

### Resilience

- **`grove despawn`** + node lifecycle — clean teardown: kills the node's pane via a
  validated single-pane target only (ambiguous targets refused, so an odd registry
  value can't kill a whole window) + registry cleanup (children/parent fixups); bulk
  `--group`/`--all` needs `--yes`; pane-absent / dead-session → registry-only. Live
  kills run inside preserveActiveWindow (no focus steal). `grove rebind` repair
  re-resolves stale pane targets.
- **Board store** — WAL + `busy_timeout=5s` + `synchronous=NORMAL` on every
  connection: readers no longer block the writer, contention waits instead of
  SQLITE_BUSY (16 concurrent claims serialize to a single CAS winner).

### Observability

- `/api/health` (unauthenticated, no leak: ok/version/board_ok/uptime) split from the
  token-gated `/api/status` (+ node-liveness summary). Structured, redacted request/
  error logs. Dashboard node-status bar + server health dot.

### Security

- Stable dashboard token persisted (0600, race-safe O_EXCL) across restarts — a
  relaunch no longer 401s open dashboards.

### agy

- Environment parity (#21): the skills generator emits `.agents/AGENTS.md` +
  `.agents/skills` for agy in sync with the codex/claude targets; agy follows the same
  harness/org/delegate conventions. (Interactive submit fixed in v1.1.)

### Docs

- `docs/DESIGN_team_auth.md` (team-mode auth design), `docs/ROADMAP_v1.2.md`.

### Deferred (→ v1.3)

- `grove delegate` / first-class board-as-delegation + multi-orchestrator UX; real
  team-auth implementation (per the design); deeper observability (heatmap detail,
  metrics).

## [0.2.0] — v1.1 "Stable" (2026-06-04)

Hardening release over v1.0: a 5-node review swarm (codex + claude + agy×3) audited
the v1.0 surface; every P0/P1/P2 finding was fixed, reviewed, and live-verified.
Comprehensive tests added (core ~88%, bridge ~89% line coverage) plus user journeys.

### Security

- **Dashboard auth gate** — the session token is no longer bootstrapped into the
  served HTML on a non-loopback bind unless `--unsafe-bind` is set (loopback
  unchanged). Host/Origin allowlist on state-changing requests with `--allow-host`;
  wildcard binds still validate Host. `/api/health` (unauthenticated, no project
  info) split from the now token-gated `/api/status` (stops project enumeration).
- **Per-project isolation** — task detail/comments/runs/comment-write/slack-thread
  endpoints cross-check the task's board against the resolved project (BOLA/IDOR
  closed). ws-ticket bound to `{project, kind, pane_id}` (JSON body); terminal/board
  WebSockets reject kind/pane mismatch (1008). Terminal WS re-checks the pane
  allowlist inside the stream loop.
- **Secret redaction** — pull-executor stdout/stderr/result/summary/comments are
  redacted before hitting the board DB; `TOKEN_RE` covers xapp-/xox[baprs]-/ghp\_/…
- **Path & shell hardening** — shared node/session name validator + `.grove`
  containment via `realpath` (rejects `../`, absolute, symlink escape); shell-quoting
  of cwd/model/resume/log paths typed into panes; `grove serve` returns stable error
  codes only (raw errors to local log).

### Reliability

- **Atomic writes** — registry and `grove.project.json` write to a temp file (0600)
  then rename; no truncation/corruption under concurrent saves or mid-write crashes.
- **Stable pane targeting** — spawn/split and config-explicit nodes store the
  immutable tmux `%pane_id`; `loadContext` prefers the registry pane. Fixes the
  `grove spawn --window` same-pane collision (multiple nodes per window now distinct).
- **agy adapter** submits reliably (enter-enter after bracketed paste; was a single
  Enter that left messages queued).
- **Board WebSocket** — exponential reconnect backoff + close-code handling (stop on
  4401, no reconnect on dispose) + catch-up reload on (re)connect.
- **ask-human crash-safety** — pending pre-record + dedup metadata + Slack-history
  reconciliation (exhaustive pagination; malformed/incomplete history retried, never
  false-complete); no permanent skip, no duplicate sends, orphan threads reconciled.
- **Board store** — `_ensure_board` uses BEGIN IMMEDIATE + INSERT OR IGNORE.
- **Team fields** preserved across restart (`...prev` merge in bringUp).

### Tests

- Core vitest coverage ~88% (new util suites at 100%; CLI commands wait/gather/ask/
  up/tail/watch/serve/down/session/rebind with failure paths).
- Bridge pytest coverage ~89% (store CAS/lease/stale, executor, web_app endpoints
  incl. the auth gate, auth-status branches + redaction, slack recovery, notifier).
- Web: headless mock harness (project switch + WS reconnect, board-live, a11y) and a
  real-server API e2e (`web/e2e/api.mjs`).
- `docs/USER_JOURNEYS.md` — 11 journeys mapped to tests + a needs-test backlog.

### UX / a11y

- Correct state on project switch (OrgChart per-effect alive flag, SlackPanel
  projectTick). AuthPanel copied-state reset + no re-fetch on language toggle.
  BoardView fallback column for out-of-range statuses. OrgChart edge-cut keyboard
  access + drawer focus-trap.

### Docs

- `docs/USER_GUIDE.md` (install/onboarding, local-per-member model), `ROADMAP_v1.1.md`,
  `V1.2_BRAINSTORM.md`.

### Known follow-ups (→ v1.2)

- Event-driven turn detection (fs.watch, replacing the poll), agy environment parity
  (AGENTS.md/skills), stable session token across restarts, `grove despawn`/node
  lifecycle, deeper resilience + observability (health depth, structured logs, node
  heatmap), real auth (beyond the token) for team mode.

## [0.1.0] — v1.0 (2026-06-03)

Initial self-contained grove dev-room: project lifecycle (`grove new-project` /
`load-project` + portable `grove.project.json`), GUI org-chart team builder, board =
live delegation (pull executor), live terminal view, Slack integration (manifest +
token registration + ask-human gate), dev-tool auth-status panel, node descriptions,
per-project WebSocket isolation. Fully Hermes-free, grove-native stack.
