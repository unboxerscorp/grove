# grove v1.22+ 브레인스토밍

> Status: historical v1 brainstorm; superseded by the current v2 live cockpit model documented in `docs/design/MASTER_NODE.md` and `docs/agents/LEAD-HANDOFF.md`.
> 작성일: 2026-06-04

## 전제

- v1.19는 per-user ledger와 soft quota를 출시했고, v1.20은 Slack 자유형 intake를 deterministic/no-LLM, default OFF, preview->confirm, role/audit gate로 출시했다.
- v1.21은 Slack thread context와 자연어 상태 질의를 진행 중인 것으로 둔다. 즉 v1.22는 "질문에 답하는 봇"보다 한 단계 운영 쪽으로 옮겨, 공유 호스트 안전성, 회고 인사이트, 비용/사용량 추세, 알림 라우팅, multi-room 알림을 다듬는 단계가 적합하다.
- 기본 원칙은 local-first, real terminal session, board=delegation protocol, team auth role, audit, privacy allowlist, read-only aggregation, default OFF for sharp edges다.
- v1.22에서 자동 실행 또는 자동 task 생성은 목표가 아니다. 제안/요약/리마인더는 할 수 있지만, task creation, quota/policy 변경, escalation rule 변경은 confirm과 role gate를 유지한다.
- sandbox v0는 "완전 격리"가 아니라 shared host에서 우발적 피어 간 간섭을 줄이는 best-effort 경계로 문서화한다.

## 우선순위 기준

- **P0**: v1.22 핵심 후보. 공유 호스트 운영 안전성 또는 Slack 운영 noise 감소에 직접 기여한다.
- **P1**: v1.22 stretch 또는 v1.23 후보. 데이터 품질, UX, 정책 모델 검증이 필요하다.
- **P2**: v1.24+ 후보. 강한 격리, 자동 mutation, 원격 multi-room action처럼 위험 경계가 크다.

## 1. v1.22+ 후보 목록

| 우선 | 아이디어                          | 한 줄                                                                                                     | 가치                                                            | 규모 | 의존성                                                         | 위험/완화                                                                                         |
| ---- | --------------------------------- | --------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- | ---- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| P0   | **Optional per-user sandbox v0**  | 사용자별 workspace root, writable paths, temp dir, env allowlist, secret namespace를 opt-in으로 분리한다. | tailnet shared host에서 피어 간 파일/환경 실수를 줄인다.        | L    | team auth, per-user ledger, project settings, process launcher | 완전 보안 경계로 오해될 위험. best-effort/default OFF, limitation banner, unsupported cases 명시. |
| P0   | **Sandbox boundary preview**      | sandbox를 켜기 전에 writable/blocked path, inherited env, secret scope를 미리 보여준다.                   | operator가 정책 효과를 이해하고 켠다.                           | M    | sandbox v0, redaction, settings UI                             | 잘못된 안전감. "차단되는 것/안 되는 것"을 분리 표시하고 audit link 제공.                          |
| P0   | **Sandbox violation audit**       | 차단된 path/env/secret 접근을 redacted audit event와 user-facing reason으로 남긴다.                       | 격리 정책을 디버깅하고 false denial을 줄인다.                   | M    | sandbox v0, audit lane, terminal/runtime wrappers              | 민감 path 노출. path/token redaction, operator-only detail, count-first summary.                  |
| P0   | **Workspace policy templates**    | personal, shared-review, read-only-reference 같은 sandbox preset을 제공한다.                              | 설정 마찰을 줄이고 반복 room 생성 품질을 높인다.                | M    | project templates, sandbox boundary preview                    | template 과신. preset마다 editable policy와 warning copy 포함.                                    |
| P0   | **Retro analytics v1**            | self-retro와 human note를 blocker, root cause, verification gap, handoff issue로 집계한다.                | 반복 실패를 운영 개선 후보로 바꾼다.                            | M    | self-retro lane, audit events, task metadata                   | 사람 평가처럼 보일 위험. 개인 ranking 금지, system/process theme 중심, sample size 표시.          |
| P0   | **Retro insight digest**          | 주간/릴리스 단위로 반복 blocker와 개선 후보를 요약한다.                                                   | 회고가 흩어지지 않고 다음 planning 입력이 된다.                 | M    | retro analytics, notification digest, board read APIs          | 과잉 요약. source task 링크, confidence, manual dismiss/merge.                                    |
| P0   | **Usage/cost trend v2**           | member/project/node/agent/day별 known/unknown usage, runtime, soft quota pressure를 추세로 보여준다.      | 비용과 공정 분배를 같은 화면에서 판단한다.                      | M/L  | /api/usage, /api/ledger, execution timeline                    | 비용 부정확. known/unknown/estimated 분리, agy credit unknown 유지, no hard enforcement.          |
| P0   | **Usage anomaly detection v1**    | token/runtime/turn spike, unknown-cost 증가, host-pressure 급등을 baseline 대비 감지한다.                 | runaway work와 capacity risk를 조기에 발견한다.                 | M    | usage trend, ledger, host-pressure                             | false positive. threshold preview, cooldown, alert-only, no automatic abort.                      |
| P0   | **Usage forecast v1**             | 현재 burn rate로 soft quota 도달 예상일과 confidence band를 계산한다.                                     | operator가 quota를 hard stop 없이 미리 조정한다.                | M    | usage trend, quota settings                                    | 예측 과신. source window, confidence, "advisory only" 표기.                                       |
| P0   | **Notification routing v2**       | condition, severity, member/role target, quiet hours, dedupe, escalation을 rule로 관리한다.               | ask-human, blocked, quota, anomaly 알림이 올바른 사람에게 간다. | M/L  | team auth, audit events, Slack/web notification surfaces       | 알림 누락/폭주. simulation, default conservative rules, per-rule audit, cooldown.                 |
| P0   | **Notification simulation mode**  | rule을 저장하기 전에 지난 24시간 이벤트에 적용해 예상 발신을 보여준다.                                    | operator가 noise를 예측하고 정책을 안전하게 바꾼다.             | M    | notification routing v2, audit/event history                   | 시뮬레이션과 실제 차이. sample window/freshness 표시, dry-run badge.                              |
| P0   | **Slack summary digest**          | blocked/stale/decision/usage/anomaly를 thread-safe digest로 요약해 정해진 시간에 보낸다.                  | Slack noise를 줄이면서 운영 상태를 놓치지 않는다.               | M    | notification routing, Slack thread context, redaction          | 민감 정보 과공유. counts-first, role/channel allowlist, local dashboard deep links.               |
| P0   | **Slack reminder loop**           | ask-human pending, stale block, unconfirmed preview를 policy에 따라 reminder로 surface한다.               | 사람 결정 지연을 줄이고 오래된 작업을 되살린다.                 | M    | Slack intake/thread linkage, notification rules                | reminder spam. quiet hours, max reminders, manual snooze, per-task dedupe.                        |
| P0   | **Multi-room alert overlay v1**   | signed read-only summaries 위에 blocked/stale/quota/anomaly/handoff alert를 한 화면에 모은다.             | 여러 room의 위험을 중앙에서 빠르게 본다.                        | M/L  | signed aggregation, notification summaries, privacy policy     | 중앙 제어 surface로 오해. read-only only, local deep-link, no remote mutation.                    |
| P0   | **Alert correlation v1**          | 같은 task chain, handoff id, room, cause에서 온 알림을 incident group으로 묶는다.                         | multi-room 알림 noise를 줄이고 원인을 빨리 찾는다.              | M    | alert overlay, audit correlation, handoff metadata             | 잘못된 grouping. confidence 표시, manual split/merge, source list.                                |
| P1   | **Retro-to-action candidates**    | 반복 retro insight를 dedupe해 board candidate로 제안하되 자동 생성하지 않는다.                            | 회고가 실행 가능한 개선 작업으로 이어진다.                      | M    | retro insight digest, gated task-create                        | task 폭증. suggestion-only, owner confirm, duplicate merge.                                       |
| P1   | **Anomaly-to-alert policy**       | usage/cost anomaly를 notification rule 조건으로 연결한다.                                                 | 비용/런타임 위험이 사람에게 자동 surface된다.                   | M    | anomaly detection, notification routing                        | alert storm. severity threshold, cooldown, simulation first.                                      |
| P1   | **Digest personalization**        | member별 role, watched board, owned tasks 기준으로 digest 내용을 다르게 만든다.                           | shared room에서도 각자 필요한 정보만 받는다.                    | M    | notification routing, team auth, presence                      | 정보 누락. default team digest 유지, personal digest는 opt-in.                                    |
| P1   | **Slack reminder actions**        | reminder 카드에서 snooze, assign reviewer, open task 같은 안전 action을 제공한다.                         | Slack에서 처리 흐름이 닫힌다.                                   | M/L  | Slack command surface, role gates, task links                  | action 우회. every mutation preview/confirm, role re-check, audit.                                |
| P1   | **Room health score**             | blocked age, stale runs, quota pressure, anomaly, handoff wait를 설명 가능한 score로 압축한다.            | multi-room overlay에서 우선순위를 빨리 잡는다.                  | M    | alert overlay, usage/anomaly, audit                            | 점수 과신. source breakdown, no hidden model, no automatic action.                                |
| P1   | **Trend report export**           | usage/retro/alert trend를 redacted markdown 또는 JSON으로 export한다.                                     | 운영 리뷰와 외부 공유가 쉬워진다.                               | S/M  | trend APIs, privacy redaction                                  | 민감 정보 유출. privacy allowlist, preview before export.                                         |
| P2   | **Hard sandbox phase 1**          | OS-level user/container/permission boundary를 제공한다.                                                   | 신뢰가 낮은 피어도 host를 더 안전하게 쓴다.                     | XL   | sandbox v0 learnings, platform-specific design                 | 호환성/운영 복잡도. 별도 설계, opt-in, platform matrix 필요.                                      |
| P2   | **Automatic retro task creation** | high-confidence retro insight를 자동으로 board task로 만든다.                                             | 개선 작업 누락을 줄인다.                                        | L    | mature retro candidates, dedupe, owner policy                  | 자동 mutation 남용. v1.22 제외, confirm 없는 자동 생성 금지.                                      |
| P2   | **Remote multi-room actions**     | aggregation 화면에서 다른 room의 approve/abort/kill-switch를 직접 수행한다.                               | 중앙 운영 편의가 크다.                                          | L/XL | auth federation, signed command, remote audit                  | 중앙 제어 위험. read-only aggregation 원칙을 깬다; 별도 security review 전 금지.                  |

## 2. 제안 v1.22 스코프

v1.22의 권장 테마는 **"shared-host ops guardrails"**다. v1.21이 Slack thread와 자연어 질의를 통해 운영 상태를 묻고 답하는 surface를 만든다면, v1.22는 그 상태를 더 안전하게 운영할 수 있도록 sandbox v0, 회고/사용량 추세, 알림 라우팅, Slack digest/reminder, multi-room alert overlay를 연결한다.

### v1.22 핵심 항목

1. **Optional per-user sandbox v0**
   - workspace root, writable paths, temp dir, env allowlist, secret namespace를 project opt-in으로 제공한다.
   - boundary preview와 violation audit을 함께 제공한다.
   - best-effort/default OFF로 표기하고, hard isolation이라고 말하지 않는다.

2. **Retro analytics + insight digest**
   - self-retro와 human note를 blocker/root cause/verification gap/handoff issue로 집계한다.
   - 반복 theme를 digest로 만들고 source task와 confidence를 붙인다.
   - board task 생성은 candidate까지만, 실제 생성은 confirm 뒤로 미룬다.

3. **Usage/cost trend + anomaly/forecast**
   - usage, runtime, soft quota pressure를 member/project/node/agent/day 차원으로 보여준다.
   - anomaly는 alert-only이며 abort/kill/claim 같은 action을 자동 실행하지 않는다.
   - cost는 known/unknown/estimated를 분리하고, agy cost/credit은 로컬 source가 없으면 unknown으로 유지한다.

4. **Notification routing v2**
   - condition/severity/target/quiet hours/dedupe/escalation rule을 제공한다.
   - 저장 전 simulation mode로 예상 발신량을 보여준다.
   - 모든 policy mutation은 operator/admin gate와 audit을 거친다.

5. **Slack digest/reminder + multi-room alert overlay**
   - blocked/stale/decision/usage/anomaly를 redacted digest로 보낸다.
   - ask-human pending, stale block, unconfirmed preview는 snooze와 max reminder로 제어한다.
   - multi-room alert overlay는 signed read-only summary와 local deep-link만 제공한다.

### v1.22 exit criteria

1. sandbox v0가 project-level opt-in으로 켜지고 workspace/writable/env/secret/temp boundary를 설명한다.
2. sandbox boundary preview가 operator에게 표시되고, violation audit이 redacted event로 남는다.
3. retro analytics가 blocker/root cause/verification gap/handoff issue를 집계하고 digest를 만든다.
4. retro insight는 candidate까지만 만들며 자동 board mutation을 하지 않는다.
5. usage/cost trend가 known/unknown/estimated를 분리하고 agy unknown honesty를 유지한다.
6. anomaly/forecast는 advisory alert만 만들고 자동 abort/kill/quota hard block을 하지 않는다.
7. notification routing v2가 simulation, quiet hours, dedupe, cooldown, escalation을 지원한다.
8. Slack digest와 reminder가 role/channel allowlist, redaction, snooze, max reminder를 지원한다.
9. multi-room alert overlay가 signed summary 기반 read-only view를 제공하고 remote mutation을 제공하지 않는다.
10. e2e는 sandbox preview/violation, retro digest, usage anomaly, notification simulation, Slack reminder, multi-room alert overlay를 검증한다.

## 3. v1.23+ 백로그

| 후보                          | 설명                                                            | 넘기는 이유                                                            |
| ----------------------------- | --------------------------------------------------------------- | ---------------------------------------------------------------------- |
| hard sandbox phase 1          | OS-level 사용자/컨테이너/권한 경계로 강한 격리를 제공한다.      | v0 false denial, compatibility, UX 데이터를 먼저 봐야 한다.            |
| retro-to-action task creation | insight candidate를 confirm 뒤 board task로 생성한다.           | v1.22에서는 candidate 품질과 dedupe 검증이 먼저다.                     |
| personalized digest actions   | Slack digest에서 safe action을 직접 실행한다.                   | action별 role/confirm/audit UX를 더 다듬어야 한다.                     |
| advanced forecast planner     | quota forecast와 routing planner를 연결해 위임 추천에 반영한다. | cost signal 신뢰도와 fairness policy가 더 필요하다.                    |
| multi-room alert workflows    | alert group에 owner, SLA, checklist, resolution을 붙인다.       | read-only overlay 안정화 뒤 workflow를 얹는 편이 안전하다.             |
| remote multi-room actions     | 다른 room action을 중앙에서 수행한다.                           | read-only 원칙을 깨므로 별도 security/auth federation 설계가 필요하다. |

## 4. 실행 순서 제안

1. **V22-W1 sandbox v0**: policy model, boundary preview, violation audit, docs copy.
2. **V22-W2 retro analytics**: category extraction, aggregation, source-linked digest, candidate-only rule.
3. **V22-W3 usage trend**: trend API, anomaly/forecast advisory, unknown honesty, quota correlation.
4. **V22-W4 notification routing**: rule model, simulation, quiet hours, dedupe, escalation, audit.
5. **V22-W5 Slack digest/reminder**: redacted digest, reminder loop, snooze, max reminder, channel/member allowlist.
6. **V22-W6 multi-room alert overlay**: signed summary ingestion, alert correlation, read-only dashboard.
7. **V22-W7 hardening**: privacy review, no-remote-mutation tests, reminder spam tests, sandbox limitation review.

## 5. 주요 리스크

- sandbox v0는 완전 격리가 아니다. default OFF, best-effort copy, boundary preview, violation audit로 기대치를 관리한다.
- retro analytics가 개인 평가처럼 보일 수 있다. 사람 ranking을 금지하고 process/system theme 중심으로 보여준다.
- usage/cost forecast는 source가 불완전하다. known/unknown/estimated와 confidence를 분리하고 hard enforcement와 연결하지 않는다.
- notification routing은 알림 누락과 폭주가 모두 위험하다. simulation, cooldown, dedupe, quiet hours, per-rule audit이 필수다.
- Slack digest/reminder는 편하지만 spam이 될 수 있다. role/channel allowlist, max reminder, snooze, digest-first 기본값으로 제한한다.
- multi-room alert overlay는 remote action으로 확장하고 싶은 압력이 크다. v1.22는 read-only와 local deep-link만 허용한다.
