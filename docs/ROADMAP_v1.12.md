# grove v1.12 — Roadmap

> Status: historical v1 roadmap; superseded by the current v2 live cockpit model documented in `docs/design/MASTER_NODE.md` and `docs/agents/LEAD-HANDOFF.md`.
> Ideas: `docs/V1_12_BRAINSTORM.md`. v1.12 = **act on the recommendations** — turn the
> v1.11 read-only planner + autonomy signals into explicit, human-initiated actions
> (control the pickup opt-in; delegate a recommended node in one click).

## Theme

v1.11 made delegation _legible_ (recommend + surface autonomy, all read-only). v1.12 makes
it _actionable_ — but every action stays explicit and human-initiated: a toggle the operator
flips, a one-click delegate the operator confirms. No new autonomous behavior in this version
(the guarded execution loop is designed here but gated to v1.13).

## Exit criteria

1. Pickup-enable toggle: a backend mutation (token + project-scoped + audited) sets a node's
   autonomous-pickup opt-in on/off, honoring the global kill-switch; surfaced in the dashboard.
2. Planner→delegate: from the read-only recommendation panel, an explicit "delegate to this
   node" action delegates via the existing delegate path (human-initiated; confirmation; not
   auto). Read-only recommendation remains the default.
3. Zero open P0/P1 from a v1.12 review pass; coverage ≥80%; full check + web e2e green
   (new endpoints covered by real-server api.mjs); CHANGELOG + 0.13.0.

## Workstreams

- **V12-W1 pickup-enable toggle backend** (bridge) — endpoint to set per-node autopickup
  opt-in (token + project scope + audit event + global kill-switch respected; persisted).
- **V12-W2 planner→delegate one-click** (web) — PlannerPanel gains an explicit "delegate"
  action per candidate that POSTs the existing delegate endpoint (confirm step; clearly an
  action, not the read-only default). Mock mirrors real delegate; verify asserts it's gated
  behind an explicit click.
- **V12-W3 brainstorm → v1.13** (grove-arch) — guarded autonomous execution loop (the big
  one, fully designed + risk-gated), Slack command surface v1, mobile actions, multi-machine.

## Execution order

1. V12-W1 toggle backend (bridge) + V12-W2 planner→delegate (web) + V12-W3 brainstorm — parallel.
2. Wave-2: FE for the pickup toggle (after W1 lands) + real-server e2e (api.mjs) for the new
   endpoints.
3. v1.12 review pass → fix → coverage → e2e → CHANGELOG + 0.13.0.

## Conventions

Unchanged: NO new autonomous behavior this version (loop deferred to v1.13); all v1.12 actions
explicit + human-initiated + audited; maker/review/test nodes code; lead orchestrates/verifies/
commits (no push); pnpm check + reviewer GO; mock mirrors real backend + real-server e2e for new
endpoints; one node per window; one writer per area per wave; agy headless; no questions until
told to stop.
