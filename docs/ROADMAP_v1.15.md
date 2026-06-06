# grove v1.15 — Roadmap

> Status: historical v1 roadmap; superseded by the current v2 live cockpit model documented in `docs/design/MASTER_NODE.md` and `docs/agents/LEAD-HANDOFF.md`.
> Design: `docs/V1_15_BRAINSTORM.md`. v1.15 = **observe & report** — see the execution loop as
> a timeline and roll up cost/usage over time. Read-only; a calmer version after the
> safety-heavy v1.13/v1.14.

## Theme

v1.13 closed the loop and v1.14 made its controls reachable. v1.15 is about _seeing_: a richer
execution timeline (the loop's transitions over time) and a cost/usage report (run cost rolled
up by node/day). All read-only — no new mutation, no new autonomy — so the review is about
correctness, scope, and no-secret-leak rather than safety invariants.

## Exit criteria

1. Cost/usage reporting: a read-only endpoint that rolls up run cost/usage (by node and by
   day, project-scoped, token-gated), with the same agy "unknown — not estimated" honesty as
   /api/cost; no secret/path leak.
2. Execution timeline visualization: the v1.13 timeline grows into a step/gantt view of the
   execution transitions (claim→…→complete) with durations, read-only.
3. Mobile: the safety surfaces (approval queue, kill-switch, status) are usable on a narrow
   viewport (responsive pass), no functional change.
4. Zero open P0/P1 from a v1.15 review; coverage ≥80%; full check + web e2e green (new endpoint
   covered by real-server api.mjs); CHANGELOG + 0.16.0.

## Workstreams

- **V15-W1 cost/usage reporting** (bridge) — read-only rollup endpoint (run cost/usage by
  node/day, project-scoped, token-gated, agy-unknown honest, no leak).
- **V15-W2 execution timeline viz** (web) — step/gantt of execution transitions with durations,
  read-only; builds on the v1.13 ExecutionTimeline.
- **V15-W3 brainstorm → v1.16** (grove-arch) — multi-machine read-only aggregation, cross-room
  handoff contract, deeper reporting, retro analytics.
- **Wave-2** — FE for the cost/usage report + a mobile responsive pass over the safety surfaces
  - real-server e2e for the new reporting endpoint.

## Conventions

Unchanged: read-only this version (no new mutation/autonomy); reporting is honest about unknown
agy cost (never fabricate); maker/review/test nodes code; lead orchestrates/verifies/commits (no
push); pnpm check + reviewer GO; mock mirrors real backend + real-server e2e for the new
endpoint; one node per window; one writer per area per wave; agy headless; no questions until
told to stop.
