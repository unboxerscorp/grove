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

- **Human-facing lists** for operator TODOs, feedback, and human-judgment points.
- **Open / view any agent's terminal live** (xterm over the running tmux panes).
- **Channels (chat)** — Slack and web chat route directly to real grove CLI sessions.
- **Human-judgment points** surface as list items + chat (Slack) threads; a human
  reply records the decision and lets the operator or target node continue.
- **QA / review / test automated**; **deploy stays human-gated**.
- **Feedback button** on live products → a 24/7 AI-triaged queue → a triage session.
- **Multi-account / 24h** operation; **multi-machine** work aggregated into one web.

## Architecture (all grove-native, self-contained)

- **grove core** — orchestrates a tree of CLI agents in tmux: `send / wait / gather`,
  durable event log, fan-in. _(built)_
- **grove serve** — exposes grove sessions as an OpenAI-compatible chat endpoint
  (the channel seam). _(built; being made fully self-contained)_
- **grove human list** — grove's own store for operator TODOs, feedback, and
  ask-human records; not a required node-to-node communication protocol.
- **grove channels** — Slack / web chat ingestion routed directly to grove sessions;
  human replies are recorded as decisions or feedback.
- **grove web** — grove's own dashboard web server: human lists + live terminals +
  org awareness + decision surfaces. A single self-owned app, no external plugin host.

## Roadmap

0. **Self-containment** — grove owns its entire stack; remove every external runtime
   dependency and every trace of borrowed control planes. _(current focus)_
1. **Human lists + optional executor** — human-facing records can be picked up by
   real sessions when the operator asks.
2. **Channels + human decisions** — chat = real sessions; human decisions via threads.
3. **Web dev-room** — human lists + live terminals + decision cards.
4. **Feedback ingest + 24/7 triage.**
5. **QA / review / test automation lanes** (deploy stays human-gated).

## How we work (non-negotiable)

- The **lead/orchestrator** drives tmux, distributes work, verifies, and integrates;
  it may also do direct work when that is the practical route or the operator asks.
- Nodes are not capability-limited by their org position. Hierarchy describes
  ownership and reporting, not a hard execution firewall.
- Organization changes remain human-owned; nodes should not autonomously rearrange
  the org chart unless the operator explicitly asks through an operator-marked path.
- Single final gate per change: `pnpm check`.

## v2 — Team OS (building)

Grove evolves from a node-comms helper into a **GUI-driven multi-agent team OS**:

- **GUI team builder** — create a node (name / agent codex|claude|agy / role / parent / group) in the web UI → grove spawns a real tmux pane, launches the agent, injects the role, registers it; the graph stays live-synced as the team changes.
- **Hierarchy & groups** — a node with children is an **orchestrator** by ownership, but any node can communicate directly and do practical work when asked; a **group** is peers who discuss/ideate as equals.
- **Org-chart awareness** — the team graph (role / parent / children / group) is a single source of truth (the registry, extended). Every node gets a **snapshot at spawn** + pulls the **live chart via `grove org`** before delegating/asking (fresh, never stale).
- **Human-facing list items, not node protocol** — the list is for operator TODOs,
  feedback, and ask-human records. Nodes coordinate directly through chat, tmux,
  grove send/ask, or whatever path fits the work.
- **Skills = orientation, not cages**: grove skills — `grove:harness`,
  `grove:org`, `grove:delegate`, `grove:spawn-node`, `grove:form-group`,
  `grove:orchestrator-rules` — keep nodes org-aware and vocabulary-aligned across
  claude/codex/agy surfaces. They should help agents choose the right path, not
  prevent practical direct communication.
- **Visualization** — replace the flat node list with a graph view (hierarchy tree + group clusters, activity pulse, hover → open terminal / edit node).
- **Later**: Slack / human-judgment gate (original vision). **Deferred**: multi-member aggregated view (low ROI). **Migration** of the current fleet into this model = done manually by the lead.

**Minimum first target:** the user can build a sample project/org chart in the GUI,
see every node's cwd and tmux pane, talk to nodes directly, and create a
human-facing item when they want something tracked for themselves.

**Team / distribution model (user, decided):** grove is a tool each member **installs and runs LOCALLY on their own machine**, with their **own** codex / claude / agy credentials — NOT a central multi-user server everyone logs into. Team reuse happens through **shareable project templates** (a saved org chart + roles + method/skills that each member instantiates locally via `grove new-project --template`), not a shared live server. Consequences: easy local install + `grove new-project` + templates is the priority; the central "aggregated multi-member view" (#7) is even lower-priority / likely unneeded (everyone runs their own); the dashboard auth gate (below) is about a member's OWN exposure if they choose to share their local instance over Tailscale, not a central team gate. **Reusable new-project flow to build:** `grove new-project <name> [--template t]` (create session + scaffold org chart + start/print dashboard) + a dashboard project (session) switcher.

**Security note (a member's own exposure):** the dashboard currently injects the `/api` session token into the served HTML and binds `0.0.0.0`, so anyone who can reach the port (Tailscale mesh / LAN) can spawn agents. This is accepted for **solo personal-Tailscale** use only. **Before exposing the dashboard to a team or any untrusted network, add a real auth gate** — an operator secret the user enters (not injected into HTML) on non-loopback binds, or a Tailscale-ACL / OAuth check. Do not enable team access without it.
