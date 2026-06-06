# grove v1.2 — Roadmap

> Status: historical v1 roadmap; superseded by the current v2 live cockpit model documented in `docs/design/MASTER_NODE.md` and `docs/agents/LEAD-HANDOFF.md`.
> Source of ideas: `docs/V1.2_BRAINSTORM.md`. v1.1 = security/reliability/test
> hardening of v1.0. v1.2 = **reliability core + team-mode foundation + observability**.

## Theme

Make the multi-orchestrator dev-room genuinely robust for unattended, multi-member,
24/7 operation: kill the polling latency, let agy run as a first-class interactive
node, recover cleanly from loss, see what's happening, and lay the groundwork for real
team auth.

## Definition of "v1.2 Stable" (exit criteria)

1. Event-driven turn detection live (no fixed poll floor); send→wait never misses a
   fast turn; the dev10 fleet runs on it without regression.
2. agy parity: an agy node operates with the same AGENTS.md/skills conventions as
   codex/claude; interactive submit live-verified.
3. Resilience: `grove despawn` + clean node teardown; session token stable across
   restarts (open dashboards survive a relaunch); documented recovery for pane/
   transcript loss.
4. Observability: `/api/health` depth (server + board + node liveness), structured
   logs (no secrets/abs-paths), a node-status view in the dashboard.
5. Zero open P0/P1 from a v1.2 review pass; coverage held ≥80% (core+bridge) with
   tests for every new surface; full `pnpm check` + e2e green; CHANGELOG + 0.3.0.

## Workstreams

- **V2-W1 Event-driven turn detection (PR1)** — `fs.watch` wake-up + `readCompletionSince`
  judge + low-freq safety poll, replacing the 1.5s sleep in `ops.ts waitForCompletion`
  - `tail.ts`; durable submit baseline. HOT PATH — implement + test + review + careful
    deploy-verify (the fleet depends on it). Plan: `quizzical-puzzling-eagle`.
- **V2-W2 agy parity (#21)** — AGENTS.md + `.agents/skills` for agy (grove harness/org/
  delegate/orchestrator-rules); live-verify interactive submit + rule-following.
- **V2-W3 Resilience** — `grove despawn`/lifecycle; stable session token (persist/derive
  across restarts so relaunch doesn't 401 open tabs); pane/transcript-loss recovery + a
  native `grove repair`.
- **V2-W4 Observability** — `/api/health` depth (board reachable, node liveness counts);
  structured server logs (redacted); dashboard node-status heatmap.
- **V2-W5 Team-mode foundation** — design real auth beyond the token (cookie/session +
  CSRF) for when 3 cofounders connect over Tailscale; keep loopback frictionless.
- **V2-W6 Multi-orchestrator UX** — `grove delegate` (board-as-delegation made
  first-class), live org graph polish, orchestrator-only audit lane.

## Execution order (waves)

1. Low-risk first: V2-W4 observability (`/api/health` depth, structured logs) +
   V2-W3 stable token (both bridge, no orchestration-hot-path risk) + V2-W2 agy parity
   (docs/skills) — in parallel.
2. V2-W1 turn detection — implement + test + review in isolation, then deploy-verify the
   dev10 fleet carefully (this changes send/wait that the office itself runs on).
3. V2-W3 despawn/repair, V2-W6 delegate; then V2-W5 team-auth design.
4. v1.2 review pass (5-node swarm) → fix → coverage → e2e → CHANGELOG + 0.3.0.

## Conventions

Same as v1.1: all code by maker/test/review nodes; lead orchestrates/verifies/commits
(no push); `pnpm check` + reviewer GO before commit; logical layer commits; agy headless
until V2-W2 verifies interactive; one node per window; one writer per area; no questions
to the user until told to stop.
