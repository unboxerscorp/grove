# CHAT MASTER

Status: first-pass design (grove-dev, canonical Gap B). **Design only — no
routing/behavior change is implemented from this doc.** Implementation is
bounded, approval-gated, and re-consulted with advisor before any code that
touches the live Slack route or board writes.

Read alongside [MASTER_NODE.md](./MASTER_NODE.md), which records the current live
decision that Slack and web chat route to the live `grove-master` node and the
bridge owns the edge (auth, context, redaction, queue, confirmation, audit).

## Canonical Intent vs Live Model

The canonical "What is GROVE?" doc describes a **CHAT MASTER** that owns external
communication (Slack threads + web chat sessions), manages each as an independent
queue, immediately acks, eventually answers the originating thread/session, and
decides whether an input is chit-chat (answer directly) or a new task (create a
task and hand it to the MASTER NODE). In the canonical org it is drawn as a node:
`grove-master → chat-master → grove-dev / projects…`.

The live model (MASTER_NODE.md) deliberately **collapsed** that scaffold: Slack
and web chat route to `grove-master`, and the **bridge connector** is the edge
owner. Most CHAT MASTER responsibilities already exist there:

| Canonical CHAT MASTER responsibility        | Current implementation                                                                                                             | State                                            |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| Receive Slack mention, immediate ack        | `slack.py:handle_event` → `_handle_chat` posts ack                                                                                 | ✅                                               |
| Independent per-thread/session queue        | `slack_chat_queue` keyed by `(team,channel,message_ts)`; `slack_threads` by `(team,channel,thread_ts,mode)`; web `conversation_id` | ✅                                               |
| Async worker, retry, idempotent answer-back | `poll_node_chat_queue` → `_process_node_chat_queue_item` (busy/timeout retry, `response_text` cache, chunked thread delivery)      | ✅                                               |
| Route to master, eventual answer            | worker → `chat_facade.send` / `AssistantBroker.handle_turn`; answer posted to origin thread/session                                | ✅                                               |
| Decide chit-chat vs new task                | `classify_master_message` (master.py) + `AssistantBroker` preview/answer                                                           | ⚠️ classifies, but free-chat → task is not wired |
| Create task from chat + confirm             | Block Kit confirm + `create_task` exists **only for slash commands** (`/bug`,`/feedback`,`/task`); not from free chat              | ❌ gap                                           |
| Web chat history                            | `/api/master/chat` GET returns `{"messages": []}` stub                                                                             | ❌ stub                                          |
| No one-node-per-thread explosion            | shared queue/broker keyed by thread; no node spawned per thread                                                                    | ✅                                               |

**Conclusion:** the canonical CHAT MASTER is ~80% realized as the _bridge edge +
grove-master_ function. The real gaps are (1) free-chat → task intake with
confirmation, and (2) web-chat durable-queue parity + history.

## Design Decision (operator's call) — node vs function

Two ways to satisfy "CHAT MASTER":

- **(A) Function, no new node (recommended).** Treat the bridge connector as the
  CHAT MASTER edge and grove-master as the interpreter; close the gaps above
  in-place. Aligns with MASTER_NODE.md's superseding decision and master's
  "avoid a new persistent node," and changes no org topology. Lowest risk.
- **(B) Distinct chat-master node.** Add a visible `chat-master` node between the
  external surfaces and `grove-master`, matching the canonical org literally.
  Contradicts the live superseding decision, adds a persistent node, and is an
  org change — **operator-owned, explicit approval required, not recommended for
  first pass.**

This doc designs for **(A)**. Choosing (B) is an operator decision; flag before
any node creation.

**Decision (2026-06, grove-master/operator): Model A** — realize CHAT MASTER as
the bridge-edge function + grove-master, no new persistent `chat-master` node. A
distinct chat-master node and the B-impl route changes remain approval-gated.

## First-Pass Target (function model)

Close the two gaps without changing the existing route:

1. **Free-chat task intake.** When the worker's classification marks a turn as a
   probable new task (not chit-chat), it produces a **task proposal** and uses
   the existing `SlackConfirmationStore` + Block Kit confirm flow (the same one
   slash commands use) to ask the user to confirm before any task is created.
   Web chat surfaces the same proposal via `/api/master/chat` →
   `/api/master/chat/confirm` (already present for brokered actions).
2. **Web-chat queue parity (smaller).** Decide explicitly whether floating web
   chat gets `slack_chat_queue`-style durability or stays live request/reply;
   implement history beyond the stub only if the operator wants it.

## Design Guards (advisor — bake into implementation)

1. **Zero double-routing.** A chat message takes exactly one path:
   chit-chat → existing master route, **or** task-detected → Block Kit confirm →
   task. Mutually exclusive and explicitly composed; one message must never be
   both answered and turned into a task. The Block Kit confirm is the gate that
   keeps task creation human-approved (no silent auto-create).
2. **Preserve `slack_chat_queue` idempotency.** The new task path must keep the
   existing idempotency key `(team, channel, thread_ts/message_ts)` + the
   `response_text` cache + no-drop semantics. No double-enqueue; add idempotency
   tests covering the task path.
3. **Detection/creation runs in the ASYNC WORKER, never the socket handler.**
   Keep the socket heartbeat / wedge-watchdog decoupled — no blocking
   classification or board write inside the Slack socket event handler. This
   preserves the socket-reconnect/self-exit watchdog behavior.
4. **Board-write scope + ownership.** Tasks created from chat are written to the
   correct project/board scope (dev10 by default), respect human-facing item
   ownership conventions, and preserve per-thread/session isolation (the
   originating thread is linked to the created task, mode `task`).

## Next Implementation Steps (when approved)

Bounded, approval-gated, re-consult advisor first. Likely surfaces:

- `bridge/.../assistant.py` — a `classify_for_task` that turns a master
  classification into an optional task proposal (no side effects).
- `bridge/.../slack.py` — in the async worker (not the handler), when a proposal
  exists, create a pending confirmation (reuse `SlackConfirmationStore`) and post
  the Block Kit preview; on confirm, `create_task` + `upsert_slack_thread(mode=
"task")`.
- `bridge/.../web_app.py` — render the proposal through the existing
  `/api/master/chat` + confirm endpoints; decide web-chat queue parity/history.
- Heavy tests: idempotency on the task path, single-path (no double-routing),
  worker-not-handler placement, per-thread isolation, board scope, redaction.

## Non-Goals (first pass)

- No change to the live Slack/web → grove-master route.
- No new persistent `chat-master` node unless the operator explicitly chooses
  model (B).
- No silent/auto task creation — always behind Block Kit / web confirm.
- No blocking work in the Slack socket handler.
