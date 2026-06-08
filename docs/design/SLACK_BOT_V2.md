# Slack Bot V2 — LLM-first board tool agent (operator override)

Replace the propose-only + Block-Kit-button-confirm flow with an always-on LLM agent
that reads and mutates the board. **No regex / classifier / intent rule tree.** Build
implementation-first; smoke/minimal tests only (operator tests directly).

## Runtime

Slack event → bridge agent loop (existing `chat_bridge_runtime` + provider
function-calling) → the LLM sees the conversation **and the current board state** →
decides tool calls → natural answer. The bridge holds only transport / permission /
rate-limit — **zero intent rules**.

## Tools (function-calling)

- **READ** (must be used for any state claim — no hallucination): `get_project_tasks`
  (have), `get_task`, `list_tasks(filters)`, `get_org` / node status.
- **WRITE** (each routed through the `chat_actions` dispatcher = role-gate / scope-exact
  / CAS / `[R]` / audit / idempotency): `create`, `update`, `assign`, `comment`,
  `transition`, `dispatch`. The dispatcher (`apply_chat_confirm_action`) is the safety
  boundary — the LLM can only make bounded, audited writes; stored fields are applied
  verbatim (no unvalidated LLM text into the DB).

## Write policy — LLM-judged, NOT rules

- **Explicit operator request → execute the write tool directly** (no button, no forced
  preview).
- **Ambiguous or risky → the LLM asks / confirms in natural text** (plain-text confirm
  supported; Block-Kit button only optional for genuinely risky ops).
- The persona (chat-master) judges execute-vs-confirm; the bridge enforces the boundary.

## Safety

Tool boundary + role gate + audit + idempotency + `[R]`. No intent rule tree. No
unvalidated LLM text → DB.

## Reuse / migration

Builds on `chat_actions.py` (write safety), `get_project_tasks` (read), the provider
function-calling loop, `chat_bridge_runtime` (agent loop). The propose-only path +
`chat_create_staged` dark flag are superseded. Gated by `chat_bridge_runtime`; the
chat-master persona stopgap (no-re-propose, ack-and-drop) is the interim until V2 lands.

## Owners

- **lead** = integration owner (review/commit/deploy).
- **chat-master** = agent semantics / persona / write-policy judgment / Slack UX / tool-use
  instructions.
- **chat-worker** = bridge tool runtime: board read/write tools + the agent loop + board-
  state context + dispatcher wiring.

## First slices

1. chat-worker: board READ tools + pass board state into the loop (answers come from real
   data). chat-master: persona tool-use + write-policy semantics.
2. chat-worker: WRITE tools via the dispatcher (create/update/assign/comment/transition/
   dispatch). chat-master: execute-vs-confirm judgment + natural confirm.
3. Plain-text confirm via LLM judgment (markers); retire the button-only path.
