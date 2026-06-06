# grove v1.4 — Roadmap

> Status: historical v1 roadmap; superseded by the current v2 live cockpit model documented in `docs/design/MASTER_NODE.md` and `docs/agents/LEAD-HANDOFF.md`.
> v1.3 built the multi-orchestrator backend (delegate + team auth + audit + node detail).
> **v1.4 = the team-facing surfaces** — make the new backend visible + usable, plus the
> cost/credit view and a couple of safety follow-ups. Source: docs/DESIGN_audit_and_cost.md.

## Theme

Surface what v1.3 made possible: who delegated/did what (audit), the live org with
delegation edges, per-agent cost/credit (esp. agy burn), richer node status — so a human
(or a teammate over Tailscale) can actually watch and steer the office.

## Exit criteria

1. Dashboard audit drawer (read-only) backed by /api/audit; filter by action/node.
2. OrgChart shows live delegation edges (who → whom).
3. Cost view: /api/cost (best-effort, source/confidence-tagged) + a dashboard panel that
   highlights agy credit burn and never presents an estimate as fact.
4. Node-status detail in the UI (idle/error/blocked/dead + last-seen).
5. delegate refuses (or warns + requires opt-in) sending the bearer token to a non-loopback
   GROVE_WEB_URL.
6. Zero open P0/P1 from a v1.4 review pass; coverage ≥80%; full check + e2e green;
   CHANGELOG + 0.5.0.

## Workstreams

- **V4-W1 audit drawer (web)** — consume /api/audit; a read-only audit lane/drawer with
  action/node filters + cursor paging.
- **V4-W2 org delegation edges (web)** — OrgChart overlay of delegation edges (from audit
  / board assignee→node), distinct from parent/group edges.
- **V4-W3 cost/credit (bridge + web)** — /api/cost best-effort (registry + run metadata +
  transcript parse; every number source/confidence-tagged; agy credit unknown+warning if
  no local source) + a dashboard cost panel.
- **V4-W4 node-status detail (web)** — consume /api/status?detail=1; show idle/error/
  blocked/dead split + last-seen in the node-status bar.
- **V4-W5 safety/polish (core)** — non-loopback GROVE_WEB_URL token-egress guard in
  delegate; node-status uses backend idle/error directly; board event cursor replay.

## Execution order

1. V4-W1 audit drawer + V4-W4 node detail (web; backends already exist) + V4-W3 /api/cost
   backend + V4-W5 token guard — in parallel.
2. V4-W2 org delegation edges; V4-W3 cost panel (after /api/cost).
3. v1.4 review pass → fix → coverage → e2e → CHANGELOG + 0.5.0.

## Conventions

Unchanged from v1.1–v1.3: code by maker/test/review nodes; lead orchestrates/verifies/
commits (no push); pnpm check + reviewer GO before commit; one node per window; one writer
per area; agy headless; no questions until told to stop.
