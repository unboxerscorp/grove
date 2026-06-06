# grove v1.23 — Roadmap

> Status: historical v1 roadmap; superseded by the current v2 live cockpit model documented in `docs/design/MASTER_NODE.md` and `docs/agents/LEAD-HANDOFF.md`.
> Design: `docs/V1_23_BRAINSTORM.md`. v1.23 = **advisory ops signals** — usage/cost trend +
> anomaly detection over the v1.15 usage + v1.19 ledger. A signal a human reads, never an action.

## Theme

Through v1.22 grove reports usage, ledger, and retro insights. v1.23 adds **trend + anomaly**:
roll usage/cost over a window, show the trend, and flag **anomalies** (a sudden spike vs. the
node's own recent baseline) as an advisory signal — plus a simple, clearly-labeled forecast.
Strictly advisory: an anomaly is a flag a human reviews, never an auto-throttle/abort/kill (the
v1.19 soft-quota stays the only limiter, and even it never hard-kills). agy-honest, scoped,
default OFF.

## Non-negotiable invariants

1. **Advisory-only** — trends/anomalies/forecasts are READ-only signals; they never trigger an
   action, throttle, abort, or config change. No coupling to the execution/quota enforcement.
2. **Honest** — only measured numbers (run metadata tokens/cost over time); agy cost stays
   "unknown, not estimated" and is excluded from cost anomalies (flagged separately as unknown);
   the forecast is a simple, labeled extrapolation (not a confident prediction); thin data →
   low-confidence / "not enough data".
3. **Deterministic + bounded** — anomaly detection is a simple deterministic rule (e.g. z-score /
   ratio vs. a trailing baseline), no LLM; bounded windows.
4. **Scoped + private** — project-scoped + role-gated; per-member trends operator-only; no
   secret/path/PII leak.
5. **Default OFF + audited**.

## Exit criteria

1. Trend + anomaly: a read-only endpoint that rolls usage/cost over a window (by node/day),
   computes the trend, and flags deterministic anomalies (spike vs. trailing baseline) + a labeled
   forecast — advisory-only, agy-honest, scoped, redacted, thin-data labeled.
2. No enforcement coupling — an anomaly never throttles/aborts/kills; it's a signal only.
3. Zero open P0/P1 from a review (privacy/scope leak, fabricated trend/forecast, any enforcement
   action from a signal); coverage ≥80%; full check + web e2e green (new endpoint covered by
   real-server api.mjs); CHANGELOG + README + 0.24.0.

## Workstreams

- **V23-W1 trend + anomaly backend** (bridge) — window rollup + trend + deterministic anomaly
  flag + labeled forecast, advisory-only, scoped, agy-honest, thin-data labeled. Default OFF.
  Adversarially tested (privacy/scope, fabrication, no-enforcement-from-signal).
- **V23-W2 brainstorm → v1.24** (grove-arch) — notification routing v2, Slack digest/reminder,
  optional per-user sandbox v0; + keep README current.
- **Wave-2** — FE trend/anomaly view (read-only, advisory) + real-server e2e for the new endpoint.

## Conventions

Unchanged + safety-first: advisory-only (a signal never acts; no enforcement coupling);
deterministic/bounded (no LLM); honest (measured only; agy unknown; forecast labeled; thin-data
low-confidence); scoped + redacted; default OFF + audited; maker/review/test nodes code; lead
orchestrates/verifies/commits; **push origin main + tags at release**; **docs lane keeps README
current**; pnpm check + reviewer GO; mock mirrors real backend + real-server e2e for the new
endpoint; one node per window; one writer per area per wave; agy headless; no questions until
told to stop.
