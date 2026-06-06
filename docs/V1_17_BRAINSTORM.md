# grove v1.17+ 브레인스토밍

> Status: historical v1 brainstorm; superseded by the current v2 live cockpit model documented in `docs/design/MASTER_NODE.md` and `docs/agents/LEAD-HANDOFF.md`.
> 작성일: 2026-06-04

## 전제

- v1.14는 Slack 안전 명령 surface를 출시했고, v1.15는 execution timeline과 usage reporting을 출시했다.
- v1.16은 signed read-only aggregation을 진행 중인 것으로 둔다.
- v1.17은 여러 room을 읽기 전용으로 관측하는 단계에서 한 단계 나아가, **서명된 handoff와 다중-room 알림/리포팅**을 안전하게 붙이는 단계가 적합하다.
- 원칙은 여전히 로컬-퍼-멤버, 실제 CLI 세션, 보드=위임 프로토콜, privacy deny-by-default, 사람이 승인하는 경계다.
- v1.17에서는 remote executor routing이나 원격 mutating command를 기본으로 열지 않는다. handoff는 signed package + receiver-local accept 흐름으로 제한한다.

## 우선순위 기준

- **P0**: v1.17 핵심 후보. signed aggregation 위에서 실제 협업 판단을 가능하게 만드는 contract, 알림, 리포팅 기능이다.
- **P1**: v1.17 stretch 또는 v1.18 후보. 가치가 크지만 UX와 신뢰 정책 검증이 더 필요하다.
- **P2**: v1.19+ 후보. 원격 실행, 자동 생성, hard enforcement처럼 운영 위험이 큰 기능이다.

## 1. v1.17+ 후보 목록

| 우선 | 아이디어                                     | 한 줄                                                                                                                  | 가치                                                            | 규모 | CLI/역할                        | 의존성                                                | 위험/완화                                                                                 |
| ---- | -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- | ---- | ------------------------------- | ----------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| P0   | **signed handoff package v1**                | sender room이 task, context, expected result, cancel authority, callback, audit correlation을 서명된 package로 만든다. | room 간 작업 인계가 구두/복붙이 아니라 추적 가능한 계약이 된다. | M/L  | bridge codex, security reviewer | signed aggregation, board schema, privacy policy      | 민감 정보 전송 위험. deny-by-default field set, redaction report, signer/freshness 필수.  |
| P0   | **receiver-local accept flow**               | receiver room operator가 package를 검토하고 수락하면 자기 room board에 task를 생성한다.                                | 원격 제어 없이 로컬 소유자가 인계를 명시적으로 받아들인다.      | M    | FE claude, bridge codex         | handoff package, team roles, board create             | 무단 task 주입 위험. accept requires local role, preview before create, audit actor 기록. |
| P0   | **handoff status callback summary**          | receiver는 accepted/blocked/done/cancelled 요약을 signed callback으로 sender와 aggregator에 공유한다.                  | sender가 다른 room 진행 상황을 읽기 전용으로 추적한다.          | M    | bridge codex, FE claude         | signed identity, aggregation ingest, task metadata    | callback 위조/중복 위험. correlation id, monotonic sequence, idempotent ingest.           |
| P0   | **handoff inbox and audit lane**             | 들어온 handoff, 보낸 handoff, pending accept, callback event를 별도 inbox/audit filter로 본다.                         | room 간 작업의 책임 상태와 병목을 한 화면에서 본다.             | M    | FE claude, reviewer claude      | audit events, task drawer, aggregation UI             | 알림/상태 과밀 위험. status-first summary, filter, stale badge.                           |
| P0   | **retro analytics v1**                       | self-retro를 blocker, failure cause, verification issue, cost issue, improvement action으로 집계한다.                  | 개별 회고를 팀 운영 개선과 다음 작업 후보로 연결한다.           | M    | reviewer claude, agy reviewer   | self-retro lane, audit events, task metadata          | 표본이 작은데 결론처럼 보일 위험. sample size, confidence, source link 표시.              |
| P0   | **retro trend board**                        | 회고 주제의 증가/감소, 반복 실패, unresolved improvement를 시간축으로 보여준다.                                        | 같은 실수를 반복하는 영역을 조기에 찾는다.                      | M    | FE claude, reviewer claude      | retro analytics, trend reporting                      | 책임 추궁처럼 보일 위험. node blame 대신 system theme 중심으로 표시.                      |
| P0   | **usage and cost trend reporting v2**        | room/node/agent/day별 usage, unknown, estimate, cost risk를 추세와 예측으로 보여준다.                                  | 비용/크레딧 소진을 사전에 보고 위임 전략을 조정한다.            | M/L  | bridge codex, FE claude         | /api/usage, aggregation summary, confidence model     | 부정확한 비용 예측 위험. source/confidence/unknown 분리, hard block 금지.                 |
| P0   | **blocked and verification trend reporting** | blocked age, verification failure, abort/rollback, stale node 추세를 room별로 비교한다.                                | 실행 품질과 운영 병목을 비용 외 지표로 본다.                    | M    | FE claude, qa agy               | execution timeline, audit events, aggregation         | 비교가 경쟁 지표가 되는 위험. health-first copy, raw count와 rate 병기.                   |
| P0   | **notification routing v2**                  | 조건부 rule, severity, role target, quiet hours, digest, dedupe, escalation을 지원한다.                                | 중요한 ask-human/safety item은 놓치지 않고 일반 noise는 줄인다. | M    | bridge codex, FE claude         | notification rules, member roles, inbox               | 과소/과다 알림 위험. dry-run preview, per-rule audit, safe defaults.                      |
| P0   | **multi-room notification overlay**          | aggregator가 여러 room의 blocked/safety/stale/cost-risk 알림을 하나의 read-only feed로 모은다.                         | 팀 리드가 room별 알림을 따로 확인하지 않아도 된다.              | M/L  | FE claude, bridge codex         | signed aggregation, notification v2, privacy policy   | 중앙 action처럼 오해될 위험. read-only feed, local deep-link, no remote mutate.           |
| P1   | **handoff dry-run capability check**         | receiver profile과 package requirements를 비교해 missing capability/context를 전송 전 알려준다.                        | 잘못된 room으로 인계하는 실패를 줄인다.                         | M    | planner claude, bridge codex    | receiver capability profile, handoff schema           | capability 정보 노출 위험. coarse capabilities only, privacy policy 적용.                 |
| P1   | **handoff cancellation contract**            | sender/receiver가 cancel request, cancel accepted/rejected, partial result를 서명된 event로 교환한다.                  | room 간 작업 중단과 책임 상태를 명확히 한다.                    | M/L  | bridge codex, security reviewer | status callback, audit correlation                    | 중간 상태 충돌 위험. state machine, idempotency, local accept 원칙.                       |
| P1   | **retro-to-action suggestions**              | 반복 회고 항목을 board candidate로 제안하되 자동 생성하지 않는다.                                                      | 회고가 실제 개선 작업으로 이어진다.                             | M    | planner claude, reviewer claude | retro analytics, board create, dedupe                 | task 폭증 위험. suggestion-only, owner confirm, merge duplicate.                          |
| P1   | **predictive risk digest**                   | trend를 기반으로 다음 주 blocked/cost/verification risk를 digest로 제안한다.                                           | 운영자가 미리 리소스와 위임 방향을 조정한다.                    | M    | reviewer claude, FE claude      | trend reporting, usage forecast                       | 예측 과신 위험. confidence bucket, no automatic escalation unless configured.             |
| P1   | **notification simulation mode**             | rule 변경 전 지난 7일 이벤트에 적용했을 때 어떤 알림이 갔을지 보여준다.                                                | 알림 정책을 실제 적용 전에 튜닝한다.                            | M    | bridge codex, FE claude         | audit events, notification v2                         | 시뮬레이션 비용/복잡도 위험. bounded window, sampled preview.                             |
| P1   | **room-specific escalation policy**          | room별 operator/admin, quiet hours, critical override, digest schedule을 따로 둔다.                                    | 각 멤버의 로컬 운영 방식과 시간대를 존중한다.                   | M    | security reviewer, FE claude    | member roles, notification v2                         | 정책 파편화 위험. templates, inherited defaults, policy audit.                            |
| P1   | **aggregation notification SLA badges**      | ask-human/safety/cost-risk 알림이 얼마나 오래 unresolved인지 room별 badge로 표시한다.                                  | 장기 방치된 인간 판단 지점을 드러낸다.                          | S/M  | FE claude, bridge codex         | multi-room feed, audit timestamps                     | 압박 지표로 오해될 위험. SLA는 configurable, blame-free labels.                           |
| P2   | **remote handoff auto-accept**               | 신뢰된 sender의 low-risk package를 receiver room이 자동 수락한다.                                                      | 반복적인 안전한 인계의 마찰을 줄인다.                           | L    | security reviewer, bridge codex | handoff maturity, trust policy, risk scoring          | 무단 실행 위험. v1.17에서는 금지, later opt-in only.                                      |
| P2   | **cross-room executor routing**              | 내 board task를 다른 room의 실제 CLI 세션이 직접 처리한다.                                                             | 전문 room이나 여유 머신을 execution substrate로 활용한다.       | L    | bridge codex, ops reviewer      | handoff implementation, backpressure, auth federation | credential/trust 경계 붕괴 위험. handoff accept 모델 안정화 뒤 검토.                      |
| P2   | **hard cost enforcement across rooms**       | forecast가 초과 위험을 보이면 room별 autonomous execution을 차단한다.                                                  | 비용 폭주를 강하게 막는다.                                      | M/L  | bridge codex, security reviewer | reliable cost data, local kill gates                  | 잘못된 차단 위험. v1.17은 report/hint까지만.                                              |
| P2   | **remote notification actions**              | aggregation feed에서 approve/abort/kill 같은 action을 원격 room에 보낸다.                                              | 중앙 운영 편의성이 커진다.                                      | L    | security reviewer, FE claude    | signed command, auth, audit federation                | 중앙 제어 위험. local deep-link만 유지.                                                   |

## 2. 제안 v1.17 스코프

v1.17의 권장 테마는 **"signed coordination over read-only federation"**이다. v1.16이 여러 room의 상태를 안전하게 모으는 기반을 만들면, v1.17은 그 기반 위에 room 간 task handoff를 실제 운영 가능한 최소 형태로 올린다. 핵심은 sender가 package를 서명하고 receiver가 로컬에서 accept해야 board task가 생기는 구조다. 동시에 retro/trend/notification을 다중-room 관측과 연결해, 어떤 room에 사람 판단과 운영 리스크가 쌓이는지 보이게 한다.

### v1.17 핵심 항목

1. **signed handoff package + receiver-local accept**
   - sender는 task/context/result/cancel/callback/audit correlation을 포함한 package를 만든다.
   - receiver는 preview와 redaction report를 보고 로컬 operator 권한으로 accept한다.
   - accept 이후에만 receiver room board task가 생성되고, sender에는 signed status callback만 돌아간다.

2. **handoff inbox and callback tracking**
   - sent/received/pending/accepted/blocked/done/cancelled 상태를 inbox와 task drawer에서 본다.
   - callback은 correlation id와 sequence로 idempotent ingest한다.
   - stale callback, mismatched signer, duplicate event는 명확히 표시하고 무시한다.

3. **retro analytics + retro trend board**
   - self-retro를 반복 blocker, verification issue, cost issue, improvement action으로 집계한다.
   - trend board는 system theme 중심으로 보여주고 개인 blame metric은 만들지 않는다.
   - 반복 개선안은 suggestion까지만, board task 생성은 사람 confirm을 요구한다.

4. **usage/cost and execution trend reporting v2**
   - usage/cost는 source/confidence/unknown을 유지한 채 room/node/agent/day 추세를 제공한다.
   - blocked age, verification failure, rollback, stale node도 같은 reporting surface에 포함한다.
   - forecast는 hint로만 쓰고 hard enforcement나 자동 차단은 제외한다.

5. **notification routing v2 + multi-room overlay**
   - 조건부 rule, severity, role target, quiet hours, digest, dedupe, escalation을 제공한다.
   - aggregator는 여러 room의 notification summary를 read-only feed로 모은다.
   - remote action은 제공하지 않고 local room deep-link로 처리한다.

### v1.17 exit criteria

1. sender room에서 signed handoff package를 만들 수 있고 redaction report가 생성된다.
2. receiver room은 package preview를 보고 local accept 후 board task를 생성한다.
3. handoff callback은 accepted/blocked/done/cancelled 상태를 signed summary로 sender와 aggregator에 반영한다.
4. handoff inbox가 sent/received/pending/stale/mismatch 상태를 구분해 보여준다.
5. retro analytics가 self-retro를 theme, blocker, verification issue, cost issue, improvement action으로 집계한다.
6. retro trend board가 반복 issue와 unresolved improvement를 blame-free 방식으로 표시한다.
7. trend reporting이 usage/cost, blocked age, verification failure, rollback, stale node를 room/node/agent/day 단위로 보여준다.
8. forecast는 source/confidence/unknown을 표시하고 자동 차단을 만들지 않는다.
9. notification routing v2가 조건부 rule, severity, target role, quiet hours, digest, dedupe, escalation dry-run을 지원한다.
10. aggregation overlay가 여러 room의 notification summary를 read-only로 모으고 local deep-link만 제공한다.
11. e2e는 handoff package/accept/callback, retro analytics, trend report, notification routing dry-run, multi-room feed를 검증한다.

## 3. v1.18+ 백로그

| 후보                                    | 설명                                                                       | 넘기는 이유                                                         |
| --------------------------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| handoff cancellation full state machine | cancel request/accept/reject/partial result를 완전한 상태 전이로 다룬다.   | v1.17 callback 흐름을 먼저 운영에서 검증해야 한다.                  |
| handoff dry-run capability check 강화   | receiver capability, expected output, context sufficiency를 자동 검증한다. | capability profile의 privacy와 정확도 모델이 필요하다.              |
| retro-to-action task creation           | 회고 제안을 owner confirm 후 board task로 생성한다.                        | suggestion 품질과 dedupe가 먼저 안정되어야 한다.                    |
| predictive risk escalation              | 특정 risk forecast를 알림 escalation에 자동 연결한다.                      | 예측 confidence와 false-positive 완화가 필요하다.                   |
| remote handoff auto-accept              | trusted sender의 low-risk handoff를 자동 수락한다.                         | 무단 task 주입 위험이 크므로 별도 trust policy가 필요하다.          |
| cross-room executor routing             | 다른 room의 실제 CLI 세션을 executor로 사용한다.                           | credential, backpressure, cancel, audit federation이 모두 필요하다. |
| remote notification actions             | aggregation feed에서 원격 room action을 실행한다.                          | 중앙 제어 경계가 크므로 v1.17에서는 제외한다.                       |

## 4. 실행 순서 제안

1. **V17-W1 signed handoff schema**: package, redaction report, signer, correlation id, sequence, stale/mismatch rules.
2. **V17-W2 receiver accept flow**: preview, local role gate, board task creation, audit, rejection reason.
3. **V17-W3 callback and inbox**: callback summary, idempotent ingest, sent/received views, task drawer linkage.
4. **V17-W4 retro analytics**: retro parser, theme aggregation, trend board, source/confidence links.
5. **V17-W5 reporting v2**: usage/cost/blocked/verification/stale trends, forecast hints, multi-room comparison.
6. **V17-W6 notification routing**: rules, dry-run, digest/escalation, multi-room read-only overlay, e2e.

## 5. 주요 리스크

- handoff가 원격 실행처럼 보이면 trust 경계가 흐려진다. receiver-local accept 없이는 task가 생성되지 않게 해야 한다.
- signed package에도 민감 정보가 섞일 수 있다. redaction report, deny-by-default, preview, signer/freshness가 필수다.
- callback 중복/순서 꼬임은 상태 불일치를 만든다. correlation id, monotonic sequence, idempotent ingest로 처리한다.
- retro/trend reporting은 팀원을 비교하는 도구가 되기 쉽다. system theme, room health, confidence 중심으로 표현한다.
- cost forecast는 source가 불완전하다. unknown을 숨기지 않고 hard enforcement로 연결하지 않는다.
- multi-room notification은 중앙 action으로 확장하고 싶은 압력이 크다. v1.17은 read-only overlay와 local deep-link만 허용한다.
