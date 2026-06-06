# grove v1.23+ 브레인스토밍

> Status: historical v1 brainstorm; superseded by the current v2 live cockpit model documented in `docs/design/MASTER_NODE.md` and `docs/agents/LEAD-HANDOFF.md`.
> 작성일: 2026-06-04

## 전제

- v1.20은 Slack 자유형 intake를 deterministic/no-LLM, default OFF, preview->confirm, role/audit gate로 출시했다.
- v1.21은 Slack thread context와 자연어 status query를 read-only assistant로 출시했다. 질문 경로는 board/run/usage를 읽기만 하고, thread context가 변이를 밀반입하지 못한다.
- v1.22는 retro analytics를 진행 중인 것으로 둔다. 따라서 v1.23은 retro에서 나온 운영 신호를 usage/cost trend, advisory anomaly/forecast, notification routing, Slack digest/reminder로 연결하는 단계가 적합하다.
- sharp edge는 계속 default OFF다. anomaly는 advisory, forecast는 planning hint, notification은 simulation-first, Slack action은 role+confirm+audit, multi-room은 read-only 원칙을 유지한다.
- optional per-user sandbox v0는 shared host 안전성의 다음 큰 덩어리지만, hard isolation으로 과장하면 안 된다. v1.23에서는 최소 경계를 실증하거나, 범위가 크면 v1.24로 넘긴다.

## 우선순위 기준

- **P0**: v1.23 핵심 후보. v1.22 retro 결과를 운영 신호와 사람 알림으로 연결하거나 shared host 안전성을 직접 높인다.
- **P1**: v1.23 stretch 또는 v1.24 후보. 가치가 크지만 UI, 정책, 데이터 신뢰도 검증이 더 필요하다.
- **P2**: v1.25+ 후보. hard enforcement, remote action, 강한 sandbox처럼 위험 경계가 크다.

## 1. v1.23+ 후보 목록

| 우선 | 아이디어                                | 한 줄                                                                                                  | 가치                                                           | 규모 | 의존성                                                         | 위험/완화                                                                               |
| ---- | --------------------------------------- | ------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------- | ---- | -------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| P0   | **Usage/cost trend v2**                 | member/project/node/agent/day별 runs, tokens, known cost, unknown cost, runtime을 추세로 보여준다.     | 비용·사용량·capacity를 같은 흐름에서 판단한다.                 | M/L  | /api/usage, /api/ledger, execution timeline                    | 비용 부정확. known/unknown/estimated 분리, agy cost unknown 유지, source label 필수.    |
| P0   | **Advisory anomaly detection**          | runtime/token spike, unknown-cost 증가, host-pressure 급등을 baseline 대비 advisory alert로 잡는다.    | runaway work나 이상 사용량을 초기에 발견한다.                  | M    | usage trend, host-pressure, audit events                       | false positive. alert-only, cooldown, threshold preview, 자동 abort/kill 금지.          |
| P0   | **Usage forecast v1**                   | 현재 burn rate로 soft quota 도달 예상과 confidence band를 계산한다.                                    | operator가 hard stop 없이 quota와 routing을 조정한다.          | M    | usage trend, soft quota ledger                                 | 예측 과신. advisory copy, source window, confidence 표시, enforcement와 분리.           |
| P0   | **Trend source inspector**              | trend 카드에서 어떤 run metadata가 숫자에 들어갔는지 source와 warning을 보여준다.                      | 비용 숫자에 대한 신뢰도를 빠르게 검증한다.                     | S/M  | usage APIs, redaction, run metadata                            | 민감 정보 노출. id/count 중심, path/body/token redaction, operator detail gate.         |
| P0   | **Notification routing v2 core**        | condition, severity, target role/member, quiet hours, dedupe, cooldown, escalation을 rule로 관리한다.  | 중요한 판단 요청을 적절한 사람에게 보내고 noise를 줄인다.      | M/L  | team auth, audit/event stream, Slack/web notification surfaces | 알림 누락/폭주. simulation-first, conservative defaults, per-rule audit.                |
| P0   | **Notification simulation mode**        | rule 저장 전 최근 이벤트에 적용해 예상 발신량과 대상자를 dry-run으로 보여준다.                         | operator가 실수로 알림 폭탄을 만들지 않는다.                   | M    | notification routing, event history                            | 실제와 simulation 차이. time window/freshness 표시, dry-run badge.                      |
| P0   | **Slack summary digest v1**             | blocked/running/stale/retro/usage/anomaly를 정해진 cadence로 redacted digest로 보낸다.                 | Slack에서 상태 확인 질문을 줄이고 운영 리듬을 만든다.          | M    | Slack read-only assistant, notification routing, redaction     | 과공유와 spam. role/channel allowlist, counts-first, local dashboard deep link.         |
| P0   | **Slack reminder loop v1**              | ask-human pending, stale block, unconfirmed preview, anomaly acknowledgement를 reminder로 surface한다. | 사람 결정을 놓치지 않고 오래된 작업을 되살린다.                | M    | Slack threads, notification rules, audit                       | reminder spam. snooze, max reminders, quiet hours, per-task dedupe.                     |
| P0   | **Retro-to-improvement candidates**     | v1.22 retro theme를 dedupe해 개선 후보로 묶고 owner confirm 전까지 board task를 만들지 않는다.         | 회고가 실제 개선 작업 후보로 이어진다.                         | M    | retro analytics, board create gate, task labels                | task 폭증. candidate-only, merge duplicates, owner confirm, stale candidate cleanup.    |
| P0   | **Improvement candidate inbox**         | retro 기반 개선 후보를 inbox에서 approve/dismiss/merge할 수 있게 한다.                                 | operator가 회고 결과를 planning에 넣기 쉽다.                   | M    | retro candidates, decision inbox, audit                        | 개인 평가처럼 보일 위험. process/system framing, no ranking, source links.              |
| P0   | **Optional per-user sandbox v0 design** | workspace root, writable paths, temp dir, env allowlist, secret namespace 정책 모델을 확정한다.        | shared host에서 피어 간 우발적 간섭을 줄이는 첫 경계가 생긴다. | M    | team auth, project settings, spawn/executor context            | hard isolation으로 오해. best-effort/default OFF, limitation banner, no security claim. |
| P0   | **Sandbox boundary preview**            | sandbox 켜기 전 허용/차단 path, inherited env, secret scope를 operator에게 보여준다.                   | 정책 적용 전 breakage와 false safety를 줄인다.                 | M    | sandbox policy design, redaction, settings UI                  | 민감 path 노출. redacted preview, operator-only detail.                                 |
| P1   | **Sandbox violation audit v0**          | 차단된 path/env/secret 접근을 redacted audit event와 사용자 이유로 남긴다.                             | sandbox 정책 디버깅과 신뢰도 확보에 필요하다.                  | M/L  | sandbox enforcement hooks, audit lane                          | false denial/민감 노출. sampled detail, redaction, safe fallback.                       |
| P1   | **Multi-room alert overlay v1**         | signed read-only summary 위에 blocked/stale/quota/anomaly/retro alert를 모아 보여준다.                 | 여러 room의 위험을 한 화면에서 훑는다.                         | M/L  | signed aggregation, notification summaries, privacy policy     | 중앙 제어 surface로 오해. read-only only, local deep link, no remote mutation.          |
| P1   | **Alert correlation v1**                | 같은 task chain, handoff id, room, root cause에서 온 알림을 incident group으로 묶는다.                 | multi-room 알림 noise를 줄이고 원인을 빨리 찾는다.             | M    | alert overlay, audit correlation, handoff metadata             | 잘못된 묶음. confidence, source list, manual split/merge.                               |
| P1   | **Slack digest personalization**        | member별 watched board, role, owned tasks, quiet hours 기준으로 digest를 다르게 만든다.                | 팀원이 자기에게 필요한 정보만 받는다.                          | M    | notification routing, team auth, presence                      | 정보 누락. team digest 기본 유지, personal digest opt-in.                               |
| P1   | **Slack reminder actions**              | reminder 카드에서 snooze, acknowledge, open task 같은 안전 action을 제공한다.                          | Slack에서 알림 처리 루프가 닫힌다.                             | M/L  | Slack command surface, role gates, dashboard links             | action 우회. mutation은 preview/confirm, role re-check, audit.                          |
| P1   | **Room health score**                   | blocked age, stale runs, quota pressure, anomaly, retro recurrence를 설명 가능한 score로 압축한다.     | operator가 attention 우선순위를 빨리 잡는다.                   | M    | trend/anomaly, retro analytics, alert overlay                  | 점수 과신. source breakdown, no hidden model, no auto action.                           |
| P1   | **Trend report export**                 | usage/retro/anomaly/notification trend를 redacted markdown/JSON으로 export한다.                        | 운영 리뷰와 외부 공유가 쉬워진다.                              | S/M  | trend APIs, redaction                                          | 민감 정보 유출. privacy allowlist, preview before export.                               |
| P2   | **Hard sandbox phase 1**                | OS-level 계정/컨테이너/권한 경계로 강한 격리를 제공한다.                                               | 신뢰가 낮은 피어도 host를 쓸 수 있다.                          | XL   | sandbox v0 learnings, platform-specific design                 | 호환성/운영 복잡도. 별도 설계와 platform matrix 필요.                                   |
| P2   | **Auto-remediation from anomaly**       | anomaly가 일정 threshold를 넘으면 자동으로 task 중지/kill-switch를 건다.                               | 비용 폭주를 빠르게 막는다.                                     | L    | mature anomaly, approval policy, kill-switch                   | 오탐으로 작업 중단. v1.23 제외, human approval 전 자동 조치 금지.                       |
| P2   | **Remote multi-room actions**           | overlay에서 다른 room의 approve/abort/kill-switch를 직접 수행한다.                                     | 중앙 운영 편의가 크다.                                         | L/XL | auth federation, signed command, remote audit                  | 중앙 제어 위험. read-only aggregation 원칙 이후 별도 security review 필요.              |

## 2. 제안 v1.23 스코프

v1.23의 권장 테마는 **"advisory ops signals"**다. v1.22가 retro analytics를 만들고 있다면, v1.23은 회고와 실행 데이터를 advisory 신호로 바꾸고, 그 신호를 operator가 볼 수 있는 trend/forecast와 Slack digest/reminder로 전달하는 데 집중한다. sandbox는 v0 정책과 boundary preview까지 포함하되, 실제 강제 차단은 범위가 크면 v1.24로 넘기는 것이 안전하다.

### v1.23 핵심 항목

1. **Usage/cost trend + advisory anomaly/forecast**
   - usage/runs/runtime/cost를 member/project/node/agent/day 기준으로 집계한다.
   - anomaly는 alert-only, forecast는 advisory-only로 둔다.
   - known/unknown/estimated와 source warning을 분리하고, agy cost unknown을 유지한다.

2. **Notification routing v2**
   - condition/severity/target/quiet hours/dedupe/cooldown/escalation rule을 제공한다.
   - 저장 전 simulation mode로 예상 발신량을 보여준다.
   - rule 변경은 operator/admin gate와 audit을 유지한다.

3. **Slack digest/reminder**
   - blocked/running/stale/retro/usage/anomaly를 redacted summary digest로 보낸다.
   - ask-human pending, stale block, unconfirmed preview는 snooze와 max reminder로 제어한다.
   - Slack action은 acknowledge/snooze/open-link 중심으로 시작하고, mutation은 confirm 뒤로 둔다.

4. **Retro-to-improvement loop**
   - v1.22 retro theme를 dedupe해 improvement candidate로 만든다.
   - candidate inbox에서 approve/dismiss/merge를 지원한다.
   - board task 생성은 owner/operator confirm 전까지 하지 않는다.

5. **Sandbox v0 policy preview**
   - per-user sandbox의 policy model과 settings surface를 확정한다.
   - workspace/writable/env/secret/temp boundary preview를 제공한다.
   - best-effort/default OFF로 문서화하고 hard isolation이라고 말하지 않는다.

### v1.23 exit criteria

1. usage/cost trend가 known/unknown/estimated/source warning을 분리해 표시한다.
2. anomaly detection이 advisory alert만 만들고 abort/kill/quota hard block을 실행하지 않는다.
3. forecast가 source window와 confidence band를 표시하고 enforcement와 분리된다.
4. notification routing v2가 simulation, quiet hours, dedupe, cooldown, escalation을 지원한다.
5. Slack digest가 role/channel allowlist와 redaction을 적용한다.
6. Slack reminder가 snooze, max reminder, per-task dedupe를 지원한다.
7. retro insight가 improvement candidate로 묶이고 candidate inbox에서 approve/dismiss/merge된다.
8. candidate는 confirm 전 board task를 만들지 않는다.
9. sandbox v0 policy와 boundary preview가 제공되며 best-effort/default OFF로 명시된다.
10. e2e는 trend, anomaly advisory, forecast, notification simulation, digest/reminder, retro candidate, sandbox preview를 검증한다.

## 3. v1.24+ 백로그

| 후보                         | 설명                                                              | 넘기는 이유                                                       |
| ---------------------------- | ----------------------------------------------------------------- | ----------------------------------------------------------------- |
| sandbox violation audit      | 실제 차단 이벤트와 false denial을 redacted audit로 남긴다.        | enforcement hook과 UI copy 검증이 필요하다.                       |
| sandbox enforcement phase 1  | path/env/secret boundary를 실제 실행 context에 적용한다.          | v1.23 policy preview로 breakage 데이터를 먼저 얻는 편이 안전하다. |
| multi-room alert overlay     | signed read-only summaries 위에 alert overlay를 만든다.           | notification summary schema 안정화가 먼저다.                      |
| personalized digest actions  | Slack digest에서 acknowledge 외 safe mutation을 제공한다.         | action별 role/confirm/audit UX를 더 다듬어야 한다.                |
| room health score            | 여러 신호를 설명 가능한 score로 압축한다.                         | trend/anomaly/notification quality가 안정화된 뒤 적합하다.        |
| auto-remediation from signal | anomaly가 kill-switch/abort 같은 조치를 자동 제안하거나 실행한다. | advisory 신호의 오탐률 검증 전 자동 조치는 위험하다.              |
| remote multi-room actions    | 다른 room의 action을 중앙에서 직접 실행한다.                      | read-only 원칙을 깨므로 별도 federation/security 설계가 필요하다. |

## 4. 실행 순서 제안

1. **V23-W1 usage trend**: trend data model/API, source warnings, known/unknown honesty.
2. **V23-W2 advisory anomaly/forecast**: baselines, confidence, alert-only contract, tests.
3. **V23-W3 notification routing v2**: rule model, simulation, quiet hours, dedupe/cooldown, audit.
4. **V23-W4 Slack digest/reminder**: redacted digest, reminder loop, snooze, max reminder, allowlists.
5. **V23-W5 retro-to-improvement**: candidate generation, dedupe, inbox, confirm-before-task.
6. **V23-W6 sandbox v0 preview**: policy model, boundary preview, default OFF copy, settings UI.
7. **V23-W7 hardening**: privacy review, no-auto-mutation tests, spam tests, forecast accuracy notes.

## 5. 주요 리스크

- usage/cost 신호는 source가 불완전하다. known/unknown/estimated와 confidence를 분리하고 hard enforcement와 연결하지 않는다.
- anomaly/forecast는 오탐이 나올 수 있다. advisory-only, cooldown, threshold preview, no automatic abort/kill이 필수다.
- notification routing은 조용하면 누락이고 시끄러우면 무시된다. simulation, quiet hours, dedupe, per-rule audit을 기본으로 둔다.
- Slack digest/reminder는 spam surface가 될 수 있다. digest-first, max reminder, snooze, role/channel allowlist를 둔다.
- retro-to-improvement는 사람 평가처럼 보일 수 있다. 개인 ranking 금지, process/system theme 중심, source task와 confidence 표시가 필요하다.
- sandbox v0는 완전 격리가 아니다. v1.23은 policy preview 중심으로 두고, enforcement는 별도 검증 뒤 진행한다.
