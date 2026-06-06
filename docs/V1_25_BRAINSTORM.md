# grove v1.25+ 브레인스토밍

> Status: historical v1 brainstorm; superseded by the current v2 live cockpit model documented in `docs/design/MASTER_NODE.md` and `docs/agents/LEAD-HANDOFF.md`.
> 작성일: 2026-06-04

## 전제

- v1.22는 retro analytics를 read-only advisory insight로 출시했다.
- v1.23은 usage/cost trend, deterministic anomaly, "예측 아님" forecast를 advisory-only signal로 출시했다.
- v1.24는 crowded top nav를 grouped left sidebar로 옮기고, notification routing v2를 dry-run default, role-gated, audited로 진행 중인 것으로 둔다.
- v1.25는 v1.24의 routing 기반 위에 Slack scheduled digest/reminder를 붙이고, 사용자가 늘어난 cockpit surface를 빠르게 찾고 조작할 수 있도록 search/command palette, keyboard navigation, a11y, theming을 정리하는 단계가 적합하다.
- Slack digest/reminder와 multi-room overlay는 알림/조회 surface다. 자동 abort/kill/quota hard block, remote mutation, hidden task creation은 범위 밖이다.
- optional per-user sandbox v0는 shared host에서 피어 간 실수를 줄이는 best-effort 경계다. hard isolation으로 과장하지 않는다.

## 우선순위 기준

- **P0**: v1.25 핵심 후보. v1.24 routing을 실제 운영 루프로 닫거나, 사이드바 이후 cockpit 탐색/접근성을 직접 개선한다.
- **P1**: v1.25 stretch 또는 v1.26 후보. 가치가 크지만 정책, UI 세부, schema 안정화가 더 필요하다.
- **P2**: v1.27+ 후보. remote action, hard sandbox, 자동 remediation처럼 위험 경계가 큰 기능이다.

## 1. v1.25+ 후보 목록

| 우선 | 아이디어                              | 한 줄                                                                                                   | 가치                                                           | 규모 | 의존성                                                  | 위험/완화                                                                               |
| ---- | ------------------------------------- | ------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- | ---- | ------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| P0   | **Slack scheduled digest v1**         | blocked/running/stale/retro/usage/anomaly를 정해진 cadence로 redacted Slack 요약으로 보낸다.            | Slack에서 상태 질문과 one-off 알림 noise를 줄인다.             | M    | v1.24 notification routing, Slack connector, redaction  | 과공유/spam. role/channel allowlist, counts-first, quiet hours, digest preview.         |
| P0   | **Slack live notice upsert reuse**    | 기존 `chat.update` 방식으로 room-status/digest 공지를 한 메시지에서 갱신한다.                           | 채널을 새 메시지로 덮지 않고 최신 상태를 유지한다.             | S/M  | Slack message ts store, digest renderer                 | update 누락/반복 업데이트. dirty flag, content hash, fallback post audit.               |
| P0   | **Slack reminder loop v1**            | ask-human pending, stale block, unacked route, unconfirmed preview를 reminder로 surface한다.            | 사람 결정이 오래 묻히는 문제를 줄인다.                         | M    | notification routing, Slack threads, audit              | reminder spam. snooze, max reminders, quiet hours, per-task/thread dedupe.              |
| P0   | **Reminder acknowledgement model**    | ack/snooze/expire 상태를 notification event와 연결해 reminder 재발송을 제어한다.                        | reminder가 반복 발송이 아니라 운영 상태가 된다.                | M    | notification store, audit events, Slack interactions    | ack 권한 우회. actor role re-check, one-shot action id, audit.                          |
| P0   | **Digest dry-run preview**            | digest rule 저장 전 지난 이벤트로 예상 요약 payload와 수신 채널을 보여준다.                             | operator가 Slack 발신량과 민감도 수준을 확인하고 켠다.         | M    | routing dry-run, digest renderer                        | 실제 digest와 차이. sample window/freshness 표시, dry-run badge.                        |
| P0   | **Optional per-user sandbox v0**      | workspace root, writable paths, temp dir, env allowlist, secret namespace를 best-effort로 분리한다.     | shared host에서 피어 간 파일/환경 실수를 줄인다.               | L    | team auth, project settings, spawn/executor context     | hard isolation 오해. default OFF, limitation banner, supported/unsupported matrix.      |
| P0   | **Sandbox boundary preview**          | sandbox 적용 전 허용/차단 path, inherited env, secret scope를 redacted preview로 보여준다.              | 정책 적용 전 breakage와 false safety를 줄인다.                 | M    | sandbox policy, redaction, settings UI                  | 민감 path 노출. operator-only detail, no raw secret values, copy review.                |
| P0   | **Sandbox violation audit v0**        | 차단/경고된 path/env/secret 접근을 redacted audit event와 사용자 reason으로 남긴다.                     | sandbox policy 디버깅과 신뢰도 확보에 필요하다.                | M/L  | sandbox wrappers, audit lane                            | false denial과 정보 노출. sampled detail, safe fallback, redaction tests.               |
| P0   | **Multi-room alert overlay v1**       | signed read-only summaries 위에 blocked/stale/quota/anomaly/handoff alert를 모아 보여준다.              | 여러 room의 운영 위험을 한 화면에서 본다.                      | M/L  | signed aggregation, notification summaries, privacy     | 중앙 제어 surface로 오해. read-only only, local deep-link, no remote mutation.          |
| P0   | **Alert correlation v1**              | task chain, room, handoff id, anomaly source가 같은 alert를 incident group으로 묶는다.                  | multi-room alert noise를 줄이고 원인 파악을 빠르게 한다.       | M    | multi-room overlay, audit correlation, handoff metadata | 잘못된 grouping. confidence, source list, manual split/merge.                           |
| P0   | **Global search**                     | task, node, room, handoff, audit event, setting을 sidebar 위 검색에서 찾는다.                           | 패널이 늘어난 cockpit에서 목적지까지 가는 시간을 줄인다.       | M    | sidebar nav, board/org/audit APIs, frontend index       | 민감 정보 노출. role-scoped source, no raw secret/path, result type badges.             |
| P0   | **Command palette v1**                | `Cmd+K`로 view 이동, task 열기, node terminal 열기, safe read action을 실행한다.                        | 사이드바를 넘어 반복 작업을 빠르게 처리한다.                   | M    | global search, route registry, role model               | mutation 우회. v1은 navigation/read-only 중심, mutation은 confirm flow로 deep-link.     |
| P0   | **Keyboard nav and a11y pass**        | sidebar, board, terminal, drawers, command palette에 focus order, shortcut, ARIA, skip link를 정리한다. | keyboard-only와 screen reader 사용성이 제품 수준으로 올라간다. | M    | sidebar nav, web e2e/a11y checks                        | shortcut 충돌. discoverable shortcuts, terminal focus mode, no global capture in input. |
| P0   | **Theme and density v1**              | light/dark/high-contrast와 compact/comfortable density를 design token으로 제공한다.                     | 장시간 운영 cockpit의 가독성과 개인 선호를 맞춘다.             | M    | CSS tokens, member/local preferences                    | one-off palette 확산. token-only theming, contrast checks, saved preference fallback.   |
| P1   | **Digest personalization**            | member별 watched board, owned tasks, role, quiet hours 기준으로 digest 내용을 다르게 만든다.            | 각 멤버가 필요한 정보만 받는다.                                | M    | Slack scheduled digest, team auth, notification rules   | 정보 누락. team digest 기본 유지, personal digest opt-in.                               |
| P1   | **Safe reminder actions**             | reminder 카드에서 ack, snooze, open task, open room 같은 safe action을 제공한다.                        | Slack에서 reminder 처리 루프가 닫힌다.                         | M    | reminder model, Slack interactions, dashboard links     | action 우회. write action은 role re-check + confirm + audit.                            |
| P1   | **Notification policy templates**     | solo, shared-host, review-heavy, incident-sensitive preset을 제공한다.                                  | notification setup friction을 줄인다.                          | S/M  | notification routing, digest dry-run                    | template 과신. every preset dry-run, editable rules, safe defaults.                     |
| P1   | **Saved cockpit views**               | 자주 쓰는 filter/search/view 조합을 sidebar favorite으로 저장한다.                                      | 팀/개인별 반복 운영 화면을 빠르게 복원한다.                    | M    | sidebar nav, global search, preferences                 | stale view. missing target 표시, project-scoped 저장.                                   |
| P1   | **Command palette mutation previews** | delegate, quota change, reminder rule edit 같은 mutation을 command palette에서 preview만 만든다.        | 빠른 조작과 안전 gate를 동시에 유지한다.                       | L    | command palette, confirm modals, role gates             | mutation 우회. preview-only, explicit confirm, operator role, audit.                    |
| P1   | **A11y regression harness**           | keyboard traversal, visible focus, ARIA labels, contrast를 e2e smoke로 고정한다.                        | UI polish가 회귀하지 않는다.                                   | M    | web e2e, selectors, theme tokens                        | 테스트 취약. stable data attrs, focused subset, manual checklist 병행.                  |
| P1   | **Multi-room alert digest**           | multi-room overlay alert를 daily/weekly signed-summary digest로 묶는다.                                 | 여러 room 운영자가 정기적으로 위험을 훑는다.                   | M    | multi-room overlay, digest renderer                     | 과공유. signed summary only, raw body 제외, room allowlist.                             |
| P1   | **Sandbox policy templates**          | personal, shared-review, read-only-reference preset을 제공한다.                                         | sandbox 설정을 빠르게 시작한다.                                | M    | sandbox v0, boundary preview                            | template 과신. explicit writable roots, editable policy, limitation copy.               |
| P2   | **Remote multi-room actions**         | overlay에서 다른 room의 approve/abort/kill-switch를 직접 수행한다.                                      | 중앙 운영 편의가 크다.                                         | L/XL | auth federation, signed command, remote audit           | 중앙 제어 위험. read-only 원칙 이후 별도 security review 필요.                          |
| P2   | **Hard sandbox phase 1**              | OS-level 계정/컨테이너/권한 경계로 강한 격리를 제공한다.                                                | 신뢰가 낮은 피어도 host를 쓸 수 있다.                          | XL   | sandbox v0 learnings, platform-specific design          | 호환성/운영 복잡도. 별도 platform matrix 필요.                                          |
| P2   | **Auto-remediation from alerts**      | anomaly/reminder escalation이 abort/kill/quota 변경을 자동 제안하거나 실행한다.                         | 비용 폭주와 stuck work를 더 빨리 멈춘다.                       | L    | mature alerts, approval policy, execution gates         | 오탐으로 작업 중단. v1.25 제외, human approval 전 자동 조치 금지.                       |

## 2. 제안 v1.25 스코프

v1.25의 권장 테마는 **"operable cockpit loop"**다. v1.24가 navigation을 sidebar로 정리하고 notification routing v2를 넣는다면, v1.25는 Slack digest/reminder로 운영 루프를 닫고, 늘어난 화면을 global search/command palette/keyboard/a11y/theme으로 실제로 쓰기 쉽게 만드는 단계가 맞다. sandbox와 multi-room overlay는 safety-first로 얇게 실증하되, remote mutation과 hard isolation은 제외한다.

### v1.25 핵심 항목

1. **Slack digest/reminder**
   - scheduled digest로 blocked/running/stale/retro/usage/anomaly를 redacted summary로 보낸다.
   - 기존 `chat.update` notice upsert를 재사용해 room-status/digest 공지를 한 메시지로 갱신한다.
   - reminder는 ack/snooze/max reminder/quiet hours/per-thread dedupe를 갖는다.

2. **Optional per-user sandbox v0**
   - workspace/writable/temp/env/secret boundary를 best-effort로 적용한다.
   - boundary preview와 violation audit을 함께 제공한다.
   - default OFF, limitation copy, supported/unsupported matrix를 명확히 둔다.

3. **Multi-room alert overlay**
   - signed read-only summary에서 alert만 모아 보여준다.
   - alert correlation으로 중복을 줄이고 source list와 confidence를 표시한다.
   - local deep-link만 제공하고 remote mutation은 제공하지 않는다.

4. **Search and command palette**
   - sidebar 위 global search로 task/node/room/handoff/audit/settings를 찾는다.
   - `Cmd+K` command palette는 view 이동과 read-only/safe open action 중심으로 시작한다.
   - mutation은 v1.25 scope에서는 direct 실행하지 않고 기존 confirm surface로 deep-link한다.

5. **Keyboard/a11y/theming**
   - sidebar, board, terminal, drawers, command palette의 focus order와 shortcuts를 정리한다.
   - high-contrast theme, light/dark, compact density를 token 기반으로 제공한다.
   - contrast, visible focus, keyboard traversal을 e2e smoke로 고정한다.

### v1.25 exit criteria

1. Slack scheduled digest가 cadence, channel allowlist, redaction, counts-first payload를 지원한다.
2. digest/room-status notice가 `chat.update` upsert로 반복 post 없이 갱신된다.
3. reminder가 ack/snooze/max reminder/quiet hours/per-thread dedupe를 지원한다.
4. sandbox v0가 best-effort/default OFF로 boundary preview와 violation audit을 제공한다.
5. multi-room alert overlay가 signed summary 기반 read-only view와 local deep-link만 제공한다.
6. global search가 role/project scope를 지키며 task/node/room/handoff/audit/settings를 찾는다.
7. command palette v1이 navigation/read-only open action을 제공하고 mutation 우회를 만들지 않는다.
8. keyboard nav가 sidebar, board, terminal, drawers, command palette에서 visible focus와 escape path를 제공한다.
9. theme/density preference가 token 기반으로 저장되고 high-contrast가 기본 contrast check를 통과한다.
10. e2e는 Slack digest/upsert, reminder snooze, sandbox preview/audit, multi-room overlay, global search, command palette, keyboard/a11y, theme persistence를 검증한다.

## 3. v1.26+ 백로그

| 후보                             | 설명                                                                   | 넘기는 이유                                                        |
| -------------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------ |
| digest personalization           | 개인 watched board/owned task/quiet hours 기준 digest를 다르게 만든다. | v1.25 team digest 안정화가 먼저다.                                 |
| command palette mutation preview | palette에서 delegate/rule edit/quota change preview를 만든다.          | confirm UX와 role/audit contract를 더 다듬어야 한다.               |
| saved cockpit views              | 검색/filter/view 조합을 favorite으로 저장한다.                         | search/palette 기반이 먼저 필요하다.                               |
| notification policy templates    | 운영 유형별 preset rule pack을 제공한다.                               | digest/reminder 실사용 데이터가 먼저 필요하다.                     |
| sandbox policy templates         | sandbox preset을 제공한다.                                             | v0 false denial과 compatibility 데이터를 먼저 봐야 한다.           |
| multi-room alert digest          | overlay alert를 정기 digest로 묶는다.                                  | overlay와 redaction schema 안정화가 먼저다.                        |
| hard sandbox phase 1             | OS-level 강한 격리를 제공한다.                                         | best-effort v0 검증 전에는 호환성 위험이 크다.                     |
| remote multi-room actions        | 다른 room action을 중앙에서 수행한다.                                  | read-only aggregation 원칙을 깨므로 별도 security 설계가 필요하다. |

## 4. 실행 순서 제안

1. **V25-W1 Slack digest**: schedule config, renderer, redaction, `chat.update` upsert, dry-run preview.
2. **V25-W2 Slack reminders**: ack/snooze, max reminder, quiet hours, per-thread dedupe, audit.
3. **V25-W3 sandbox v0**: best-effort policy, boundary preview, violation audit, limitation copy.
4. **V25-W4 multi-room overlay**: signed alert summary, correlation, source list, local deep-link.
5. **V25-W5 search/palette**: global search index, command registry, `Cmd+K`, role-scoped results.
6. **V25-W6 keyboard/a11y**: focus order, shortcuts, terminal focus mode, skip links, e2e smoke.
7. **V25-W7 theming**: token cleanup, high-contrast, density, preference persistence, contrast review.
8. **V25-W8 hardening**: no-spam tests, no remote mutation, no hidden mutation through palette, sandbox expectation review.

## 5. 주요 리스크

- Slack digest/reminder는 쉽게 spam이 된다. digest-first, max reminder, quiet hours, role/channel allowlist, upsert notice로 제한한다.
- sandbox v0는 완전 격리가 아니다. best-effort/default OFF, limitation copy, boundary preview, violation audit로 기대치를 관리한다.
- multi-room overlay는 중앙 action surface로 확장하고 싶은 압력이 크다. v1.25는 read-only와 local deep-link만 허용한다.
- command palette는 편한 만큼 mutation 우회 위험이 있다. v1은 navigation/read-only 중심으로 두고 write action은 기존 confirm surface로 보낸다.
- keyboard shortcut은 terminal/input과 충돌할 수 있다. input focus와 terminal focus mode에서는 global capture를 피하고 discoverable shortcut help를 둔다.
- theming은 색상 난립과 contrast 회귀를 만들 수 있다. design token만 허용하고 high-contrast/visible-focus checks를 고정한다.
