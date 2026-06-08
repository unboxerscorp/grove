# Slack Bot List Permission / Tool Model — Design Review (review only, no code)

> Owner: chat-worker (review per grove-master + lead; **no implementation** — lead integrates).
> Operator premise: the Slack bot / chat runtime must manage human-facing lists well, but
> **unrestricted board-DB write is dangerous**. Invariant preserved throughout:
> **confirm-before-create / human-approval boundary** (CLAUDE.md: classification can only
> PROPOSE; create/mutation requires explicit human confirmation).

## 0. Scope of "lists"

Human-facing list items = board **tasks** + **TODO / feedback / ask-human** records. Wanted
capabilities: (a) **query** lists, (b) **create/classify** items, (c) optional **human comment**,
(d) **execute/submit** (handoff / state-transition) **only on explicit human confirm**.

## 1. Baseline (what exists today)

- **Read-only tool**: `get_project_tasks` (Gemini function-calling, redacted results [R],
  no-hallucinate defer). The runtime can already **query**.
- **Gated write path (the only write today)**: `SlackConfirmationStore` mints a one-shot
  `confirmation_id` (a token), posts a Block Kit confirm card
  (`_chat_bridge_runtime_task_preview` / `_preview_intake_task`); `create_task` fires **only**
  inside the confirm handler (`_handle_command_confirm` → `consume()` = one-shot). Web has a
  parallel confirm flow. ⇒ **today's confirm flow is already a one-shot capability-token gated write.**
- **Gap**: that gate covers **task-create only**. No gated path for classify / state-transition /
  todo·feedback·ask-human create / comment, and **no write tools** in the tool layer.

## 2. Capability tiers (the axis)

| Tier         | Bot capability                             | Write path                   |
| ------------ | ------------------------------------------ | ---------------------------- |
| T0 read      | query lists                                | none (read-only tools)       |
| T1 propose   | propose create/classify/transition/comment | none — structured proposal   |
| T2 stage     | hold a pending mutation (not applied)      | confirm-gated                |
| **T3 apply** | apply mutation                             | **human confirm event ONLY** |

Boundary: the bot owns **T0–T2** (query + propose + stage); **T3 (apply) is reachable only by a
human confirm**. The bot never holds T3.

## 3. Candidates

### A — Read-only tools + generalized confirm-action gate (extend today's flow) — RECOMMENDED

- Read-only tools per list type (`get_project_tasks` ✓, `get_todo_items`, `get_feedback`, `get_ask_human`).
- Any mutation = a **chat-master-authored structured proposal** → rendered into the existing
  `SlackConfirmationStore` confirm card; applied **only** on the human confirm (`consume()`,
  one-shot) via one **typed confirm-action dispatcher** (create_task | create_item | classify |
  transition | comment), each behind the same one-shot + role gate.
- **LLM-callable tools = read-only only. Writes are never tools** — they are proposals.
- Pros: reuses the proven one-shot gate + Block Kit; smallest new surface; zero LLM-initiated
  write; confirm-before-create automatic for **all** mutations. Cons: one click per mutation →
  mitigate with **batch-confirm** (one card covering N proposed items). **Risk: low.**

### B — Scoped write tools + allowlist (capability-scoped LLM tools)

- LLM gets WRITE tools (`create_item`, `classify_item`, `set_status`), each **allowlisted**
  (ops/fields/transitions + role). **B1 stage-only**: tools prepare a pending action, applied on
  confirm → collapses into A with more tool surface. **B2 apply-within-allowlist**: tools apply
  immediately inside the allowlist.
- Confirm boundary: B1 preserves it; **B2 weakens it** (LLM writes without human confirm).
- **Risk: medium–high (B2)** — an allowlist is a denylist-complement; misconfig or prompt-injection
  inside the allowlist still mutates state; self-applied LLM writes are harder to audit; crosses the
  operator's "no unrestricted write" line by degree. B1 ≈ A but every write tool is an LLM-reachable
  code path (larger attack surface).

### C — Web/API-mediated action tokens (capability tokens)

- Bot mints a **signed, scoped, single-use action token** (target list/item, fields/transition,
  proposing conversation, expiry, nonce). Bot has **zero** write capability — token is inert. Human
  **redeems** it (Slack button OR authenticated web/API call); bridge validates
  (signature/scope/expiry/one-shot) and applies.
- Pros: cleanest "bot has no write"; auditable/scoped/expiring tokens; uniform Slack + web; redeem
  can be a richer web UI. Cons: new token surface — **but that is exactly what
  `SlackConfirmationStore` already is**. ⇒ **C is A's model made explicit/cross-surface.**
  **Risk: low–medium** (strong if signing/scope/one-shot hardened vs replay + scope-escalation).

## 4. Recommendation

**Candidate A — recognizing A == C realized on the existing `SlackConfirmationStore`.**
Generalize today's one-shot confirm flow into a **typed confirm-action gate** covering
create / classify / state-transition / comment for all list types; keep the LLM tool set
**read-only (query only)**; represent every mutation as a chat-master-authored proposal that is
**inert until the human confirms**; add **batch-confirm** for triage ergonomics. **Reject B2**
(allowlist immediate-write) — it crosses the operator's "no unrestricted write" line.

**Tool / permission model:**

- LLM-callable tools = **read-only only** (`get_*` per list). Writes are **never** tools.
- Mutation = structured proposal → one-shot, **role-gated**, **scope-exact** confirm-action → one
  store write. **Apply ignores LLM text at apply time** — it applies the _stored_ proposed fields
  verbatim (no re-interpretation).
- Authorization: confirm restricted to operator/admin (reuse the existing actor-role gate).
  Optional human comment = a field on the proposal, persisted on apply (no separate write path).

**Confirm boundary (preserved):** bot = query + propose + stage; **apply = human confirm only**,
one-shot, role-gated, scope-exact.

## 5. Risks (cross-cutting) + mitigations

- Wrong/malicious LLM proposal → human reviews card pre-confirm + apply uses stored fields (no LLM
  at apply) + scope-exact target pinning.
- Replay / double-apply → one-shot `consume()` (existing).
- Authorization bypass → role gate on confirm; token/confirm bound to actor + conversation.
- Secret/PII leakage → existing [R] redaction on tool results + card text.
- Scope escalation (confirm/token for X mutates Y) → proposal pins target id + op; validate at apply.
- Bulk fatigue → batch-confirm; never auto-apply to "solve" fatigue.

## 6. Minimal tests (for the eventual implementation slice — not now)

1. read-only tool returns list data; no write. 2. proposal posts a confirm card; DB unchanged.
2. human confirm → exactly the proposed mutation applied (1 item) + audit event.
3. no-confirm / expired / duplicate confirm → no write / no double-write.
4. unauthorized actor confirm → denied, no write. 6. apply uses stored fields (LLM text ignored).
5. batch-confirm → N items on one confirm. 8. [R] redaction on tool results + card.

## 7. Suggested phasing (if accepted)

1. Read-only list tools beyond tasks (todo/feedback/ask-human) — pure additive, low risk.
2. Generalize the confirm-action gate to typed actions (classify / transition / comment) reusing
   `SlackConfirmationStore` one-shot + role gate. 3. Batch-confirm. 4. (Optional) explicit signed
   action tokens (C) only if a non-Slack redeem surface is needed. Each behind the existing flag,
   confirm-before-create unchanged.
