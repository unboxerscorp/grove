# GROVE MASTER 설계

작성일: 2026-06-04

## 0. 전제와 근거

- 제품 비전은 항상 켜진 개발실이다. 모든 작업은 실제로 보고 대화할 수 있는 CLI 세션이 수행하고, 보드·채널·라이브 터미널이 한 화면에 모인다. 근거: `VISION.md:3`, `VISION.md:9`, `VISION.md:16`, `VISION.md:35`.
- 전략 메모리는 세 축을 둔다: 복원/이전 가능성, 로그인+프로젝트 생애주기, 그리고 `~/dev`를 관장하는 단일 MASTER CLI와 우측 하단 플로팅 채팅. 근거: `grove-vision-prod-platform.md:10`, `grove-vision-prod-platform.md:17`, `grove-vision-prod-platform.md:21`.
- 현재 안전 패턴은 이미 있다. Slack intake는 deterministic triage가 preview만 만들고, owner confirm 뒤에만 task를 생성하며, role/audit/project-scope를 강제한다. 근거: `bridge/src/grove_bridge/slack.py:291`, `bridge/src/grove_bridge/slack.py:1468`, `bridge/src/grove_bridge/slack.py:1535`, `bridge/src/grove_bridge/slack.py:1696`.
- web backend는 project create, board query, saved view, task create, node spawn을 이미 API로 가진다. 변이는 `_require_operator_state_change`를 통과하고 audit을 남긴다. 근거: `bridge/src/grove_bridge/web_app.py:925`, `bridge/src/grove_bridge/web_app.py:1011`, `bridge/src/grove_bridge/web_app.py:1089`, `bridge/src/grove_bridge/web_app.py:1150`, `bridge/src/grove_bridge/web_app.py:1306`, `bridge/src/grove_bridge/web_app.py:4861`.
- CLI 쪽도 `new-project`, `spawn`, `delegate`가 1급 명령이다. 특히 `delegate`는 web API로 board task를 만들며 프로젝트 헤더와 dashboard token을 사용한다. 근거: `src/commands/new-project.ts:251`, `src/commands/delegate.ts:202`.

## 1. 목표

GROVE MASTER는 사용자가 `~/dev` 전체를 자연어로 다루는 단일 입구다.

1. **사용자 메타 어시스턴트**
   - "뭐 가능?", "이런 프로젝트 만들어줘", "A 프로젝트 리뷰어 몇 명?", "B 프로젝트에 리뷰어 2명 더 붙여줘" 같은 요청을 받는다.
   - 조회는 바로 답한다.
   - 변이는 preview → confirm → 기존 gated API/CLI 실행 → audit 순서로만 처리한다.

2. **grove 자체 개선 라우터**
   - 제품 자체에 대한 버그, 피드백, 개선 요청을 받는다.
   - `grove-dev-team` 프로젝트의 `dev-room` 보드와 해당 오케스트레이터로 라우팅한다.
   - 현재 사람이 수동으로 하던 "피드백 → 보드 task → dev group 위임" 흐름을 제품화한다.

3. **실제 세션 원칙**
   - MASTER의 판단과 대화 주체는 실제 Codex CLI tmux 세션이다.
   - broker는 권한·스키마·confirm·audit을 맡는 얇은 실행 경계다.
   - 나중에 다른 CLI로 바꾸기 쉽게 `MasterAgentAdapter` 뒤에 숨긴다.

## 2. 비목표

- 사용자의 자연어를 shell 명령으로 직접 실행하지 않는다.
- MASTER가 dashboard token, signing key, member secret을 프롬프트로 받지 않는다.
- MASTER가 자신의 권한을 상승시키거나 confirm 없이 변이를 실행하지 않는다.
- v1 첫 구현에서 destructive action, bulk action, cross-room remote mutation을 제공하지 않는다.
- 완전한 자동 개발 매니저를 만들지 않는다. 사람 승인과 role gate가 제품 계약이다.

## 3. 아키텍처

```text
web SPA floating chat
  |
  |  member session + csrf + project scope
  v
master broker in grove-web
  |
  +-- conversation store / confirmation store / audit writer
  +-- context pack builder
  +-- tool registry allowlist
  +-- MasterAgentAdapter
        |
        v
      real MASTER Codex CLI in tmux, cwd=~/dev
```

### 3.1 MASTER 세션

- 기본 노드 이름: `master`.
- 기본 agent: `codex`.
- 기본 cwd: `~/dev`.
- 기본 session: 별도 `grove-master` 또는 host-level dev-room session. live dev session과 충돌하지 않게 독립 pane을 권장한다.
- 역할 prompt:
  - 사용자의 자연어 의도를 분류한다.
  - 답변 또는 `tool_proposal` JSON만 낸다.
  - 변이는 실행하지 않고 proposal만 만든다.
  - grove feedback은 dev-team route proposal로 낸다.
- swap 가능성:
  - `MasterAgentAdapter.start()`
  - `MasterAgentAdapter.send_turn(conversation_id, prompt)`
  - `MasterAgentAdapter.stream_events()`
  - `MasterAgentAdapter.transcript_ref()`
  - Codex가 기본이지만 adapter 계약은 CLI 독립으로 둔다.

### 3.2 Broker

Broker는 MASTER가 낸 제안을 검증하고 실행하는 server-side gate다.

- 입력:
  - member/session actor
  - selected project
  - user message
  - conversation id
  - csrf token for state changes
- 출력:
  - streamed answer
  - read-only result card
  - mutation preview card
  - confirm result
  - audit event link
- 책임:
  - context pack 생성
  - MASTER turn enqueue
  - `tool_proposal` 파싱
  - JSON schema validation
  - project/board/node scope validation
  - preview 생성
  - same-owner confirm TTL
  - existing API/CLI 호출
  - audit 기록
  - 결과를 MASTER에 다시 넣어 최종 사용자 문장 생성

### 3.3 Floating Chat UX

- 위치: dashboard 우측 하단 floating button.
- 기본 상태: 작은 원형/사각 버튼, unread dot, current project badge.
- 열린 상태:
  - 상단: "MASTER", 현재 project, auth role, 연결 상태.
  - 본문: compact chat transcript.
  - 하단: input + send.
  - preview card: action, 대상 project/board/node, diff, 위험, confirm/cancel.
  - read-only answer card: table/list 형태의 프로젝트, 노드, 보드 요약.
  - "open MASTER terminal" 링크: 실제 tmux/xterm viewer로 이동.
- 모바일:
  - bottom sheet로 열린다.
  - confirm button은 sticky footer에 두고 accidental tap을 막는다.

## 4. Context Pack

MASTER에는 raw secrets 대신 bounded summary만 넣는다.

```json
{
  "conversation_id": "master_conv_...",
  "actor": { "id": "member-id", "role": "operator" },
  "selected_project": "project-a",
  "visible_projects": [{ "name": "project-a", "board": "default" }],
  "org_summary": [{ "name": "lead", "role": "orchestrator", "children": 3 }],
  "board_summary": { "ready": 8, "running": 2, "blocked": 1 },
  "allowed_tools": ["project.create", "project.query", "node.spawn", "task.create"],
  "pending_confirmations": []
}
```

Rules:

- project list는 actor가 볼 수 있는 범위만 포함한다.
- org는 role/group/status 중심으로 축약한다.
- board는 count와 redacted title 정도만 넣는다.
- token, absolute path, transcript raw text, email PII는 기본 제외한다.
- user가 특정 task/thread를 열고 있을 때만 해당 task의 redacted body/comment summary를 넣는다.

## 5. NL → Tool Mapping

| 사용자 요청 예시               | 분류             | Tool proposal             | 실행 경로                                      | gate                         |
| ------------------------------ | ---------------- | ------------------------- | ---------------------------------------------- | ---------------------------- |
| "뭐 가능?"                     | capability query | `capability.explain`      | static registry + visible project summary      | read-only                    |
| "A 프로젝트 리뷰어 몇 명?"     | org query        | `project.org.query`       | `GET /api/projects`, `GET /api/org` equivalent | read-only                    |
| "blocked 뭐 있어?"             | board query      | `board.query`             | `GET /api/boards/{board}/query`                | read-only                    |
| "이런 프로젝트 만들어줘"       | project create   | `project.create`          | `POST /api/projects` or `grove new-project`    | preview→confirm+operator     |
| "A에 reviewer 2명 더 만들어줘" | node spawn       | `node.spawn[]`            | `POST /api/nodes`                              | preview→confirm+operator     |
| "maker-1에게 이 일 맡겨"       | delegate         | `task.create`             | `POST /api/boards/{board}/tasks`               | preview→confirm+operator     |
| "이 설정 바꿔줘"               | config mutation  | `config.change_proposal`  | future config endpoint                         | preview diff; v1 not execute |
| "이 제품 버그야: ..."          | product feedback | `dev_feedback.route`      | `dev-room` task create                         | preview→confirm+operator     |
| "이 노드 지워"                 | destructive      | `unsupported_destructive` | none                                           | answer with safe next step   |

## 6. Tool Proposal Schema

MASTER may emit only this shape:

```json
{
  "type": "tool_proposal",
  "proposal_id": "local-id-from-master",
  "intent": "project.create",
  "confidence": 0.91,
  "reason": "user asked to create a new project",
  "requires_confirmation": true,
  "project": "optional-project",
  "payload": {
    "name": "my-project",
    "template": "web",
    "dir": "~/grove-projects/my-project"
  },
  "user_visible_summary": "Create project my-project from template web."
}
```

Broker validation:

- `intent` must be in an allowlist.
- `payload` must match a strict schema.
- names must pass existing grove name validation.
- `project`, `board`, and `node` must resolve inside actor scope.
- any mutation must require confirmation.
- forbidden fields such as raw token, shell command, arbitrary file path glob, environment dump, or transcript raw body reject the proposal.

## 7. Confirm Contract

Preview creation:

```text
pending_id = create_pending(
  actor_id,
  conversation_id,
  intent,
  normalized_payload,
  expires_at,
  preview_hash
)
audit(master.preview, actor, intent, project, target, preview_hash)
```

Confirm:

```text
confirm(pending_id, actor_id, csrf):
  require same actor
  require operator/admin for mutation
  require unexpired
  revalidate project/board/node scope
  revalidate payload hash
  execute existing API/CLI path
  audit(master.execute, status, result)
```

Denial cases:

- wrong actor
- viewer role for mutation
- expired confirmation
- changed project scope
- missing board/node
- proposal contains disallowed field
- destructive intent not in current allowlist

## 8. Feedback Routing To grove-dev-team

### 8.1 Intake

MASTER classifies messages into:

- `product_bug`
- `product_feedback`
- `feature_request`
- `question`
- `unsafe_or_secret`

This mirrors the existing deterministic intake categories: bug, feedback, task request, question, command.

### 8.2 Route

Default route:

```text
target_project = "grove-dev-team"
target_board = "dev-room"
target_assignee = "lead" or configured dev orchestrator
labels = ["grove-feedback", category]
```

Task body:

- user-facing summary
- reproduction/context
- current project/page if present
- source conversation id
- actor id
- redacted transcript excerpt
- proposed severity

Metadata:

```json
{
  "source": "master-floating-chat",
  "category": "product_feedback",
  "conversation_id": "master_conv_...",
  "origin_project": "project-a",
  "route": { "project": "grove-dev-team", "board": "dev-room", "assignee": "lead" }
}
```

### 8.3 Safety

- feedback task creation is still a mutation and needs preview→confirm for normal users with operator role.
- viewer can draft feedback but cannot create the task directly; it becomes a request-for-operator-confirm.
- secret-looking text is redacted before preview and before task body.
- MASTER should ask one clarification if severity or reproduction is missing, but should not block simple bug filing forever.

## 9. Data Model Additions

Small SQLite additions, preferably under existing bridge store:

```sql
master_conversations(
  id text primary key,
  actor_id text not null,
  project text,
  created_at real not null,
  updated_at real not null,
  status text not null
)

master_messages(
  id text primary key,
  conversation_id text not null,
  role text not null,
  body_redacted text not null,
  metadata_json text not null,
  created_at real not null
)

master_pending_actions(
  id text primary key,
  conversation_id text not null,
  actor_id text not null,
  intent text not null,
  payload_json text not null,
  preview_hash text not null,
  expires_at real not null,
  status text not null
)
```

Do not store raw secrets or unredacted transcripts here.

## 10. API Sketch

```http
GET  /api/master/status
POST /api/master/conversations
GET  /api/master/conversations/{id}/messages
POST /api/master/conversations/{id}/messages
POST /api/master/pending/{id}/confirm
POST /api/master/pending/{id}/cancel
WS   /api/master/conversations/{id}/stream
```

Auth:

- read endpoints require existing auth.
- message send requires auth.
- confirm/cancel require state-change checks.
- mutation confirm requires operator/admin.
- all state-changing calls inherit Host/Origin/CSRF checks.

## 11. Execution Flow

### 11.1 Read-only query

1. User: "A 프로젝트 리뷰어 몇 명?"
2. Broker builds context pack for visible projects.
3. MASTER proposes `project.org.query`.
4. Broker validates read-only scope and calls org/project read APIs.
5. Broker feeds result back to MASTER.
6. MASTER answers: "A에는 reviewer 2명, QA reviewer 1명이 있습니다."
7. Audit optional: `master.query` with redacted summary.

### 11.2 Project creation

1. User: "React dashboard 프로젝트 만들어줘."
2. MASTER proposes `project.create`.
3. Broker renders preview: name, dir, template, initial nodes, dashboard command.
4. User confirms.
5. Broker calls existing project create path.
6. Audit records actor, project, result.
7. MASTER summarizes next steps and links project dashboard.

### 11.3 Node spawn

1. User: "A 프로젝트에 reviewer 2명 더."
2. Broker resolves project A and current org.
3. MASTER proposes two `node.spawn` actions.
4. Preview shows names, parent, group, role, agent.
5. Confirm calls existing node spawn endpoint.
6. MASTER reports created panes and links terminal views.

### 11.4 Feedback route

1. User in floating chat: "보드 검색이 너무 느려."
2. MASTER classifies product feedback.
3. Broker previews dev feedback task for `grove-dev-team/dev-room`.
4. Confirm creates task assigned to configured dev orchestrator.
5. MASTER replies with task id and "이 피드백은 dev-room에서 추적됩니다."

## 12. 안전 설계

| 위험             | 완화                                                                   |
| ---------------- | ---------------------------------------------------------------------- |
| prompt injection | MASTER output is advisory; broker accepts only strict JSON allowlist.  |
| role bypass      | mutation confirm uses current member auth, not MASTER identity.        |
| hidden mutation  | all mutation paths require preview card and explicit confirm.          |
| cross-project    | broker resolves project/board/node inside actor scope on every step.   |
| secret leak      | context pack and stored messages are redacted; no raw token in prompt. |
| stale preview    | confirm revalidates payload hash and project/node state.               |
| concurrency      | single MASTER session is queued; one active turn per conversation.     |
| destructive ask  | despawn/delete/bulk ops are unsupported until separate design.         |
| audit gap        | preview, confirm, cancel, denial, and execute all write audit events.  |
| over-trust       | UI labels MASTER suggestions as proposed action, not completed work.   |

## 13. v1.28 브레인스토밍

v1.28의 추천 산출물은 **MASTER 설계 확정 + read-only floating chat prototype**이다.

P0:

- MASTER node lifecycle design: single Codex CLI, tmux pane, transcript link, adapter interface.
- Floating chat shell: open/close, project badge, auth role, message list, streaming placeholder.
- Read-only NL query MVP: project list, org count, board count, capability answer.
- Tool proposal parser MVP: accept `type=tool_proposal`, validate strict schemas, reject mutation unless feature flag enabled.
- Audit skeleton: query/preview/deny events only.

P1:

- Feedback draft flow: classify and preview dev feedback task, but task creation may remain disabled behind feature flag.
- Context pack tuning: selected project, open board/task, redacted summaries.
- MASTER terminal link: open actual tmux pane from the chat header.

Out of scope for v1.28:

- direct project creation
- node spawn execution
- config mutation
- destructive actions
- multi-MASTER concurrency

## 14. 단계적 구현안 v1.29+

### v1.29: MASTER read-only + feedback preview

- Ship MASTER process manager and adapter.
- Ship floating chat read-only query path.
- Ship feedback preview to `grove-dev-team/dev-room`, default OFF for actual task creation.
- Tests: prompt injection rejects tool call, viewer cannot create feedback task, secrets redacted.

### v1.30: gated project create + node spawn

- Enable `project.create` and `node.spawn` behind feature flags.
- Reuse existing `POST /api/projects` and `POST /api/nodes`.
- Add preview diff, same-owner confirm, audit, CSRF, project-scope tests.
- Keep config mutation disabled.

### v1.31: gated delegate/task create

- Enable `task.create` and `delegate` proposals.
- Route implementation work to board tasks, never hidden direct asks.
- Add planner suggestions as read-only hints before assignment.

### v1.32: project lifecycle assistant

- Add templates, setup checklist, tmux/SSH connect guidance, import/export helper.
- MASTER can explain repair/snapshot status but cannot run destructive recovery without separate confirm.

### v1.33+: config assistant and deeper automation

- Add config proposal diff only after config endpoints exist.
- Add bulk/destructive actions only with typed confirmation and separate review.
- Add multi-user queue fairness and conversation privacy controls.

## 15. MVP Scope Recommendation

Smallest slice that proves the model:

1. Start a visible `master` Codex CLI pane in cwd `~/dev`.
2. Add floating chat that sends a bounded prompt to that pane.
3. Support read-only answers for "뭐 가능?" and "A 프로젝트 리뷰어 몇 명?"
4. Parse `dev_feedback.route` proposal but show preview only.
5. Require operator confirm before creating a dev feedback task.
6. Record audit for preview, confirm, deny, and task create.

This validates the central claim: a human talks to a visible MASTER session, MASTER proposes grove actions, and the broker enforces safety before any state changes.
