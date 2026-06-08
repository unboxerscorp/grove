# Tmux Operation Model

Status: first-pass design (grove-dev, canonical Gap A). Documents the intended
tmux window/pane layout and the service-vs-agent node distinction, and stages
the implementation by risk. Live pane relayout and fleet-config edits are
operator/master-owned and are NOT performed by this doc.

## Problem

The live sample session runs background **server processes** (`grove-web`,
`grove-slack`) in tmux windows that look like ordinary agent nodes. They are
declared in `grove.yaml` with fixed pane targets (`web` → `tmux: "1.0"`,
`slack` → `tmux: "2.0"`, `agent: codex`) and brought up by `grove up`, but the
actual processes are the Python console scripts `grove-web` / `grove-slack`
(`bridge/pyproject.toml [project.scripts]`), not Codex agents. The org chart and
dashboard therefore render servers as if they were addressable agent nodes,
which is misleading and invites accidental "send a message to the server pane"
actions.

Two distinct problems are tangled here:

1. **Identity** — nothing in the data model marks a node as "background service"
   vs "agent". `NodeRecord.kind` is only `human | registry`
   (`web_app.py:_node_kind_for_registry`); `group` is display-only and drives no
   layout. `fleet.yaml` already declares `archetype: service` for web/slack, but
   no code reads it.
2. **Layout** — window indices are assigned by tmux in creation order
   (`src/tmux.ts:newWindowArgs` uses `-n <name>`; grove never sets an index).
   There is no policy that keeps masters, services, and per-project nodes in
   stable, meaningful windows.

This first pass fixes **identity** (so servers stop _looking_ like agents) and
**documents** the layout. It does NOT move panes.

## Target Operation Model

Operator-specified durable layout (already echoed in `cockpit.grove.yaml` /
`fleet.yaml` comments):

```text
window 0  master / chat nodes        (grove-master, future chat surfaces)
window 1  services / background       (grove-web, grove-slack, … split into panes)
window 2  project 1 nodes (incl lead)
window 3  project 2 nodes (incl lead)
window N  project (N-1) nodes
```

Principles:

- One window per **project**; the project's `lead` and its nodes share that
  window, split into panes. Window 0 is the master/chat plane; window 1 is the
  shared services plane.
- The window a node lands in is a function of its **role plane** (master /
  service / project) and, for project nodes, **which project** it belongs to —
  not of creation order.
- Background services are visually and semantically distinguished from agents in
  the registry/org/UI so a server pane is never presented as an addressable
  agent.

## Service-vs-Agent Distinction

Introduce an explicit, optional node **`kind`** that flows through the existing
plumbing (the registry already tolerates a raw `kind` key —
`web_app.py:_is_human_node_mapping` reads `kind == "human"`):

- Values: `agent` (default), `service`, `human`.
- Declared as **explicit metadata** in `grove.yaml`/config (never inferred from
  node names), preserved in the registry, surfaced in `/api/org` (the org
  payload already carries `kind`), and rendered as a "service / background" badge
  in the dashboard org node and drawer.
- **Display/identity only.** `_node_kind_for_registry` returns `service` only
  when a node _declares_ `kind: service`; unmarked nodes are unchanged. It does
  NOT touch `input_allowed` / `terminal_allowed` / status / pane-liveness —
  those stay derived exactly as today. (Advisor guard: deciding service health
  from service endpoints, or gating addressability by kind, is a separate
  approval-gated step; it is deliberately excluded from this pass to avoid any
  status/liveness regression.)

This aligns the data model with `fleet.yaml`'s existing `archetype: service`
intent without inventing a second vocabulary; `kind` is the one that already
reaches the web layer. `fleet.yaml` is **read-only** here — we wire the intent,
we do not edit operational fleet config without approval.

## Staged First-Pass (by risk)

**A1 — policy doc (this file). LOW risk.** Records the model so it stops
recurring. No code.

**A2 — service/agent identity code + activation path. LOW risk, no pane move.**

- TS: optional `kind` on `NodeConfigSchema`, `ResolvedNode` (`resolveNodes`),
  `NodeRuntime`, `nodeFromRuntime`, and the spawn path (so it roundtrips through
  config/registry/spawn exactly like `work_instructions`); optional `--kind`
  spawn flag.
- Python: `_node_kind_for_registry` returns `service` for explicitly-declared
  `kind: service`; `kind` already flows into the org payload.
- Frontend: `GroveNode.kind`; a "service / background" badge.
- Tests mirror the work_instructions pattern: schema/registry roundtrip, org
  payload classification, **unmarked → org payload byte-identical** (backward
  compat, like WI-unset), FE types. sample 6-node baseline must not regress.

**Activation (make the live web/slack distinguishable). APPROVAL-GATED MUTATION,
proposed not auto-applied.** Per master directive, A2 ships a concrete activation
path rather than staying inert; the _mutation itself_ is proposed for approval
before applying and moves no panes:

- Durable: add `kind: service` to `web` and `slack` in `grove.yaml` (exact diff
  proposed to operator/master; operational fleet config edit is approval-gated).
- Live: a surgical registry patch adding `"kind": "service"` to the `web`/`slack`
  entries in the sample registry (exact command proposed; field-only, no restart,
  no pane move). Takes visible effect once the bridge change is redeployed
  (rides the normal master-owned redeploy).

**A3 — window-allocation policy + live relayout. GATED, design only here.**

- A pure helper computing the intended window for a node from its role plane +
  project (no side effects), plus a spawn/bringup _guard/warning_ when a target
  window contradicts the policy.
- Any **move of existing live panes** is an operator-approved operational action
  (a planned follow-up), verified afterward with health (8765+5173),
  pane-liveness (`list-panes`), and the remote 5173 tier1 smoke. Not done here.

## First-Pass Success (per master)

Documented policy (A1) + schema/guard/display code making service panes
distinguishable + tests (A2) + a proposed, no-pane-move activation path. Actual
window migration is an explicitly-approved follow-up.

## Verification

`pnpm check`; targeted vitest/pytest; `web` tsc; remote 5173 tier1; 8765+5173
`/api/health`; slack queue stays socket_connected. A2 must show byte-stable org
output for unmarked nodes (no regression for the live 6-node baseline).

## Non-Goals

- Moving or renumbering live panes without an approved plan.
- Editing `grove.yaml` / `fleet.yaml` / `cockpit.grove.yaml` without approval
  (activation diffs are proposed, not auto-applied).
- Inferring service-ness from node names.
- Changing service-node access/liveness/health semantics in the first pass.
- Auto-spawning or reparenting nodes to satisfy the layout (org changes stay
  human-owned).
