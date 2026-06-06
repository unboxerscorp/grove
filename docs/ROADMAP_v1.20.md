# grove v1.20 — Roadmap

> Status: historical v1 roadmap; superseded by the current v2 live cockpit model documented in `docs/design/MASTER_NODE.md` and `docs/agents/LEAD-HANDOFF.md`.
> **Headline = explicit user request**: advance the Slack bot — submit bug reports / dev feedback
> from Slack, and let the bot read a free-form message and **judge** whether to file it as a task
> or just answer. Design: `docs/V1_20_SLACK_BRAINSTORM.md` (+ docs/V1_20_BRAINSTORM.md).

## Theme

v1.14 gave Slack fixed safety commands (status/approve/abort/killswitch). v1.20 makes the bot
_understand_: a free-form message is classified (bug / feedback / task request / question /
command), and the bot either **files a board task** (for bug/feedback/task) or **just answers**
(for a question) — proposing its decision and letting a human correct it. Bug/feedback intake
becomes a first-class flow. Safety-first: the only mutation is task creation, and it reuses the
v1.18 gated path (role + audit + preview→confirm); the answer path is read-only. Default OFF.

## Non-negotiable invariants

1. **One gated mutation path** — filing a task from Slack goes through the existing gated
   task-create (the v1.18 central role-gate: viewers can't create; audited, actor = Slack
   identity); NO second path that bypasses a gate. The answer path is read-only.
2. **Human in the loop for mutations** — the bot proposes (preview); creating the task needs an
   explicit confirm (or a clearly-bounded auto-create that's itself default-OFF + role-gated).
3. **Bounded classifier** — the intent judgement is a bounded LLM call; ambiguity/low-confidence
   defaults to "answer / ask", never to a silent mutation. Resistant to prompt-injection that
   tries to force an unauthorized task-create.
4. **Privacy** — intake/answers never echo secrets/tokens/paths/PII; filed tasks are
   privacy-allowlisted.
5. **Default OFF + scoped** — the intelligent intake is opt-in (extends v1.14 --enable-commands),
   token/role-scoped, audited.

## Exit criteria

1. Slack free-form intake: a message → bounded intent classification → {bug/feedback/task →
   gated task-create (preview→confirm)} | {question → read-only answer}; bug/feedback intake
   flow; default OFF.
2. Reuses the gated task-create path (no gate-bypassing second path); role-gated; audited;
   prompt-injection resistant (a message can't force an unauthorized mutation).
3. Zero open P0/P1 from an adversarial review (prompt-injection→unauthorized task-create, role
   bypass, privacy leak, second mutation path); coverage ≥80%; full check + web e2e green (new
   endpoints covered by real-server api.mjs); CHANGELOG + README + 0.21.0.

## Workstreams

- **V20-W1 Slack intent triage + intake backend** (bridge) — Slack message intake, bounded
  classifier, the gated task-create helper (preview→confirm, role, audit, redaction), bug/
  feedback flow. Default OFF (extends --enable-commands). Adversarially tested (prompt-injection,
  role bypass, ambiguity→answer, privacy).
  - **Block Kit UX (user directive)**: compose the bot's messages with Block Kit (section +
    action buttons + confirm dialog for preview→confirm; overflow/modal where it helps). Reference
    `~/dev/notion-slack-sync-server` for patterns — especially its **continuously-updated
    announcement**: persist a message ts in the store and `chat.update` it in place (upsert)
    rather than posting new messages. grove should have a live, in-place-updating announcement
    (e.g. a triage/room-status message). Respect the 3000-char section limit + progressive collapse.
- **V20-W2 brainstorm → v1.21** (grove-arch) — further Slack enhancements (thread context, status
  queries, routing), optional per-user sandbox v0, retro analytics; + keep README current.
- **Wave-2** — FE (Slack intake config/preview surface; show the bot's decision + correct it) +
  real-server e2e for the new endpoints.

## Conventions

Unchanged + safety-first: one gated mutation path (no bypass); human in the loop for mutations;
bounded classifier (ambiguity→answer, injection-resistant); privacy; default OFF + scoped +
audited; maker/review/test nodes code; lead orchestrates/verifies/commits; **push origin main +
tags at release**; **docs lane keeps README current**; pnpm check + an adversarial reviewer GO
(Slack auto-task-create is safety-sensitive); mock mirrors real backend + real-server e2e for new
endpoints; one node per window; one writer per area per wave; agy headless; no questions until
told to stop.
