# Bridge-Native Chatbot Runtime + Durable Sessions (Stage0 Design)

> **External chat hot path must not call any persistent CLI node. It uses a bridge-native
> chatbot runtime with durable per-thread/per-conversation sessions.**

> **Status: DESIGN-FIRST (chat-worker, owner). Adopted per grove-master/operator decision; GROVE_CANONICAL.md
> updated to bridge-native chatbot runtime is the standard.** Stage0 = **behind-flag / inert** (default OFF,
> zero live behavior change, existing route untouched). Stage0 code lands after lead review + window. Live
> flip / canary / cutover = separate master/operator approval. No org change (no node-per-thread). Persona /
> policy / user-facing wording co-owned with chat-master (semantic owner). Supersedes `CHAT_MASTER_INTAKE_RETARGET.md`
> (CLI-retarget + predicate — abandoned). MVP provider is Gemini, configured from Setup via `chat-provider.json`.

## 1. Problem

Today every external chat turn is answered on a **synchronous, persistent-CLI-node hot path**: the bridge shells
out to the chat-master tmux pane one turn at a time (`chat_facade.send(node="chat-master", …)` for Slack;
`NodeRoutedAssistantClient.complete` CLI `ask` for web). That single pane serializes all Slack threads + web
conversations, couples availability/latency to one pane, and provides no first-class per-conversation session.
The operator decision: replace the CLI hot path with a **bridge-native chatbot runtime** that generates answers
through a bridge-owned provider adapter, with durable per-conversation sessions and a bounded async worker pool.
For the current MVP this adapter is Gemini (`gemini-2.5-flash` by default), configured by the operator in Setup.

## 2. Current state (verified)

- Slack (live, `--route-chat-to-node`, default node `chat-master`): `_handle_chat` enqueues `slack_chat_queue`
  (key `(team,channel,thread_ts,message_ts)`) + posts ack; a **single daemon thread** `node_chat_queue_thread`
  → `poll_node_chat_queue` → `_process_node_chat_queue_item` → `chat_facade.send` (synchronous CLI to the pane).
  Retry/idempotency via `mark_slack_chat_message_running` / `store_slack_chat_message_response` (response_text
  cache) / `defer` / `fail` / `complete`.
- Web: `POST /api/master/chat` → `AssistantBroker.handle_turn` → `NodeRoutedAssistantClient.complete` (sync CLI).
  History persisted (G5) via `append_master_chat_message` / `list_master_chat_messages`.
- The bridge now has a **direct Gemini provider** path: `GeminiChatProviderAdapter` (chat_runtime.py) calls
  Gemini's REST API over HTTP. The runtime formalizes and replaces the CLI path with a bridge-native adapter.

## 3. Adopted architecture (Stage0 introduces, inert behind flag)

### (1) Unified `ChatSession` model (Slack + Web)

`conversation_id` = a Slack thread `(team,channel,thread_ts)` or a web `conversation_id`, treated as one
first-class **durable chat session**. DB-backed state per session: transcript + pending confirm + mode.
Reuse G5 `master_chat_messages` for the transcript (extend to the Slack surface) and `slack_threads` for
mode/linkage. New `chat_sessions(conversation_id, surface, status, created_at, last_active_at)` ties it together.

### (2) Chatbot provider adapter / LLM call path (NO CLI pane buffer)

A **dedicated bridge-native provider adapter** generates each turn by calling the configured chatbot provider
directly — **never** the persistent CLI node and **never** the `AssistantBroker` node-routed client. (chat-master
node is the persona/policy/semantic _source_, not a runtime backend.)

- MVP provider: Gemini via `GeminiChatProviderAdapter`, configured from Setup (`/api/chat/provider`) and stored in
  the master session at `~/.grove/dev10/chat-provider.json` so every selected project uses the same chat runtime
  key.
- Default model: `gemini-2.5-flash` unless the operator changes it in Setup.
- Persona/policy = system prompt (from chat-master); context = bounded, redacted session transcript + facts.
- The adapter emits a **structured turn result** (answer | task-proposal + fields + chat-master-authored card text).

### (3) Bounded async worker pool + per-session FIFO

Bridge-side pool of N workers (configurable, small default). **Intra-session FIFO** via a per-session lease
(one in-flight worker per session → ordering); **inter-session bounded concurrency** (≤ N concurrent sessions).
Replaces the single daemon thread. Reuses `slack_chat_queue` durability/idempotency (`mark_running` +
`running_stale_before` lease reclaim + `response_text` cache + `complete/defer/fail`); web gains queue parity.

### (4) No-template user-facing guarantee

**User-facing chat answer = ONLY a successful chatbot generation.** The bridge never posts a hardcoded template
as a chat answer (working/busy/timeout/fallback strings are removed or internal-log-only). System
**ack / reaction / progress** is distinct from the chat answer and minimal (e.g. 👀 reaction, best-effort).

> **Scope boundary (chat-master, semantic owner):** the no-template rule governs the **free-chat ANSWER channel**
> only — a free-turn answer is _always_ LLM-generated. The **confirm-flow** surfaces (proposal card, created-result,
> answer-only result, expired/owner, 👀 ack) are **chat-master-authored structured interaction copy**, not "chat
> answers" — fixed strings there are correct and **not** subject to the no-template rule. See §7.

### (5) Confirm-before-create only

Detection/proposal creates nothing. `create_task` fires **only** on the explicit confirm event (reuse
`SlackConfirmationStore` / web confirm), keyed by `conversation_id`. The confirm card text/judgment is authored by
chat-master (§7 copy); the bridge supplies structure/fields/validation/defaults + the gated create plumbing.

### (6) Stage0 safety

Feature flag `chat_bridge_runtime` (default **OFF**, stored on the master/dev10 board and shared across projects),
a kill-switch, and metrics. **`gui_features.intake` stays `false`** (intake DARK) throughout. New components are
constructed **only when the flag is on**; with the flag off, the existing Slack daemon / web request path is
**unchanged and the live route is not touched**. DB schema additions are **additive** (new tables/columns; no
migration of live data, no change to existing reads).

### (7) chat-master node = presence/policy/audit/semantic owner

Not a hot-path processor. It owns persona, policy, audit, operator dialogue, and the user-facing semantics
(wording, the chit-chat-vs-task judgment encoded into the persona/contract). The bridge runtime executes turns.

## 4. Failure handling & SAFE FALLBACK (no fabricated answers)

On provider error, parse failure, or any turn-processing exception, the bridge **must not fabricate a user-facing
chat answer or post a template.** Instead it either:

- **defers** the queue item for durable retry (reuse `slack_chat_queue` defer/`next_attempt_at`), or
- surfaces an **explicit non-chat system status / transport error** (internal log + optional out-of-band system
  notice that is clearly _not_ a chat answer).

The only text posted as a chat answer is a **successful** chatbot generation. This absorbs **G2 Caveat-2**
(detector/turn exception) at the pool level: an exception never breaks the worker/pool, never drops the turn, and
never yields a fabricated answer — it leaves the queue retryable. **G2 Caveat-1**: the deterministic task
pre-filter (`classify_for_task`) stays zero-I/O and is an internal pre-filter only (never authors user-facing
text, never alone creates a task). Caveat-1/2 green remains the precondition before intake is re-enabled.

## 5. Concurrency, ordering, idempotency

Intra-session FIFO (single lease per session); inter-session bounded concurrency (≤ N); at-least-once +
idempotent answer-back via the existing `response_text` cache + `complete/defer/fail`; queue keys unchanged;
backpressure via the durable queue; crash recovery via `running_stale_before` lease reclaim.

## 6. Stage0 scope & rollout

- Land `ChatSessionStore`, `ChatWorkerPool`, the provider adapter, and the unified queue **inert** behind the
  flag. Flag OFF → existing behavior, **0 live impact, existing route untouched**.
- Metrics: per-session queue depth, worker utilization, turn latency, generation success/failure counts,
  defer/retry counts, confirm rate, ack latency.
- Rollout (flag-gated): **shadow → canary → cutover** (detailed in §6a). **Rollback = flag OFF** (instant;
  schema is additive so no data migration). chat-master pane remains as presence throughout.

## 6a. Implementation-plan completion criteria (advisor guard — required for Stage0 plan sign-off)

1. **Flag-gated rollout: shadow → canary → cutover.**
   - **Shadow:** flag on in shadow mode — the runtime processes turns and generates answers but **does not post
     them to the user**; output is logged/compared against the live CLI path (correctness + latency + saturation
     baseline). Zero user-facing change. The live route still serves users.
   - **Canary:** flag on for a single test thread/conversation (approval + metrics watch) — the runtime serves
     real user-facing answers for that one session only; everything else stays on the live path.
   - **Cutover:** flag on for all external chat (separate master/operator approval), live route retired only after
     the canary metrics clear. Each stage is independently gated; **rollback = flag OFF** at any stage (instant).
2. **Kill-switch (first-class).** A single runtime kill-switch (flag/GUI) that, when tripped, immediately stops the
   bridge-native runtime from serving and reverts to the prior live path (or to defer/system-status if mid-cutover)
   — no restart required, no user-facing template. Distinct from the rollout flag: the rollout flag stages
   exposure; the kill-switch is the emergency stop. Tested.
3. **Single-session fallback (degraded mode).** If the bounded worker pool is unavailable, saturated, or repeatedly
   failing, the runtime degrades to **single-session sequential** processing rather than dropping turns — and,
   consistent with §4 (grove-master revision #2), if even that fails the turn goes to **retry/defer or an explicit
   non-chat system status**. Under no failure mode is a fabricated/template answer posted as a chat answer
   (**user-facing answer = 0 on failure**). The fallback preserves per-session FIFO + idempotency.
4. **Observability metrics (extend `slack_chat_queue` / `node_chat_queue` surface).** Emit: per-session + pool
   **concurrency depth**, turn **latency** (enqueue→ack, enqueue→answer), pool **saturation** (workers busy / queue
   depth / lease-reclaim count), and **errors** (generation failures, parse failures, defers/retries, kill-switch
   trips). These gate canary→cutover and back the kill-switch decision. Reuse `node_chat_queue_summary` as the
   extension point.

These 4 + grove-master's 2 revisions (§3.2 CLI/node-routed backend removed; §4 failure ≠ user-facing answer) +
the 7 required items (§3) constitute a complete Stage0 design + implementation plan.

## 7. Confirm-card copy — authored by chat-master (quoted, chat-master owns; do not alter without their sign-off)

> Source: chat-master (dev10), 2026-06-06. Tone: 존댓말·간결·이모지 절제; "task" → "태스크".

- **즉시 ack:** 👀 reaction (무텍스트, best-effort; reaction 실패가 워커를 막지 않음).
- **제안 카드 (task 감지 시):** 헤더 `이 요청을 태스크로 만들까요?` / `*제목* {title}` / `*내용* {body or '—'}` /
  `*프로젝트* {project}` (기본 dev10) / `*워크트리* {worktree or '새 브랜치 자동 생성'}` /
  버튼 `[✅ 태스크 생성]`=`grove_intake_confirm` · `[💬 답변만]`=`grove_intake_answer_only` /
  푸터 `아직 생성 전이에요. 태스크 생성을 누르면 보드에 등록됩니다.`
- **생성 후(confirm):** `태스크를 등록했어요 ✅ [{task_id}] {title} · 프로젝트 {project}. 진행은 보드에서 확인하실 수 있어요.`
- **답변만(answer_only):** `태스크는 만들지 않을게요. 이어서 답변드릴게요.`
- **만료/소유자(consume_for_owner 실패):** `이 확인은 만료됐거나 이미 처리됐어요. 다시 요청해 주세요.` /
  `요청하신 분만 확인할 수 있어요.`
  (Field boundary: bridge = structure/fields/validation/defaults; chat-master = wording/tone/judgment. The
  busy/timeout copy chat-master drafted is **not** posted as a chat answer under §4 — if surfaced at all it is an
  explicit, clearly-non-chat system status, once, idempotent.)

**No-template scope (chat-master):** the §4/§3(4) no-template rule applies to the **free-chat answer channel**
only. This confirm-flow copy is chat-master-authored **structured interaction copy** (fixed strings, correct here)
— it is _not_ a "chat answer" and is exempt from no-template. Free-turn answers = always LLM-generated;
confirm-flow strings = chat-master-authored fixed.

## 8. Test strategy (Stage0)

- **Flag-off inertness:** with the flag off, the existing Slack daemon + web request path are byte-for-byte
  unchanged; the new components are not constructed; **0 live behavior change.**
- **No-template (strengthened):** on a chat-turn failure (provider error / parse failure / exception), assert
  **bridge fallback strings are NOT posted on the chat turn**; the failure leaves the queue **retryable** (deferred)
  or returns a **transport error** — never a fabricated/template chat answer.
- **Per-session isolation:** turns in conversation A do not leak into B's context.
- **Per-session FIFO + idempotency:** re-enqueue/retry → no double-process (response_text cache); ordering held.
- **Inter-session concurrency bound:** ≤ N sessions processed concurrently; no head-of-line block across sessions.
- **confirm-before-create:** proposal alone never creates; create only on confirm; cross-conversation confirm
  cannot fire another conversation's task.
- **Caveat-1/2:** detector zero-I/O assertion; turn/detector exception → retryable defer, no fabricated answer.
- **Watchdog:** socket heartbeat / reconnect / self-exit unaffected (enqueue stays fast; pool is a separate executor).

## 9. Guards preserved

`slack_chat_queue` durability + idempotency; immediate ack (now a distinct system reaction); per-thread/session
isolation (now first-class); confirm-before-create; socket watchdog (no new blocking in the socket handler); no
node-per-thread; no user-facing templates; live route untouched until an approved cutover.

## 10. Open questions (co-own with chat-master)

- **Persona source — chat-master owns/authors.** chat-master authors and owns the persona/policy doc that becomes
  the adapter system prompt, and will submit a draft at Stage0 sequencing. It encodes the 3 canonical modes +
  the answer↔task judgment + tone + propose-only discipline. (claimed by chat-master 2026-06-06)
- **Structured-turn contract — chat-master is emitter/owner.** marker/JSON shape for answer vs. task-proposal
  (+ fields + card text) + the safe-fallback parse rule; finalized at the Stage0 window. Parse failure → defer per
  §4, **never** a raw-text fabricated answer (agreed). (claimed by chat-master 2026-06-06)
- **Pool size N** + per-surface concurrency caps; web queue parity scope (durable vs request/reply).
- **Provider backend specifics:** Gemini is the MVP provider. Keep the provider boundary narrow enough to add a
  different backend later, but current runtime docs/tests should assume Gemini config and redaction.

## 11. Risks

- Adapter responses must match chat-master persona/policy (mitigate: persona system prompt owned by chat-master +
  audit). - Pool concurrency vs. provider rate limits (mitigate: bounded N + backpressure + SDK retry). - Web queue
  parity is additional surface (stage separately). - Cutover risk (mitigate: flag + canary + instant rollback). -
  Lease correctness under crash (mitigate: `running_stale_before` reclaim + idempotent answer-back).

## 12. Non-goals (Stage0)

No live route change; no chat-master node removal; no intake re-enable; no per-thread node spawning; no
user-facing templates; no fabricated answers on failure; no flip/canary/cutover without separate approval.

## 13. Integrated Implementation Plan (advisor SIGNED OFF 2026-06-06)

> Single consolidated plan. Implementation HELD until lead review/sequencing + edit windows + the approval gates
> in §13.5. Absorbs advisor's 5 stability acceptance criteria as guards/tests (mapped inline **[A1]–[A5]**) plus
> the advisor forward-note **[R]** (provider redaction). advisor signed off the 5 criteria; this section finalizes
> the plan in grove-master format.

### 13.1 Stages (flag-gated; each independently gated; rollback = flag OFF at any stage)

- **Stage 0 — inert (flag default OFF).** Land `ChatSessionStore`, `ChatWorkerPool`, the bridge-native provider
  adapter, the durable-queue extension, observability counters, and the kill-switch — constructed **only when the
  flag is on**. Flag OFF ⇒ existing Slack daemon / web path byte-identical, **live route untouched**, 0 behavior
  change. DB additions are additive. **[A3]** `intake_enabled` stays FALSE throughout.
- **Stage 1 — shadow.** Flag on, shadow mode: process + generate but **do not post**; log/compare vs the live CLI
  path; baseline latency/saturation/error metrics.
- **Stage 2 — canary.** Flag on for a single thread/conversation (real user-facing); metrics watched.
- **Stage 3 — cutover.** Flag on for all external chat; live CLI path retired only after canary metrics clear.
  Separate master/operator approval. **Independent of intake-enable — intake stays DARK.** **[A3]**

### 13.2 Touched files (explicit)

- `bridge/src/grove_bridge/store.py` — `chat_sessions` table (additive); `slack_chat_queue`/`node_chat_queue`
  **reused, not replaced** **[A2]**; bounded concurrent drain with **per-item claim** **[A2]**; metrics
  extension (depth/oldest_age/active workers/saturation/error rate) **[A5]**.
- `bridge/src/grove_bridge/chat_runtime.py` — bridge-native **provider adapter** (`GeminiChatProviderAdapter`),
  persona system prompt, structured-turn parse +
  safe-fallback (parse fail → defer, never fabricate), **redaction of secrets/PII before any provider call** **[R]**.
  Not the abandoned node-routed/predicate code.
- `bridge/src/grove_bridge/slack.py` — worker-pool integration behind flag; shadow/canary gating; kill-switch;
  demote `working/busy/timeout/ASSISTANT_TRANSPORT_FALLBACK_TEXT` to ops-log **[A4]**; reaction ack. (HELD until
  grove-master stabilizes slack.py + lead window.)
- `bridge/src/grove_bridge/web_app.py` — web `ChatSession` + queue parity + flag-gated runtime. (HELD until the
  board-worker window.)
- Tests: `bridge/tests/test_{slack,assistant,web_app,store}.py` (see 13.4).
- Config (operator/fleet-owned, NOT chat-worker): rollout flag + kill-switch (gui feature flag / env) + Stage-3
  cutover. `intake` gui flag stays FALSE.

### 13.3 Live-flip + kill-switch

- **Live-flip** = the rollout flag advanced shadow→canary→cutover, master/operator-approved per stage.
- **Kill-switch** (first-class, separate from the rollout flag) = emergency stop → immediately revert to the live
  path (or defer/system-status mid-cutover), no restart, no user-facing template. A **circuit-breaker** on the
  error-rate metric **[A5]** trips it automatically. Tested.

### 13.4 Minimal verification (§8 + advisor 3 guard tests + redaction)

All of §8, **plus**:

- **[A1] bounded/no-spawn:** assert the org/registry node count is **unchanged** by the runtime and the pool honors
  its cap (no per-thread node, no unbounded workers).
- **[A2] concurrency idempotency:** under concurrent drain, the **same thread is never double-processed** (per-item
  claim); no-drop + reclaim-on-stale preserved.
- **[A4] template-detector — ANSWER channel only:** feed **varying inputs** to the free-chat answer channel; assert
  it **never** emits a fixed bridge string (fixed output across varying inputs ⇒ FAIL); backpressure = durable
  **HOLD/defer**, not a fake "busy". **Confirm-flow §7 fixed copy is chat-master-authored and EXCLUDED** from this
  detector (per chat-master semantic ownership).
- **[R] provider redaction:** assert secrets/PII (e.g. `xoxb-…` tokens, paths, emails) in the session transcript
  are **redacted before** any direct Gemini/provider call — the provider request never carries raw secrets (mirror
  the existing `build_assistant_facts` redaction test style).
- Plus observability assertions (metrics per-poll) + circuit-breaker→kill-switch path **[A5]**.

### 13.5 Remaining approval gates (in order)

1. **advisor sign-off** — ✅ done (5 criteria, 2026-06-06).
2. **lead review + commit sequencing** (chat-worker reports diffs; lead commits) + edit **windows** (slack.py after
   grove-master stabilization; web_app.py after the board-worker window).
3. **master/operator cutover approval** (Stage 3).
4. **intake-enable = SEPARATE consult-gate** — `intake_enabled` stays FALSE through cutover; re-enable is gated on
   G2 **Caveat-1/2 green** (`docs/superpowers/plans/2026-06-06-g2-free-chat-task-intake.md` §8) + its own approval.

### 13.6 §10 open items — resolution (chat-master-owned items resolved at impl)

- **Persona/policy doc** — **chat-master-owned deliverable**, submitted at the Stage0 window (3 canonical modes +
  answer↔task judgment + tone + propose-only). → adapter system prompt.
- **Structured-turn contract** — **chat-master-owned deliverable**, finalized at the Stage0 window (marker/JSON for
  answer | task-proposal + fields + card text; parse fail → defer, never raw fabricate).
- **Pool size N** — **Rec:** small default (e.g. N=4), configurable, per-surface cap; **Stage1:** tune from
  shadow/canary saturation **[A5]**.
- **Web queue parity** — **Rec:** a **dedicated web queue + web worker**; **Stage1:** Slack first, web parity is
  a separate post-MVP gate. **⚠ CAVEAT (operator-blocked 2026-06-06):** web turns MUST NOT be enqueued onto
  `slack_chat_queue` (e.g. `team_id="web"`) for the shared Slack worker to drain — that cross-surface contamination
  risks fake Slack-channel posts. Web parity needs its own queue/worker, not slack_chat_queue reuse.
- **Provider backend** — **Resolved for MVP:** Gemini (`GeminiChatProviderAdapter`, default
  `gemini-2.5-flash`) configured from Setup. Future providers can be added behind the same adapter boundary.
