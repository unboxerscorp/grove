# Chat-Master Intake Re-Target — Design Proposal

> **⛔ SUPERSEDED by `CHAT_BRIDGE_CHATBOT_RUNTIME.md` (operator: bridge-native, not CLI retarget).**
> The web/slack → chat-master **CLI retarget** and the `_routes_to_live_master` **predicate** approach
> are abandoned per grove-master/operator (GROVE_CANONICAL.md updated to bridge-native chatbot runtime).
> **Do not implement anything from this doc.** Kept for historical context only; the expression-principle
> and confirm-before-create guards carry forward into the new doc.

> **Status: DESIGN-FIRST proposal (chat-worker).** No code edited. `slack.py`/`web_app.py`
> edits are HELD per lead (board-worker active in `web_app.py`; grove-master stabilizing
> `slack.py`). Flow: this doc → lead review → advisor consult → master deploy approval.
> Owner split: run-loop/env = master/operator-applied; bridge code (`assistant.py` predicate,
> `slack.py` expression, `web_app.py` target) = chat-worker, behind lead review, after the
> board-worker window + slack stabilization. Semantics co-owned with chat-master.

## 1. Goal

External chat (Slack threads + web chat) must be **received first by `chat-master`** (canonical),
not `grove-master` directly. All **user-facing expression** must be **chat-master-generated** — no
hardcoded bridge templates shown to users. Preserve guards: `slack_chat_queue` durability,
immediate ack, per-thread isolation, confirm-before-task-create, socket watchdog.

## 1a. HARD REQUIREMENT (grove-master/operator mandate — binding on design + impl)

1. **All** Slack/Web user-facing chat responses **must** be chat-master-generated expression.
2. **No** connector/bridge/worker arbitrary template auto-response is exposed to users — fixed
   ack / busy / timeout / fallback strings ("접수했습니다 / 처리 중 / 대기열 / 전달 실패 / 재시도 중")
   are **forbidden when user-facing**.
3. The connector does **transport / queue / mention-detection / thread-separation only**;
   the only user-facing text it posts is a chat-master turn result.
4. Task creation happens **only** after chat-master judgment **+** explicit confirm flow —
   never from deterministic classification or a template alone.
5. Existing slack templates (ack / busy / timeout / fallback) are **removed or internal-log-only**.

This mandate governs both the re-target (below) and the queued **G2 hardening**: see §6 + §6a
for how chat-master authorship reconciles with the deterministic G2 foundation (364b6df).

## 2. Verified current state (read-only)

| Surface   | Live target today   | Mechanism                                                                                                                                                                                                               | Re-target status                                                                |
| --------- | ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| **Slack** | **chat-master ✅**  | `~/.grove/dev10/run-slack-loop.sh` → `grove-slack --default-node chat-master --route-chat-to-node`; `_select_chat_node` → `ChatRouteConfig.default_node` (slack.py:3084); worker `chat_facade.send(node="chat-master")` | **DONE** (grove-master applied run-loop). Routing already lands on chat-master. |
| **Web**   | **grove-master ❌** | `_assistant_client` (web_app.py:6120) → `create_default_assistant_client()` → `NodeRoutedAssistantClient(node_name = GROVE_ASSISTANT_NODE or NODE_ROUTED_ASSISTANT_NAME="grove-master")` (assistant.py:40,337,912)      | **TODO** — still grove-master.                                                  |

So the remaining work is: **(W) web target re-target**, **(E) expression principle** (both surfaces),
**(A) immediate-ack composition**, **(C) confirm-card-from-chat-master**.

## 3. (W) Web re-target — mechanism + a blocking side-effect

**Mechanism options:**

- **W1 (config, mirrors Slack):** set `GROVE_ASSISTANT_NODE=chat-master` in the web service
  run-loop/env. Operator/master-owned (like the slack `--default-node` change). No web_app.py code.
- **W2 (code):** construct the web assistant client with `node_name="chat-master"` explicitly in
  web_app.py. chat-worker-owned, behind review, after board-worker window.

**⚠ Blocking side-effect (must fix regardless of W1/W2):** `_routes_to_live_master(client)`
(assistant.py:915) returns True **iff `node_name == "grove-master"`**. Re-targeting to chat-master
makes it return **False**, which **un-dormants** the `AssistantBroker.handle_turn` action branch
(`if _is_action_handoff_request(...) and not _routes_to_live_master(...)` → `_action_preview_response`
→ decision-proposal path). That is an unintended behavior change: web chat would start emitting
action previews/decision proposals instead of forwarding to the node.

**Fix (assistant.py, behind review):** generalize the predicate to treat the **configured assistant
node** as the live route (recognize chat-master and grove-master), e.g. compare against the live
node-routed target set rather than the hardcoded constant. This keeps the action-gate **dormant**
after the re-target, preserving current behavior. Add a regression test: web client targeting
chat-master → `_routes_to_live_master` True → action branch stays dormant.

**Recommendation:** W1 (env re-target, operator-applied) **+** the assistant.py predicate
generalization (chat-worker, behind review). W1 alone is unsafe without the predicate fix.

## 4. (E) Expression principle — remove hardcoded user-facing templates

User-facing text must come from chat-master. Today the bridge posts hardcoded templates to users.
Inventory (slack.py):

- `_slack_node_chat_working_notice(node)` — posted as the **immediate ack** in `_handle_chat` (~2255).
- `_slack_node_chat_busy_notice` / `_slack_node_chat_timeout_notice` — `_post_node_chat_busy/timeout_notice`.
- `ASSISTANT_TRANSPORT_FALLBACK_TEXT` — used at slack.py:1543, 2004, 2155 (assistant/worker fallback).

**Design:** demote all of these from **user-facing** to **ops-log-only** (LOGGER) or non-exposed.
The **first user-facing reply** is chat-master-generated (the worker already routes the turn to
chat-master via `chat_facade.send` and posts chat-master's response). On busy/timeout/transport
failure, do **not** post a templated sentence; either stay silent (the durable queue retries and
chat-master eventually answers) or post a **chat-master-authored** short status if one is needed.
(Implementation in slack.py is HELD until grove-master stabilizes the file.)

## 5. (A) Immediate-ack composition (canonical) without templates

Immediate ack is a canonical feature but must not be a hardcoded user-facing sentence.

- **A1 (recommended, Slack):** ack with a **non-textual reaction** (e.g. 👀) on the user's message —
  immediate, non-blocking, not a template sentence. Requires adding a `reactions_add` method to the
  slack client (slack.py, deferred). The first **textual** reply is chat-master's.
- **A2 (fallback):** no textual ack; rely on the fast durable-queue worker delivering chat-master's
  first reply quickly. Safe if reaction support is unavailable.
- **Web:** ack = the synchronous HTTP reply, which is already chat-master's generated answer — no
  template needed. On unavailability return 204/503 (no user-facing template sentence).

Ack stays in the **socket handler / enqueue path** (fast, non-blocking) — watchdog/heartbeat
unaffected; only the _content_ of the ack changes (reaction vs. template sentence).

## 6. (C) Confirm-card authored by chat-master

The Block Kit confirm proposal (title/body/fields + card text) should be **chat-master's generated
proposal**, not the bridge's static `_preview_intake_task` string ("preview: create … confirm <id>").
Design: the proposal content (title/body/labels) originates from chat-master's decision; the bridge
renders it into the existing confirm/`SlackConfirmationStore` + Block Kit machinery and keeps the
**confirm-gates-creation** invariant (creation only on the confirm event). This composes with the
G2 foundation (364b6df) — chat-master supplies the proposal semantics; the bridge supplies the
gated confirm/create plumbing. (Ties into the queued G2 hardening: Caveat-1/2 + threshold 0.8.)

## 6a. Reconciling the HARD REQUIREMENT with the G2 foundation (364b6df)

364b6df currently has the **bridge** both classify (`classify_for_task`) **and** author the
user-facing preview text (`_preview_intake_task`: "preview: create … confirm <id>"). Rules #1/#3/#4
forbid bridge-authored user-facing text and bridge-only task judgment. Reconciled model:

- The worker already routes **every** chat turn to chat-master (`chat_facade.send(node="chat-master")`)
  — that **is** the chat-master turn and the source of all user-facing text.
- chat-master returns a **structured turn result** = either **answer** (post chat-master text as-is)
  or **task proposal** (chat-master's judgment + proposal fields + **chat-master-authored card text**).
  The bridge renders that into the existing confirm / `SlackConfirmationStore` / Block Kit plumbing
  and keeps confirm-gates-creation. No bridge template is ever shown.
- Deterministic `classify_for_task` is demoted to an **internal, non-user-facing pre-filter** at most
  (e.g. to decide whether to ask chat-master for a structured proposal) and **never** authors
  user-facing text nor alone gates creation (rule #4). It may also simply be removed if chat-master's
  turn result carries the judgment.

**Open structural question (needs lead + chat-master):** `chat_facade.send(...) -> str` returns a
plain string. To carry a _structured_ proposal (answer vs. task + fields + card text) we need either
(i) chat-master emits a parseable structured marker in its reply that the bridge parses, or
(ii) a structured turn interface (the web path already returns a typed `MasterChatResponse` via the
broker; the slack node-routed path returns raw text). Choosing (i) vs (ii) is the key decision for
implementing the hard requirement on the Slack node-routed path.

## 7. Guard preservation (unchanged by re-target)

- `slack_chat_queue` durability + idempotency: routing target change only; enqueue/worker/retry
  lifecycle untouched.
- Immediate ack: preserved (content changes per §5; timing/placement unchanged).
- Per-thread isolation: `slack_threads` / `conversation_id` keys unchanged.
- Confirm-before-create: unchanged (G2 foundation; creation only on confirm event).
- Socket watchdog / reconnect / self-exit: untouched (no new blocking in the socket handler).

## 8. Safe handoff / rollout / rollback

- Slack: already live on chat-master; rollback = revert run-loop `--default-node` (master-owned).
- Web: stage via `GROVE_ASSISTANT_NODE=chat-master` once the predicate fix lands; rollback = unset env.
- Predicate + expression changes land behind lead review + targeted tests; deploy via master approval.
- No live route breaks before verification: web re-target gated on the predicate fix being merged.

## 9. Ownership & sequencing

1. assistant.py `_routes_to_live_master` generalization + test — chat-worker, behind review (no
   file-collision; assistant.py is not board-worker's). ← **safe to start first when lead opens window.**
2. Web env re-target `GROVE_ASSISTANT_NODE=chat-master` — operator/master-applied (config), after #1.
3. slack.py expression demotion + reaction-ack — chat-worker, **after grove-master stabilizes slack.py**.
4. web_app.py target/confirm-card wiring (if W2) — chat-worker, **after board-worker window opens**.
5. G2 hardening (Caveat-1/2 + 0.8) — queued; flip-gate = caveats green + lead review + master deploy.

## 10. Open items (co-own with chat-master)

- Confirm-card text format + which fields chat-master authors vs. bridge defaults.
- Reaction-ack emoji + whether reactions_add is acceptable to add to the slack client.
- Whether web should also adopt the durable-queue (separate slice; out of scope here).
