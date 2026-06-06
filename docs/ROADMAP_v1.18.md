# grove v1.18 — Roadmap

> Status: historical v1 roadmap; superseded by the current v2 live cockpit model documented in `docs/design/MASTER_NODE.md` and `docs/agents/LEAD-HANDOFF.md`.
> **Headline = explicit user request**: let people on the same Tailscale tailnet open my grove
> dashboard, **start new projects**, and use my Mac mini's local CLIs (codex/agy/claude) — with
> **easy connection setup**. Other ideas: `docs/V1_18_BRAINSTORM.md`.

## Theme

Through v1.17 grove is single-operator (one token). v1.18 makes it a **shared room on your
tailnet**: tailnet peers connect to the dashboard with their own identity, start projects, and
drive the host's local agent CLIs — easy to turn on, easy to join. Tailnet-only (a trusted,
private network — never the public internet), opt-in, per-user identity, fully audited.

## Non-negotiable invariants

1. **Tailnet-scoped, not public** — shared access binds to the tailnet (e.g. the Tailscale
   interface / an allow-host list), never 0.0.0.0-to-the-internet without explicit acknowledgement;
   default OFF (single-operator stays the default).
2. **Per-user identity** — each peer authenticates to a distinct member (reusing team-auth:
   cookie session + member registry + CSRF + roles); no anonymous mutation.
3. **Role-gated + audited** — what a peer may do (start a project, delegate, approve/abort/kill,
   etc.) is role-gated; every action is audited with actor = the peer's member.
4. **Easy connect** — turning shared access on prints/show a shareable join (URL + one-time join
   code); a peer joins by opening the URL and entering the code → gets a member. No hand-editing
   configs.
5. **Local resources, explicit** — spawned work uses the host's codex/agy/claude as today; this
   is stated plainly (peers share the host's capacity; no per-user sandbox in v1.18).

## Exit criteria

1. Shared-access mode (default OFF): a tailnet-scoped multi-user mode where a peer joins via a
   one-time join code → a per-user member (role), CSRF-protected session, audited. Single-operator
   default unchanged.
2. Start projects: a joined peer (with the right role) can create/load projects from the
   dashboard, work running on the host's local CLIs; actions audited per member.
3. Easy connect: enabling shared access surfaces a shareable join (tailnet URL + one-time code);
   joining is open-URL-then-enter-code, no config editing. Documented.
4. Zero open P0/P1 from an adversarial review (auth bypass, join-code abuse/replay, privilege
   escalation, anonymous mutation, accidental public exposure); coverage ≥80%; full check + web
   e2e green (new endpoints covered by real-server api.mjs); CHANGELOG + 0.19.0.

## Workstreams

- **V18-W1 shared-access + join backend** (bridge) — shared-access mode (default OFF, tailnet-
  scoped), one-time join code → per-user member onboarding (reuse team_auth: session/CSRF/roles),
  role-gated project-create + actions, per-member audit. Adversarially tested (auth bypass,
  join-code replay/brute force, privilege escalation, anonymous mutation, public-exposure guard).
- **V18-W2 brainstorm → v1.19** (grove-arch) — retro analytics, usage/cost trend reporting v2,
  notification routing v2, per-user quotas, optional per-user sandboxing.
- **Wave-2** — FE connect/onboarding UX (enable shared access → shareable join link + code; a peer
  join screen; "who's connected"; start-project reachable) + easy `grove serve` tailnet ergonomics
  (friendly "share this URL" output) + real-server e2e for the new join/multi-user endpoints.

## Conventions

Unchanged + safety-first: tailnet-scoped not public; default OFF; per-user identity (no anon
mutation); role-gated + audited; easy connect (join code, no config editing); local resources
shared explicitly; maker/review/test nodes code; lead orchestrates/verifies/commits (no push);
pnpm check + an adversarial reviewer GO (multi-user access is safety-sensitive); mock mirrors real
backend + real-server e2e for new endpoints; one node per window; one writer per area per wave;
agy headless; no questions until told to stop.
