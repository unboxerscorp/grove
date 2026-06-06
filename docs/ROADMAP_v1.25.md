# grove v1.25 — Roadmap

> Status: historical v1 roadmap; superseded by the current v2 live cockpit model documented in `docs/design/MASTER_NODE.md` and `docs/agents/LEAD-HANDOFF.md`.
> Design: `docs/V1_25_BRAINSTORM.md`. v1.25 = **reach + summarize** — a **command palette** (Cmd-K)
> over the now-many views (complements the v1.24 sidebar) + a **Slack digest/reminder** (scheduled
> board/status summary, reusing the v1.20 live-announcement chat.update). Tracked on the dev-room
> board (dogfood).

## Theme

v1.24 made nav cleaner (sidebar) but there are 14 views — a **command palette** (Cmd-K) gives
instant keyboard nav/search to any view/drawer (read-only navigation; no hidden mutation). And the
Slack bot gains a **digest/reminder**: a scheduled, in-place-updating board/status summary
(reusing the v1.20 persisted-ts chat.update announcement), plus optional reminders for
stale-blocked/ask-human — read-only/notify only, default OFF.

## Workstreams

- **V25-W1 command palette** (web) — Cmd-K (and a button) opens a palette listing all views +
  drawers (and maybe quick read-only actions like "go to blocked tasks"); fuzzy filter; keyboard
  nav; closes on select/Esc. **Navigation only — no mutation** (any action routes to the existing
  gated UI). a11y (focus trap, aria). Responsive. No backend change. verify `commandPaletteOk`.
  Board task on dev-room, assignee grove-fe.
- **V25-W2 Slack digest/reminder** (bridge) — a scheduled digest (board summary: counts, blocked,
  running) posted/updated in place via the v1.20 live-announcement upsert (persisted ts +
  chat.update + dirty/hash); optional reminder for stale blocked/ask-human. **Read-only/notify
  only** (no task mutation), dry-run default, operator-gated config, audited, redacted, default
  OFF. Board task on dev-room, assignee grove-py.
- **V25-W3 brainstorm → v1.26** (grove-arch) — optional per-user sandbox v0, multi-room alert
  overlay, theming; + keep README current.
- **Wave-2** — FE for the Slack digest config (if useful) + real-server e2e for any new endpoint;
  palette polish.

## Exit criteria

1. Command palette: Cmd-K opens a palette reaching all 14 views + 3 drawers, fuzzy filter,
   keyboard nav, navigation-only (no mutation), a11y, responsive; no regression (sidebarNavOk +
   all flags green).
2. Slack digest/reminder: scheduled in-place digest via chat.update upsert; read-only/notify only;
   dry-run default; operator-gated + audited + redacted; default OFF.
3. Zero open P0/P1 from review (palette hidden mutation/focus trap; digest leak/unintended
   outbound/role bypass); coverage ≥80%; full check + web e2e green (new endpoints covered by
   real-server api.mjs); CHANGELOG + README + 0.26.0.

## Conventions

Unchanged + safety-first: palette is navigation-only (no mutation/safety surface); Slack digest is
read-only/notify, dry-run default, operator-gated + audited; maker/review/test nodes code; lead
orchestrates/verifies/commits; **track work on the dev-room board (dogfood)**; **push origin main +
tags at release**; **docs lane keeps README current**; **refresh the live :9131 dashboard at
release**; pnpm check + reviewer GO; mock mirrors real backend + real-server e2e for new endpoints;
one node per window; one writer per area per wave; agy headless; no questions until told to stop.
