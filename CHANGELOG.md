# Changelog

All notable changes to grove are documented here. grove is the standalone,
self-contained dev-room / team-OS product (kanban board + channels + live-terminal
web), driving a tree of real codex / claude / antigravity (agy) CLI sessions in tmux.

## [0.17.0] — v1.16 (2026-06-04)

See many rooms in one view. Auto-started after v1.15.0. Read-only and privacy-first —
observation only, no cross-machine control. Default OFF.

### Signed read-only summary + aggregation

- **GET /api/summary** (default OFF, token + project-scoped) exports a signed, privacy-
  allowlisted summary: board/node/task/run COUNTS only, every count key drawn from an enum
  allowlist (status, agent) with anything else folded into an "other" bucket — no arbitrary
  string, secret, token, path, member PII, task body, or transcript content. HMAC-signed; the
  response carries key_id, never the key (stored O_EXCL + 0600).
- **POST /api/aggregate** verifies each submitted summary against a key resolved by its key_id
  from a trusted key set (local + optional summary-trusted-keys.json); unknown/missing key_id or
  a tampered signature → untrusted; a timestamp past the freshness window → stale; beyond a 60s
  clock-skew constant → untrusted. Untrusted/stale are excluded from the combined view; the
  combined view re-applies the allowlist. Observe-only — no mutation, no cross-machine control.

### Aggregation view

- A "집계" tab: per-room cards with counts, a trust badge (trusted/untrusted) and a freshness
  badge (fresh/stale + relative time); untrusted/stale rooms are marked "excluded from combined"
  — never shown as live. Only key_id is shown (never signature/key). The multi-room path is real:
  paste another grove's signed summary to add a peer, then own + peers are submitted to
  /api/aggregate. Disabled export renders a fixed "off" notice.

### Quality / safety

- Adversarial review hardened privacy + trust: P1 value-allowlist (count keys were arbitrary
  strings → enum + "other"), P1 key_id trust model (per-source verification, unknown → untrusted),
  P1 mock/FE aggregate contract drift (mock now processes the actually-submitted summaries, not
  fabricated rooms), clock-skew constant. 243 py tests; web e2e 327/327 (+51 for the endpoints,
  with canonical signing + tamper/unknown/stale/future cases).

### Deferred (→ v1.17)

- Signed cross-room handoff contract, retro analytics, usage/cost trend reporting v2,
  notification routing v2 (see docs/V1_17_BRAINSTORM.md).

## [0.16.0] — v1.15 (2026-06-04)

Observe & report. Auto-started after v1.14.0. Read-only — no new mutation or autonomy.

### Cost/usage reporting

- **GET /api/usage** rolls up run cost/usage by node and by day — read-only, token +
  project-scoped (cross-project leak rejected, path-traversal / missing-project denied),
  reusing the existing cost logic. agy stays honest: tokens are reported when run_metadata
  recorded them, but cost/credit is unknown + warning — never fabricated. Response carries
  node/filter/warnings only (run metadata redacted; no secret/path). The cost tab surfaces it
  as a node/day usage section.

### Execution timeline visualization

- The v1.13 execution timeline grows into a step/gantt: per-transition duration, proportional
  bars, phase glyphs/colors, current-phase highlight, total duration. Read-only (audit GET).
  mock + verify + i18n now mirror the real 7-phase contract from store.py
  (claim→preflight→approval-pending→approve→execute→verify→complete, + abort/rollback/
  release-stale) — a dropped approval-pending phase was caught in review.

### Mobile

- A responsive pass (@media max-width:480px) over the safety surfaces (approval queue,
  kill-switch, status, node-status detail): tabs scroll, panels fit, no horizontal overflow at
  390px. CSS only, no functional change.

### Quality

- Reviewer + real-server e2e caught two contract drifts (timeline missing approval-pending;
  usage mock source + agy tokens-known-vs-cost-unknown) — realigned to the real backend. 239 py
  tests; web e2e 276/276 (+44 for /api/usage).

### Deferred (→ v1.16)

- Signed multi-machine read-only aggregation + privacy policy + trust/freshness badges,
  cross-room handoff contract, retro analytics, trend reporting (see docs/V1_16_BRAINSTORM.md).

## [0.15.0] — v1.14 (2026-06-04)

Reach the safety controls from Slack. Auto-started after v1.13.0. Remote control, not remote
automation — every Slack action carries the v1.13 gates.

### Slack command surface v1 (off by default)

- **status / approve / abort / killswitch** from Slack, each safety-gated:
  - **Role-gated** — Slack identity maps to a member; only operator/admin can approve/abort/
    arm-kill; viewers and unmapped identities are rejected before any mutating preview.
  - **Preview → confirm** — a command returns a preview; execution needs an explicit confirm
    with a one-shot, expiring confirmation id. The id store is mutex-guarded so owner-check +
    consume is a single critical section — exactly-once even under concurrent confirms; a
    non-owner can't burn the owner's id.
  - **Reuses the v1.13 execution path** — approve/abort/kill go through the same store
    transitions; no second path that bypasses a gate (reviewer confirmed no direct-execute).
  - **killswitch node** is validated against the project registry allowlist (typo / unexposed
    node rejected); project-scoped (no cross-project control).
  - **Audited** (actor = Slack identity) and **redacted** (no token/path/lease in any
    preview/status/error). main() wires the commands only under --enable-commands.

### Quality / safety

- Adversarial review found no gate-bypass; P1 production-wiring + owner-before-consume +
  unknown-node-reject, then one-shot-consume atomicity (mutex) — all fixed and re-reviewed.
  237 py tests (incl. replay, expiry, owner-griefing, unknown-node, concurrent consume), 88%
  coverage. Slack-side feature (no new HTTP endpoint); web e2e unchanged at 232/232.

### Deferred (→ v1.15)

- Mobile approval/kill-switch surface, execution timeline visualization, multi-machine
  read-only aggregation, cross-room handoff, cost/usage reporting (see docs/V1_15_BRAINSTORM.md).

## [0.14.0] — v1.13 (2026-06-04)

The guarded autonomous execution loop. Auto-started after v1.12.0. Built safety-first over
a 5-round adversarial review — the loop closes only behind every gate.

### Guarded execution loop (default OFF)

- A claimed task can move claimed → preflight → approval-pending → (approve) → executing →
  verify → complete, with abort/rollback safe terminals. Safety is enforced at the DB at
  runtime, not just in config:
  - **Default OFF + both gates** — execution is a separate flag from autopickup; the execute
    path and every transition require BOTH ON.
  - **Approval gate** — a preflighted task waits in approval-pending; no path reaches
    executing without an explicit approve.
  - **Concurrency 1** — per-assignee executing lease in BEGIN IMMEDIATE.
  - **Multi-level kill-switch** — global/board/node/task, checked at every transition and at
    dispatch; a mid-flight flip aborts (heartbeat re-checks both gates).
  - **Prepared two-phase dispatch** — the helper spawns held and execs only after it
    re-validates a one-shot dispatch lease in a single immediate transaction (gate + state +
    approved + run/node/token + expiry + consumed_at). Absent/invalid lease is fail-closed;
    the lease rides the Popen env and never leaves the server. Residual post-consume flip is
    a mid-flight kill, caught by the heartbeat dual-gate.
  - **release_stale** resets execution metadata + audits; every transition is audited with
    recursive payload sanitization.

### Dashboard

- A "실행" tab: approval queue (explicit, confirm-gated approve/abort), per-node execution
  toggle (distinct from autopickup; gate/kill-switch/viewer aware), global kill-switch
  arm/clear (confirm + viewer-locked), and an execution timeline from audit.execution.\*.
  /api/me drives a proactive role-based viewer lock.

### Quality / safety fixes (caught before ship)

- 5-round adversarial safety review of the dispatch race: 2 P0 (autopickup-OFF bypass,
  kill-switch dispatch race) + P1 (release_stale leak), then the race closed across
  handshake → heartbeat dual-gate → helper-side lease re-validation → env-delivery +
  fail-closed + atomic lease-consume.
- Real-server e2e caught the per-node execution toggle returning 200 instead of 409 under a
  gate-OFF / kill-switch; fixed. /api/tasks/{id}/execution strips the dispatch_lease
  (token never exposed). 228 py tests; web e2e 232/232 (+68 for the loop).

### Deferred (→ v1.14)

- Slack command surface v1 (safety commands first), mobile approval/kill-switch, execution
  timeline visualization, multi-machine read-only aggregation (see docs/V1_14_BRAINSTORM.md).

## [0.13.0] — v1.12 (2026-06-04)

Act on the recommendations — explicit, human-initiated actions. Auto-started after v1.11.0.
No new autonomous behavior (the guarded execution loop is designed in docs/V1_13_BRAINSTORM.md,
gated to v1.13).

### Control the autonomy

- **Pickup-enable toggle** — GET/POST /api/nodes/{node}/autopickup flips a node's autonomous-
  pickup opt-in (token + project-scoped, strict node name, team viewers rejected, persisted in
  board settings_json, audited as audit.node.autopickup). The **global gate is authoritative**:
  POST returns 409 when global is OFF / kill-switch ON, AND pull_executor re-reads the DB global
  state at runtime before every pickup — a per-node ON can never bypass a global OFF / kill-switch.
- **Toggle in the dashboard** — node-status detail shows the toggle (real config), kept distinct
  from the v1.11 ⚡ 자율(추론) inferred badge. When global is OFF / kill-switch ON the toggle is
  disabled with a reason; a viewer (403) locks it; errors render a fixed string.

### Delegate from a recommendation

- **Planner→delegate one-click** — the read-only planner panel gains an explicit, two-step
  "delegate to this node" per candidate (button → confirm → POST the existing delegate path,
  assignee + status:ready). Recommendation stays read-only by default; nothing is delegated
  without a button + confirm. Errors render a fixed string (no raw/secret leak).

### Quality

- Reviewer gates: kill-switch runtime-bypass (P0, executor ignored DB global state) + mock/backend
  contract drift (node validation, trim normalization) + verify coverage (kill-switch case) —
  each caught and fixed before commit. 204 py tests; web e2e 164/164 (+29 for the new endpoint).

### Deferred (→ v1.13)

- Guarded autonomous execution loop (risk-gated: preflight/approval/execute/verify/complete,
  concurrency 1, rollback, multi-level kill-switch), Slack command surface v1, mobile actions,
  multi-machine read-only aggregation (see docs/V1_13_BRAINSTORM.md).

## [0.12.0] — v1.11 (2026-06-04)

Smarter delegation + visible autonomy. Auto-started after v1.10.0.

### Routing planner (read-only)

- **GET /api/plan** recommends candidate nodes for a task/role — ranked by role/capability
  match + current node load (running/blocked from node-status) + cost signal — and returns
  them read-only. No side effects: the planner only reads (list_runs/list_tasks), never
  claims/delegates/spawns; the human/lead still decides. Token-gated and project/task
  scoped (no cross-project leak). Every score factor is tagged with source + confidence
  (estimate vs measured); cost normalizes tokens and usd separately (no unit mixing).
  Returned requirements terms are redacted via the backend's path/secret masking (no
  absolute path or xoxb/sk-/gh\*\_ token leak). 198 py tests + 28 real-server e2e checks.

### Autonomy visibility (web)

- **Audit drawer** surfaces autopickup + retro events with distinct chips/glyphs and quick
  filters (exact /api/audit?action= match) — you can see who self-claimed or self-retro'd.
- **Org nodes** show a `⚡ 자율(추론)` / `auto (inferred)` badge when a node has autonomous
  pickups in the audit trail — labeled inferred (read-only; not a config flag).

### Planner surfacing (web)

- **Task drawer** gains a read-only "node recommendation" panel: enter a role → GET
  /api/plan → ranked candidates with per-factor score + confidence. No assign/delegate
  button (display only; verify asserts no mutation before/after). Error UI renders a fixed
  string only — never e.message — and getJSON strips the query from thrown errors so role
  input can't leak. Mock mirrors the real \_plan_payload shape and its redaction order
  (mask path/secret → tokenize), so /etc/passwd + xoxb-tokens never surface as terms.

### Quality

- Reviewer gates: planner term-redaction (P1) + cost-unit-mixing, FE error-leak (P1) +
  mock/backend redaction drift (P2) — each caught and fixed before commit. Full check +
  web e2e green (135/135).

### Deferred (→ v1.12)

- planner→delegate one-click, pickup-enable toggle UI, guarded autonomous execution loop,
  Slack command surface v1, mobile actions (see docs/V1_12_BRAINSTORM.md).

## [0.11.0] — v1.10 (2026-06-04)

Safe self-direction. Auto-started after v1.9.0.

### Autonomy (guarded)

- **Guarded autonomous pickup** (default OFF) — an idle, opt-in node can CAS-claim one
  ready, unassigned board task matching its role/capability rules (via claim_next, no
  CAS/lease bypass): at most one in-flight, a cooldown persisted across restarts/--once,
  global + per-node kill-switch, despawn/repair respected. Each pickup is audited
  (audit.task.autopickup, actor=node). No runaway.
- **Self-retro lane** — POST /api/tasks/{id}/retro appends a short retro on a done task
  (opt-in; team viewers rejected; status untouched) → audit.task.retro. The node field is
  strict-validated and audit payloads are recursively sanitized (token/path masked).

### Deferred (→ v1.11)

- Routing/cost-aware planner, Slack command surface, mobile actions, FE surfacing of
  autopickup/retro (see docs/V1_11_BRAINSTORM.md).

## [0.10.0] — v1.9 (2026-06-04)

Portable, easy-to-start team room. Auto-started after v1.8.0.

### Portability

- **Project export/import** — `grove export-project` writes a portable bundle
  (bundle.json + grove.project.json + scaffold.yaml) with machine-local fields stripped
  (session_id / transcript / absolute paths / secrets excluded); `grove import-project`
  recreates the project with workspace-path containment (rejects traversal / absolute).
  Round-trip preserves the org chart / nodes / workspace (machine-local stays fresh).

### Onboarding

- **Onboarding wizard v2** — a skippable, remembered first-run flow (create / load /
  import a project, add first nodes, auth status) that reuses the existing project APIs.

### Deferred (→ v1.10)

- Self-retro lane; guarded autonomous pickup, routing planner, Slack command surface
  (see docs/V1_10_BRAINSTORM.md).

## [0.9.0] — v1.8 (2026-06-04)

Complete the team room — presence + a notification layer. Auto-started after v1.7.0.

### Collaboration

- **Presence** — /api/presence shows who's connected: in team-auth mode, members by
  name/role; on loopback, an anonymous count. A header presence indicator (4s poll,
  project-scoped) renders name/role only (no id/session/token).
- **Notification rules** — blocked / ask-human-pending tasks fire a notification through
  the existing (dry-run-default) notifier, deduped via notify_subs so the same task
  doesn't re-notify; payloads are path/token-redacted.

### Deferred (→ v1.9)

- Onboarding wizard v2, project import/export, self-retro lane, guarded autonomous
  pickup (see docs/V1.9_BRAINSTORM.md).

## [0.8.0] — v1.7 (2026-06-04)

The collaborative team room — a decision inbox + precise board replay. Auto-started
after v1.6.0.

### Collaboration

- **Decision inbox** — /api/inbox surfaces blocked + ask-human tasks that need a human
  decision (project-scoped, sanitized), shown in a dashboard inbox drawer with an
  unresolved-count badge. Answering (POST /api/tasks/{id}/answer) records the answer as
  a comment **and** unblocks the task (operator/admin; viewers read-only), so the item
  resolves and disappears; the audit lane records the actor.

### Reliability

- **Board event cursor replay** — on WS reconnect the client requests
  events-after-cursor (the server already streams via list_events_after): precise
  downtime catch-up instead of a full reload, with the full-reload fallback preserved.

### Deferred (→ v1.8)

- Presence; notification rules, onboarding wizard v2, project import/export, self-retro
  lane (see docs/V1.8_BRAINSTORM.md).

## [0.7.0] — v1.6 (2026-06-04)

Reliability + delegation visibility. Auto-started after v1.5.0.

### Reliability

- **`grove repair` node auto-recovery** — detects dead/stale nodes (pane gone /
  transcript missing-or-empty / stale) and recovers them non-destructively: a stale
  pane target is re-resolved via paneTarget, a bound session with a broken transcript
  is marker-rebound; a fully-lost pane is reported `unrecoverable` (never killed —
  kill stays despawn-only). Focus-safe (preserveActiveWindow). Reports
  {recovered, stale, unrecoverable}; `--all|--node|--json`.

### Dashboard

- **Delegation-chain explorer** — traces multi-hop delegation chains
  (lead → sub-lead → leaf) from /api/audit assign/delegate events (cycle-graceful),
  with a node filter; complements the single-edge overlay.

### Deferred (→ v1.7)

- Board event cursor replay; presence, notification rules, decision inbox, onboarding
  wizard v2, project import/export (see docs/V1.7_BRAINSTORM.md).

## [0.6.0] — v1.5 (2026-06-04)

Test-net hardening + dashboard delegation. Auto-started after v1.4.0.

### Testing

- **Real-server e2e** (web/e2e/api.mjs, 61 → 107 checks) now covers /api/audit,
  /api/status?detail=1 and /api/cost with exact-shape assertions against a live
  grove-web — closing the mock-only gap that caused the v1.1/v1.4 FE↔backend drift
  (a mismatch now fails CI, not just the hand-written mock).

### Dashboard

- **Delegate from the UI** — an org-chart node action opens a small form that posts an
  assigned task (web equivalent of `grove delegate`); project-scoped; the backend
  records the audit actor.
- **Node-status uses backend idle/error directly** — no more derived idle that
  mis-counted error nodes; error gets its own coral segment/chip in the bar + detail.

### Deferred (→ v1.6)

- Board event cursor replay; v1.6 features from V1.6_BRAINSTORM (delegation-chain
  explorer, presence, notification rules, node auto-recovery, room supervisor).

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
