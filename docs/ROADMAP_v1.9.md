# grove v1.9 — Roadmap

> Status: **autonomous build in progress** (auto-started 2026-06-04 after v1.8.0).
> Ideas: `docs/V1.9_BRAINSTORM.md`. v1.9 = **portable, easy-to-start team room** — share a
> project as a bundle, onboard in a wizard, and let nodes self-reflect.

## Theme

Make grove easy to hand to a teammate (export/import a project) and easy to start
(onboarding wizard), and give the office a memory of how it worked (self-retro).

## Exit criteria

1. `grove export-project` produces a portable bundle (grove.project.json + scaffold/
   templates, machine-local paths excluded) and `grove import-project <bundle>` recreates
   the project; round-trip verified.
2. Onboarding wizard v2: a dashboard first-run flow (create or load/import a project, add
   the first nodes, point at auth) — guided, skippable, ko/en.
3. Self-retro lane: a node can append a short retrospective on its completed work,
   recorded in the audit lane (opt-in, redacted).
4. Zero open P0/P1 from a v1.9 review pass; coverage ≥80%; full check + e2e green;
   CHANGELOG + 0.10.0.

## Workstreams

- **V9-W1 project import/export** (core) — `grove export-project [--out bundle]` (bundles
  grove.project.json + scaffold/templates; strips machine-local transcripts/absolute
  paths) + `grove import-project <bundle> [--dir]` (recreates the project folder + file);
  round-trip test.
- **V9-W2 onboarding wizard v2** (web) — a first-run wizard: create/load/import a project,
  add first nodes, show auth status; skippable, remembered.
- **V9-W3 self-retro lane** (bridge) — a node appends a short retro on a completed task
  (e.g., via /api/tasks/{id}/retro or a comment kind), recorded in audit; opt-in, redacted.
- **V9-W4 brainstorm → v1.10** (grove-arch) — guarded autonomous pickup, routing planner,
  Slack command surface, mobile actions, multi-machine.

## Execution order

1. V9-W1 export/import (core) + V9-W2 wizard (web) + V9-W4 brainstorm — parallel.
2. V9-W3 self-retro lane.
3. v1.9 review pass → fix → coverage → e2e → CHANGELOG + 0.10.0.

## Conventions

Unchanged: maker/review/test nodes code; lead orchestrates/verifies/commits (no push);
pnpm check + reviewer GO before commit; mock mirrors real backend + real-server e2e for
new endpoints; one node per window; one writer per area; agy headless; bundles exclude
machine-local paths/secrets; no questions until told to stop.
