# grove v1.7 — Roadmap

> Status: historical v1 roadmap; superseded by the current v2 live cockpit model documented in `docs/design/MASTER_NODE.md` and `docs/agents/LEAD-HANDOFF.md`.
> Ideas: `docs/V1.7_BRAINSTORM.md`. v1.7 = **the collaborative team room** — surface the
> decisions a human must make, show who's present, and finish the board-replay polish.

## Theme

A non-engineer (or a teammate over Tailscale) can open the room, immediately see the
decisions waiting on them, who else is around, and answer — the human-in-the-loop made
first-class.

## Exit criteria

1. Decision inbox: a dashboard view of tasks blocked / waiting on a human (ask-human
   gate + blocked board tasks), project-scoped, with the decision context; answering
   advances the task (reuses the existing unblock/ask-human path).
2. Presence: the dashboard shows who is connected (team-auth members; anonymous on
   loopback), updating live.
3. Board event cursor replay: on WS reconnect, fetch events-after-cursor (precise
   catch-up) rather than only a full reload.
4. Zero open P0/P1 from a v1.7 review pass; coverage ≥80%; full check + e2e green;
   CHANGELOG + 0.8.0.

## Workstreams

- **V7-W1 decision inbox** (bridge + web) — /api/inbox: project-scoped list of blocked /
  ask-human-pending tasks with decision context; FE inbox panel; answering routes through
  the existing unblock / ask-human reply path; audit records the actor.
- **V7-W2 presence** (bridge + web) — track connected viewers (team-auth member or
  anonymous-loopback) via ws-ticket/session; /api/presence or a ws channel; FE presence
  chips. Privacy-light (no PII beyond member name/role).
- **V7-W3 board cursor replay** (web + bridge) — track the last board-event cursor; on
  reconnect request events-after-cursor (list_events_after) instead of a full reload.
- **V7-W4 brainstorm → v1.8** (grove-arch) — notification rules, onboarding wizard v2,
  import/export, self-retro lane.

## Execution order

1. V7-W1 inbox backend + V7-W3 cursor replay (web) + V7-W4 brainstorm — parallel.
2. V7-W1 inbox FE; V7-W2 presence (backend then FE).
3. v1.7 review pass → fix → coverage → e2e → CHANGELOG + 0.8.0.

## Conventions

Unchanged: maker/review/test nodes code; lead orchestrates/verifies/commits (no push);
pnpm check + reviewer GO before commit; mock mirrors real backend + real-server e2e for
new endpoints; one node per window; one writer per area; agy headless; no questions until
told to stop.
