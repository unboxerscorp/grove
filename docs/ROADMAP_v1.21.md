# grove v1.21 — Roadmap

> Status: historical v1 roadmap; superseded by the current v2 live cockpit model documented in `docs/design/MASTER_NODE.md` and `docs/agents/LEAD-HANDOFF.md`.
> Design: `docs/V1_21_BRAINSTORM.md`. v1.21 = **the Slack bot converses** — thread context +
> natural-language status queries. Read-only (no new mutation); continues the v1.20 Slack work
> the user has been steering.

## Theme

v1.20 gave the Slack bot intent triage (file a task vs. answer). v1.21 makes it conversational
and useful as a read-only assistant: it keeps **thread context** (a follow-up in the same thread
is understood in context, not classified from scratch), and answers **natural-language status
queries** ("what's the board look like?", "any blocked tasks?", "who's running what?", "today's
usage?") from the existing read-only APIs — with Block Kit answers. No new mutation: this is the
"just answer" path made genuinely useful. Default OFF (extends --enable-intake / commands).

## Non-negotiable invariants

1. **Read-only** — status queries + thread follow-ups only READ (board/status/audit/usage/ledger);
   the only mutation remains the v1.20 gated task-create (unchanged). No new mutation path.
2. **Deterministic + bounded** — query understanding stays a bounded, deterministic heuristic (no
   LLM in the loop, consistent with v1.20); ambiguous → a helpful "did you mean…" rather than a
   wrong action.
3. **Scoped answers** — answers respect the asker's role + project scope (a viewer's answer can't
   reveal what they couldn't see in the dashboard); no secret/PII/path leak in answers.
4. **Thread safety** — thread context is bounded (size/age), per-thread, and can't be used to
   smuggle an unauthorized mutation (a thread follow-up that "asks" to create still goes through
   the v1.20 gated preview→confirm).
5. **Default OFF + audited**.

## Exit criteria

1. NL status queries: a deterministic query parser maps a message → {board summary, blocked
   tasks, running, usage/ledger, …} → a read-only Block Kit answer, role + project scoped, no
   leak; ambiguous → suggestions.
2. Thread context: a follow-up in a thread is interpreted with bounded prior context; a thread
   "ask to create" still requires the gated preview→confirm (no mutation smuggling).
3. Zero open P0/P1 from an adversarial review (scope/role leak in answers, mutation via thread,
   injection); coverage ≥80%; full check + web e2e green; CHANGELOG + README + 0.22.0.

## Workstreams

- **V21-W1 NL status queries + thread context** (bridge) — deterministic query parser →
  read-only answers (Block Kit) from existing APIs, role/project-scoped; bounded per-thread
  context; ambiguity → suggestions. Read-only. Adversarially tested (answer scope/role leak,
  thread mutation smuggling, injection).
- **V21-W2 brainstorm → v1.22** (grove-arch) — optional per-user sandbox v0, retro analytics,
  usage/cost trend reporting v2, notification routing v2; + keep README current.
- **Wave-2** — FE surfacing (Slack query/thread activity in audit, if useful) + e2e check.

## Conventions

Unchanged + safety-first: read-only this version (only the v1.20 gated task-create mutates);
deterministic/bounded (no LLM); scoped answers (role + project, no leak); thread context can't
smuggle a mutation; default OFF + audited; maker/review/test nodes code; lead orchestrates/
verifies/commits; **push origin main + tags at release**; **docs lane keeps README current**;
pnpm check + an adversarial reviewer GO; mock mirrors real backend + real-server e2e for new
endpoints; one node per window; one writer per area per wave; agy headless; no questions until
told to stop.
