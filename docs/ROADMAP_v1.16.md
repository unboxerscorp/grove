# grove v1.16 — Roadmap

> Status: historical v1 roadmap; superseded by the current v2 live cockpit model documented in `docs/design/MASTER_NODE.md` and `docs/agents/LEAD-HANDOFF.md`.
> Design: `docs/V1_16_BRAINSTORM.md`. v1.16 = **see many rooms in one view** — a signed,
> read-only, privacy-first summary a grove can export, and an aggregator that consumes several
> into one view with trust + freshness badges.

## Theme

Through v1.15 grove is a single room. v1.16 lets you watch several rooms at once — but
read-only and privacy-first: each grove exports a **signed summary** (board/node counts, status
rollups — no secrets, no PII, no transcript content), and an aggregator verifies the signature
(**trust**) and timestamp (**freshness**) before showing it. No control crosses machines this
version (no remote approve/abort/kill); aggregation is observation only. Default OFF.

## Non-negotiable invariants

1. **Privacy-first summary** — the exported summary contains only counts/status/rollups that
   pass an explicit allowlist; never secrets, tokens, paths, member PII, task bodies, or
   transcript content.
2. **Signed + verified** — a summary is signed; the aggregator rejects an unverifiable or
   tampered summary (trust badge reflects verification state).
3. **Freshness** — every summary carries a timestamp; the aggregator shows a freshness badge and
   marks stale data, never presenting old data as live.
4. **Read-only / no cross-machine control** — aggregation observes; no approve/abort/kill or any
   mutation crosses machines this version.
5. **Default OFF + scoped** — export and aggregation are opt-in, token-gated, and project-scoped.

## Exit criteria

1. Signed summary export: a read-only, privacy-allowlisted, signed summary endpoint (default
   OFF, token-gated); no secret/PII/transcript leak (adversarially checked).
2. Aggregation: an endpoint/view consumes multiple summaries, verifies signature (trust) +
   timestamp (freshness), and presents a combined read-only view; tampered/stale handled.
3. Zero open P0/P1 from a v1.16 review (privacy leak, signature bypass, stale-as-live);
   coverage ≥80%; full check + web e2e green (new endpoints covered by real-server api.mjs);
   CHANGELOG + 0.17.0.

## Workstreams

- **V16-W1 signed summary + aggregation backend** (bridge) — privacy-allowlisted summary export
  - signature (sign/verify) + freshness; aggregation endpoint that verifies and combines.
    Default OFF, token-gated, adversarially tested (privacy leak, tamper, stale).
- **V16-W2 brainstorm → v1.17** (grove-arch) — cross-room handoff contract, retro analytics,
  trend reporting, notification routing v2.
- **Wave-2** — FE aggregation view (trust/freshness badges, read-only) + real-server e2e for the
  new endpoints, once W1 lands.

## Conventions

Unchanged + privacy-first: read-only / no cross-machine control this version; privacy allowlist
(never secrets/PII/transcript); signed + freshness-stamped; default OFF + token-gated + scoped;
maker/review/test nodes code; lead orchestrates/verifies/commits (no push); pnpm check + an
adversarial reviewer GO (privacy/signature is safety-sensitive); mock mirrors real backend +
real-server e2e for new endpoints; one node per window; one writer per area per wave; agy
headless; no questions until told to stop.
