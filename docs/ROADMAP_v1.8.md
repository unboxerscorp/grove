# grove v1.8 — Roadmap

> Status: **autonomous build in progress** (auto-started 2026-06-04 after v1.7.0).
> Ideas: `docs/V1.8_BRAINSTORM.md`. v1.8 = **complete the team room** — presence + a
> notification layer so people know who's around and get pinged when a decision needs them.

## Theme

Close the collaboration loop: see who's present, and be notified (not just polling) when
a task blocks / needs a human — building on the v1.7 decision inbox + the existing notifier.

## Exit criteria

1. Presence: /api/presence (or a ws channel) lists who's connected — team-auth members by
   name/role, anonymous on loopback — updating live; a dashboard presence indicator.
2. Notification rules: when a task blocks / an ask-human is raised, a notification fires
   through the existing notifier (dry-run-safe), governed by simple, configurable rules;
   no duplicate spam (dedup), secrets redacted.
3. Zero open P0/P1 from a v1.8 review pass; coverage ≥80%; full check + e2e green;
   CHANGELOG + 0.9.0.

## Workstreams

- **V8-W1 presence** (bridge + web) — track connected viewers via the team-auth session
  store + active ws; /api/presence (token, project-scoped; member name/role only, no PII
  beyond that); FE presence chips, live-updating; loopback shows anonymous.
- **V8-W2 notification rules** (bridge) — on block / ask-human-pending, emit a notification
  via the notifier (already dry-run-default); a small rules config (which events, which
  channel); dedup so the same blocked task doesn't re-notify; redacted payloads.
- **V8-W3 brainstorm → v1.9** (grove-arch) — onboarding wizard v2, import/export, self-retro
  lane, autonomous pickup, routing recommender.

## Execution order

1. V8-W1 presence backend + V8-W2 notification rules + V8-W3 brainstorm — parallel.
2. V8-W1 presence FE.
3. v1.8 review pass → fix → coverage → e2e → CHANGELOG + 0.9.0.

## Conventions

Unchanged: maker/review/test nodes code; lead orchestrates/verifies/commits (no push);
pnpm check + reviewer GO before commit; mock mirrors real backend + real-server e2e for
new endpoints; one node per window; one writer per area; agy headless; notifier stays
dry-run-default; no questions until told to stop.
