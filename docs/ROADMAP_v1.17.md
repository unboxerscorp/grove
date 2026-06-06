# grove v1.17 — Roadmap

> Status: historical v1 roadmap; superseded by the current v2 live cockpit model documented in `docs/design/MASTER_NODE.md` and `docs/agents/LEAD-HANDOFF.md`.
> Design: `docs/V1_17_BRAINSTORM.md`. v1.17 = **hand a task to another room** — a signed,
> privacy-first handoff package that the receiver verifies and accepts LOCALLY. Data transfer,
> not remote control.

## Theme

v1.16 let rooms observe each other (signed read-only summaries). v1.17 lets one room hand a
task to another: the sender exports a **signed handoff package** (task title/body/context,
privacy-allowlisted), the receiver **verifies the signature (trust)** and **accepts it locally**
as a new board task — a human at the receiver confirms. It is DATA transfer: nothing executes
remotely, no control crosses machines, the receiver always decides. Default OFF.

## Non-negotiable invariants

1. **Receiver-local accept** — a handoff becomes a task only when a human at the receiver
   explicitly accepts; the sender cannot create or execute anything on the receiver.
2. **Signed + verified** — the package is signed (v1.16 key model); an unverifiable/tampered/
   unknown-key package is rejected before accept; trust is shown.
3. **Privacy-allowlisted payload** — the package carries only the fields needed to recreate a
   task (title, body, labels) under an allowlist; no secrets/tokens/paths/PII/transcript.
4. **Idempotent + audited** — accepting the same handoff twice does not create duplicates
   (one-shot handoff id); both export and accept are audited.
5. **Default OFF + scoped** — export and accept are opt-in, token-gated, project-scoped.

## Exit criteria

1. Signed handoff export: a read-only, privacy-allowlisted, signed handoff package (default OFF,
   token-gated); no secret/PII leak (adversarially checked).
2. Receiver-local accept: verify (trust) → preview → explicit human accept → a new local task;
   tampered/unknown-key/duplicate rejected; audited. No remote execution.
3. Zero open P0/P1 from an adversarial v1.17 review (forge, replay/duplicate, privacy leak,
   remote-create bypass); coverage ≥80%; full check + web e2e green (new endpoints covered by
   real-server api.mjs); CHANGELOG + 0.18.0.

## Workstreams

- **V17-W1 signed handoff export + accept backend** (bridge) — export a signed handoff package;
  accept = verify + idempotent local task create (human-confirmed at the API), audited. Default
  OFF, token-gated, adversarially tested (forge, duplicate, privacy leak, remote-create bypass).
- **V17-W2 brainstorm → v1.18** (grove-arch) — retro analytics, usage/cost trend reporting v2,
  notification routing v2, multi-room alert overlay.
- **Wave-2** — FE handoff surface (export a package, paste + preview + accept) + real-server e2e
  for the new endpoints, once W1 lands.

## Conventions

Unchanged + safety-first: data transfer, not remote control; receiver-local accept (human
decides); signed + verified; privacy allowlist; idempotent + audited; default OFF + token-gated +
scoped; maker/review/test nodes code; lead orchestrates/verifies/commits (no push); pnpm check +
an adversarial reviewer GO (cross-room transfer is safety-sensitive); mock mirrors real backend +
real-server e2e for new endpoints; one node per window; one writer per area per wave; agy
headless; no questions until told to stop.
