# v1.29 orch-product architecture pass

상태: 구현 전 handoff spec. 코드 변경 없이 source task 두 건을 기준으로 정리했다.

Source tasks:

- `task_ae67d84bb52f4ee394ca39d05d825f83`: 보드 컬럼/상태 모델 재설계, 완료 작업 가시화, 1:1:1 단일 보드 전제.
- `task_993d7a97d270482b95ed636d2acecc29`: 조직도 위임 엣지의 의미, 현재/누적 구분, 실시간 UX 정의.

현재 근거:

- Store는 task `status`를 문자열로 보관하고 `ready -> running -> done`, `running -> blocked`, `blocked -> ready`를 직접 수행한다 (`bridge/src/grove_bridge/store.py:179`, `bridge/src/grove_bridge/store.py:462`, `bridge/src/grove_bridge/store.py:601`, `bridge/src/grove_bridge/store.py:716`, `bridge/src/grove_bridge/store.py:817`).
- 실행 내부 FSM은 task status가 아니라 metadata/run event의 `claimed/preflight/executing/complete` 계열이다 (`bridge/src/grove_bridge/store.py:23`, `bridge/src/grove_bridge/pull_executor.py:401`).
- Board API는 project-scoped `GET /api/boards/{board}/tasks`, query, create만 있고 수동 상태 변경 endpoint는 아직 없다 (`bridge/src/grove_bridge/web_app.py:1080`, `bridge/src/grove_bridge/web_app.py:1100`, `bridge/src/grove_bridge/web_app.py:1239`).
- 현재 FE 컬럼은 `triage/todo/scheduled/ready/running/blocked/review/done`이며 unknown status fallback은 있다 (`web/src/constants.ts:3`, `web/src/components/BoardView.tsx:211`).
- 현재 OrgChart의 위임 overlay는 최근 audit assign/delegate event를 누적 집계한다 (`web/src/components/OrgChart.tsx:584`, `web/src/components/OrgChart.tsx:791`).

## 1. Board Status Model

권장 persisted/display model:

| Column key    | Label       | Source of truth                                                                                          | Meaning                                                                                                                               |
| ------------- | ----------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `ready`       | Ready       | `tasks.status = "ready"`                                                                                 | 실행 가능한 backlog. Pull executor와 사람 모두 여기서 시작한다.                                                                       |
| `in_progress` | In Progress | canonical target; legacy `running/claimed/executing` maps here                                           | 작업자가 실제 세션에서 수행 중. Backend v1.29는 legacy `running` 저장을 허용하되 FE/API normalized status는 `in_progress`를 노출한다. |
| `review`      | Review      | `tasks.status = "review"`                                                                                | maker가 끝냈고 per-task reviewer pool이 pull/review할 차례.                                                                           |
| `done`        | Done        | `tasks.status = "done"` plus aliases `complete/completed`                                                | 완료. 기본 board에서 계속 보이며 count와 card에 남는다.                                                                               |
| `blocked`     | Blocked     | `tasks.status = "blocked"` and no human gate flag                                                        | 실행자가 막혔지만 사람 답변 전용은 아닌 상태.                                                                                         |
| `ask_human`   | Ask Human   | v1.29 MVP: virtual column from `status="blocked" && metadata.needs_human=true`; later persisted optional | 사람 판단/답변 대기. Decision inbox와 같은 의미로 보인다.                                                                             |

Column order is `ready -> in_progress -> review -> done`, then exception columns `blocked`, `ask_human` 또는 UI 밀도상 `blocked/ask_human`을 별도 lane/side bucket으로 둔다. `done`은 숨기지 않는다. 필터가 없으면 `GET /api/boards/default/tasks`는 done을 포함한 모든 task를 반환해야 한다.

Legacy compatibility:

- Input aliases accepted by API: `running`, `claimed`, `executing` => `in_progress`; `complete`, `completed` => `done`; `ask-human`, `ask_human_pending` => `ask_human`.
- Store compatibility: pull executor가 아직 `status="ready"`를 claim하고 `status="running"`을 찾는 동안에는 DB 저장값 `running`을 유지해도 된다. API payload에 `status`는 canonical `in_progress`, `raw_status`는 optional legacy value로 줄 수 있다.
- Execution metadata aliases (`claimed/preflight/executing/complete`) are not board columns. Task drawer/timeline may show them as execution phases only.

Reviewer pool:

- Add task metadata shape:

```json
{
  "review": {
    "pool": ["reviewer-a", "reviewer-b"],
    "requested_by": "maker-1",
    "requested_at": 1780567259,
    "claimed_by": null,
    "claimed_at": null,
    "source_run_id": "run_..."
  }
}
```

- `review` status is pullable only by nodes in `metadata.review.pool` unless operator overrides.
- `assignee` remains the implementation owner until review claim. `review.claimed_by` is the reviewer owner. FE card should show assignee plus reviewer chip when present.

## 2. Manual State Transitions

Recommended API surface:

- `GET /api/boards/{board}/workflow`: returns columns, aliases, allowed transitions, default column order, reviewer candidates.
- `POST /api/tasks/{task_id}/transition`: body `{ "to_status": "review", "reason": "...", "assignee": "optional-node", "reviewer_pool": ["node"], "idempotency_key": "..." }`.
- `POST /api/tasks/{task_id}/assign`: body `{ "assignee": "node", "reason": "...", "reviewer_pool": ["optional"] }`; may be folded into transition for MVP, but explicit assign is clearer for audit and org edges.

Rules:

- All manual transitions are `_require_operator_state_change` style: operator/admin only, CSRF/Origin checked, project-scoped through `X-Grove-Project`, and recorded in board events (`bridge/src/grove_bridge/web_app.py:1184`, `bridge/src/grove_bridge/web_app.py:1245`, `bridge/src/grove_bridge/web_app.py:696`).
- Board store is the source of truth. FE drag/drop/dropdown never mutates local-only state.
- Audit kinds: `audit.task.transition`, `audit.task.assign`, `audit.task.review_claim`, `audit.task.review_complete`. Payload must include `from_status`, `to_status`, actor, target task, project, board, redacted reason.
- Allowed transitions:
  - `ready -> in_progress`: claim/manual start.
  - `in_progress -> review`: maker done, review required.
  - `review -> done`: reviewer approve.
  - `review -> in_progress`: changes requested; require comment/reason and restore assignee to maker.
  - `ready|in_progress|review -> blocked|ask_human`: block with reason; preserve `previous_status`.
  - `blocked|ask_human -> ready`: answer/unblock; preserve comment.
  - `done -> review|in_progress`: operator reopen only, reason required.
- If review is disabled for a task/project, `in_progress -> done` remains allowed. If review is enabled, direct complete is a reviewed override and must be audited.

## 3. Delegation Edges

Use two product names:

- **Current delegation**: live snapshot of active work ownership. Derived from open board tasks, not from cumulative audit. Edge `from_node/member -> assignee` means "this actor currently has open work assigned to that node." Review edges use `from_node/member -> review.claimed_by` when claimed, otherwise `from_node/member -> reviewer_pool` as a pool edge. Done/archived tasks do not create current edges.
- **Delegation history**: cumulative audit trail from `audit.task.assign`, `audit.task.delegate`, `audit.task.transition`, `audit.task.review_*`. This is what the current OrgChart overlay already approximates from `/api/audit`; rename the toggle from "위임 흐름" to "위임 기록" unless it switches to snapshot data.

Snapshot fields:

```json
{
  "from": "lead",
  "to": "maker-1",
  "kind": "implementation|review_pool|review_claim",
  "task_ids": ["task_..."],
  "count": 3,
  "latest_assigned_at": 1780567259,
  "oldest_open_updated_at": 1780562895,
  "stale": false
}
```

Recommended endpoints:

- `GET /api/org/delegations/current?project=...`: current snapshot, project-scoped, viewer-readable.
- `GET /api/org/delegations/history?cursor=&limit=&since=&node=`: audit-backed history, same shape as `/api/audit` but pre-grouped for graph rendering.

Live UX:

- Current delegation updates on board WS whenever task create/assign/transition/comment/unblock/complete changes the snapshot. Edges animate in/out; done removes current edge but done card remains visible.
- History does not disappear. It shows count, latest timestamp, and optional time window. Stale means "no open task update/heartbeat within threshold" for current delegation only; history uses "last seen" rather than stale.
- Tooltip copy must say either "현재 위임: 열린 작업 N개" or "위임 기록: 최근/누적 N회" to avoid the ambiguity in `task_993d...`.

## 4. Cross-Project Org Mental Model

Product graph:

```text
GROVE MASTER
  -> project lead: dev10
       -> project-master
       -> workers/reviewers
  -> project lead: other-project
       -> project-master
       -> workers/reviewers
```

Click behavior:

- Clicking `GROVE MASTER` opens the floating MasterChat for the current or global context. It does not switch project or execute actions.
- Clicking another project lead switches project through the same path as `ProjectSwitcher` (`setProject`, clear selected pane, bump project tick), then opens that project's org view (`web/src/app.tsx:271`, `web/src/app.tsx:321`).
- Clicking the current project lead opens its node drawer or read-only terminal if `terminal_allowed` is true. Node-send remains blocked by backend flags.

Recommended API:

- Keep `/api/org` project-scoped for the active project (`bridge/src/grove_bridge/web_app.py:1671`, `bridge/src/grove_bridge/web_app.py:6323`).
- Add `GET /api/org/global`: returns `{ root, projects: [{ name, lead_node, status, node_count, current, click_action }] }` using existing `/api/projects` data as the minimal source (`bridge/src/grove_bridge/web_app.py:997`).
- Later, optionally lazy-load each project's `/api/org` after switching; do not expose all project node details in one global response until scope/redaction policy is explicit.

## 5. FE Implementation Implications

- Replace board columns with canonical workflow columns. Keep fallback column for unknown legacy statuses, but map known aliases before grouping.
- Add task card badges: `assignee`, `reviewer_pool`/`review.claimed_by`, `stale`, `done visible`.
- Add drag/drop or dropdown transition control only after backend transition API exists; until then UI must stay read-only for status changes.
- Task drawer should expose "Move to review", "Approve done", "Request changes", "Block", "Ask human", "Reopen" according to workflow API, role, and current status.
- OrgChart needs a mode switch: `Current delegation` from snapshot endpoint vs `Delegation history` from audit endpoint. Existing audit overlay should be relabeled history if no snapshot endpoint lands in the same slice.
- Cross-project org can start as a compact tree above/inside OrgChart: MASTER root + project leads. Non-current project lead click delegates to existing project switcher logic.

## 6. Risks

- Breaking pull executor if persisted `running` is renamed too early. Mitigation: alias layer first, then migrate executor/store together.
- Review status can strand tasks if no reviewer pool is present. Mitigation: require pool on `in_progress -> review` or default to project reviewer candidates; surface "no reviewer" as blocked-like warning.
- Current delegation can be misleading without a `delegated_by` field. Mitigation: on task create/assign store `metadata.delegated_by` from actor/from_node and keep audit fallback only for legacy tasks.
- Done visibility can overload board performance. Mitigation: show recent done by default plus explicit "all done" pagination only if task count becomes large; never make count zero by hidden filtering.
- Cross-project org can leak project metadata. Mitigation: global org returns project lead summaries only, uses same auth/project list policy, and lazy-loads details after switch.
