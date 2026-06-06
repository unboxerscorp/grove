# grove v1.5 — Roadmap

> Status: historical v1 roadmap; superseded by the current v2 live cockpit model documented in `docs/design/MASTER_NODE.md` and `docs/agents/LEAD-HANDOFF.md`.
> v1.5 = harden the test net (close the mock-drift gap systemically), finish the small
> v1.4 polish, and make delegation usable from the dashboard (not just the CLI).

## Theme

Stop FE↔backend contract drift from ever shipping again, then push the team OS forward:
delegate from the UI, finish node-status/board-replay polish.

## Exit criteria

1. Real-server e2e (api.mjs) covers /api/audit, /api/status?detail=1, /api/cost with
   shape assertions — so a FE↔backend mismatch fails CI without relying on the mock.
2. Dashboard delegate: a UI action (OrgChart / board) that delegates a task to a node
   (web equivalent of `grove delegate`), respecting auth + project scope.
3. Node-status uses the backend idle/error directly (no derived idle); board event
   cursor replay on reconnect (no silently-missed events).
4. Zero open P0/P1 from a v1.5 review pass; coverage ≥80%; full check + e2e green;
   CHANGELOG + 0.6.0.

## Workstreams

- **V5-W1 real-server e2e for new endpoints** (web/e2e/api.mjs) — boot real grove-web,
  hit /api/audit (items/cursor/object-actor), /api/status?detail=1 (node_details/string
  confidence), /api/cost (by_agent/total_tokens/agy credit unknown); assert the exact
  shapes the FE consumes. Closes the mock-only gap that caused the v1.1/v1.4 drift.
- **V5-W2 dashboard delegate** — a "delegate" affordance (OrgChart node action or board)
  → POST assigned task (assignee=node) via the existing API; auth + project scoped; the
  audit lane already records it.
- **V5-W3 polish** — node-status reads backend idle/error directly; board event cursor
  replay on WS reconnect (request events-after-cursor via list_events_after rather than a
  full reload only).
- **V5-W4 brainstorm → next** — keep ideating (grove-arch) so v1.6 is ready.

## Execution order

1. V5-W1 e2e (systemic test fix) + V5-W4 brainstorm in parallel.
2. V5-W2 dashboard delegate; V5-W3 polish.
3. v1.5 review pass → fix → coverage → e2e → CHANGELOG + 0.6.0.

## Conventions

Unchanged: maker/review/test nodes do the code; lead orchestrates/verifies/commits
(no push); pnpm check + reviewer GO before commit; mock must mirror the real backend;
one node per window; one writer per area; agy headless; no questions until told to stop.
