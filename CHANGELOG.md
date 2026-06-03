# Changelog

All notable changes to grove are documented here. grove is the standalone,
self-contained dev-room / team-OS product (kanban board + channels + live-terminal
web), driving a tree of real codex / claude / antigravity (agy) CLI sessions in tmux.

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
