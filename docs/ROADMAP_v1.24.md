# grove v1.24 — Roadmap

> Status: historical v1 roadmap; superseded by the current v2 live cockpit model documented in `docs/design/MASTER_NODE.md` and `docs/agents/LEAD-HANDOFF.md`.
> **FE headline = explicit user UI feedback**: the top nav has too many menus — move navigation
> to a clean, grouped **left sidebar**. Plus notification routing v2 (backend). Ideas:
> `docs/V1_24_BRAINSTORM.md`.

## Theme

The dashboard grew many tabs (board, org, audit, chain, inbox, presence, cost, planner,
execution, autopickup, slack, connect, ledger, aggregation, handoff, insights, trend). The top
nav is crowded. v1.24 moves navigation into a **left sidebar** — grouped, collapsible, responsive
— for a cleaner layout (user feedback). In parallel, **notification routing v2** adds conditional
routing + escalation to the v1.8 notifier (dry-run default, no new outbound risk).

## Workstreams

- **V24-W1 left sidebar nav** (web, FE headline) — move the top-nav tabs into a grouped left
  sidebar (collapsible sections + icons); keep the top bar minimal (project switcher / connection
  / presence). Responsive: collapses to a drawer on a narrow viewport (don't regress mobileOk).
  Every panel stays reachable; verify selectors updated; no backend change; ko/en; observatory
  styling. Reviewed for no-regression (reachability, mobile, a11y).
- **V24-W2 notification routing v2** (bridge) — conditional routing + escalation on the v1.8
  notification rules / notifier: route block/ask-human/anomaly to configured targets by
  condition; escalate if unacknowledged within a window. **Dry-run default** (consistent with the
  existing notifier), role-gated config, audited, no secret/PII leak. Default OFF for new routing.
- **V24-W3 brainstorm → v1.25** (grove-arch) — Slack digest/reminder, optional per-user sandbox
  v0, multi-room alert overlay; + keep README current.
- **Wave-2** — FE for notification routing config (if useful) + real-server e2e for the new
  routing endpoints; sidebar nav polish.

## Exit criteria

1. Left sidebar nav: navigation moved to a grouped, responsive left sidebar; every existing panel
   reachable; mobile drawer; no regression (verify + e2e green).
2. Notification routing v2: conditional routing + escalation, dry-run default, role-gated +
   audited, no leak; default OFF.
3. Zero open P0/P1 from review (nav regression/unreachable panel; routing leak/role bypass/
   unintended outbound); coverage ≥80%; full check + web e2e green (new endpoints covered by
   real-server api.mjs); CHANGELOG + README + 0.25.0.

## Conventions

Unchanged + safety-first: sidebar is a pure layout refactor (no new mutation/safety surface);
notification routing dry-run default + role-gated + audited (no surprise outbound); maker/review/
test nodes code; lead orchestrates/verifies/commits; **push origin main + tags at release**;
**docs lane keeps README current**; **refresh the live :9131 dashboard at release**; pnpm check +
reviewer GO; mock mirrors real backend + real-server e2e for new endpoints; one node per window;
one writer per area per wave; agy headless; no questions until told to stop.
