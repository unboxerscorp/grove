# grove v1.10 — Roadmap

> Status: historical v1 roadmap; superseded by the current v2 live cockpit model documented in `docs/design/MASTER_NODE.md` and `docs/agents/LEAD-HANDOFF.md`.
> Ideas: `docs/V1_10_BRAINSTORM.md`. v1.10 = **safe self-direction** — let an idle node
> pick up suitable work on its own (heavily guarded + audited), and let nodes self-reflect.

## Theme

Move from "lead/parent assigns everything" toward a room that can keep itself busy:
an idle node may claim a ready, unassigned task it's suited for — but only under strict,
auditable guards (opt-in, rules, rate-limited) so it never runs away.

## Exit criteria

1. Guarded autonomous pickup v1: an idle, opt-in node can CAS-claim a ready, unassigned
   board task matching its capability/role rules; rate-limited; every pickup recorded in
   the audit lane (actor=node, action=autopickup); off by default; a kill-switch.
2. Self-retro lane: a node can append a short retrospective on a completed task (recorded
   in audit, opt-in, redacted), surfaced read-only.
3. Zero open P0/P1 from a v1.10 review pass; coverage ≥80%; full check + e2e green;
   CHANGELOG + 0.11.0.

## Workstreams

- **V10-W1 guarded autonomous pickup** (bridge) — extend the pull executor: when a node is
  idle and pickup is enabled (per-node opt-in flag + a capability/role rule), it may
  CAS-claim ONE ready unassigned task at a time, rate-limited (cooldown), and only from
  its allowed set; records audit.task.autopickup; a global + per-node off switch (default
  OFF). No runaway: at most one in-flight, cooldown between picks, respects despawn/repair.
- **V10-W2 self-retro lane** (bridge) — on task complete, a node may append a short retro
  (POST /api/tasks/{id}/retro or a comment kind) recorded in audit; opt-in, redacted,
  surfaced read-only (audit drawer already shows it).
- **V10-W3 brainstorm → v1.11** (grove-arch) — routing/cost-aware planner, Slack command
  surface, mobile actions, multi-machine read-only, template marketplace.

## Execution order

1. V10-W1 autonomous pickup (bridge) + V10-W2 self-retro (bridge — sequential, same lane) +
   V10-W3 brainstorm — parallel where areas differ.
2. FE surfacing (autopickup/retro in audit drawer + a pickup toggle), if time.
3. v1.10 review pass (extra scrutiny on autonomy guards) → fix → coverage → e2e →
   CHANGELOG + 0.11.0.

## Conventions

Unchanged + **autonomy is guarded**: default OFF, opt-in, rate-limited, audited, with a
kill-switch; never bypasses CAS/lease; review pass scrutinizes runaway safety. Otherwise:
maker/review/test nodes code; lead orchestrates/verifies/commits (no push); pnpm check +
reviewer GO; mock mirrors real backend; agy headless; no questions until told to stop.
