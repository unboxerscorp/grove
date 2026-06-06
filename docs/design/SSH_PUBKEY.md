# SSH Public Key Registration (G4)

Status: PROPOSAL — design-only. No code, no live changes. Pending grove-dev
lead review and explicit operator approval before any implementation. The
actual `authorized_keys` write described in "The Install Step" is a separate,
off-by-default capability that requires its own explicit operator approval to
build; it is intentionally NOT designed for autonomous execution.

This document proposes the SSH public-key registration path described in
`docs/canonical/GROVE_CANONICAL.md` §연결 (lines 110-114): a teammate generates
an SSH public key, submits it via the web UI or to chat-master, and — after an
operator-gated registration step on chopin — can connect over SSH through the
Tailscale tailnet.

## Goals

- Give a Tailscale teammate a clear, auditable path to register an SSH public
  key for `chopin-macmini` without the operator hand-editing files ad hoc.
- Two submission entrypoints, one queue: web UI submit and chat-master submit
  both land as the same **pending registration request** record.
- Keep the human operator the only authority that can cause a key to actually
  be installed. Nothing reaches `authorized_keys` without an explicit operator
  action.
- Reuse the existing auth, operator-gating, event-log, and ask-human/review
  surfaces rather than inventing parallel mechanisms.
- Ship the safe, useful part first (request + review + approval state, all pure
  metadata) and treat the OS-level install as a separately-gated follow-up.

## Current State (what already exists)

Grounding from the live bridge/web code so the proposal matches house patterns:

- **Tailnet is already first-class.** `web_app.py` detects the tailnet IPv4 via
  `tailscale ip -4` (`_detect_tailnet_ip`, `100.64.0.0/10` filter) and prints a
  "Team dashboard" URL. The web UI is intended to be reachable by tailnet
  members; SSH is the power-user alternative, not the only door.
- **Auth model.** `AuthMode.LOCAL_TOKEN` (operator on chopin via injected
  session token) vs `AuthMode.TEAM_COOKIE` (account-backed sessions, HttpOnly
  cookie, CSRF on state-change). See `docs/design/AUTH_AND_PROJECTS.md`.
- **Roles** (`team_auth.py`): `viewer | operator | admin`. `viewer` is
  read-only; `operator`/`admin` are privileged. `_require_operator_access`
  denies `viewer`.
- **Operator-gated mutation template.** `POST /api/share`
  (`_require_operator_state_change`) issues a one-time record from a store and
  returns it — the exact shape an approval action should take.
- **Pending→resolved record + event log.** `DecisionProposal` /
  `create_decision_proposal` (status `pending`, emits `decision.proposed` to the
  durable event log) is the pattern for a request that waits on a human.
- **Chat action gate.** `requires_master_chat_action_gate` forces operator role
  - an action-preview confirm for state-changing chat-master actions. The
    chat-master submission path mirrors this: classify → confirm fingerprint →
    create pending request; never auto-install.
- **Operator review surface.** The "사람의 판단이 필요" (ask-human) board section
  and `/api/decisions*` already model "items a human must resolve." Pending key
  requests slot into the same mental model.

## Scope and Non-Goals

In scope (this doc): the request → review → approval **state machine and
surfaces**, the data model, the API/UI proposal, the chat-master path, and
validation rules. All of it is metadata about keys; none of it installs a key.

Out of scope here, gated separately:

- The mechanism that actually writes a key into an OS `authorized_keys` file (or
  equivalent). Described below as a proposal only, off by default, requiring its
  own explicit operator approval before it is built.
- Tailscale ACL / device authorization changes, account provisioning, and any
  fleet/security config edits.

Hard boundary (non-negotiable for this worker): **0 `authorized_keys` writes, 0
automatic key installation, 0 security/org/services/fleet mutation, 0 live
changes, 0 code** until the design is approved and the install capability is
separately approved.

## Security Boundary and Threat Model

An SSH key grants shell access to the 24/7 host. That makes "what can install a
key" the entire ballgame. Design rules:

1. **Submission is not installation.** Any authenticated teammate may _submit_ a
   key. Submission only creates a `pending` request. No filesystem effect.
2. **Only the operator approves, and only the operator installs.** Approval is
   `operator`/`admin`-gated (`_require_operator_state_change` +
   `_require_operator_access`). The install step is operator-only and, in v1,
   not performed by the web service at all (see recommended approach A).
3. **Default deny on bind.** Submission/review endpoints follow existing
   allowed-origin + CSRF gates; they are usable on loopback and on an explicitly
   `--allow-host` tailnet bind only.
4. **Fingerprint pinning.** The fingerprint shown at submit time, echoed by
   chat-master, displayed at review, and (eventually) installed must be the same
   value end to end, so an operator approves exactly the bytes that were
   submitted. Approval records the fingerprint it approved.
5. **No silent broadening.** Reject keys that already exist, malformed keys, and
   unsupported types. Rate-limit submissions per member (mirror the join-code
   rate limiter).
6. **Auditability.** Every transition (submitted, approved, rejected, revoked,
   and — if ever built — installed) emits a durable event-log record with actor,
   fingerprint, and timestamp.

Threats explicitly addressed: a `viewer` escalating to shell (blocked by role
gate); a teammate self-approving (approval is a distinct operator action); a
substituted key between approve and install (fingerprint pinning); CSRF/cross
-origin submit (existing `_require_state_change` gates); request spam (rate
limit + dedupe).

## Registration Flow

```
 submit (web UI)  ┐
                  ├─► [pending request]  ──operator review──►  approve ─┐
 submit (chat)    ┘        (metadata only)        │                     │
                                                  └──► reject            │
                                                                        ▼
                                          [approved]  ──operator install step──►  [installed]
                                          (still NO authorized_keys write here;     (key usable
                                           install is a separate, gated action)      over SSH)
```

State machine for a request record:

`pending` → `approved` → `installed`
`pending` → `rejected`
`approved` | `installed` → `revoked`

Notes:

- `approved` means "operator has signed off on this exact fingerprint." It does
  NOT mean the key is on disk. In recommended approach A, the operator then runs
  the install manually and marks `installed`.
- `revoked` is a metadata state; actual removal from `authorized_keys` is, like
  install, an operator-controlled step (out of scope to automate here).

## Submission Entrypoints

### Web UI submit

A teammate opens a "Register SSH key" form, pastes their **public** key
(`ssh-ed25519 …` / `ssh-rsa …`), optionally a label. The client posts it; the
server validates, fingerprints, dedupes, and stores a `pending` request bound to
the submitting member. The UI shows the computed fingerprint and "waiting for
operator approval." No secret/private material is ever requested or accepted.

### chat-master submit

A teammate pastes their public key into Slack/web chat. chat-master classifies
it as a key-registration intent and — mirroring `requires_master_chat_action_
gate` — responds with a confirm preview: "Register this key? fingerprint
`SHA256:…`, type `ed25519`, for member X." On explicit confirmation it creates
the same `pending` request (same store, same fingerprint) and replies with the
request id. chat-master never installs and never approves; it only enqueues and
echoes the fingerprint for the human to verify. This reuses the canonical
chat-master rule that classification can only _propose_.

## Operator Review and Approval

Pending requests appear in an operator-only review surface alongside the
existing ask-human/decision board. For each request the operator sees: member,
key type, fingerprint, label, submitted-at, and source (web/chat). Operator
actions, all `_require_operator_state_change` + `_require_operator_access`:

- **Approve** → record moves to `approved`, stamps approver + approved-at +
  approved-fingerprint, emits `ssh_key.approved`. In approach A the response
  includes the exact, copy-pasteable install snippet (see below).
- **Reject** → `rejected`, optional reason, emits `ssh_key.rejected`.
- **Revoke** (on approved/installed) → `revoked`, emits `ssh_key.revoked`.

## The Install Step (gated, off-by-default, separately approved)

This is the only step that touches `authorized_keys`. It is described as a
proposal; **it is not designed for autonomous execution and must not be built
without separate explicit operator approval.** Three approaches:

**A. Manual operator install — RECOMMENDED for v1.**
The web service never writes `authorized_keys`. On approval it renders the
exact, fingerprint-pinned command/snippet for the operator to run in their own
shell on chopin (e.g. an append guarded by a "is this fingerprint already
present" check), then the operator marks the request `installed`. Pros: fully
honors the hard boundary; zero new write surface in a network-reachable service;
fastest to ship. Cons: a manual step per key.

**B. Operator-triggered server-side installer — future, separately approved.**
A narrowly-scoped, off-by-default module that, only when an operator
explicitly invokes it, performs an idempotent, fingerprint-pinned append with a
dry-run/preview default and full audit logging. Requires a config opt-in plus a
dedicated approval to build. Pros: one-click for the operator. Cons: introduces
a privileged write path reachable from the service; larger threat surface;
needs careful sandboxing of the target path and key bytes.

**C. Tailscale SSH / ACL model — strategic alternative.**
Avoid per-user OS `authorized_keys` entirely by leaning on Tailscale SSH
(tailnet ACL grants) so "registration" becomes a tailnet/ACL decision rather
than a file edit. Pros: no `authorized_keys` management at all; centralized,
revocable. Cons: diverges from the canonical "SSH Public Key 등록" wording; ACL
edits are themselves operator/security-config changes; depends on tailnet SSH
being enabled. Worth an explicit operator decision before A/B are built out.

Recommendation: build A's request/approval surfaces now (pure metadata, safe),
ship manual install for v1, and treat B as an opt-in convenience and C as a
strategic conversation — both pending operator direction.

## Data Model (proposed)

A new store record, illustrative shape (design artifact, not an implementation):

```
ssh_key_registration
  id                 string   (e.g. "sshkey_<token>")
  member_id          string   submitting member
  source             enum     web | chat
  key_type           enum     ed25519 | ecdsa | rsa   (allowlist)
  public_key         string   full single-line OpenSSH public key
  fingerprint        string   SHA256:… (canonical, recomputed server-side)
  label              string?  optional human label/comment
  status             enum     pending | approved | rejected | installed | revoked
  submitted_at       ts
  decided_by         string?  operator/admin member id
  decided_at         ts?
  approved_fp        string?  fingerprint pinned at approval time
  reason             string?  reject/revoke note
```

Only the **public** key is ever stored. No private material, no installed-key
mirroring beyond the public key the member supplied.

## API Surface (proposed)

All paths under the existing FastAPI app; gates named match live helpers.

| Method | Path                           | Gate                                                | Purpose                                           |
| ------ | ------------------------------ | --------------------------------------------------- | ------------------------------------------------- |
| POST   | `/api/ssh-keys`                | `_require_state_change` (any authed member)         | Submit a public key → `pending` request           |
| GET    | `/api/ssh-keys`                | `_require_auth`; member sees own, operator sees all | List requests                                     |
| GET    | `/api/ssh-keys/{id}`           | `_require_auth` (own or operator)                   | Request detail                                    |
| POST   | `/api/ssh-keys/{id}/approve`   | `_require_operator_state_change`                    | Approve (→ install snippet in A)                  |
| POST   | `/api/ssh-keys/{id}/reject`    | `_require_operator_state_change`                    | Reject                                            |
| POST   | `/api/ssh-keys/{id}/revoke`    | `_require_operator_state_change`                    | Revoke                                            |
| POST   | `/api/ssh-keys/{id}/installed` | `_require_operator_state_change`                    | (A) operator marks installed after manual install |

Illustrative submit request / response:

```
POST /api/ssh-keys
{ "public_key": "ssh-ed25519 AAAA… user@host", "label": "laptop" }

201
{ "id": "sshkey_…", "status": "pending",
  "fingerprint": "SHA256:…", "key_type": "ed25519" }
```

Server recomputes type + fingerprint from `public_key`; it does not trust
client-supplied type/fingerprint.

## UI Surface (proposed)

- **Member view:** a "SSH keys" panel — submit form (textarea + label),
  per-request status chips (`pending`/`approved`/`installed`/…), and the computed
  fingerprint. On `approved` (approach A) the member sees "approved — operator is
  installing."
- **Operator view:** a review list in the ask-human/decision area showing member,
  type, fingerprint, source, submitted-at, with Approve / Reject / Revoke. On
  approve, surface the copy-paste install snippet + a "mark installed" control.
- **chat-master:** confirm-preview message at submit; request-id ack; status is
  read back from the same store on request.

## Validation Rules

- Accept exactly one OpenSSH public key line; reject private keys outright
  (detect `BEGIN … PRIVATE KEY`) with a clear error.
- Type allowlist: `ed25519` (preferred), `ecdsa`, `rsa` (with a minimum bit
  length); reject `dss`/unknown.
- Recompute SHA256 fingerprint server-side; dedupe by fingerprint (reject if an
  active `pending`/`approved`/`installed` record already holds it).
- Per-member submission rate limit (reuse the join-code rate-limiter shape).
- Length/charset bounds on `public_key` and `label`.

## Open Decisions (operator's call)

1. **Install mechanism:** approach A (manual, recommended v1), B (gated
   server-side installer, later), or C (Tailscale SSH/ACL)? A is the only one
   buildable without a new privileged write path.
2. **Whose `authorized_keys`?** A single shared service account vs per-member OS
   users on chopin. Affects revocation and blast radius.
3. **Revocation semantics:** is `revoked` metadata-only (operator removes the
   line manually, like install) for v1?
4. **chat-master submit:** enable at launch, or web-UI-only first?
5. **Where exactly the operator-review panel lives:** fold into the existing
   ask-human/decision board, or a dedicated "Access" panel?

## Phased Plan

1. **Now:** this design → lead review → operator approval. (current step)
2. **Phase 1 (after approval):** build the request/review/approval **metadata**
   surfaces — store record, API endpoints, web UI, event-log transitions,
   validation. No `authorized_keys` write anywhere. Approval renders an install
   snippet; operator installs manually and marks `installed` (approach A).
3. **Phase 2 (separate explicit approval required):** evaluate approach B/C with
   the operator; only then design/build any server-side or ACL-based install.

## Test Strategy (when implemented)

- Unit: key parsing/validation, fingerprint computation, dedupe, type allowlist,
  private-key rejection, state-machine transitions, rate limiting.
- Auth: viewer cannot approve/reject/revoke; non-owner cannot read others'
  requests; CSRF/allowed-origin enforced on all state-change endpoints.
- Integration: web submit and chat submit converge on one record with identical
  fingerprint; approval emits the right event-log entries; no code path writes a
  filesystem `authorized_keys` in Phase 1.
- Verification gate: `pnpm check` (Prettier, ESLint, TS, Vitest, Ruff, mypy
  strict, pytest).

## Non-Goals

- Writing or editing any `authorized_keys` file in Phase 1.
- Automatic/unattended key installation in any phase.
- Tailscale device authorization, ACL edits, or account provisioning.
- Editing fleet/security configs (`fleet.yaml`, `grove.yaml`,
  `cockpit.grove.yaml`) or org/services state.
- Managing private keys or performing key generation on the user's behalf.
