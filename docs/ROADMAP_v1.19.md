# grove v1.19 — Roadmap

> Status: **autonomous build in progress** (auto-started 2026-06-04 after v1.18.0).
> Design: `docs/V1_19_BRAINSTORM.md`. v1.19 = **fair sharing** — now that tailnet peers share
> one host's agent capacity (v1.18), give it a per-user resource ledger + soft quotas so one
> peer can't starve the others, and surface host pressure. Observe + soft-limit, not hard-kill.

## Theme

v1.18 made grove a shared room; v1.19 makes the sharing fair and legible. A **per-user resource
ledger** attributes runs/tokens/cost to the member who started them (reusing v1.15 usage +
v1.18 identity + audit), **soft quotas/rate** warn and gently throttle a member who exceeds a
configurable budget, and a **host-pressure** signal shows when the Mac mini is saturated. Soft
by default — warn + queue/slow, never a hard kill of running work (hard enforcement stays a
later, opt-in option). Default OFF.

## Non-negotiable invariants

1. **Attribution is honest** — the ledger attributes only what's actually measured (runs/tokens
   from run_metadata); agy cost stays "unknown, not estimated"; no fabricated numbers; per-member,
   project-scoped, no PII/secret leak.
2. **Soft by default** — exceeding a quota warns + soft-throttles (rate/queue), never kills a
   running task; hard enforcement is a separate, default-OFF opt-in.
3. **Role-gated config** — only operator/admin can set/change quotas; a member can see their own
   usage; viewers read-only.
4. **Audited** — quota changes + throttle events are audited (actor).
5. **Default OFF + scoped** — ledger/quota are opt-in, token-gated, project-scoped.

## Exit criteria

1. Per-user resource ledger: a read-only, per-member rollup (runs/tokens/cost, agy-honest,
   project-scoped, no leak) building on /api/usage + the member identity.
2. Soft quotas/rate: an operator can set a per-member soft budget; exceeding it warns + soft-
   throttles (no hard kill); a host-pressure signal surfaces saturation. Default OFF.
3. Zero open P0/P1 from a review (attribution leak, quota bypass, role bypass, hard-kill of
   running work); coverage ≥80%; full check + web e2e green (new endpoints covered by real-server
   api.mjs); CHANGELOG + README + 0.20.0.

## Workstreams

- **V19-W1 per-user ledger + soft quota backend** (bridge) — per-member rollup (reuse usage +
  identity), operator-set soft budgets, soft-throttle + host-pressure signal, audited. Default
  OFF, adversarially tested (attribution leak, quota/role bypass, no-hard-kill).
- **V19-W2 brainstorm → v1.20** (grove-arch) — optional per-user sandbox v0, retro analytics,
  usage/cost trend reporting v2, notification routing v2; + keep README current.
- **Wave-2** — FE ledger/quota view (per-member usage, my-budget, host-pressure, operator quota
  controls) + real-server e2e for the new endpoints.

## Conventions

Unchanged + safety-first: honest attribution; soft by default (no hard kill of running work);
role-gated config; audited; default OFF + scoped; maker/review/test nodes code; lead
orchestrates/verifies/commits; **push origin main + tags at release**; **docs lane keeps README
current**; pnpm check + reviewer GO; mock mirrors real backend + real-server e2e for new
endpoints; one node per window; one writer per area per wave; agy headless; no questions until
told to stop.
