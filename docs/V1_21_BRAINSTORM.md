# grove v1.21+ 브레인스토밍

작성일: 2026-06-04

## 전제

- v1.18은 tailnet shared-access를 출시했고, v1.19는 per-user ledger와 soft quota를 출시했다.
- v1.20은 Slack 봇 지능화를 진행 중인 것으로 둔다. 핵심은 bug/feedback/task intake와 자유형 triage를 default OFF, preview->confirm, role/audit gate 재사용으로 여는 것이다.
- v1.21은 Slack 봇을 단발 intake에서 **thread-aware 운영 대화 surface**로 확장하고, 동시에 공유 호스트의 선택적 sandbox, 회고/비용 인사이트, 알림 라우팅을 실제 운영 루프로 묶는 단계가 적합하다.
- 원칙은 실제 CLI 세션, 보드=위임 프로토콜, receiver-local accept, per-user identity, soft quota, privacy allowlist, read-only query 우선, mutation은 confirm이다.
- 자연어 질의와 thread 후속 대화는 편의 기능이다. task 생성, comment, unblock, quota 변경, execution action 같은 mutation은 기존 gate를 우회하면 안 된다.

## 우선순위 기준

- **P0**: v1.21 핵심 후보. v1.20 Slack intake를 실제 운영 대화로 만들거나 공유 호스트 안전성을 직접 높인다.
- **P1**: v1.21 stretch 또는 v1.22 후보. 가치가 크지만 정책, UX, 데이터 신뢰도 검증이 더 필요하다.
- **P2**: v1.23+ 후보. 자동 실행, hard enforcement, 원격 action처럼 위험 경계가 큰 기능이다.

## 1. v1.21+ 후보 목록

| 우선 | 아이디어                              | 한 줄                                                                                                    | 가치                                                             | 규모 | 의존성                                                     | 위험/완화                                                                        |
| ---- | ------------------------------------- | -------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- | ---- | ---------------------------------------------------------- | -------------------------------------------------------------------------------- |
| P0   | **Slack thread context v1**           | Slack thread root와 최근 reply를 bounded context로 요약해 triage와 답변에 사용한다.                      | 사용자가 같은 thread에서 재현 정보와 후속 맥락을 이어갈 수 있다. | M    | v1.20 Slack intake, Slack history, redaction               | 민감 정보 확대 위험. N-limit, privacy allowlist, no file content by default.     |
| P0   | **Conversational follow-up preview**  | "라벨 바꿔", "재현 단계 추가", "task로 전환" 같은 후속 메시지를 preview 변경으로 처리한다.               | Slack 안에서 봇 판단을 고치고 task 후보를 다듬는다.              | M/L  | preview state, correction commands, confirmation store     | mutation 우회 위험. preview-only update, same-owner confirm, expiry.             |
| P0   | **Task-thread linkage**               | 생성된 task와 Slack thread를 연결해 후속 댓글/상태 조회가 같은 thread에서 이어진다.                      | Slack 대화와 board task가 분리되지 않는다.                       | M    | task metadata, slack_threads, comments                     | 잘못된 task에 연결 위험. explicit link preview, task id display, audit.          |
| P0   | **Natural-language status query**     | "막힌 것 뭐야?", "오늘 실행 실패?", "사용량 높은 node?"를 board/execution/usage read API로 답한다.       | Slack에서 운영 상태를 빠르게 확인한다.                           | M/L  | read APIs, usage ledger, execution timeline, redaction     | 정보 노출 위험. role-gated detail, channel allowlist, counts-first default.      |
| P0   | **Query answer provenance**           | 자연어 답변에 data source, freshness, scope, confidence, redaction note를 붙인다.                        | 사용자가 답변을 과신하지 않고 근거를 확인한다.                   | M    | status query, audit/read APIs                              | LLM 환각 위험. evidence-only answer, no unsupported claims, stale badge.         |
| P0   | **Read-only answer sandbox**          | 질문 응답 경로는 board/comment/task mutation을 만들 수 없는 read-only runtime으로 격리한다.              | 질문과 작업 요청의 안전 경계를 유지한다.                         | S/M  | Slack answer path, service boundary tests                  | 숨은 side effect 위험. mutation spy tests, explicit read-only interface.         |
| P0   | **Optional per-user sandbox v0**      | workspace root, writable paths, temp dir, env allowlist, secret namespace를 project opt-in으로 분리한다. | shared host에서 피어 간 파일/환경 실수를 줄인다.                 | L    | v1.19 ledger, project creation, process launcher           | 완전 격리로 오해될 위험. best-effort label, off by default, limitations.         |
| P0   | **Sandbox boundary preview**          | sandbox 적용 전 허용/차단 path, inherited credentials, env/secret scope를 보여준다.                      | 사용자가 격리 범위를 이해하고 켠다.                              | M    | sandbox v0, redaction, project settings                    | 잘못된 안전감 위험. preview, unsupported cases, audit of policy changes.         |
| P0   | **Sandbox violation audit**           | blocked path/env/secret access를 redacted audit event와 user-facing reason으로 남긴다.                   | 격리 정책을 디버깅하고 정책 문제를 투명하게 본다.                | M    | sandbox v0, audit lane                                     | 민감 정보 노출 위험. path/token redaction, admin detail gate.                    |
| P0   | **Retro analytics v2**                | self-retro와 human note를 root cause, blocker, verification, cost, collaboration issue로 집계한다.       | 반복 실패를 개선 후보와 운영 리뷰 agenda로 바꾼다.               | M    | retro lane, audit events, per-user ledger                  | 사람 평가처럼 보일 위험. system theme 중심, sample size, confidence.             |
| P0   | **Usage/cost trend v2**               | user/project/node/agent/day별 known/unknown/estimate usage와 soft quota pressure를 표시한다.             | 비용과 공정 분배를 같은 맥락에서 판단한다.                       | M/L  | /api/usage, /api/ledger, cost confidence                   | 비용 부정확 위험. known/unknown 분리, agy unknown 유지, no hard block.           |
| P0   | **Usage anomaly and forecast**        | token/runtime/turn spike, unknown-cost 증가, quota pressure를 baseline과 confidence band로 탐지한다.     | 이상 실행과 비용 위험을 조기에 발견한다.                         | M    | usage trend, execution timeline, ledger                    | false positive 위험. threshold preview, silence with audit, no auto enforcement. |
| P0   | **Notification routing v2**           | 조건, severity, target member/role, quiet hours, digest, dedupe, escalation을 rule로 관리한다.           | 중요한 사람 판단을 올바른 사람에게 보내고 noise를 줄인다.        | M/L  | team auth, audit events, Slack/web notification surfaces   | 알림 누락/과다 위험. simulation, safe defaults, per-rule audit.                  |
| P0   | **Multi-room alert dashboard**        | aggregation 위에 blocked, stale, quota pressure, handoff wait, anomaly alert를 read-only로 모은다.       | 여러 room의 운영 위험을 한 화면에서 본다.                        | M/L  | signed aggregation, notification summaries, privacy policy | 중앙 action 오해 위험. read-only overlay, local deep-link, no remote mutation.   |
| P1   | **Slack status drilldown follow-ups** | "왜?", "어느 task?", "지난 24시간만" 같은 follow-up을 같은 query context에서 처리한다.                   | Slack 상태 질의가 실제 대화처럼 이어진다.                        | M    | thread context, query provenance, read APIs                | context 오해 위험. visible query scope, reset command, bounded memory.           |
| P1   | **Slack answer cards**                | board/usage/execution 답변을 compact card + expand link 형태로 렌더링한다.                               | 긴 운영 답변을 읽기 쉽게 만든다.                                 | M    | Slack formatting, dashboard deep links                     | 과공유 위험. default counts, detail links role-gated.                            |
| P1   | **Slack-to-notification rules**       | Slack에서 "이 유형은 나에게 알려줘" 같은 rule 생성 preview를 만든다.                                     | 알림 설정을 사용자가 대화로 조정한다.                            | M    | notification routing v2, preview->confirm                  | 정책 오작동 위험. simulation before confirm, operator role required.             |
| P1   | **Workspace policy templates**        | personal, shared-review, read-only-reference sandbox template을 제공한다.                                | sandbox 설정 마찰을 줄인다.                                      | M    | sandbox v0, project templates                              | template 남용 위험. editable, explicit writable roots, safe defaults.            |
| P1   | **Retro-to-action candidate**         | 반복 retro insight를 dedupe해 board candidate로 제안하되 자동 생성하지 않는다.                           | 회고가 실제 개선 작업으로 이어진다.                              | M    | retro analytics, board create gate                         | task 폭증 위험. suggestion-only, owner confirm, merge duplicates.                |
| P1   | **Anomaly-to-alert policy**           | usage anomaly와 forecast risk를 notification rule 조건으로 연결한다.                                     | 위험 신호가 사람에게 자동 surface된다.                           | M    | anomaly detection, notification v2                         | alert storm 위험. cooldown, severity threshold, simulation first.                |
| P1   | **Alert correlation**                 | 같은 root cause나 handoff chain에서 온 alert를 incident group으로 묶는다.                                | multi-room 알림 noise를 줄이고 원인을 빨리 찾는다.               | M    | alert dashboard, audit correlation, handoff ids            | 잘못된 묶음 위험. confidence, manual split/merge, source list.                   |
| P1   | **Collaborative review room**         | task/handoff 중심으로 terminal view, notes, checklist, evidence를 한 화면에 묶는다.                      | 사람 리뷰와 QA 협업을 제품 안에서 처리한다.                      | M/L  | presence, shared notes, terminal viewer                    | 화면 과밀 위험. focused mode, role filters, viewer no-input default.             |
| P2   | **Auto-create trusted Slack tasks**   | trusted channel/role에서 low-risk bug를 confirm 없이 task로 만든다.                                      | 반복 intake 마찰을 줄인다.                                       | L    | mature classifier, trust policy                            | 자동 mutation 남용 위험. v1.21 제외, 별도 opt-in/adversarial review 필요.        |
| P2   | **Hard sandbox mode**                 | OS-level 계정/컨테이너/권한 경계로 강한 per-user 격리를 제공한다.                                        | 신뢰가 낮은 피어도 안전하게 host를 쓸 수 있다.                   | L/XL | sandbox v0 maturity, platform design                       | 복잡도/호환성 위험. 별도 설계와 opt-in 필요.                                     |
| P2   | **Hard budget enforcement**           | quota/cost 초과 시 spawn/execution을 강제 차단한다.                                                      | 비용 폭주를 강하게 막는다.                                       | M/L  | reliable usage data, override policy                       | 잘못된 차단 위험. soft quota와 warnings 안정화 뒤 검토.                          |
| P2   | **Remote multi-room actions**         | multi-room dashboard에서 다른 room의 approve/abort/kill 같은 action을 직접 수행한다.                     | 중앙 운영 편의가 커진다.                                         | L    | auth federation, signed command, audit                     | 중앙 제어 위험. read-only aggregation 원칙 이후 별도 검토.                       |

## 2. 제안 v1.21 스코프

v1.21의 권장 테마는 **"thread-aware ops assistant"**이다. v1.20이 Slack에서 bug/feedback/task를 안전하게 task 후보로 만드는 단계라면, v1.21은 같은 thread에서 후속 질문, 상태 질의, task 후보 정정, task linkage가 이어지게 만든다. 동시에 shared host의 다음 큰 안전 장치인 optional sandbox v0와 운영 인사이트/알림 기반을 얇게 넣어, Slack 대화와 dashboard 운영 화면이 같은 상태를 보도록 한다.

### v1.21 핵심 항목

1. **Slack thread context + conversational follow-up**
   - thread root와 최근 reply를 bounded/redacted context로 요약한다.
   - follow-up은 preview state를 수정하거나 read-only query를 실행한다.
   - task/comment 생성은 same-owner confirm과 role gate를 유지한다.

2. **Natural-language status query**
   - board, execution, usage, ledger, handoff 상태를 자연어로 질의한다.
   - 답변에는 source, freshness, scope, confidence, redaction note를 붙인다.
   - 질문 경로는 read-only interface만 사용한다.

3. **Optional per-user sandbox v0**
   - workspace root, writable paths, env allowlist, secret namespace, temp dir을 project opt-in으로 분리한다.
   - boundary preview와 violation audit을 제공한다.
   - best-effort/off-by-default로 두고 hard sandbox라고 주장하지 않는다.

4. **Retro and usage insights**
   - retro analytics v2와 usage/cost trend v2를 first pass로 묶는다.
   - anomaly/forecast는 confidence band와 known/unknown 표시를 유지한다.
   - insight는 board candidate까지만, 자동 task 생성은 제외한다.

5. **Notification routing + multi-room alerts**
   - condition/severity/member/role/digest/escalation rule을 제공한다.
   - multi-room dashboard는 alert summary를 read-only로 모은다.
   - Slack notification은 redacted payload와 local deep-link 중심으로 둔다.

### v1.21 exit criteria

1. Slack thread context가 N-limit, redaction, freshness metadata를 갖고 triage/query에 사용된다.
2. follow-up 메시지가 preview update 또는 read-only query로 분기된다.
3. task creation/comment mutation은 same-owner confirm, operator role, audit을 계속 요구한다.
4. 자연어 상태 질의가 board/execution/usage/ledger/handoff를 읽고 source/freshness/confidence를 표시한다.
5. question/status query 경로가 board mutation을 만들지 않는 e2e가 있다.
6. sandbox v0가 workspace/writable/env/secret/temp 정책을 project opt-in으로 제공한다.
7. sandbox boundary preview와 violation audit이 redacted output을 제공한다.
8. retro analytics v2가 root cause, blocker, verification, cost, collaboration issue로 집계된다.
9. usage/cost trend와 anomaly/forecast가 known/unknown/estimate와 confidence band를 표시한다.
10. notification routing v2가 simulation, digest, dedupe, escalation을 지원한다.
11. multi-room alert dashboard가 blocked/stale/quota/handoff/anomaly alert를 read-only로 보여준다.
12. e2e는 Slack thread follow-up, status query, sandbox preview, retro/usage insight, notification routing, multi-room alert를 검증한다.

## 3. v1.22+ 백로그

| 후보                                  | 설명                                                                           | 넘기는 이유                                                     |
| ------------------------------------- | ------------------------------------------------------------------------------ | --------------------------------------------------------------- |
| Slack status drilldown v2             | follow-up 질의에서 time window, task filter, owner filter를 자연어로 유지한다. | v1.21 query provenance와 thread context 안정화가 먼저 필요하다. |
| Slack-to-notification rule creation   | Slack 대화로 알림 rule을 만들고 confirm한다.                                   | routing simulation과 role-gated policy UX가 필요하다.           |
| sandbox hardening phase 1             | env scrub, path allowlist enforcement, secret mount policy를 강화한다.         | v0의 false denial과 호환성 데이터를 먼저 봐야 한다.             |
| retro-to-action task creation         | retro insight를 owner confirm 후 board task로 생성한다.                        | suggestion 품질과 dedupe를 먼저 검증해야 한다.                  |
| anomaly-to-alert automatic escalation | anomaly가 조건을 넘으면 escalation을 자동 시작한다.                            | false positive와 alert storm 완화가 필요하다.                   |
| hard sandbox mode                     | OS-level 강한 격리를 제공한다.                                                 | 별도 플랫폼 설계와 큰 호환성 검증이 필요하다.                   |
| remote multi-room actions             | multi-room dashboard에서 다른 room action을 직접 수행한다.                     | 중앙 제어 위험이 커서 v1.21 scope에서 제외한다.                 |

## 4. 실행 순서 제안

1. **V21-W1 Slack thread context**: bounded context, redaction, preview state linkage, task-thread linking.
2. **V21-W2 Slack query engine**: natural language read-only queries, provenance, source/freshness/confidence.
3. **V21-W3 sandbox v0**: project opt-in, boundary preview, best-effort policy, violation audit.
4. **V21-W4 insight layer**: retro analytics, usage/cost trend, anomaly/forecast confidence.
5. **V21-W5 notification and alerts**: routing v2, simulation, multi-room alert dashboard, Slack redacted payloads.
6. **V21-W6 hardening**: prompt-injection tests, no-mutation query tests, privacy review, real-server e2e.

## 5. 주요 리스크

- Slack thread context는 민감 정보를 확대할 수 있다. N-limit, redaction, no-file-content default, source links만 허용해야 한다.
- 자연어 질의가 hallucinated status를 만들 수 있다. evidence-only 답변과 source/freshness/confidence 표기가 필수다.
- follow-up correction이 mutation으로 새면 Slack이 backdoor가 된다. preview update와 confirm 경계를 엄격히 나눈다.
- sandbox v0는 완전한 보안 경계가 아니다. best-effort/off-by-default와 unsupported cases를 명확히 표시한다.
- usage/cost 예측은 source가 불완전하다. known/unknown/estimate를 분리하고 hard block으로 연결하지 않는다.
- multi-room alert dashboard는 중앙 제어 surface로 확장하고 싶은 압력이 크다. v1.21은 read-only와 local deep-link만 허용한다.
