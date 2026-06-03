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
