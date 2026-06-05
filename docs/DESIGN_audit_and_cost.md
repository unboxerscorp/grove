# grove audit, org graph, cost 설계

> Status: historical v1.3 design. Current grove uses direct node communication
> and human-facing list items; board/task names below are legacy backing API and
> historical audit design vocabulary, not the current node-to-node coordination
> model.

상태: v1.3 설계안. 구현은 후속 작업에서 진행한다.

## 현재 기준

- board store에는 `events` 테이블과 `BoardEvent` 모델이 이미 있다. 모델은 `bridge/src/grove_bridge/store.py:131`, 조회는 `bridge/src/grove_bridge/store.py:836`, 테이블은 `bridge/src/grove_bridge/store.py:1044`, 기록 helper는 `bridge/src/grove_bridge/store.py:1169`에 있다.
- web board API는 `/api/boards`, `/api/boards/{board_id}/tasks`, `POST /api/boards/{board_id}/tasks`를 제공한다. 근거는 `bridge/src/grove_bridge/web_app.py:361`부터 `bridge/src/grove_bridge/web_app.py:409`까지다.
- board WebSocket은 `list_events_after`를 tail하고 project로 필터링하지만, 현재 payload는 `cursor`, `type`, `task_id`만 내려준다. 근거는 `bridge/src/grove_bridge/web_app.py:603`부터 `bridge/src/grove_bridge/web_app.py:627`, payload 축약은 `bridge/src/grove_bridge/web_app.py:1668`부터 `bridge/src/grove_bridge/web_app.py:1675`까지다.
- team auth는 `AuthMode`, `/api/me`, `/api/login`, `/api/logout`, `/api/csrf`, cookie session, CSRF gate를 갖는 방향으로 들어와 있다. 근거는 `bridge/src/grove_bridge/web_app.py:83`, `bridge/src/grove_bridge/web_app.py:274`, `bridge/src/grove_bridge/web_app.py:772`, `bridge/src/grove_bridge/web_app.py:801`이다.
- team auth 설계의 최소 actor 필드는 `member_id`, `member_login`, `role`, `action`, `target`, `status`다. 근거는 `docs/DESIGN_team_auth.md:65`부터 `docs/DESIGN_team_auth.md:108`까지다.
- OrgChart는 `/api/org`를 읽어 node/parent/children graph를 그리고, SVG edge layer를 이미 갖고 있다. 근거는 `web/src/components/OrgChart.tsx:440`, edge 계산은 `web/src/components/OrgChart.tsx:634`, 렌더는 `web/src/components/OrgChart.tsx:704`다.
- BoardView는 task assignee/status를 표시하고 필터링한다. 근거는 `web/src/components/BoardView.tsx:136`부터 `web/src/components/BoardView.tsx:177`, assignee pill은 `web/src/components/BoardView.tsx:254`다.
- node status summary는 backend가 `running/stale/idle/error`를 세지만 FE는 현재 `running/stale/idle`만 표시한다. 근거는 `bridge/src/grove_bridge/web_app.py:706`, `web/src/components/NodeStatusBar.tsx:36`부터 `web/src/components/NodeStatusBar.tsx:60`까지다.
- v1.2 brainstorm은 org live graph, orchestrator audit, node heatmap, metrics, cost/token dashboard를 v1.3+로 밀어둔 상태다. 근거는 `docs/V1.2_BRAINSTORM.md:27`, `docs/V1.2_BRAINSTORM.md:29`, `docs/V1.2_BRAINSTORM.md:58`, `docs/V1.2_BRAINSTORM.md:60`이다.

---

# A. V3-W3 org graph + audit 레인

## 데이터모델

권장안은 **기존 `events` 테이블을 audit의 1차 원장으로 재사용**하는 것이다.

이유:

- 이미 board, task, run, project filtering, cursor tail, WS wake-up이 붙어 있다.
- `payload_json`이 있어 actor/action/target 확장이 schema 변경 없이 가능하다.
- board task lifecycle과 audit timeline을 같은 cursor 순서로 볼 수 있다.
- 별도 audit 로그를 쓰면 event duplication, replay ordering, project scoping을 다시 풀어야 한다.

단, `events`는 `board_id NOT NULL`이므로 node lifecycle도 project board에 묶는다. project/session 하나를 board scope로 보고, node spawn/despawn/update는 `task_id = null`, `target_type = "node"`인 event로 기록한다.

event kind 규칙:

```text
task.created              # 기존 task 생성
task.claimed              # 기존 claim
task.completed            # 기존 complete
task.blocked              # 기존 block
comment.added             # 기존 comment
audit.task.delegate       # 명시적 위임: from_node/member -> assignee node
audit.task.assign         # 일반 assign: actor -> assignee node
audit.node.spawn          # node 생성
audit.node.update         # parent/group/description 변경
audit.node.despawn        # node 제거
audit.ws.ticket           # terminal/board ticket 발급, 상세는 redacted
```

audit payload 최소형:

```json
{
  "actor": {
    "kind": "member|node|local|system",
    "id": "mem_...|lead|node-name|system",
    "login": "optional",
    "role": "admin|operator|viewer|none"
  },
  "action": "delegate|assign|claim|complete|block|spawn|despawn|ticket",
  "target": {
    "type": "task|run|node|ws_ticket",
    "id": "task_...|node-name",
    "node": "assignee-or-target-node"
  },
  "project": "dev10",
  "board": "dev10",
  "from_node": "lead",
  "to_node": "maker-1",
  "status": "ok|failed",
  "summary": "short redacted text",
  "ts": 1780000000
}
```

actor 해석:

- team-auth 모드: `AuthContext.member`가 authoritative actor다. role은 member registry에서 온다.
- local-token 모드: 기본 actor는 `{kind:"local", id:"lead"}`다.
- node가 직접 `grove delegate`를 실행하는 경우: 후속 `--from <node>` 또는 `GROVE_CURRENT_NODE`가 있으면 `{kind:"node", id:<node>}`로 기록한다. 없으면 local actor로 남기고 `from_node`는 비운다.
- pull executor: claim/complete/block은 `{kind:"node", id:<execution_node>}` 또는 `{kind:"system", id:"pull-executor"}`로 기록하되, target node는 run/node metadata에 넣는다.

별도 audit 로그가 필요한 경우:

- cross-project security audit, auth login/logout, member key rotation, secret 저장 같은 project board 밖 사건은 v1.3에서 `~/.grove/team-auth/audit.jsonl` 또는 `audit_events` table로 남겨도 된다.
- V3-W3 범위에서는 board/org 관련 audit를 `events`에 집중하고, auth/security event는 team-auth 문서의 별도 store를 유지한다.

## API

`GET /api/audit`

권한:

- local-token: 기존 token 통과 시 허용.
- team-cookie: `admin`/`operator`는 full payload, `viewer`는 actor login과 sensitive summary가 redacted된 summary만 허용하거나 403으로 시작한다. v1.3 MVP는 403이 단순하다.

Query:

```text
cursor=0
limit=100
kind=audit.task.delegate
action=delegate
actor=member-or-node
target_type=task|node
node=maker-1
since=unix-ts
until=unix-ts
```

Response:

```json
{
  "items": [
    {
      "cursor": 101,
      "id": "event_...",
      "ts": 1780000000,
      "type": "audit.task.delegate",
      "project": "dev10",
      "board_id": "board_...",
      "task_id": "task_...",
      "run_id": null,
      "actor": { "kind": "member", "id": "mem_a", "login": "a", "role": "operator" },
      "action": "delegate",
      "target": { "type": "task", "id": "task_...", "node": "maker-1" },
      "from_node": "lead",
      "to_node": "maker-1",
      "summary": "Fix failing auth test"
    }
  ],
  "next_cursor": 102
}
```

`GET /api/org/live`

기존 `/api/org`에 board/audit derived fields를 합친 read model이다.

```json
{
  "nodes": [...],
  "roots": ["lead"],
  "groups": {"core": ["maker-1"]},
  "delegation_edges": [
    {
      "from": "lead",
      "to": "maker-1",
      "open": 2,
      "running": 1,
      "blocked": 0,
      "last_task_id": "task_...",
      "last_delegated_at": 1780000000,
      "confidence": "explicit|inferred"
    }
  ]
}
```

데이터 출처:

- explicit edge: `audit.task.delegate`의 `from_node` + `to_node`.
- inferred edge: ready/running/blocked task의 `assignee`와 현재 org parent를 결합한다. 이 경우 `confidence="inferred"`로 표시한다.
- node workload: `/api/boards/{board}/tasks?assignee=<node>`와 task status count.

Board WS 정합:

- board WS는 지금처럼 얇은 wake-up stream으로 유지해도 된다.
- audit event가 들어오면 `type="audit.task.delegate"` 정도만 내려와 FE가 `/api/audit` 또는 `/api/org/live`를 재조회하게 한다.
- payload 전체를 WS에 싣는 것은 v1.3 MVP에서 피한다. member identity와 summary redaction 정책이 REST auth와 섞이기 때문이다.

## FE

Org graph overlay:

- 기존 SVG edge layer에 `delegation_edges`를 한 겹 더 그린다.
- parent-child 구조 edge는 기존 색/선으로 유지하고, delegation edge는 점선 또는 얇은 animated stroke로 분리한다.
- `open/running/blocked` count를 edge midpoint badge로 표시한다.
- explicit edge는 선, inferred edge는 node inbound glow 또는 희미한 선으로 표시한다.
- hover/click 시 edge drawer를 열어 최근 task 5개와 audit item 5개를 보여준다.

Audit lane:

- dashboard 우측 또는 board 아래에 read-only timeline panel을 둔다.
- 필터: action, actor, node, task, status.
- 기본 timeline은 `delegate`, `claim`, `complete`, `block`, `spawn`, `despawn`만 보여준다.
- `comment.added`와 low-level `task.created`는 기본 숨김, 상세 모드에서 표시한다.

BoardView 연결:

- task card는 `delegated_by` 또는 latest audit actor가 있으면 작은 actor chip을 표시한다.
- task drawer에는 “created by / assigned to / claimed by / completed by” audit row를 붙인다.
- BoardView의 assignee filter는 그대로 사용하되, org overlay와 같은 count source를 공유한다.

## v1.3 실행 최소항목

1. store helper `add_audit_event(board, action, actor, target, payload)` 설계 및 구현.
2. `create_task`, `claim_next`, `complete`, `block`, comment, node spawn/update/despawn 경로에 audit payload 추가.
3. `/api/audit` read-only endpoint 추가. `limit`, `cursor`, `action`, `node`, `task_id` 필터만 MVP로 둔다.
4. `/api/org/live` 또는 `/api/org?live=1`로 `delegation_edges`와 node workload count 제공.
5. Board WS는 audit event 발생 시 liveTick만 깨우도록 유지.
6. OrgChart에 delegation overlay와 edge drawer 추가.
7. Audit lane FE 추가. viewer role은 MVP에서 403 또는 redacted summary.
8. 테스트: audit event append, project filtering, role gate, redaction, org edge aggregation, WS wake-up.

## 한계와 오픈 퀘스천

- local-token 모드에서는 멤버 actor를 알 수 없다. `lead` 또는 `local` actor로 남기는 것이 정직하다.
- `from_node`는 자동 추론이 어렵다. `grove delegate --from` 또는 node env가 들어오기 전에는 member→node assign으로 보일 수 있다.
- node despawn이 TS CLI에서 직접 registry를 바꾸면 web audit를 우회할 수 있다. v1.3에서는 dashboard/API 경로부터 보장하고, CLI는 web이 있으면 audit POST를 시도하는 보조 방식을 검토한다.
- 기존 `events` 테이블은 board scoped다. auth login/logout, member 변경, secret rotation은 별도 team-auth audit store가 더 적합하다.
- audit payload가 커지면 events table이 board WS와 같이 커진다. v1.4에서는 retention/compaction 또는 separate materialized audit table을 검토한다.

---

# B. V3-W4 cost/observability

## 데이터모델

권장안은 “측정값과 추정값을 같은 API에 넣되, 모든 항목에 `source`와 `confidence`를 붙이는 best-effort 모델”이다. 토큰/크레딧 surface는 CLI별로 불균일하므로, v1.3에서 비용을 확정값처럼 보이면 안 된다.

기본 snapshot:

```json
{
  "project": "dev10",
  "generated_at": 1780000000,
  "window": { "since": 1779990000, "until": 1780000000 },
  "totals": {
    "input_tokens": 12000,
    "output_tokens": 3400,
    "total_tokens": 15400,
    "cost_usd_estimate": null,
    "confidence": "partial"
  },
  "by_agent": {
    "codex": { "nodes": 2, "total_tokens": 8000, "confidence": "partial" },
    "claude": { "nodes": 1, "total_tokens": 5000, "confidence": "partial" },
    "agy": {
      "nodes": 1,
      "total_tokens": 2400,
      "credit_remaining": null,
      "credit_status": "unknown",
      "confidence": "unknown"
    }
  },
  "nodes": [
    {
      "node": "maker-1",
      "agent": "codex",
      "status": "idle",
      "last_seen_at": 1780000000,
      "turns": 4,
      "input_tokens": 1000,
      "output_tokens": 600,
      "source": "transcript",
      "confidence": "partial",
      "errors": []
    }
  ]
}
```

데이터 출처:

- registry: node name, agent type, session id, transcript path, tmux pane. 근거는 `src/registry.ts:7`부터 `src/registry.ts:30`까지다.
- bridge grove runner metadata: completed run에는 node, session, transcript path가 metadata로 남는다. 근거는 `bridge/src/grove_bridge/grove.py:166`부터 `bridge/src/grove_bridge/grove.py:177`까지다.
- board runs: task/run completion metadata와 summary를 사용해 task 단위 비용 attribution을 묶을 수 있다.
- transcript/log parser: 각 adapter transcript에서 `usage`, `token_usage`, `input_tokens`, `output_tokens`, `total_tokens`, `cost` 같은 필드를 best-effort로 읽는다.
- CLI status: `auth_status`는 로그인 여부만 안정적으로 알려준다. credit/usage는 별도 collector가 필요하다.
- agy credit: v1.3 MVP에서는 가장 중요한 signal로 다루되, 확실한 local source를 발견하지 못하면 `credit_status="unknown"`을 경고색으로 표시한다. 추정 burn rate와 실제 잔여 credit을 섞지 않는다.

가격 모델:

- v1.3은 hard-coded 가격표를 넣지 않는다.
- 선택 파일 `~/.grove/cost/prices.json`에 agent/model별 단가를 넣으면 `cost_usd_estimate`를 계산한다.
- 가격표가 없으면 token/turn count만 보여준다.

node-status detail:

```json
{
  "nodes": [
    {
      "name": "maker-1",
      "agent": "codex",
      "status": "idle|running|stale|error|blocked|dead",
      "status_reason": "pending turn 12m|pane missing|last task blocked",
      "last_seen_at": 1780000000,
      "pending_since": null,
      "transcript_mtime": 1779999900,
      "tmux_pane": "dev10:1.2",
      "tmux_alive": true,
      "current_task_id": null,
      "blocked_task_count": 0,
      "error": null
    }
  ]
}
```

status 계산:

- `running`: registry pending 또는 board running task가 있음.
- `blocked`: assignee의 blocked task가 있음.
- `stale`: transcript mtime 또는 pending age가 threshold를 넘음.
- `dead`: registry pane이 있지만 tmux pane/session이 없음.
- `error`: registry node error, adapter/session probe failure, recent runner failure.
- `idle`: 위 조건이 모두 아님.

## API

`GET /api/cost`

Query:

```text
project=<session>        # header와 동일한 의미, header 우선
window=24h|7d|all
node=maker-1
agent=codex|claude|agy
include=nodes,runs,sources
```

권한:

- local-token: token 통과 시 허용.
- team-cookie: `admin`/`operator` full. `viewer`는 aggregate만 허용하거나 403으로 시작한다. v1.3 MVP는 aggregate-only보다 403이 단순하다.

`GET /api/status?detail=1`

- 기존 summary shape는 유지한다.
- `detail=1`이면 `nodes_detail` 배열을 추가한다.
- FE `NodeStatusBar`는 backend의 `idle/error` count를 그대로 쓰고, click 시 detail drawer를 연다.

`GET /api/metrics/board`

V3-W4에서 같이 넣을 수 있는 작은 board metrics:

```json
{
  "throughput_24h": 7,
  "lead_time_p50_seconds": 1800,
  "blocked_count": 2,
  "released_stale_count": 1
}
```

이 값은 events table과 runs table만으로 계산한다. cost와 같은 화면에 넣되 API는 분리한다.

## FE

Cost view:

- dashboard 상단 또는 Operations 탭에 “Usage” panel을 둔다.
- Agent별 카드: codex, claude, agy.
- 각 카드: turns, input/output/total tokens, estimated cost, confidence, source age.
- agy card는 `credit_status`를 크게 보여준다. `unknown`도 회색이 아니라 주황 warning으로 둔다. 이유는 unknown이면 소진을 예측할 수 없기 때문이다.
- node table: node, agent, status, last seen, turns, tokens, source, confidence.
- source tooltip: transcript, run metadata, CLI status, estimated 등.

Node status detail:

- 현재 NodeStatusBar는 `running/idle/stale`만 보여준다. v1.3에서는 `error`, `blocked`, `dead` chips를 추가한다.
- org node card에는 status reason tooltip을 붙인다.
- terminal drawer와 task drawer에서 current task / last completed run / last error를 링크한다.

Audit/cost 연결:

- audit lane에서 task complete event를 누르면 cost node row로 필터링한다.
- cost node row를 누르면 해당 node의 org card와 recent task list를 강조한다.

## v1.3 실행 최소항목

1. registry + board runs + transcript paths를 모으는 `UsageCollector` 인터페이스 설계.
2. adapter별 parser v0: 확실히 읽히는 token 필드만 추출하고, 없으면 unknown으로 둔다.
3. `/api/cost` aggregate + node rows 제공. price table이 없으면 cost estimate는 null.
4. agy credit field를 별도 최상위 signal로 노출: `credit_status=ok|low|unknown`, `credit_remaining`, `source`.
5. `/api/status?detail=1`로 per-node status, last_seen, reason 제공.
6. FE Usage panel + NodeStatusBar detail 확장.
7. 테스트: parser fixture, unknown handling, price-table optional, role gate, no secret/absolute path leakage.

## 한계와 오픈 퀘스천

- 각 CLI transcript/log format은 안정 API가 아닐 수 있다. parser는 best-effort여야 하며 실패가 dashboard 500으로 번지면 안 된다.
- agy credit 잔여량의 신뢰 가능한 local source를 별도 조사해야 한다. 찾기 전까지는 `unknown`을 warning으로 보여주는 것이 맞다.
- token usage와 실제 과금은 다를 수 있다. model, cache, 무료 credit, plan 할인은 v1.3에서 정확히 반영하지 않는다.
- transcript path가 없거나 rebind 전인 node는 usage를 알 수 없다.
- terminal stream을 token source로 쓰지 않는다. 화면 캡처는 사람이 보는 UI이지 계량 원장이 아니다.
- cost panel은 민감할 수 있다. team auth role policy가 먼저 안정되어야 remote viewer에게 노출할지 결정할 수 있다.
- retention: transcript가 rotate/compact되면 historical cost는 사라질 수 있다. v1.4에서는 usage snapshots를 별도 sqlite table에 적재한다.
