# grove v1.3 — Roadmap

> Status: **autonomous build in progress** (auto-started 2026-06-04 right after
> v1.2.0 shipped). v1.0 = product; v1.1 = security/test hardening; v1.2 = reliability
> core + observability. **v1.3 = the multi-orchestrator team OS made real** — the
> headline the user asked for ("오케스트레이터를 여러명 써서").

## Theme

Make board-as-delegation a first-class command any orchestrator node can run, stand
up real team auth (per the v1.2 design), and finish the team-facing surfaces (org
graph, audit, cost/observability) so 3 cofounders can actually co-drive over Tailscale.

## Definition of "v1.3 Stable" (exit criteria)

1. `grove delegate <node> "<task>"` creates a first-class, assigned board task that the
   target node's executor runs; live-verified (parent node delegates → child runs →
   board reflects). Multi-orchestrator delegation works end-to-end.
2. Real team auth live: cookie session + CSRF + a small member registry + audit, in an
   explicit team-auth mode; loopback stays frictionless; 3 members can log in over
   Tailscale and actions are attributed.
3. Org graph + orchestrator audit: dashboard shows the live org tree with delegation
   edges; an audit lane records who delegated/assigned/completed what.
4. Cost/observability: a token/credit view (esp. agy credit) + node-status detail.
5. Zero open P0/P1 from a v1.3 review pass; coverage held ≥80%; full check + e2e green;
   CHANGELOG + 0.4.0.

## Workstreams

- **V3-W1 grove delegate** (headline) — `grove delegate <node> "<title>" [--body]
[--board]` creates an assigned board task via the local grove-web API (token from the
  stable dashboard-token), so any orchestrator node can delegate to its children and the
  pull executor runs it. Board = the delegation protocol, made a command.
- **V3-W2 team auth** — implement docs/DESIGN_team_auth.md: AuthMode, member registry,
  cookie session + CSRF, /api/me|login|logout|csrf, WS-ticket member binding, roles
  (admin/operator/viewer). Loopback frictionless; team-auth mode for Tailscale.
- **V3-W3 org graph + audit** — live org tree with delegation edges in the dashboard; an
  audit lane (who delegated/assigned/claimed/completed), surfaced read-only.
- **V3-W4 cost/observability** — token/credit usage view (per agent type; highlight agy
  credit burn) + node-status detail (idle/error split, last-seen).
- **V3-W5 polish/backlog** — node-status uses backend idle/error directly; board event
  cursor replay; remaining a11y; doc refresh.

## Execution order (waves)

1. V3-W1 delegate (design the integration path, then implement + live-verify) — the
   headline; unblocks the multi-orchestrator demo.
2. V3-W2 team auth (build on the design; loopback-safe first, then team-mode) — biggest;
   review-heavy (security).
3. V3-W3 org graph + audit; V3-W4 cost view; V3-W5 polish.
4. v1.3 review pass (5-node swarm) → fix → coverage → e2e → CHANGELOG + 0.4.0.

## Conventions

Same as v1.1/v1.2: code by maker/test/review nodes; lead orchestrates/verifies/commits
(no push); pnpm check + reviewer GO before commit; logical commits; agy headless;
one node per window; one writer per area; hot-path changes deploy-verified carefully;
no questions to the user until told to stop.
