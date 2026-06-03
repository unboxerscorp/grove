# grove v1.1 "Stable" — Roadmap

> Status: **autonomous build in progress** (started 2026-06-04, overnight run).
> v1.0 shipped (local dev-room: project lifecycle, Slack, auth-status, per-project
> WS isolation). v1.1 makes it **STABLE**: every known bug fixed, comprehensively
> tested (unit + integration + e2e), reliable for daily multi-member use.
>
> Driven by the grove fleet itself (dogfooding): a 5-node review swarm
> (agy×3 + claude + codex), 3 dedicated test engineers, maker lanes (ts/py/fe),
> reviewer + qa gates. Lead orchestrates/verifies/commits; writes no product code.

## Definition of "v1.1 Stable" (exit criteria)

1. **Zero open P0/P1** findings from the 5-node review swarm.
2. **Test suite**: unit + integration + e2e green; bridge & core line coverage ≥ 80%;
   every v1 feature (projects, scoping, WS isolation, Slack, auth-status, board,
   executor, node desc) has at least one integration test and one failure-path test.
3. **End-to-end live**: dashboard create-project → switch → assign task → node runs →
   board updates → load-project on a fresh session — all proven against the live server.
4. **Distribution**: a clean `grove` global binary built from current source includes
   new-project / load-project / spawn --description; documented install reproduces it.
5. **Resilience**: server survives node crash, tmux pane loss, WS disconnect, malformed
   input; documented graceful-degradation behavior; no unhandled 500s on bad input.
6. **Docs**: USER_GUIDE + CHANGELOG + release checklist current; legacy-name grep 0 everywhere.

---

## Workstreams

### W1 — Review hardening (5-node swarm → fixes)

Slices (one reviewer each), structured findings P0–P3 (file:line + fix):

- **rev-agy-core** → `src/` TS core: new-project, load-project, project-file, spawn,
  ops, registry, org, cli — correctness, error handling, edge cases, the
  **spawn-into-existing-window pane mis-registration bug** (all panes → `W.1`).
- **rev-agy-bridge** → `bridge/` web_app + store: project scoping, ws-ticket binding,
  board/terminal WS isolation, CAS/lease concurrency, event filtering.
- **rev-agy-sec** → `bridge/` auth_status + slack + pull_executor + notifier: secret
  non-exposure, subprocess argv safety, timeouts, Slack token handling, ask-human flow.
- **rev-claude-web** → `web/`: ProjectSwitcher, AuthPanel, SlackPanel, OrgChart, app.tsx,
  api.ts — state correctness, WS reconnect, XSS/secret surface, a11y, error UX.
- **rev-codex-xcut** → cross-cutting: the X-Grove-Project/ws-ticket model holistically,
  error sanitize completeness, auth-gate posture, a second pass on highest-risk areas.
  Acceptance: all P0/P1 fixed + verified; P2 triaged (fix or backlog); P3 backlog.

### W2 — Comprehensive test suite (3 test engineers)

- **test-py** (bridge): pytest expansion — project resolve (valid/invalid/traversal/404/
  fallback), ws-ticket project binding, terminal pane allowlist cross-project denial,
  board event project filtering, Slack status/contract/timeout, auth-status redaction +
  every tool branch, CLI-error sanitize (all abs-path roots), store CAS/lease/stale,
  pull-executor claim→run→complete/block. Target ≥80% line coverage on `bridge/`.
- **test-ts** (core): vitest expansion — new-project (template/clone/json), project-file
  round-trip, load-project (resume/fresh/integrity/traversal-reject), spawn (role/desc/
  team fields), org rendering, registry persistence, bringup adopt/launch. Add a fake-tmux
  harness where missing.
- **test-e2e** (web + full stack): headless browser/mock harness flows — project switch
  re-scopes org/board/nodes + WS reconnect, create-project, load-project integrity
  buckets, auth panel render + refresh + login-hint, Slack panel registration, board
  live add/claim/complete, terminal mirror. Plus an API-level e2e against a real
  `grove-web` (spin up, hit endpoints, assert).
  Acceptance: all green in `pnpm check`; coverage gate added; e2e runnable headless.

### W3 — Core stability

- **W3.1 Event-driven turn detection (PR1)** — replace 1.5s poll with `fs.watch`
  wake-up + `readCompletionSince` judge + safety poll; durable submit baseline
  (`pending` in registry) so send→wait never misses fast turns. (See plan
  `quizzical-puzzling-eagle`.)
- **W3.2 spawn multi-pane fix** — `grove spawn --window N` must register each new pane's
  real id (today all collide on `N.1`); add a test; verify a 5-node team in one window.
- **W3.3 node lifecycle** — a clean `grove despawn/kill <node>` (remove pane + registry)
  so swarms can be torn down without manual registry edits.

### W4 — Distribution readiness

- **W4.1 global binary rebuild** from current source (new-project/load-project/
  spawn --description/serve); document the exact build+link steps; smoke each new command.
- **W4.2 project create/load end-to-end live** — dashboard "새 프로젝트"/"불러오기" against
  the rebuilt binary; confirm `grove.project.json` written + reload restores org/board.
- **W4.3 install reproducibility** — a fresh-clone install dry-run following USER_GUIDE.

### W5 — agy parity (#21)

AGENTS.md + `.agents/skills` for agy matching claude/codex (grove harness/org/delegate/
orchestrator-rules), so agy nodes operate with the same conventions. Live-verify an agy
node follows org/delegate rules.

### W6 — Resilience & observability

Graceful handling of: node/transcript loss (clear "run repair" hint), tmux pane death,
WS disconnect/reconnect storms, malformed API input (no raw 500s), board db contention.
Add `/api/health` depth + structured server logs (no secrets/abs-paths).

### W7 — Docs & release

USER_GUIDE polish from review feedback, **CHANGELOG.md** (v1.0 → v1.1), a v1.1 **release
checklist**, final integration smoke report, version bump to 0.1.1 (or 1.1.0) in package
manifests. Confirm legacy-name grep 0 across the tree.

---

## Execution order (waves)

1. **Wave 1 (now):** roadmap + dispatch 5-node review + spawn 3 test engineers + start
   global-binary rebuild (W4.1) in parallel.
2. **Wave 2:** triage review findings (P0/P1 first); test engineers lay down the test
   harness + first integration tests; fix W3.2 (spawn bug) early (unblocks clean swarms).
3. **Wave 3..N:** fix loop — makers fix by finding → reviewer gate → commit; test
   engineers expand coverage in parallel; W3.1 (turn detection) + W5 (agy parity) land.
4. **Final wave:** coverage gate + e2e + live end-to-end + resilience pass → docs +
   CHANGELOG + version bump → v1.1 stable smoke report.

## Conventions

- All code by maker/test/review nodes; lead orchestrates + verifies + commits (no push).
- Every change: `pnpm check` green + grove-reviewer GO before commit; logical layer commits.
- Findings tracked in the task list; this doc updated at each wave boundary.
- No questions to the user until v1.1 is reached (per directive 2026-06-04).
