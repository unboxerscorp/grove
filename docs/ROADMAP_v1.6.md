# grove v1.6 — Roadmap

> Status: **autonomous build in progress** (auto-started 2026-06-04 after v1.5.0).
> Ideas: `docs/V1.6_BRAINSTORM.md`. v1.6 = **reliability + delegation visibility** — keep
> the 24/7 room self-healing and make delegation chains traceable.

## Theme

A room that recovers from node loss on its own, never silently drops board events, and
lets you trace a delegation from lead down to the leaf that did the work.

## Exit criteria

1. `grove repair` detects dead/stale nodes (pane gone / transcript missing / last-seen
   exceeded) and recovers them (rebind / re-resolve), reporting recovered vs unrecoverable;
   an audit event is recorded. (Foundation for an optional watchdog.)
2. Board event cursor replay: on WS reconnect the client requests events-after-cursor
   (precise catch-up) instead of only a full reload.
3. Delegation-chain explorer: from the audit, surface multi-hop delegation chains
   (lead → sub-lead → leaf), not just single edges.
4. Zero open P0/P1 from a v1.6 review pass; coverage ≥80%; full check + e2e green;
   CHANGELOG + 0.7.0.

## Workstreams

- **V6-W1 node auto-recovery** (core) — `grove repair` enhancement: detect dead/stale
  nodes and rebind/re-resolve; report; record an audit event. Sets up a watchdog mode.
- **V6-W2 board cursor replay** (web + maybe bridge) — track the last board-event cursor;
  on reconnect fetch events-after-cursor (list_events_after) rather than a full reload.
- **V6-W3 delegation-chain explorer** (web) — build chains from /api/audit assign/delegate
  edges; a view that traces a task's delegation path; distinct from the single-edge overlay.
- **V6-W4 brainstorm → v1.7** (grove-arch) — presence, notification rules, onboarding
  wizard v2, project import/export, self-retro lane.

## Execution order

1. V6-W1 repair (core) + V6-W2 cursor replay (web) + V6-W4 brainstorm — parallel.
2. V6-W3 delegation-chain explorer.
3. v1.6 review pass → fix → coverage → e2e → CHANGELOG + 0.7.0.

## Conventions

Unchanged: maker/review/test nodes code; lead orchestrates/verifies/commits (no push);
pnpm check + reviewer GO before commit; mock mirrors real backend + real-server e2e for
new endpoints; one node per window; one writer per area; agy headless; hot-path changes
deploy-verified; no questions until told to stop.
