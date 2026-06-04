# grove v1.19+ 브레인스토밍

작성일: 2026-06-04

## 전제

- v1.16은 signed read-only aggregation을 출시했고, v1.17은 receiver-local cross-room handoff를 출시했다.
- v1.18은 tailnet 멀티유저 접속을 진행 중인 것으로 둔다. 여러 사용자가 한 호스트 대시보드에 접속해 프로젝트를 만들고, 호스트의 로컬 CLI 세션과 리소스를 함께 쓰는 모델이다.
- v1.19는 이 공유 호스트 모델을 제품으로 안전하게 만들기 위해 **per-user quota/rate, 선택적 per-user sandbox, presence/협업 고도화, 운영 인사이트와 알림**을 묶는 단계가 적합하다.
- 원칙은 실제 CLI 세션, 로컬 호스트 소유권, 보드=위임 프로토콜, receiver-local accept, privacy deny-by-default, 감사 가능한 사용자 action이다.
- v1.19에서도 cross-room executor routing, 자동 handoff accept, hard budget enforcement는 기본 scope에서 제외한다.

## 우선순위 기준

- **P0**: v1.19 핵심 후보. 멀티유저 호스트가 안정적으로 운영되려면 반드시 필요한 공정성, 격리, 실시간 협업 기반이다.
- **P1**: v1.19 stretch 또는 v1.20 후보. 가치가 크지만 정책 UX, 비용 신뢰도, 팀 습관 검증이 더 필요하다.
- **P2**: v1.21+ 후보. 자동 실행, 강제 비용 차단, 원격 action처럼 위험 경계가 큰 기능이다.

## 1. v1.19+ 후보 목록

| 우선 | 아이디어                                | 한 줄                                                                                                           | 가치                                                       | 규모 | CLI/역할                        | 의존성                                            | 위험/완화                                                                         |
| ---- | --------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- | ---- | ------------------------------- | ------------------------------------------------- | --------------------------------------------------------------------------------- |
| P0   | **per-user resource ledger**            | member별 project, node, task, run, turn, spawn, cost/usage estimate를 감사 가능한 ledger로 집계한다.            | quota/rate와 비용 리포팅의 공통 원장이 된다.               | M    | bridge codex, security reviewer | team auth, usage reporting, audit events          | 사용자 추적 과다 위험. 최소 필드, redaction, admin-only detail, retention policy. |
| P0   | **per-user quota policy v1**            | 사용자별 active project/node, concurrent run, daily turn, spawn count, usage hint 한도를 설정한다.              | 공유 호스트에서 한 사용자가 리소스를 독점하지 못하게 한다. | M/L  | bridge codex, FE claude         | resource ledger, team roles, node registry        | 작업 차단 오판 위험. soft quota 우선, override with audit, clear reason.          |
| P0   | **per-user rate limiter**               | spawn, ask, delegate, project start, API write action에 사용자별 burst/cooldown을 적용한다.                     | 실수나 자동 반복이 호스트를 밀어내는 것을 막는다.          | M    | bridge codex, qa agy            | team auth, audit actor, web API middleware        | 정상 작업 지연 위험. per-action policy, retry-after 표시, admin override.         |
| P0   | **host pressure guardrails**            | CPU, memory, pane count, active run count, queue depth가 높으면 새 spawn/start를 제한한다.                      | 사용자가 늘어도 호스트가 죽지 않게 한다.                   | M/L  | bridge codex, ops reviewer      | node status, process monitor, quota policy        | 과보수 제한 위험. thresholds preview, degrade gracefully, existing runs 우선.     |
| P0   | **fair start queue**                    | project start와 node spawn 요청을 사용자별 공정 queue로 처리한다.                                               | 여러 사용자가 동시에 시작해도 선착순 독점과 충돌을 줄인다. | M    | bridge codex, FE claude         | rate limiter, project registry, node spawn        | UX 답답함 위험. position/ETA 표시, cancel, priority only for admin.               |
| P0   | **optional per-user sandbox v0**        | 사용자별 workspace root, env allowlist, secret namespace, temp dir을 분리하는 선택 모드를 제공한다.             | 피어 간 실수로 파일/환경을 건드리는 위험을 줄인다.         | L    | security reviewer, bridge codex | project creation, workspace policy, env injection | 복잡도와 호환성 위험. off by default, project-level opt-in, clear limitations.    |
| P0   | **sandbox boundary preview**            | sandbox를 켜기 전 접근 가능한 path/env/secret scope를 preview한다.                                              | 격리 정책을 이해하고 안전하게 적용한다.                    | M    | FE claude, security reviewer    | sandbox v0, redaction, project settings           | 잘못된 안전감 위험. "best-effort" 표시, explicit unsupported cases.               |
| P0   | **presence v2 live activity**           | 누가 어떤 project/tab/task/node/terminal을 보고 있는지 live presence로 표시한다.                                | 멀티유저가 서로의 작업 맥락을 실시간으로 이해한다.         | M    | FE claude, bridge codex         | team auth, websocket, audit actor                 | 감시 느낌 위험. coarse activity, opt-out for detail, private tabs.                |
| P0   | **collaboration cursors and focus**     | task drawer, board card, terminal view에서 사용자 cursor/focus를 표시한다.                                      | 같은 작업을 동시에 보는 충돌과 중복 질문을 줄인다.         | M    | FE claude                       | presence v2, board UI, terminal viewer            | UI noise 위험. subtle indicators, collapse inactive, no text capture.             |
| P0   | **shared action audit feed**            | 멤버별 create/spawn/delegate/approve/kill/handoff accept 같은 중요 action을 feed로 보여준다.                    | 누가 무엇을 바꿨는지 즉시 추적한다.                        | M    | FE claude, reviewer claude      | audit events, team roles, redaction               | blame culture 위험. operational language, filters, admin detail gate.             |
| P0   | **retro analytics for multi-user host** | self-retro와 human incident note를 member/project/node/theme별로 집계하되 blame-free로 표시한다.                | 호스트 공유 과정에서 반복되는 병목과 마찰을 학습한다.      | M    | reviewer claude, agy reviewer   | retro lane, resource ledger, audit events         | 개인 평가로 오해될 위험. system theme 중심, sample size, confidence.              |
| P0   | **usage/cost trend reporting v2**       | user/project/node/agent/day별 usage, known/unknown cost, quota pressure, anomaly를 표시한다.                    | 공정 분배와 비용 관리를 같은 화면에서 본다.                | M/L  | bridge codex, FE claude         | /api/usage, resource ledger, aggregation          | 비용 source 부정확 위험. known/unknown 분리, estimate badge, hard block 금지.     |
| P0   | **notification routing v2 for members** | 조건, severity, target member/role, quiet hours, digest, escalation, multi-channel fanout을 제공한다.           | 사람 판단이 필요한 일을 올바른 멤버에게 보낸다.            | M/L  | bridge codex, FE claude         | team auth, notification rules, presence           | 알림 누락/과다 위험. dry-run, safe defaults, per-rule audit, digest fallback.     |
| P0   | **multi-user alert overlay**            | host pressure, quota near-limit, sandbox violation, stale node, handoff wait, usage anomaly를 한 피드에 모은다. | 공유 호스트의 운영 위험을 한눈에 본다.                     | M    | FE claude, bridge codex         | alert overlay, quota/rate, node status            | 중앙 통제 오해 위험. local host only, read-first, explicit action confirm.        |
| P1   | **quota simulator**                     | 새 quota/rate 정책을 지난 7일 ledger에 적용했을 때 누가 얼마나 제한됐을지 보여준다.                             | 정책을 적용하기 전 팀에 맞게 조정한다.                     | M    | bridge codex, FE claude         | resource ledger, quota policy                     | 과거 데이터 편향 위험. sampled window, explain limits, dry-run only.              |
| P1   | **per-user sandbox hardening**          | sandbox v0에 path allowlist enforcement, env scrub, secret mount policy를 강화한다.                             | 격리 신뢰도를 높인다.                                      | L    | security reviewer, bridge codex | sandbox v0, process launcher                      | 호환성 깨짐 위험. opt-in, audit denials, project templates.                       |
| P1   | **presence-based collision warnings**   | 같은 task/node를 여러 사용자가 동시에 수정/명령하려 하면 경고한다.                                              | 중복 지시와 상충 action을 줄인다.                          | S/M  | FE claude, bridge codex         | presence v2, action audit                         | 과도한 경고 위험. warn-only, allow proceed, cooldown.                             |
| P1   | **shared notes on task and node**       | task/node에 멤버가 짧은 운영 note를 남기고 presence와 연결한다.                                                 | 실시간 대화 없이도 맥락을 남긴다.                          | M    | FE claude, reviewer claude      | comments, team auth, audit actor                  | 잡담/노이즈 위험. pinned summary, resolve, notification opt-in.                   |
| P1   | **retro-to-action candidate board**     | 반복 retro insight를 owner confirm 후 board candidate로 제안한다.                                               | 회고가 실제 개선 작업으로 이어진다.                        | M    | planner claude, reviewer claude | retro analytics, board create, dedupe             | task 폭증 위험. suggestion-only, merge duplicate, owner confirm.                  |
| P1   | **quota-aware routing planner**         | node 추천 시 현재 user quota, host pressure, cost trend를 함께 반영한다.                                        | 리소스 공정성을 위임 판단에 녹인다.                        | M    | planner claude, bridge codex    | routing planner, quota ledger, usage trend        | 추천이 불투명할 위험. factor breakdown, confidence, read-only.                    |
| P1   | **member digest and escalation matrix** | 멤버별 quiet hours, backup, escalation target, digest cadence를 관리한다.                                       | 알림이 팀 운영 방식에 맞게 흐른다.                         | M    | security reviewer, FE claude    | notification v2, team roles                       | 정책 파편화 위험. inherited defaults, templates, audit.                           |
| P1   | **host capacity forecast**              | 최근 사용량과 active node 추세로 호스트 리소스 고갈 시점을 예측한다.                                            | 새 작업 시작 전 capacity를 판단한다.                       | M    | bridge codex, ops reviewer      | usage trend, pressure metrics                     | 예측 과신 위험. confidence band, no auto block, admin hint only.                  |
| P1   | **collaborative review room**           | 특정 task/handoff에 멤버들이 같은 drawer와 terminal view를 보며 review note를 남긴다.                           | 사람 리뷰와 QA 협업을 제품 안에서 처리한다.                | M/L  | FE claude, reviewer claude      | presence, shared notes, terminal viewer           | 화면 과밀 위험. focused mode, role filters, no terminal input by viewers.         |
| P2   | **hard per-user budget enforcement**    | quota 초과 시 autonomous execution과 spawn을 강제 차단한다.                                                     | 비용과 리소스를 강하게 통제한다.                           | M/L  | security reviewer, bridge codex | reliable usage, quota maturity, override policy   | 잘못된 차단 위험. v1.19는 soft quota/rate 중심.                                   |
| P2   | **trusted user auto-override**          | 특정 멤버는 quota/rate 제한을 자동 우회한다.                                                                    | 운영자 마찰을 줄인다.                                      | M    | security reviewer, bridge codex | role model, audit                                 | 권한 남용 위험. explicit admin override만 우선, auto는 후속.                      |
| P2   | **remote multi-room action surface**    | aggregation view에서 다른 room의 action을 직접 수행한다.                                                        | 중앙 운영 편의가 커진다.                                   | L    | security reviewer, FE claude    | auth federation, signed command, audit            | 중앙 제어 위험. v1.19에서는 local host action만.                                  |
| P2   | **cross-room executor routing**         | 다른 room의 실제 CLI 세션을 실행 substrate로 사용한다.                                                          | 전문성과 여유 리소스를 공유한다.                           | L    | bridge codex, ops reviewer      | handoff workflow, trust, backpressure             | credential/trust 경계 붕괴 위험. handoff 안정화 후 검토.                          |

## 2. 제안 v1.19 스코프

v1.19의 권장 테마는 **"fair multi-user host"**이다. v1.18이 tailnet 멀티유저 접속을 열면, 다음 문제는 사용자가 늘어도 호스트가 예측 가능하게 동작하고, 누가 무엇을 하는지 보이며, 필요할 때만 격리와 제한을 켤 수 있게 하는 것이다. v1.19는 자동화를 늘리기보다 공유 호스트의 운영 안전성과 협업 감각을 먼저 잡는다.

### v1.19 핵심 항목

1. **per-user resource ledger + soft quota**
   - member별 project/node/run/turn/spawn/action/usage를 집계한다.
   - active project/node, concurrent run, daily turn, spawn count에 soft quota를 둔다.
   - 제한은 clear reason, retry-after, admin override with audit를 제공한다.

2. **per-user rate limiter + host pressure guardrails**
   - spawn, ask, delegate, project start, API write action에 burst/cooldown을 적용한다.
   - CPU, memory, pane count, active run count, queue depth가 높으면 새 start/spawn을 제한한다.
   - existing run은 가능하면 유지하고 새 작업만 queue/defer한다.

3. **optional per-user sandbox v0**
   - 사용자별 workspace root, env allowlist, secret namespace, temp dir 분리를 선택적으로 제공한다.
   - sandbox boundary preview로 적용 전 path/env/secret scope를 보여준다.
   - off by default로 두고 project-level opt-in과 명확한 한계를 표시한다.

4. **presence and collaboration v2**
   - 누가 어떤 project/task/node/terminal을 보고 있는지 coarse presence로 표시한다.
   - task drawer와 terminal view에 cursor/focus를 보여주고 collision warning은 warn-only로 둔다.
   - shared action audit feed로 중요한 변경을 즉시 추적한다.

5. **operational insight and notifications**
   - retro analytics, usage/cost trend v2, quota pressure, host pressure, anomaly를 같은 운영 surface에서 본다.
   - notification routing v2는 target member/role, quiet hours, digest, escalation, multi-channel fanout을 지원한다.
   - multi-user alert overlay는 host pressure, quota near-limit, sandbox violation, stale node, handoff wait를 모은다.

### v1.19 exit criteria

1. resource ledger가 member/project/node/run/turn/spawn/action/usage를 감사 가능한 형태로 집계한다.
2. soft quota가 active project/node, concurrent run, daily turn, spawn count에 적용되고 reason/override를 제공한다.
3. rate limiter가 주요 write action에 burst/cooldown/retry-after를 제공한다.
4. host pressure guardrail이 높은 pressure에서 새 start/spawn을 queue/defer하고 기존 run을 우선 보호한다.
5. fair start queue가 사용자별 queue position, ETA, cancel을 표시한다.
6. optional sandbox v0가 workspace root, env allowlist, secret namespace, temp dir 정책을 project-level opt-in으로 제공한다.
7. sandbox boundary preview가 적용 전 접근 scope와 한계를 보여준다.
8. presence v2가 project/task/node/terminal 단위 coarse activity를 표시하고 private/detail opt-out을 제공한다.
9. collaboration cursor/focus와 shared action audit feed가 task/node/terminal 변경 맥락을 보여준다.
10. usage/cost trend v2가 user/project/node/agent/day별 known/unknown cost와 quota pressure를 표시한다.
11. notification routing v2가 target member/role, quiet hours, digest, escalation, multi-channel payload preview를 지원한다.
12. e2e는 quota/rate, pressure queue, sandbox preview, presence, audit feed, notification dry-run을 검증한다.

## 3. v1.20+ 백로그

| 후보                             | 설명                                                         | 넘기는 이유                                                    |
| -------------------------------- | ------------------------------------------------------------ | -------------------------------------------------------------- |
| quota simulator                  | 새 정책이 과거 ledger에 어떤 제한을 걸었을지 시뮬레이션한다. | v1.19 ledger와 soft quota 데이터를 먼저 쌓아야 한다.           |
| per-user sandbox hardening       | path/env/secret enforcement를 더 강하게 만든다.              | v0의 호환성 문제와 실제 사용 패턴을 먼저 봐야 한다.            |
| quota-aware routing planner      | node 추천에 user quota와 host pressure를 반영한다.           | quota 신뢰도와 planner factor 설명이 필요하다.                 |
| hard per-user budget enforcement | quota 초과 시 실행과 spawn을 강제 차단한다.                  | soft quota 오판과 override UX를 먼저 검증해야 한다.            |
| collaborative review room        | task/handoff 단위로 멤버들이 같은 view에서 리뷰한다.         | presence와 shared notes가 안정된 뒤 확장하는 편이 안전하다.    |
| remote multi-room action surface | aggregation view에서 다른 room action을 직접 수행한다.       | 중앙 제어 위험이 크므로 별도 보안 설계가 필요하다.             |
| cross-room executor routing      | 다른 room의 실제 CLI 세션으로 task를 실행한다.               | handoff, trust, backpressure, credential 경계가 모두 필요하다. |

## 4. 실행 순서 제안

1. **V19-W1 resource ledger**: member attribution, action/run/usage rollup, redaction, retention policy.
2. **V19-W2 quota and rate**: soft quota schema, rate limiter, retry-after, override audit, fair queue.
3. **V19-W3 host pressure**: CPU/memory/pane/run pressure, start/spawn defer, queue UI.
4. **V19-W4 sandbox v0**: workspace/env/secret/temp policy, boundary preview, project opt-in.
5. **V19-W5 presence/collaboration**: coarse presence, focus/cursor, collision warning, action feed.
6. **V19-W6 insight/notification**: user-level usage trends, retro rollup, notification routing, multi-user alert overlay, e2e.

## 5. 주요 리스크

- quota/rate는 정상 작업을 막을 수 있다. v1.19는 soft quota, retry-after, clear reason, admin override로 시작한다.
- 멀티유저 호스트는 리소스 고갈이 곧 전체 장애가 된다. pressure guardrails는 새 작업 제한 중심으로 설계하고 기존 run을 우선 보호한다.
- sandbox v0는 완전한 보안 경계로 오해될 수 있다. best-effort와 한계를 명확히 표시하고 project opt-in으로 둔다.
- presence는 감시처럼 느껴질 수 있다. coarse activity, private mode, detail opt-out, 짧은 retention이 필요하다.
- usage/cost는 여전히 source가 불완전하다. known/unknown/estimate를 분리하고 hard enforcement로 바로 연결하지 않는다.
- notification routing은 멀티유저에서 noise가 빠르게 늘어난다. dry-run, digest, dedupe, escalation cap, per-rule audit을 기본으로 둔다.
