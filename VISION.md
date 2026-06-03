# Grove — Vision & Goal

Grove is the product. The end state is an always-on **"dev room (개발실)"** web where
both engineers and non-engineers see everything at a glance, make only the decisions
that genuinely need a human, and do the final deploy check.

## North star

Every agent is a **real, viewable, talk-to-able Claude Code / Codex CLI session** —
never an invisible API runtime. You can open any agent's terminal live, talk to it,
and watch it work. Grove owns this end to end and depends on **no external agent
control plane** — it is fully self-contained.

## What the dev room shows / does

- **Kanban of all agent tasks**, each executed by a real grove CLI session.
- **Open / view any agent's terminal live** (xterm over the running tmux panes).
- **Channels (chat)** — every chat is answered by a real grove CLI session.
- **Human-judgment points** surface as kanban cards + chat (Slack) threads; a human
  reply advances the work (the _ask-human_ gate).
- **QA / review / test automated**; **deploy stays human-gated**.
- **Feedback button** on live products → a 24/7 AI-triaged queue → a triage session.
- **Multi-account / 24h** operation; **multi-machine** work aggregated into one web.

## Architecture (all grove-native, self-contained)

- **grove core** — orchestrates a tree of CLI agents in tmux: `send / wait / gather`,
  durable event log, fan-in. _(built)_
- **grove serve** — exposes grove sessions as an OpenAI-compatible chat endpoint
  (the channel seam). _(built; being made fully self-contained)_
- **grove board** — grove's own task / kanban store + executor: claim → run in a real
  session → complete / block, with deps, comments, notify subscriptions.
- **grove channels** — Slack / web chat ingestion routed to grove sessions; human
  replies advance blocked tasks.
- **grove web** — grove's own dashboard web server: the board + the live terminal
  viewer + decision cards. A single self-owned app, no external plugin host.

## Roadmap

0. **Self-containment** — grove owns its entire stack; remove every external runtime
   dependency and every trace of borrowed control planes. _(current focus)_
1. **Board + executor** — tasks = real sessions.
2. **Channels + ask-human gate** — chat = real sessions; human decisions via threads.
3. **Web dev-room** — board + live terminals + decision cards.
4. **Feedback ingest + 24/7 triage.**
5. **QA / review / test automation lanes** (deploy stays human-gated).

## How we work (non-negotiable)

- The **lead/orchestrator** drives tmux, distributes work, verifies, integrates — and
  writes **no product code**.
- All implementation goes to **dedicated maker panes by specialty** (TS / Python /
  frontend); a **reviewer** pane reviews every change before commit, a **QA** pane gates.
- **Web UI is built by a Claude Code worker using the `frontend-design` skill.**
- Single final gate per change: `pnpm check`.

## v2 — Team OS (building)

Grove evolves from a node-comms helper into a **GUI-driven multi-agent team OS**:

- **GUI team builder** — create a node (name / agent codex|claude|agy / role / parent / group) in the web UI → grove spawns a real tmux pane, launches the agent, injects the role, registers it; the graph stays live-synced as the team changes.
- **Hierarchy & groups** — a node with children is an **orchestrator** (delegates only, does no implementation); a **group** is peers who discuss/ideate as equals.
- **Org-chart awareness** — the team graph (role / parent / children / group) is a single source of truth (the registry, extended). Every node gets a **snapshot at spawn** + pulls the **live chart via `grove org`** before delegating/asking (fresh, never stale).
- **Board = delegation protocol** — a parent delegates to a child **only** by creating a board task (`assignee=child`); the board is the inter-node work channel + audit trail.
- **Enforcement = skill-first** (not rigid hooks): a grove skill set — `grove:harness` (meta: check the matching grove skill before any team/delegation/node action, using-superpowers pattern), `grove:org`, `grove:delegate` (ask-vs-assign), `grove:spawn-node`, `grove:form-group`, `grove:orchestrator-rules` — authored for all 3 services (claude skills / codex plugin-skills / agy `.agents/skills`). Skills teach + encode the right path; the board/GUI make it the easy path; a light audit surfaces violations. **Hard hooks added only surgically, later, where a rule proves chronically violated** (efficiency + flexibility first). Audit the superpowers plugin and adapt anything that conflicts with the grove method.
- **Visualization** — replace the flat node list with a graph view (hierarchy tree + group clusters, activity pulse, hover → open terminal / edit node).
- **Later**: Slack / human-judgment gate (original vision). **Deferred**: multi-member aggregated view (low ROI). **Migration** of the current fleet into this model = done manually by the lead.

**Minimum first target:** the user can build a sample node org chart in the GUI and assign it a simple task.
