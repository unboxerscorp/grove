# grove v1.11 — Roadmap

> Status: **autonomous build in progress** (auto-started 2026-06-04 after v1.10.0).
> Ideas: `docs/V1_11_BRAINSTORM.md`. v1.11 = **smarter delegation + surface the autonomy** —
> recommend who to delegate to, and make v1.10's pickup/retro visible in the dashboard.

## Theme

Help a human (or lead) delegate well — a read-only routing recommendation by role/load/cost —
and make the self-direction added in v1.10 visible (autopickup + retro in the audit lane,
pickup-enabled status), so autonomy stays transparent.

## Exit criteria

1. Routing planner: /api/plan (or similar) recommends, for a given task/role, the best
   candidate node(s) by capability/role + current load (node-status) + cost signal —
   read-only (the human/lead still decides); source/confidence tagged.
2. Autonomy visibility: the audit drawer surfaces autopickup + retro events distinctly;
   node-status shows whether autonomous pickup is enabled for a node.
3. Zero open P0/P1 from a v1.11 review pass; coverage ≥80%; full check + e2e green;
   CHANGELOG + 0.12.0.

## Workstreams

- **V11-W1 routing planner** (bridge) — /api/plan: given a task (or role), rank candidate
  nodes by role/capability match + load (running/idle from node-status) + cost signal;
  read-only recommendation, source/confidence tagged, project-scoped, token-gated.
- **V11-W2 autonomy visibility** (web) — audit drawer: distinct chips/filters for
  autopickup + retro events; node-status / org: a small indicator that a node has
  autonomous pickup enabled. Read-only surfacing of the v1.10 backend.
- **V11-W3 brainstorm → v1.12** (grove-arch) — Slack command surface, mobile actions,
  pickup-enable toggle UI, small autonomous execution loop (guarded), multi-machine.

## Execution order

1. V11-W1 planner (bridge) + V11-W2 visibility (web) + V11-W3 brainstorm — parallel.
2. FE planner surfacing (a "suggest node" affordance), if time.
3. v1.11 review pass → fix → coverage → e2e → CHANGELOG + 0.12.0.

## Conventions

Unchanged: planner is read-only (recommendation, not auto-act); maker/review/test nodes
code; lead orchestrates/verifies/commits (no push); pnpm check + reviewer GO; mock mirrors
real backend + real-server e2e for new endpoints; one node per window; one writer per area;
agy headless; no questions until told to stop.
