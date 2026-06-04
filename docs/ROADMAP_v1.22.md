# grove v1.22 — Roadmap

> Status: **autonomous build in progress** (auto-started 2026-06-04 after v1.21.0).
> Design: `docs/V1_22_BRAINSTORM.md`. v1.22 = **retro analytics** — turn the v1.10 self-retro
> lane + completed-task history into read-only, advisory insights. Observe + suggest, never act.

## Theme

v1.10 gave nodes a self-retro lane (a short retro on a done task). v1.22 aggregates those retros

- completed-task history into **read-only insights**: throughput over time, common retro themes,
  slow/blocked patterns, per-node/role outcomes — surfaced as advisory cards (and answerable via
  the v1.21 Slack NL path). Strictly advisory and candidate-only: insights are suggestions a human
  reads, never an automated action. agy-honest, scoped, no leak. Default OFF.

## Non-negotiable invariants

1. **Read-only + advisory** — analytics only READ (retros, audit, completed tasks); they produce
   insight cards/suggestions, never an action, task, or config change.
2. **Honest** — aggregates only what's measured (retro text, timestamps, statuses); agy cost stays
   "unknown, not estimated"; no fabricated trends; small-sample insights are labeled low-confidence.
3. **Scoped + private** — project-scoped + role-gated (a viewer sees what they could see in the
   dashboard); retro text is redacted (no secret/path/PII); no member singled out punitively.
4. **Default OFF + audited** (reads are cheap, but the endpoint is opt-in + token-gated).

## Exit criteria

1. Retro analytics: a read-only endpoint that aggregates the self-retro lane + completed tasks
   into insights (throughput, themes, blocked/slow patterns, outcomes), project-scoped, redacted,
   low-confidence labeled; advisory/candidate-only (no action).
2. Surfaced: an insights view (dashboard) + answerable via the v1.21 Slack NL path; both read-only.
3. Zero open P0/P1 from a review (privacy/scope leak, fabricated/over-claimed insight, any
   non-advisory action); coverage ≥80%; full check + web e2e green (new endpoint covered by
   real-server api.mjs); CHANGELOG + README + 0.23.0.

## Workstreams

- **V22-W1 retro analytics backend** (bridge) — aggregate retros + completed tasks → insight
  cards (throughput/themes/patterns/outcomes), read-only, scoped, redacted, low-confidence
  labeled, agy-honest. Default OFF. Adversarially tested (privacy/scope leak, fabrication,
  no-action).
- **V22-W2 brainstorm → v1.23** (grove-arch) — usage/cost trend + anomaly/forecast (advisory),
  optional per-user sandbox v0, notification routing v2; + keep README current.
- **Wave-2** — FE insights view (read-only cards) + real-server e2e for the new endpoint.

## Conventions

Unchanged + safety-first: read-only + advisory (no action from analytics); honest (no fabricated
trends; agy unknown; low-confidence labeled); scoped + redacted; default OFF + audited; maker/
review/test nodes code; lead orchestrates/verifies/commits; **push origin main + tags at
release**; **docs lane keeps README current**; pnpm check + reviewer GO; mock mirrors real backend

- real-server e2e for the new endpoint; one node per window; one writer per area per wave; agy
  headless; no questions until told to stop.
