# grove v1.15+ 브레인스토밍

작성일: 2026-06-04

## 전제

- v1.12는 planner→delegate와 pickup 토글을 출시했고, v1.13은 guarded execution loop와 실행 tab을 출시했다.
- v1.14는 Slack 안전 명령을 진행 중인 것으로 둔다.
- v1.15는 **모바일 승인/kill-switch surface**, **실행 timeline 시각화**, **multi-machine read-only aggregation**, **cross-room handoff contract**, **비용/사용량 리포팅**을 묶어 운영실 제품성을 끌어올리는 단계가 적합하다.
- 핵심 원칙은 여전히 실제 CLI 세션, 보드=위임 프로토콜, 사람 승인/감사 guard, 로컬-퍼-멤버 실행, Tailscale 선택 공유다.

## 우선순위 기준

- **P0**: v1.15 핵심 후보. v1.13~v1.14의 guarded loop와 Slack safety surface를 보완하는 사용자-facing 운영 기능이다.
- **P1**: v1.15 stretch 또는 v1.16 후보. 가치가 크지만 privacy, 비용 신뢰도, cross-room 신뢰 모델 검증이 필요하다.
- **P2**: v2.0+ 후보. 실제 cross-room execution, 멀티머신 executor routing, destructive remote command처럼 경계가 크다.

## 1. v1.15+ 후보 목록

| 우선 | 아이디어                                   | 한 줄                                                                                                               | 가치                                                             | 규모 | CLI/역할                        | 의존성                                             | 위험/완화                                                                                |
| ---- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- | ---- | ------------------------------- | -------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| P0   | **mobile approval queue v1**               | 모바일에서 approval-needed, verification-failed, rollback-needed, kill-waiting item을 처리한다.                     | 자리를 비운 상태에서도 자율 실행의 사람 판단 병목을 풀 수 있다.  | M    | FE claude, bridge codex         | guarded loop, decision inbox, team auth            | 작은 화면 오조작 위험. scope labels, preview, confirm, destructive 제외.                 |
| P0   | **mobile kill-switch surface**             | global/board/node/task kill-switch와 pause/resume을 모바일에서 role-gated로 제공한다.                               | 긴급 상황에서 즉시 자율 실행을 멈추고 감사 기록을 남긴다.        | M    | FE claude, security reviewer    | execution gates, node status, audit actor          | 잘못된 kill 위험. clear target, double confirm for global, immediate audit, resume path. |
| P0   | **mobile timeline cards**                  | 모바일에서 task execution timeline의 preflight/approval/verify/kill/checkpoint 요약을 본다.                         | 승인/kill 전에 필요한 맥락을 작은 화면에서 확인한다.             | M    | FE claude                       | execution timeline, redaction policy               | 정보 과밀 위험. step summary, expand-on-demand, no raw transcript.                       |
| P0   | **execution timeline step view**           | task drawer에 preflight -> approval -> dispatch -> heartbeat -> verify -> complete/block 단계를 stepper로 표시한다. | 사람이 현재 실행 상태와 다음 게이트를 즉시 이해한다.             | M    | FE claude, bridge codex         | audit.execution events, task drawer                | 상태 오해 위험. source/confidence 표시, stale event badge.                               |
| P0   | **execution timeline Gantt view**          | node별 autonomous run, approval wait, execution, verification, kill/abort 구간을 시간축으로 본다.                   | 병목과 긴 대기, kill 지연, verification 실패 패턴을 한눈에 본다. | L    | FE claude, bridge codex         | audit events, node status, cursor paging           | 시각화 과부하 위험. time window, filters, summary-first.                                 |
| P0   | **timeline filtering and drilldown**       | task/node/action/risk/actor/status별로 timeline을 필터하고 세부 audit payload를 연다.                               | 사건 조사와 운영 회고 속도를 높인다.                             | M    | FE claude                       | audit API, timeline cards                          | 민감 정보 노출 위험. redacted payload, role gate, no raw errors.                         |
| P0   | **cost/usage reporting v1**                | agent/node/task별 token, estimated cost, confidence, unknown source를 주간 리포트로 표시한다.                       | 자율 실행이 늘어날수록 비용과 usage를 팀이 이해하고 제어한다.    | M/L  | bridge codex, FE claude         | /api/cost, run metadata, transcript parser         | 숫자 신뢰도 위험. source/confidence 필수, unknown을 unknown으로 표시.                    |
| P0   | **autonomy cost attribution**              | autonomous pickup/execution run의 비용과 수동 run 비용을 분리해 보여준다.                                           | 자율화가 실제로 비용/효율에 어떤 영향을 주는지 평가한다.         | M    | bridge codex, reviewer claude   | audit.execution, cost API, self-retro              | attribution 오류 위험. estimate badge, run-id linkage, partial data 표시.                |
| P1   | **multi-machine read-only aggregation v0** | 여러 local room의 org/board/health/autonomy/cost summary를 Tailscale에서 read-only로 모은다.                        | 각 멤버가 로컬 실행을 유지하면서 팀 전체 상태를 한 화면에 본다.  | L    | bridge codex, security reviewer | signed summaries, project identity, privacy policy | 민감 정보 공유 위험. summary-only, deny-by-default, no comments/diffs by default.        |
| P1   | **aggregation privacy policy v1**          | aggregation에 포함할 board fields, autonomy events, cost summary, member names, redaction level을 정한다.           | read-only view가 과도한 정보를 공유하지 않게 한다.               | M    | security reviewer, bridge codex | export redaction, team auth, signed summaries      | 과공유 위험. per-field toggles, preview, audit share changes.                            |
| P1   | **aggregation freshness and trust badges** | 각 remote summary의 age, signer, project id, confidence, last successful fetch를 표시한다.                          | stale/위조/불완전 데이터를 운영자가 구분한다.                    | M    | FE claude, bridge codex         | signed summaries, aggregation service              | stale 판단 오류 위험. explicit age, stale threshold, no auto action from stale data.     |
| P1   | **cross-room handoff contract v1**         | task package, context pack, expected result, callback, cancellation, audit correlation schema를 정의한다.           | 실제 handoff 전에 책임과 추적 경계를 고정한다.                   | M/L  | architect claude, bridge codex  | aggregation, support bundle, signed handoff        | 책임 불명확 위험. owner/cancel/result authority 필수, no execution yet.                  |
| P1   | **handoff preview and redaction report**   | 전송 전 package, missing context, redacted fields, receiver requirements를 preview한다.                             | cross-room 실행 전에 사람이 privacy와 context 품질을 검토한다.   | M    | FE claude, security reviewer    | handoff contract, support bundle                   | 잘못된 context 전송 위험. diffable package, explicit approval, no auto-send.             |
| P1   | **cost budget hints**                      | node/group/agent별 daily/weekly budget hint와 초과 위험을 dashboard/mobile에 표시한다.                              | 비용 리포팅이 실제 운영 판단으로 이어진다.                       | M    | bridge codex, FE claude         | cost reporting, team roles                         | 과도한 제약 위험. hint-only, no hard block until data confidence improves.               |
| P1   | **self-retro cost section**                | self-retro가 비용 unknown, high-cost task, repeated verification failure를 요약한다.                                | 운영 회고가 성능뿐 아니라 비용과 실패 패턴까지 다룬다.           | M    | reviewer claude, agy reviewer   | self-retro, cost reporting, audit timeline         | 잘못된 결론 위험. confidence 표시, evidence links.                                       |
| P1   | **mobile incident bundle trigger**         | 모바일에서 특정 task/run timeline을 support bundle 후보로 표시하고 나중에 desktop에서 export한다.                   | 외부에서 사고를 발견했을 때 조사 대상을 놓치지 않는다.           | S/M  | FE claude, qa agy               | mobile timeline, support bundle                    | 민감 export 위험. 모바일은 mark-only, actual export는 desktop confirm.                   |
| P2   | **cross-room handoff implementation**      | 다른 room으로 task package를 보내고 progress/result summary를 되받는다.                                             | 로컬-퍼-멤버 모델을 유지하면서 전문 node를 공유한다.             | L    | bridge codex, security reviewer | handoff contract, signed callbacks, aggregation    | retry/cancel/audit 복잡성. v1.15에서는 계약/preview까지만.                               |
| P2   | **multi-machine executor routing**         | 다른 머신의 실제 CLI 세션이 내 board task를 처리하도록 opt-in 연결한다.                                             | 개인 credentials 경계를 유지하면서 팀 compute를 넓힌다.          | L    | bridge codex, ops reviewer      | cross-room handoff, trust policy, backpressure     | trust 경계 붕괴 위험. read-only aggregation 안정화 후 후속.                              |
| P2   | **hard cost enforcement**                  | budget 초과 시 autonomous execution 자체를 차단한다.                                                                | 비용 폭주를 강하게 막는다.                                       | M/L  | bridge codex, security reviewer | reliable cost data, budget policy                  | 잘못된 차단 위험. v1.15는 hint-only로 두고 hard gate는 후속.                             |

## 2. 제안 v1.15 스코프

v1.15의 권장 테마는 **"operational visibility beyond desktop"**이다. v1.14가 Slack 안전 명령을 열면, v1.15는 모바일에서 승인/kill을 처리하고, execution timeline을 사람이 이해 가능한 step/Gantt로 만들며, 여러 local room을 read-only로 모으기 위한 첫 신뢰 모델을 잡는 것이 자연스럽다.

### v1.15 핵심 항목

1. **mobile approval/kill-switch surface**
   - approval-needed, verification-failed, rollback-needed, kill-waiting queue를 모바일에서 처리한다.
   - global/board/node/task kill-switch와 pause/resume은 role-gated + confirm + audit로 제한한다.
   - 모바일은 action scope를 좁게 유지하고 destructive/cross-room command는 제외한다.

2. **execution timeline step/Gantt visualization**
   - task drawer에는 stepper, ops view에는 node/time Gantt를 둔다.
   - checkpoint, verification, rollback plan, kill reason은 redacted card로 표시한다.
   - filters와 drilldown으로 incident 조사와 self-retro 근거를 빠르게 찾는다.

3. **cost/usage reporting v1**
   - node/task/agent별 usage와 estimated cost를 source/confidence와 함께 보여준다.
   - autonomous run과 manual run을 분리해 자율화의 비용 영향을 본다.
   - v1.15는 budget hint까지만, hard enforcement는 후속으로 둔다.

4. **multi-machine read-only aggregation v0**
   - signed summary, project id, freshness, trust badge, privacy policy를 갖춘 read-only prototype을 만든다.
   - comments/diffs/raw transcript는 기본 제외하고 org/board counts/health/autonomy/cost summary부터 시작한다.

5. **cross-room handoff contract and preview**
   - task package, context pack, expected result, cancellation, callback, audit correlation schema를 정의한다.
   - 실제 전송/실행은 하지 않고 preview와 redaction report까지만 제공한다.

### v1.15 exit criteria

1. 모바일 approval queue에서 approval-needed, verification-failed, rollback-needed item을 볼 수 있다.
2. 모바일에서 node/task/global kill-switch 또는 pause/resume을 confirm 후 실행하고 audit에 남긴다.
3. 모바일 timeline card가 preflight, approval, verification, kill/checkpoint 요약을 보여준다.
4. task drawer에 execution step view가 표시된다.
5. ops view에 node/time 기반 Gantt timeline이 표시되고 task/node/action/risk 필터가 동작한다.
6. cost/usage reporting이 node/task/agent별 source/confidence-tagged 값을 보여준다.
7. autonomous run cost와 manual run cost가 분리되어 표시된다.
8. multi-machine read-only aggregation prototype이 signed summary, freshness, trust badge, privacy policy를 제공한다.
9. cross-room handoff contract와 preview/redaction report가 문서와 UI/JSON schema로 정리된다.
10. 실제 서버 e2e가 mobile approval/kill, timeline step/Gantt, cost report, aggregation summary 계약을 검증한다.

## 3. v1.16+ 백로그

| 후보                              | 설명                                                            | 넘기는 이유                                                     |
| --------------------------------- | --------------------------------------------------------------- | --------------------------------------------------------------- |
| cross-room handoff implementation | task package를 다른 room으로 보내고 progress/result를 되받는다. | read-only aggregation과 handoff preview가 먼저 안정되어야 한다. |
| multi-machine executor routing    | 다른 머신의 실제 CLI 세션이 내 board task를 처리한다.           | credentials 경계와 trust/backpressure 모델 검증이 더 필요하다.  |
| hard cost enforcement             | budget 초과 시 autonomous execution을 차단한다.                 | 비용 source confidence가 충분히 높아져야 한다.                  |
| Slack limited delegate full       | Slack에서 planner 추천 기반 delegate까지 처리한다.              | safety command와 mobile queue 안정화 후가 안전하다.             |
| mobile command center             | 모바일에서 board/org/terminal action까지 넓힌다.                | approval/kill 중심 UX가 먼저 검증되어야 한다.                   |
| public/shared template index      | local template marketplace를 팀 공유 index로 확장한다.          | privacy/provenance 모델과 aggregation identity가 필요하다.      |

## 4. 실행 순서 제안

1. **V15-W1 mobile safety surface**: approval queue, kill-switch controls, role/confirm/audit.
2. **V15-W2 execution timeline**: step view, Gantt view, filters, redacted checkpoint cards.
3. **V15-W3 cost reporting**: source/confidence model, autonomous/manual attribution, budget hints.
4. **V15-W4 aggregation prototype**: signed summaries, freshness/trust badges, privacy policy.
5. **V15-W5 handoff contract**: package schema, cancellation/callback/audit correlation, preview/redaction report.
6. **V15-W6 hardening**: real-server e2e, redaction review, mobile a11y, timeline performance.

## 5. 주요 리스크

- 모바일 kill-switch는 오조작 피해가 크다. scope labels, confirm, audit, resume path를 함께 제공해야 한다.
- timeline/Gantt는 민감 정보와 과도한 이벤트가 섞이기 쉽다. summary-first, redacted detail, filters가 필요하다.
- 비용 리포팅은 숫자 신뢰도가 낮으면 잘못된 의사결정을 만든다. source/confidence와 unknown 표시가 1급 정보여야 한다.
- multi-machine aggregation은 read-only라도 privacy 위험이 있다. deny-by-default, signed summary, freshness badge, per-field policy로 시작한다.
- cross-room handoff는 v1.15에서 실제 실행하지 않는다. 계약과 preview가 충분히 검증된 뒤 구현해야 한다.
