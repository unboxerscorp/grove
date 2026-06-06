# grove v1.13 — Roadmap

> Status: historical v1 roadmap; superseded by the current v2 live cockpit model documented in `docs/design/MASTER_NODE.md` and `docs/agents/LEAD-HANDOFF.md`.
> Design: `docs/V1_13_BRAINSTORM.md`. v1.13 = **the guarded autonomous execution loop** —
> the big, safety-critical feature, built safety-first: default OFF, approval-gated, every
> transition audited, kill-switch at every level.

## Theme

Through v1.12 the loop stops at "claim a task" (autopickup) and "recommend/delegate" (planner).
v1.13 closes the loop — a claimed task can move through preflight → approval → execute → verify
→ complete — but **safety dominates**: nothing executes without passing every gate, the default
is OFF, an explicit human approval gate sits before execute (auto-approve is itself a separate,
default-OFF, gated opt-in), concurrency is 1, and a global/board/node/task kill-switch halts it
at any point. The pipeline + gates land first; wiring real dispatch comes last and stays behind
the approval gate.

## Non-negotiable safety invariants

1. **Default OFF** — execution is a separate flag from autopickup; both must be ON.
2. **Approval gate before execute** — a claimed+preflighted task waits in `approval-pending`;
   it executes only after an explicit approve (human, or a default-OFF gated auto-approve).
3. **Concurrency 1** — at most one task in `executing` per node (lease/CAS, no bypass).
4. **Multi-level kill-switch** — global / board / node / task; checked at the DB at every
   transition AND immediately before execute (runtime, like the v1.12 autopickup fix).
5. **Full audit timeline** — every transition (claim/preflight/approve/execute/verify/complete/
   abort/rollback) is an audit event; payloads sanitized (token/path masked).
6. **Rollback** — a failed verify moves the task to a safe terminal state + audits; no silent loss.

## Exit criteria

1. State machine + gates implemented (preflight/approval/execute/verify/complete/abort) with the
   six invariants above, default OFF, all transitions audited and token/project-scoped.
2. Execute dispatches via the existing delegate/send path ONLY when execution-enabled AND task
   approved AND all kill-switches clear AND concurrency < 1; otherwise the task stays
   approval-pending (no dispatch). A kill-switch flip mid-flight aborts safely.
3. Zero open P0/P1 from a v1.13 review pass (safety-focused, adversarial); coverage ≥80%; full
   check + web e2e green (new endpoints covered by real-server api.mjs); CHANGELOG + 0.14.0.

## Workstreams

- **V13-W1 execution loop core** (bridge) — the state machine, gates, kill-switches, audit
  timeline, and the approval/abort endpoints. Execute = dispatch via existing path, gated.
  Backend only, exhaustively tested (incl. adversarial: kill mid-flight, concurrency race,
  approval bypass attempts, scope/viewer).
- **V13-W2 brainstorm → v1.14** (grove-arch) — Slack command surface v1 (safety commands first:
  approve/abort/kill-switch from Slack), mobile actions, multi-machine read-only aggregation,
  cross-room handoff contract.
- **Wave-2** — FE for the loop (approval queue + per-task/level kill-switch controls + execution
  timeline) + real-server e2e for the new endpoints, once W1 lands.

## Conventions

Unchanged + safety-first: NOTHING executes without passing every gate; default OFF; approval
before execute; concurrency 1; kill-switch authoritative at runtime; everything audited; maker/
review/test nodes code; lead orchestrates/verifies/commits (no push); pnpm check + an adversarial
reviewer GO (safety review is mandatory and strict for this version); mock mirrors real backend +
real-server e2e for new endpoints; one node per window; one writer per area per wave; agy
headless; no questions until told to stop.
