# grove v1.24+ 브레인스토밍

작성일: 2026-06-04

## 전제

- v1.21은 Slack thread context와 deterministic/no-LLM read-only status query를 출시했다.
- v1.22는 self-retro lane과 완료 task/run history를 read-only advisory insight로 출시했다.
- v1.23은 usage/cost trend, advisory anomaly detection, forecast를 진행 중인 것으로 둔다. 즉 v1.24는 이 신호를 사람이 놓치지 않도록 notification routing, Slack digest/reminder, multi-room alert overlay로 연결하는 단계가 적합하다.
- notification은 실행 시스템이 아니다. v1.24의 알림은 dry-run, preview, advisory, role/audit gate를 유지하며, abort/kill/quota hard block/task creation 같은 변이를 자동으로 수행하지 않는다.
- optional per-user sandbox v0는 shared host에서 피어 간 우발적 간섭을 줄이는 best-effort 경계다. 강한 격리나 보안 샌드박스로 과장하지 않는다.

## 우선순위 기준

- **P0**: v1.24 핵심 후보. advisory signal을 올바른 사람/채널에 전달하거나 shared host 안전성을 직접 높인다.
- **P1**: v1.24 stretch 또는 v1.25 후보. 가치가 크지만 UX, 정책, schema 안정화가 더 필요하다.
- **P2**: v1.26+ 후보. 자동 조치, remote action, hard isolation처럼 위험 경계가 큰 기능이다.

## 1. v1.24+ 후보 목록

| 우선 | 아이디어                                  | 한 줄                                                                                                 | 가치                                                            | 규모 | 의존성                                                     | 위험/완화                                                                                  |
| ---- | ----------------------------------------- | ----------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- | ---- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| P0   | **Notification routing v2 core**          | condition, severity, target member/role, quiet hours, dedupe, cooldown, escalation을 rule로 관리한다. | ask-human, anomaly, quota, stale task를 올바른 사람에게 보낸다. | M/L  | team auth, audit events, board/run state, v1.23 signals    | 알림 누락/폭주. conservative default, dry-run first, per-rule audit, cooldown.             |
| P0   | **Routing dry-run simulator**             | rule 저장 전 최근 이벤트에 적용해 예상 발신량, 대상, escalation path를 보여준다.                      | operator가 알림 정책 변경의 영향을 미리 본다.                   | M    | notification routing, event history, member roles          | simulation과 실제 차이. sample window/freshness/dry-run badge 표시.                        |
| P0   | **Multi-channel target model**            | Slack, dashboard inbox, web toast, digest를 같은 rule target으로 표현한다.                            | channel별 중복 구현 없이 정책을 확장한다.                       | M    | notification routing, existing inbox/Slack surfaces        | 채널별 권한 차이. target별 role check, redaction profile, delivery audit.                  |
| P0   | **Escalation and acknowledgement loop**   | 미확인 알림을 owner->operator->admin 순으로 escalate하고 ack/snooze를 기록한다.                       | 오래 방치된 사람 결정과 blocked task를 줄인다.                  | M/L  | team auth, notification store, audit lane                  | escalation spam. max depth, quiet hours, manual snooze, per-alert dedupe.                  |
| P0   | **Anomaly-to-advisory notification**      | v1.23 anomaly/forecast를 advisory alert로 변환하되 자동 abort/kill은 하지 않는다.                     | runaway usage와 capacity risk를 사람에게 즉시 surface한다.      | M    | usage trend, anomaly detector, notification routing        | false positive. advisory-only, confidence band, cooldown, no automatic state change.       |
| P0   | **Slack scheduled digest v1**             | blocked/running/stale/retro/usage/anomaly를 정해진 cadence의 redacted digest로 보낸다.                | 상태 질문과 noisy one-off 알림을 줄이고 운영 리듬을 만든다.     | M    | Slack connector, notification routing, redaction           | 과공유/spam. counts-first, role/channel allowlist, local dashboard links.                  |
| P0   | **Slack live notice upsert reuse**        | 기존 `chat.update` 방식으로 room-status/triage/digest notice를 한 메시지에서 갱신한다.                | Slack 채널을 새 메시지로 덮지 않고 최신 상태를 유지한다.        | S/M  | Slack message ts store, digest renderer                    | 업데이트 누락/반복 업데이트. dirty flag, content hash, fallback post audit.                |
| P0   | **Slack reminder loop v1**                | ask-human pending, stale block, unconfirmed preview, anomaly ack 대기를 reminder로 surface한다.       | 사람이 필요한 결정을 놓치지 않는다.                             | M    | Slack threads, notification rules, audit                   | reminder spam. max reminders, snooze, quiet hours, per-task/thread dedupe.                 |
| P0   | **Optional per-user sandbox v0**          | workspace root, writable path, temp dir, env allowlist, secret namespace를 best-effort로 분리한다.    | shared host에서 피어 간 파일/환경 실수를 줄인다.                | L    | team auth, project settings, spawn/executor context        | hard isolation으로 오해. default OFF, best-effort label, limitation banner, fallback plan. |
| P0   | **Sandbox boundary preview**              | sandbox 켜기 전 허용/차단 path, inherited env, secret scope를 operator에게 보여준다.                  | policy 적용 전 breakage와 false safety를 줄인다.                | M    | sandbox v0, redaction, settings UI                         | 민감 path 노출. redacted preview, operator-only detail, no raw secret values.              |
| P0   | **Sandbox violation audit v0**            | 차단 또는 경고된 path/env/secret 접근을 redacted audit event로 남긴다.                                | sandbox 정책을 디버깅하고 신뢰도를 높인다.                      | M/L  | sandbox wrappers, audit lane                               | false denial/민감 정보 노출. sampled detail, redaction, safe fallback.                     |
| P0   | **Multi-room alert overlay v1**           | signed read-only summaries 위에 blocked/stale/quota/anomaly/handoff alert를 모아 보여준다.            | 여러 room의 운영 위험을 한 화면에서 본다.                       | M/L  | signed aggregation, notification summaries, privacy policy | 중앙 제어 surface로 오해. read-only only, local deep-link, no remote mutation.             |
| P0   | **Alert correlation v1**                  | task chain, room, handoff id, anomaly source가 같은 alert를 incident group으로 묶는다.                | multi-room 알림 noise를 줄이고 원인 파악을 빠르게 한다.         | M    | alert overlay, audit correlation, handoff metadata         | 잘못된 grouping. confidence, source list, manual split/merge.                              |
| P1   | **Digest personalization**                | member별 watched board, owned tasks, role, quiet hours 기준으로 digest 내용을 다르게 만든다.          | 각 팀원이 필요한 정보만 받는다.                                 | M    | notification routing, team auth, presence                  | 정보 누락. team digest 기본 유지, personal digest opt-in.                                  |
| P1   | **Safe Slack reminder actions**           | reminder 카드에서 ack, snooze, open task 같은 safe action을 제공한다.                                 | Slack에서 알림 처리 루프가 닫힌다.                              | M    | Slack command surface, role gates, dashboard links         | action 우회. state mutation은 preview/confirm, role re-check, audit.                       |
| P1   | **Notification policy templates**         | solo, shared-host, review-heavy, incident-sensitive 같은 preset rule pack을 제공한다.                 | setup friction을 줄이고 운영 품질을 높인다.                     | S/M  | notification routing, dry-run simulator                    | template 과신. every preset dry-run, editable rules, safe defaults.                        |
| P1   | **Room health alert score**               | blocked age, stale runs, anomaly, quota pressure, reminder backlog를 설명 가능한 score로 압축한다.    | multi-room overlay에서 attention 우선순위를 빠르게 잡는다.      | M    | alert overlay, anomaly, notification state                 | 점수 과신. source breakdown, no hidden model, no automatic action.                         |
| P1   | **Notification delivery audit dashboard** | sent/skipped/deduped/escalated/failed delivery를 한 화면에서 본다.                                    | 알림이 왜 갔는지, 왜 안 갔는지 디버깅한다.                      | M    | delivery store, audit lane, FE view                        | 민감 payload 노출. redacted summary, operator-only detail.                                 |
| P1   | **Cross-room alert digest**               | multi-room overlay의 alert를 daily/weekly summary로 묶는다.                                           | 여러 room 운영자가 정기적으로 위험을 훑는다.                    | M    | alert overlay, digest renderer                             | 과공유. room allowlist, signed summary만 사용, raw body 제외.                              |
| P2   | **Auto-remediation from anomaly**         | anomaly가 threshold를 넘으면 abort/kill/quota 변경을 자동 제안하거나 실행한다.                        | 비용 폭주를 빠르게 막는다.                                      | L    | mature anomaly, approval policy, kill-switch               | 오탐으로 작업 중단. v1.24 제외, human approval 전 자동 조치 금지.                          |
| P2   | **Remote multi-room actions**             | overlay에서 다른 room의 approve/abort/kill-switch를 직접 수행한다.                                    | 중앙 운영 편의가 크다.                                          | L/XL | auth federation, signed command, remote audit              | 중앙 제어 위험. read-only 원칙 이후 별도 security review 필요.                             |
| P2   | **Hard sandbox phase 1**                  | OS-level 계정/컨테이너/권한 경계로 강한 격리를 제공한다.                                              | 신뢰가 낮은 피어도 host를 쓸 수 있다.                           | XL   | sandbox v0 learnings, platform-specific design             | 호환성/운영 복잡도. 별도 설계와 platform matrix 필요.                                      |

## 2. 제안 v1.24 스코프

v1.24의 권장 테마는 **"routed advisory alerts"**다. v1.23이 trend/anomaly/forecast를 advisory signal로 만들고 있다면, v1.24는 그 신호를 사람에게 안전하게 전달하는 notification routing v2와 Slack digest/reminder를 완성하는 데 집중한다. 동시에 sandbox v0는 best-effort 경계와 preview/audit까지만 실증하고, multi-room alert overlay는 read-only로 제한한다.

### v1.24 핵심 항목

1. **Notification routing v2**
   - condition/severity/target/quiet hours/dedupe/cooldown/escalation rule을 제공한다.
   - rule 저장 전 dry-run simulator로 예상 발신량과 대상자를 보여준다.
   - Slack, dashboard inbox, web toast, digest를 target model로 통합한다.

2. **Slack digest/reminder**
   - scheduled digest로 blocked/running/stale/retro/usage/anomaly를 redacted summary로 보낸다.
   - 기존 `chat.update` notice upsert 방식을 재사용해 room-status/digest 공지를 갱신한다.
   - reminder는 ack/snooze/max reminder/quiet hours/per-thread dedupe를 갖는다.

3. **Anomaly-to-advisory alerts**
   - usage/cost anomaly와 forecast risk를 notification rule condition으로 연결한다.
   - alert는 advisory-only이며 abort/kill/quota hard block을 자동 실행하지 않는다.
   - confidence, source window, freshness, cooldown을 표시한다.

4. **Optional per-user sandbox v0**
   - workspace/writable/temp/env/secret boundary를 best-effort로 적용한다.
   - boundary preview와 violation audit을 함께 제공한다.
   - default OFF와 limitation copy를 UI/API에 명확히 둔다.

5. **Multi-room alert overlay**
   - signed read-only summary에서 alert만 모아 보여준다.
   - alert correlation으로 중복을 줄이고 local deep-link를 제공한다.
   - remote mutation은 제공하지 않는다.

### v1.24 exit criteria

1. notification routing v2가 condition, severity, target, quiet hours, dedupe, cooldown, escalation을 지원한다.
2. 모든 notification rule 저장은 dry-run 결과를 먼저 볼 수 있다.
3. Slack digest가 scheduled, redacted, role/channel allowlisted, counts-first로 동작한다.
4. `chat.update` upsert notice가 반복 post 없이 room-status/digest를 갱신한다.
5. reminder가 ack/snooze/max reminder/per-thread dedupe를 지원한다.
6. anomaly/forecast 알림은 advisory-only이며 자동 abort/kill/quota hard block을 하지 않는다.
7. sandbox v0는 best-effort/default OFF로 boundary preview와 violation audit을 제공한다.
8. multi-room alert overlay는 signed summary 기반 read-only view와 local deep-link만 제공한다.
9. alert correlation은 source list와 confidence를 보여주고 manual split/merge를 허용한다.
10. e2e는 routing dry-run, escalation, Slack digest/upsert, reminder snooze, anomaly alert, sandbox preview/audit, multi-room overlay를 검증한다.

## 3. v1.25+ 백로그

| 후보                          | 설명                                                            | 넘기는 이유                                                        |
| ----------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------ |
| digest personalization        | 개인 watched board/role/owned task 기준 digest를 다르게 만든다. | v1.24 team digest와 routing core 안정화가 먼저다.                  |
| notification policy templates | 운영 유형별 preset rule pack을 제공한다.                        | dry-run과 delivery audit 품질을 먼저 검증해야 한다.                |
| room health alert score       | 여러 alert 신호를 설명 가능한 score로 압축한다.                 | signal quality가 안정화된 뒤 도입해야 과신을 줄인다.               |
| cross-room alert digest       | multi-room overlay를 정기 digest로 보낸다.                      | read-only overlay와 redaction schema 안정화가 필요하다.            |
| auto-remediation from anomaly | anomaly 기반 abort/kill/quota 변경을 자동 제안하거나 실행한다.  | advisory false positive를 충분히 검증하기 전에는 위험하다.         |
| remote multi-room actions     | 다른 room action을 중앙에서 수행한다.                           | read-only aggregation 원칙을 깨므로 별도 security 설계가 필요하다. |
| hard sandbox phase 1          | OS-level 강한 격리를 제공한다.                                  | v0의 compatibility와 false denial 데이터를 먼저 봐야 한다.         |

## 4. 실행 순서 제안

1. **V24-W1 notification routing**: rule schema, target model, role scope, delivery audit.
2. **V24-W2 dry-run and escalation**: simulator, quiet hours, dedupe/cooldown, escalation state.
3. **V24-W3 Slack digest/upsert**: scheduled digest, redaction, `chat.update` notice reuse, tests.
4. **V24-W4 reminders**: ack, snooze, max reminder, per-thread dedupe, reminder audit.
5. **V24-W5 anomaly advisory alerts**: rule conditions, confidence/source display, no-auto-action tests.
6. **V24-W6 sandbox v0**: best-effort policy, boundary preview, violation audit, limitation copy.
7. **V24-W7 multi-room overlay**: signed alert summary, correlation, local deep-link, read-only tests.
8. **V24-W8 hardening**: spam review, privacy review, dry-run accuracy, no remote mutation, no auto remediation.

## 5. 주요 리스크

- notification routing은 알림 누락과 폭주가 모두 위험하다. dry-run, conservative defaults, cooldown, quiet hours, per-rule audit을 기본으로 둔다.
- Slack digest/reminder는 spam surface가 되기 쉽다. digest-first, max reminder, snooze, role/channel allowlist, upsert notice로 제한한다.
- anomaly advisory는 false positive가 생길 수 있다. confidence와 source window를 표시하고 자동 abort/kill/quota hard block과 분리한다.
- sandbox v0는 완전 격리가 아니다. best-effort/default OFF, boundary preview, limitation copy, violation audit로 기대치를 관리한다.
- multi-room alert overlay는 중앙 제어로 확장하고 싶은 압력이 크다. v1.24는 read-only와 local deep-link만 허용한다.
- 다중채널 알림은 channel별 redaction/role 차이를 놓치기 쉽다. target별 redaction profile과 delivery audit을 별도로 둔다.
