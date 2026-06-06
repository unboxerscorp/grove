# grove v1.14 — Roadmap

> Status: historical v1 roadmap; superseded by the current v2 live cockpit model documented in `docs/design/MASTER_NODE.md` and `docs/agents/LEAD-HANDOFF.md`.
> Design: `docs/V1_14_BRAINSTORM.md`. v1.14 = **reach the controls from where you are** —
> drive the v1.13 safety controls (approve / abort / kill-switch) from Slack, safety-first.

## Theme

v1.13 put the guarded execution loop + its controls in the dashboard. v1.14 brings the
_safety_ controls to Slack so an operator can approve/abort/kill from their phone — but every
Slack action carries the same gates as the dashboard: role-gated, preview→confirm (no
one-message destructive action), one-shot confirmation id (no replay), project-scoped, and
audited. Nothing new becomes autonomous; this is remote _control_, not remote _automation_.

## Non-negotiable safety invariants (carried from v1.13)

1. **Role-gated** — only an operator/admin identity can approve/abort/arm-kill; viewers are
   rejected. Slack identity maps to a member; unmapped → rejected.
2. **Preview → confirm** — a command first returns a preview (what it will do); execution
   needs an explicit confirm carrying a **one-shot, expiring confirmation id** (no replay,
   no blind destructive action).
3. **Kill-switch is always allowed, arm is privileged** — arming/clearing the kill-switch is
   the most protected action; clearing requires confirm + role.
4. **Audited + scoped** — every Slack-initiated action is audited (actor = Slack identity)
   and project-scoped; no cross-project control.
5. **No secret leak** — Slack responses never echo tokens/paths/lease material.

## Exit criteria

1. Slack command surface v1: status/approve/abort/kill-switch commands, each role-gated,
   preview→confirm with a one-shot id, project-scoped, audited; testable without a live Slack
   (dry-run, like the existing notifier).
2. The commands reuse the v1.13 execution endpoints/state machine (no second code path that
   could bypass a gate).
3. Zero open P0/P1 from an adversarial v1.14 review (replay, role bypass, scope escape,
   secret leak); coverage ≥80%; full check + web e2e green (new endpoints covered by
   real-server api.mjs); CHANGELOG + 0.15.0.

## Workstreams

- **V14-W1 Slack command surface** (bridge) — parse + handle Slack slash/interactive commands
  for status/approve/abort/kill-switch; role mapping, preview→confirm one-shot id, scope,
  audit, dry-run testable. Reuses the v1.13 execution path.
- **V14-W2 brainstorm → v1.15** (grove-arch) — mobile approval/kill-switch surface, execution
  timeline visualization, multi-machine read-only aggregation, cross-room handoff.
- **Wave-2** — FE (Slack command config/preview surface if useful) + real-server e2e for the
  new command endpoints, once W1 lands.

## Conventions

Unchanged + safety-first: remote control, not remote automation; role-gated; preview→confirm
with one-shot id; kill-switch arm is the most protected; everything audited + scoped; reuse the
v1.13 execution path (no gate-bypassing second path); maker/review/test nodes code; lead
orchestrates/verifies/commits (no push); pnpm check + an adversarial reviewer GO (Slack control
is safety-sensitive); mock mirrors real backend + real-server e2e for new endpoints; one node
per window; one writer per area per wave; agy headless; no questions until told to stop.
