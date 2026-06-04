# grove v1.18+ 브레인스토밍

작성일: 2026-06-04

## 전제

- v1.15는 execution timeline과 usage reporting을 출시했고, v1.16은 signed read-only aggregation을 출시했다.
- v1.17은 cross-room handoff를 진행 중인 것으로 둔다.
- v1.18은 aggregation과 handoff를 기반으로 **회고 인사이트, 비용/사용량 추세, 조건부 알림, 다중-room alert overlay, 다단계 handoff workflow**를 운영 가능한 루프로 묶는 단계가 적합하다.
- 원칙은 실제 CLI 세션, 로컬-퍼-멤버, 보드=위임 프로토콜, privacy deny-by-default, receiver-local accept, read-only aggregation이다.
- v1.18에서도 cross-room executor routing, remote auto-accept, hard budget block은 기본 scope에서 제외한다.

## 우선순위 기준

- **P0**: v1.18 핵심 후보. v1.16 aggregation과 v1.17 handoff 위에서 사람 운영 판단을 빠르게 만드는 기능이다.
- **P1**: v1.18 stretch 또는 v1.19 후보. 유용하지만 정책/신뢰도/UX 검증이 더 필요하다.
- **P2**: v1.20+ 후보. 자동 실행, 원격 action, 강제 차단처럼 위험 경계가 큰 기능이다.

## 1. v1.18+ 후보 목록

| 우선 | 아이디어                              | 한 줄                                                                                                       | 가치                                                               | 규모 | CLI/역할                        | 의존성                                            | 위험/완화                                                                            |
| ---- | ------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ | ---- | ------------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------ |
| P0   | **retro analytics insight v1**        | self-retro를 blocker, root cause, verification issue, cost issue, improvement action으로 정규화해 집계한다. | 개별 회고를 반복 패턴과 개선 후보로 바꾼다.                        | M    | reviewer claude, agy reviewer   | self-retro lane, audit events, task metadata      | 작은 표본 과해석 위험. sample size, confidence, source link 필수.                    |
| P0   | **retro trend heatmap**               | room/node/agent/theme별 회고 이슈 증가와 감소를 heatmap으로 보여준다.                                       | 어느 영역이 반복적으로 느려지거나 깨지는지 조기에 본다.            | M    | FE claude, reviewer claude      | retro analytics, aggregation summary              | 개인 평가처럼 보일 위험. blame-free copy, system theme 중심, opt-out aggregation.    |
| P0   | **retro insight digest**              | 주간 회고 요약을 unresolved improvement, repeated failure, fixed pattern으로 묶는다.                        | 회고가 실제 운영 리뷰 agenda가 된다.                               | S/M  | reviewer claude, FE claude      | retro trend, notification routing                 | 장문 noise 위험. top-N, evidence links, confidence badge.                            |
| P0   | **usage/cost trend reporting v2**     | room/node/agent/day별 usage, known/unknown cost, warning, moving average를 표시한다.                        | 비용과 크레딧 위험을 추세로 보고 위임 전략을 조정한다.             | M/L  | bridge codex, FE claude         | /api/usage, signed aggregation, confidence model  | 부정확한 비용 위험. known/unknown 분리, source 표시, hard block 금지.                |
| P0   | **usage anomaly detection**           | 평소 대비 token/turn/runtime/cost spike와 갑작스러운 unknown 증가를 탐지한다.                               | 비용 폭주와 비정상 실행을 일찍 발견한다.                           | M    | bridge codex, qa agy            | usage trend, timeline durations                   | false positive 위험. threshold preview, per-room baseline, silence with audit.       |
| P0   | **forecast confidence bands**         | 이번 주 usage/cost/credit 위험을 low/medium/high confidence band로 예측한다.                                | 운영자가 사전 조정하되 숫자를 과신하지 않는다.                     | M    | bridge codex, reviewer claude   | trend reporting, cost source confidence           | 예측 과신 위험. confidence bucket, unknown penalty, no auto enforcement.             |
| P0   | **notification routing v2 rules**     | 조건, severity, role target, quiet hours, digest, dedupe, escalation을 rule로 관리한다.                     | 중요한 사람 판단은 놓치지 않고 일반 noise는 줄인다.                | M    | bridge codex, FE claude         | notification rules, member roles, inbox           | 정책 실수 위험. dry-run, preview, safe defaults, per-rule audit.                     |
| P0   | **multi-channel notification fanout** | dashboard inbox, Slack, email/webhook, digest를 같은 rule engine에서 라우팅한다.                            | 팀원이 자기 채널에서 중요한 상태를 받는다.                         | M    | bridge codex, security reviewer | notification v2, channel credentials, redaction   | 민감 정보 유출 위험. channel-specific redaction, opt-in, preview payload.            |
| P0   | **multi-room alert overlay**          | aggregation view 위에 blocked/safety/stale/anomaly/handoff alert를 read-only로 모은다.                      | 여러 room의 위험 상태를 한 피드에서 본다.                          | M/L  | FE claude, bridge codex         | signed aggregation, alert summary, privacy policy | 중앙 action 오해 위험. read-only feed, local deep-link, no remote mutation.          |
| P0   | **alert correlation and dedupe**      | 같은 root cause, handoff chain, stale dependency로 생긴 alert를 하나의 incident group으로 묶는다.           | 다중-room noise를 줄이고 실제 원인을 찾는다.                       | M    | bridge codex, reviewer claude   | alert overlay, audit correlation, handoff ids     | 잘못된 묶음 위험. confidence, manual split/merge, source list 표시.                  |
| P0   | **multi-step handoff workflow v1**    | request -> accept -> execute -> review -> return -> close 단계를 명시적 workflow로 관리한다.                | 단순 task 인계를 검토/반환/종료까지 이어지는 운영 흐름으로 만든다. | L    | bridge codex, FE claude         | v1.17 handoff, board state, audit callback        | 상태 복잡도 위험. finite state machine, local owner authority, idempotent callbacks. |
| P0   | **handoff review and return gate**    | receiver 결과를 sender가 review하고 accept-return 또는 request-rework로 닫는다.                             | room 간 결과 품질과 책임 종료 시점이 명확해진다.                   | M/L  | reviewer claude, bridge codex   | handoff workflow, task comments, callbacks        | 무한 ping-pong 위험. max rework count, explicit close reason, audit.                 |
| P1   | **retro-to-action candidate board**   | 반복 회고 insight를 board candidate로 제안하되 사람 confirm 전에는 생성하지 않는다.                         | 회고가 개선 작업으로 이어진다.                                     | M    | planner claude, reviewer claude | retro analytics, board create, dedupe             | task 폭증 위험. suggestion-only, merge duplicate, owner confirm.                     |
| P1   | **anomaly-to-alert policy**           | usage anomaly와 trend risk를 notification rule의 조건으로 연결한다.                                         | 이상 징후가 사람에게 자동 surface된다.                             | M    | bridge codex, security reviewer | anomaly detection, routing v2                     | alert storm 위험. cooldown, severity threshold, sampled dry-run.                     |
| P1   | **room escalation matrix**            | room별 operator, backup, admin, quiet hours, critical override를 matrix로 관리한다.                         | 다중-room 운영에서 누가 받을지 명확해진다.                         | M    | FE claude, security reviewer    | member roles, routing v2                          | 정책 파편화 위험. inherited defaults, templates, policy audit.                       |
| P1   | **handoff SLA badges**                | handoff 단계별 pending age, review wait, rework count를 badge로 표시한다.                                   | room 간 인계 병목과 방치 상태를 빠르게 본다.                       | S/M  | FE claude, bridge codex         | handoff workflow, alert overlay                   | 압박 지표 위험. configurable SLA, blame-free wording, health-first.                  |
| P1   | **workflow templates for handoff**    | bugfix, review, QA, research 같은 handoff 유형별 단계/필수 context template을 제공한다.                     | 인계 품질을 높이고 반복 입력을 줄인다.                             | M    | planner claude, FE claude       | handoff workflow, template system                 | template 남용 위험. editable template, minimal required fields.                      |
| P1   | **report narrative generator**        | trend/retro/anomaly를 근거 링크와 함께 주간 운영 리포트 초안으로 만든다.                                    | 숫자를 사람이 읽는 운영 메모로 바꾼다.                             | M    | reviewer claude, agy reviewer   | reporting v2, retro digest, alert overlay         | 환각/과장 위험. evidence-only, editable draft, confidence labels.                    |
| P1   | **multi-room alert subscriptions**    | 사용자가 특정 room, severity, handoff chain, metric에 subscribe한다.                                        | 각자 필요한 운영 알림만 받는다.                                    | M    | FE claude, bridge codex         | alert overlay, routing v2                         | 누락 위험. default critical subscription, subscription audit.                        |
| P2   | **remote handoff auto-accept**        | trusted sender의 low-risk handoff를 receiver가 자동 수락한다.                                               | 반복 인계 마찰을 줄인다.                                           | L    | security reviewer, bridge codex | handoff workflow maturity, trust policy           | 무단 task 생성 위험. v1.18에서는 금지, later opt-in only.                            |
| P2   | **cross-room executor routing**       | handoff 없이 다른 room의 실제 CLI 세션을 executor로 사용한다.                                               | 전문 room이나 여유 머신을 실행 substrate로 쓴다.                   | L    | bridge codex, ops reviewer      | workflow trust, backpressure, auth federation     | credential/trust 경계 붕괴 위험. handoff workflow 안정화 뒤 검토.                    |
| P2   | **hard budget enforcement**           | forecast/anomaly가 임계치를 넘으면 autonomous execution을 차단한다.                                         | 비용 폭주를 강하게 막는다.                                         | M/L  | bridge codex, security reviewer | reliable cost data, kill gates                    | false positive 차단 위험. report/hint 선행, manual approve required.                 |
| P2   | **remote alert actions**              | multi-room overlay에서 원격 approve/abort/kill 같은 action을 수행한다.                                      | 중앙 운영 편의가 커진다.                                           | L    | security reviewer, FE claude    | signed command, auth federation, audit            | 중앙 제어 위험. v1.18에서는 local deep-link만 유지.                                  |

## 2. 제안 v1.18 스코프

v1.18의 권장 테마는 **"operational intelligence over handoff and aggregation"**이다. v1.16은 여러 room을 안전하게 보이게 했고, v1.17은 signed handoff를 진행 중이다. v1.18은 이 두 기반을 이용해 회고, 사용량, 알림, handoff workflow를 하나의 운영 루프로 묶는다. 핵심은 자동 실행을 늘리는 것이 아니라, 사람이 어디에 개입해야 하는지 더 정확히 보이게 하는 것이다.

### v1.18 핵심 항목

1. **retro analytics insight v1**
   - self-retro를 root cause, blocker, verification issue, cost issue, improvement action으로 정규화한다.
   - heatmap과 digest는 system theme 중심으로 보여주고 개인 blame metric은 만들지 않는다.
   - improvement는 candidate까지만 만들고 board task 생성은 사람 confirm을 요구한다.

2. **usage/cost trend reporting v2**
   - room/node/agent/day별 usage, cost known/unknown, moving average, warning을 표시한다.
   - anomaly detection은 per-room baseline과 confidence를 사용한다.
   - forecast는 hint로만 쓰고 hard budget enforcement는 제외한다.

3. **notification routing v2 with multi-channel fanout**
   - 조건, severity, role target, quiet hours, digest, dedupe, escalation, dry-run을 제공한다.
   - dashboard inbox, Slack, email/webhook, digest는 같은 redacted payload contract를 공유한다.
   - channel별 opt-in과 preview payload를 제공한다.

4. **multi-room alert overlay**
   - signed aggregation 위에 blocked, safety, stale, anomaly, handoff alert를 read-only feed로 모은다.
   - alert correlation과 dedupe로 같은 root cause를 incident group으로 묶는다.
   - remote action은 제공하지 않고 local room deep-link만 제공한다.

5. **multi-step handoff workflow v1**
   - request -> accept -> execute -> review -> return -> close 단계를 finite state machine으로 관리한다.
   - sender review와 request-rework를 명시하되 rework count와 close reason을 audit한다.
   - 모든 상태 변경은 해당 room의 local owner authority 안에서만 일어난다.

### v1.18 exit criteria

1. retro analytics가 self-retro를 root cause, blocker, verification issue, cost issue, improvement action으로 집계한다.
2. retro heatmap과 digest가 sample size, confidence, source link를 표시한다.
3. usage/cost trend reporting v2가 room/node/agent/day별 moving average와 known/unknown cost를 보여준다.
4. usage anomaly detection이 per-room baseline, threshold preview, confidence를 제공한다.
5. forecast는 low/medium/high confidence band로 표시되고 자동 차단을 만들지 않는다.
6. notification routing v2가 조건, severity, target role, quiet hours, digest, dedupe, escalation dry-run을 지원한다.
7. multi-channel fanout은 channel-specific redaction과 preview payload를 지원한다.
8. multi-room alert overlay가 blocked/safety/stale/anomaly/handoff alert를 read-only feed로 모은다.
9. alert correlation이 incident group, confidence, source list, manual split/merge를 제공한다.
10. multi-step handoff workflow가 request/accept/execute/review/return/close 상태를 idempotent callback으로 관리한다.
11. handoff review gate가 accept-return, request-rework, close reason, max rework count를 audit한다.
12. e2e는 retro analytics, usage anomaly, routing dry-run, multi-channel redaction, alert overlay, handoff workflow를 검증한다.

## 3. v1.19+ 백로그

| 후보                                | 설명                                                                   | 넘기는 이유                                                         |
| ----------------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------- |
| retro-to-action task creation       | 회고 insight를 owner confirm 후 실제 board task로 생성한다.            | v1.18에서 insight 품질과 dedupe를 먼저 검증해야 한다.               |
| anomaly-to-alert 자동 escalation    | anomaly가 특정 조건을 넘으면 escalation을 자동 시작한다.               | false-positive와 alert storm 완화가 필요하다.                       |
| workflow templates for handoff 강화 | handoff 유형별 필수 context와 review criteria를 template으로 제공한다. | v1.18 workflow가 실제 사용 패턴을 보여준 뒤 다듬는 편이 안전하다.   |
| remote handoff auto-accept          | trusted sender의 low-risk handoff를 자동 수락한다.                     | 무단 task 생성 위험이 커서 별도 trust policy가 필요하다.            |
| cross-room executor routing         | 다른 room의 실제 CLI 세션으로 task를 실행한다.                         | credential, backpressure, cancel, audit federation이 모두 필요하다. |
| hard budget enforcement             | forecast/anomaly 기반으로 실행을 차단한다.                             | 비용 source 신뢰도와 false-positive 완화가 부족하다.                |
| remote alert actions                | overlay에서 원격 room action을 수행한다.                               | 중앙 제어 경계가 커서 별도 보안 설계가 필요하다.                    |

## 4. 실행 순서 제안

1. **V18-W1 retro insight model**: retro taxonomy, parser, confidence, source links, heatmap data.
2. **V18-W2 trend and anomaly reporting**: usage moving average, unknown handling, baseline, forecast bands.
3. **V18-W3 notification routing v2**: rule schema, dry-run, dedupe, escalation, quiet hours.
4. **V18-W4 multi-channel fanout**: channel redaction, preview payload, digest, delivery audit.
5. **V18-W5 multi-room alert overlay**: alert summary, incident grouping, correlation, local deep-link.
6. **V18-W6 handoff workflow**: finite state machine, review/return gate, idempotent callbacks, e2e.

## 5. 주요 리스크

- retro analytics는 사람이나 node 평가 도구로 오해되기 쉽다. system theme, sample size, confidence, source evidence 중심으로 둔다.
- cost/usage forecast는 source가 불완전하다. unknown을 숨기지 않고 hard block이나 자동 escalation으로 바로 연결하지 않는다.
- notification routing은 noise와 누락이 모두 위험하다. dry-run, dedupe, quiet hours, escalation cap, preview payload를 기본으로 둔다.
- multi-channel fanout은 민감 정보 유출 경로가 늘어난다. channel-specific redaction, opt-in, delivery audit이 필요하다.
- multi-room overlay는 중앙 control surface가 되기 쉽다. v1.18에서는 read-only feed와 local deep-link만 허용한다.
- handoff workflow는 상태가 복잡해질수록 꼬인다. finite state machine, idempotent callback, local owner authority를 강제한다.
