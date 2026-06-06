# grove v1.20+ 브레인스토밍

> Status: historical v1 brainstorm; superseded by the current v2 live cockpit model documented in `docs/design/MASTER_NODE.md` and `docs/agents/LEAD-HANDOFF.md`.
> 작성일: 2026-06-04

## 전제

- v1.17은 receiver-local cross-room handoff를 출시했고, v1.18은 tailnet shared-access를 출시했다.
- v1.19는 per-user resource ledger와 soft quota/rate를 진행 중인 것으로 둔다.
- v1.20은 공유 호스트에서 여러 사용자가 더 안전하고 덜 부딪히게 일하기 위한 **선택적 per-user sandbox, 회고/비용 인사이트, 조건부 알림, 실시간 협업 고도화**가 적합하다.
- 원칙은 실제 CLI 세션, 로컬 호스트 소유권, 보드=위임 프로토콜, per-user identity, audit, soft quota 우선, privacy deny-by-default다.
- sandbox v0는 완전한 보안 경계가 아니라 peer 간 실수와 운영 충돌을 줄이는 best-effort 격리로 정의한다.

## 우선순위 기준

- **P0**: v1.20 핵심 후보. v1.19의 per-user ledger/soft quota 위에서 팀 사용성을 안정화하는 기능이다.
- **P1**: v1.20 stretch 또는 v1.21 후보. 가치가 크지만 데이터 신뢰도, UX, 정책 검증이 필요하다.
- **P2**: v1.22+ 후보. hard enforcement, 원격 실행, 강한 격리처럼 위험 경계가 큰 기능이다.

## 1. v1.20+ 후보 목록

| 우선 | 아이디어                             | 한 줄                                                                                                            | 가치                                                   | 규모 | CLI/역할                        | 의존성                                           | 위험/완화                                                                      |
| ---- | ------------------------------------ | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ | ---- | ------------------------------- | ------------------------------------------------ | ------------------------------------------------------------------------------ |
| P0   | **optional per-user sandbox v0**     | 사용자별 workspace root, writable path, temp dir, env allowlist, secret namespace를 project opt-in으로 분리한다. | 공유 호스트에서 피어 간 파일/환경 실수를 줄인다.       | L    | security reviewer, bridge codex | v1.19 ledger, project creation, process launcher | 완전 격리로 오해될 위험. best-effort label, unsupported cases, off by default. |
| P0   | **sandbox boundary preview**         | sandbox 적용 전 허용 path/env/secret scope, blocked paths, inherited credentials를 보여준다.                     | 사용자가 격리 범위를 이해하고 켠다.                    | M    | FE claude, security reviewer    | sandbox v0, redaction, project settings          | 잘못된 안전감 위험. preview + limitation copy + audit of changes.              |
| P0   | **workspace policy templates**       | personal, shared-review, read-only-reference 같은 workspace 권한 template을 제공한다.                            | 매번 권한을 직접 설계하지 않아도 된다.                 | M    | planner claude, bridge codex    | sandbox v0, template system                      | template 남용 위험. editable, explicit writable roots, safe defaults.          |
| P0   | **sandbox violation audit**          | blocked path/env/secret access attempt를 redacted audit event와 user-facing reason으로 남긴다.                   | 격리 정책 문제를 디버깅하고 오작동을 투명하게 본다.    | M    | bridge codex, security reviewer | sandbox v0, audit lane                           | 민감 정보 노출 위험. path/token redaction, admin detail gate, sampling.        |
| P0   | **retro analytics v2**               | self-retro와 human incident note를 root cause, blocker, verification, cost, collaboration issue로 정규화한다.    | 반복되는 운영 문제를 개선 후보로 바꾼다.               | M    | reviewer claude, agy reviewer   | retro lane, audit events, per-user ledger        | 개인 평가처럼 보일 위험. system theme 중심, sample size, confidence.           |
| P0   | **retro trend heatmap**              | project/node/agent/member/theme별 회고 이슈 추세를 heatmap과 top-N list로 보여준다.                              | 어디서 반복 실패가 쌓이는지 조기에 본다.               | M    | FE claude, reviewer claude      | retro analytics, usage trends                    | blame metric 위험. member detail은 opt-in/admin, theme-first UI.               |
| P0   | **retro insight digest**             | 주간 회고를 fixed pattern, unresolved improvement, repeated blocker로 요약한다.                                  | 회고가 운영 리뷰 agenda와 개선 후보로 이어진다.        | S/M  | reviewer claude, FE claude      | retro analytics, notification routing            | 장문 noise 위험. top-N, evidence links, editable summary.                      |
| P0   | **usage/cost trend reporting v2**    | user/project/node/agent/day별 usage, known/unknown cost, quota pressure, moving average를 표시한다.              | soft quota와 비용 판단을 같은 화면에서 본다.           | M/L  | bridge codex, FE claude         | /api/usage, resource ledger, cost confidence     | 비용 부정확 위험. known/unknown/estimate 분리, hard block 금지.                |
| P0   | **usage anomaly detection**          | 평소 대비 turn/runtime/token/unknown-cost spike와 repeated retry를 탐지한다.                                     | 비용 폭주와 비정상 루프를 일찍 발견한다.               | M    | bridge codex, qa agy            | usage trend, execution timeline, ledger          | false positive 위험. baseline preview, silence with audit, confidence.         |
| P0   | **forecast confidence bands**        | 이번 주 quota/cost/credit pressure를 low/medium/high confidence band로 예측한다.                                 | 팀이 실행량을 미리 조정한다.                           | M    | bridge codex, reviewer claude   | trend reporting, source confidence               | 예측 과신 위험. unknown penalty, no auto enforcement, source labels.           |
| P0   | **notification routing v2**          | 조건, severity, target member/role, quiet hours, digest, dedupe, escalation을 rule로 관리한다.                   | 사람 판단이 필요한 일을 올바른 사람에게 보낸다.        | M/L  | bridge codex, FE claude         | team auth, presence, audit events                | 알림 누락/과다 위험. dry-run, safe defaults, per-rule audit.                   |
| P0   | **notification simulation mode**     | rule 변경 전 최근 이벤트에 적용하면 어떤 알림이 갔을지 preview한다.                                              | 정책 실수를 실제 발송 전에 줄인다.                     | M    | bridge codex, FE claude         | notification v2, audit cursor                    | 과거 데이터 편향 위험. bounded window, sampled preview, dry-run label.         |
| P0   | **presence v3 live collaboration**   | project/task/node/terminal 단위로 누가 보고 있고 어떤 action을 준비 중인지 coarse presence로 표시한다.           | 중복 지시와 충돌을 줄이고 협업 맥락을 만든다.          | M    | FE claude, bridge codex         | v1.19 presence, websocket, team auth             | 감시 느낌 위험. coarse only, private mode, short retention.                    |
| P0   | **collaboration focus and locks**    | task drawer, board card, terminal input에 focus indicator와 optional soft lock을 제공한다.                       | 같은 대상에 여러 사람이 동시에 명령하는 사고를 줄인다. | M    | FE claude, bridge codex         | presence v3, action audit                        | 작업 지연 위험. soft lock only, override with reason, timeout.                 |
| P0   | **shared notes and review thread**   | task/node/handoff에 짧은 shared note, pin, resolve, mention을 남긴다.                                            | 실시간 대화 없이도 작업 맥락과 리뷰 결정을 남긴다.     | M    | FE claude, reviewer claude      | comments, team auth, notification routing        | noise 위험. pinned summary, resolve flow, notification opt-in.                 |
| P1   | **sandbox hardening phase 1**        | env scrub, path allowlist enforcement, secret mount policy, denied-write tests를 강화한다.                       | sandbox v0의 실제 보호력을 높인다.                     | L    | security reviewer, bridge codex | sandbox v0, process launcher                     | 호환성 깨짐 위험. opt-in, dry-run mode, audit denials.                         |
| P1   | **quota-aware sandbox defaults**     | quota pressure가 높은 사용자는 새 project 기본 sandbox/template을 보수적으로 추천한다.                           | 리소스 공정성과 격리를 자연스럽게 연결한다.            | M    | planner claude, bridge codex    | quota ledger, sandbox templates                  | 정책이 불투명할 위험. recommendation-only, factor breakdown.                   |
| P1   | **retro-to-action candidate board**  | 반복 insight를 dedupe해 board candidate로 제안하되 사람 confirm 전에는 생성하지 않는다.                          | 회고가 실제 개선 작업으로 이어진다.                    | M    | planner claude, reviewer claude | retro analytics, board create                    | task 폭증 위험. suggestion-only, merge duplicate, owner confirm.               |
| P1   | **anomaly-to-alert policy**          | usage anomaly와 forecast risk를 notification rule 조건으로 연결한다.                                             | 이상 징후가 놓치지 않고 surface된다.                   | M    | bridge codex, security reviewer | anomaly detection, notification v2               | alert storm 위험. cooldown, severity threshold, simulation first.              |
| P1   | **member escalation matrix**         | member별 primary/backup, quiet hours, critical override, digest cadence를 설정한다.                              | 팀마다 다른 응답 방식을 반영한다.                      | M    | FE claude, security reviewer    | notification v2, team roles                      | 정책 파편화 위험. inherited defaults, templates, audit.                        |
| P1   | **collaborative review room**        | 특정 task/handoff를 중심으로 terminal view, notes, checklist, audit evidence를 한 화면에 묶는다.                 | 사람 리뷰와 QA 협업을 제품 안에서 처리한다.            | M/L  | FE claude, reviewer claude      | presence v3, shared notes, terminal viewer       | 화면 과밀 위험. focused mode, role filters, viewer no-input default.           |
| P1   | **host capacity report**             | active nodes, pane count, CPU/memory pressure, queue age, usage trend를 capacity report로 묶는다.                | 새 작업 시작 전 호스트 여유를 판단한다.                | M    | bridge codex, ops reviewer      | v1.19 pressure guardrails, usage trend           | 예측 과신 위험. confidence bands, no auto block.                               |
| P2   | **hard sandbox mode**                | OS-level 계정/컨테이너/권한 경계를 도입해 강한 per-user 격리를 제공한다.                                         | 신뢰가 낮은 피어도 안전하게 호스트를 쓸 수 있다.       | L/XL | security reviewer, ops reviewer | sandbox v0 maturity, platform design             | 복잡도/호환성 위험. 별도 설계와 opt-in 필요.                                   |
| P2   | **hard per-user budget enforcement** | quota/cost 초과 시 spawn/execution을 강제 차단한다.                                                              | 비용과 리소스를 강하게 통제한다.                       | M/L  | security reviewer, bridge codex | reliable cost data, override policy              | 잘못된 차단 위험. v1.20은 report/hint/soft lock 중심.                          |
| P2   | **remote multi-room action surface** | aggregation view에서 다른 room action을 직접 수행한다.                                                           | 중앙 운영 편의가 커진다.                               | L    | security reviewer, FE claude    | auth federation, signed command                  | 중앙 제어 위험. local host action만 유지.                                      |
| P2   | **cross-room executor routing**      | 다른 room의 실제 CLI 세션을 실행 substrate로 사용한다.                                                           | 전문성과 여유 리소스를 공유한다.                       | L    | bridge codex, ops reviewer      | handoff workflow, trust, backpressure            | credential/trust 경계 붕괴 위험. handoff 안정화 후 검토.                       |

## 2. 제안 v1.20 스코프

v1.20의 권장 테마는 **"safe collaboration inside a shared host"**이다. v1.19가 per-user ledger와 soft quota로 공정성을 잡으면, v1.20은 같은 호스트를 쓰는 사용자가 서로 덜 부딪히고, 실수로 파일/환경을 건드리지 않으며, 운영 문제가 누적되기 전에 보이도록 만드는 단계가 자연스럽다. 핵심은 강제 제어가 아니라 best-effort 격리, 명확한 미리보기, 읽기 쉬운 인사이트, 안전한 알림이다.

### v1.20 핵심 항목

1. **optional per-user sandbox v0**
   - workspace root, writable path, env allowlist, secret namespace, temp dir을 project-level opt-in으로 분리한다.
   - sandbox boundary preview가 허용/차단 scope와 한계를 보여준다.
   - violation은 redacted audit event와 사용자-facing reason으로 남긴다.

2. **retro analytics v2**
   - self-retro와 human incident note를 root cause, blocker, verification, cost, collaboration issue로 정규화한다.
   - heatmap/digest는 system theme 중심으로 보여주고 개인 비교 지표는 기본 제공하지 않는다.
   - improvement는 candidate까지만 만들고 board task 생성은 사람 confirm을 요구한다.

3. **usage/cost trend reporting v2**
   - user/project/node/agent/day별 known/unknown/estimate usage와 quota pressure를 표시한다.
   - anomaly detection과 forecast confidence band를 제공하되 hard enforcement로 연결하지 않는다.
   - agy cost처럼 source가 없는 값은 unknown으로 남긴다.

4. **notification routing v2**
   - 조건, severity, target member/role, quiet hours, digest, dedupe, escalation, simulation mode를 제공한다.
   - usage anomaly, sandbox violation, stale node, handoff wait는 rule 조건으로 쓸 수 있게 한다.
   - multi-channel fanout은 redacted payload preview와 opt-in을 요구한다.

5. **presence and collaboration v3**
   - project/task/node/terminal 단위 coarse presence, focus indicator, optional soft lock을 제공한다.
   - shared notes/review thread로 작업 맥락과 사람 결정을 task/handoff에 남긴다.
   - soft lock은 timeout과 override reason을 갖고, hard lock은 만들지 않는다.

### v1.20 exit criteria

1. sandbox v0가 workspace root, writable path, env allowlist, secret namespace, temp dir을 project opt-in으로 제공한다.
2. sandbox boundary preview가 허용/차단 scope, inherited credentials, unsupported cases를 보여준다.
3. sandbox violation audit이 redacted event와 사용자-facing reason을 남긴다.
4. retro analytics v2가 root cause, blocker, verification, cost, collaboration issue로 회고를 집계한다.
5. retro heatmap/digest가 sample size, confidence, source link를 표시한다.
6. usage/cost trend v2가 user/project/node/agent/day별 known/unknown/estimate와 quota pressure를 표시한다.
7. usage anomaly detection이 baseline preview, confidence, silence-with-audit를 지원한다.
8. forecast는 confidence band로 표시되고 자동 차단을 만들지 않는다.
9. notification routing v2가 조건, severity, target, quiet hours, digest, dedupe, escalation simulation을 지원한다.
10. presence v3가 coarse activity, private mode, short retention을 제공한다.
11. focus/soft lock/shared notes가 task/node/terminal/handoff 협업 맥락을 남긴다.
12. e2e는 sandbox preview/violation, retro analytics, usage anomaly, notification simulation, presence/soft-lock을 검증한다.

## 3. v1.21+ 백로그

| 후보                                  | 설명                                                                   | 넘기는 이유                                                  |
| ------------------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------ |
| sandbox hardening phase 1             | env scrub, path allowlist enforcement, secret mount policy를 강화한다. | v0의 실제 호환성과 false denial을 먼저 봐야 한다.            |
| retro-to-action task creation         | insight를 owner confirm 후 board task로 생성한다.                      | suggestion 품질과 dedupe를 먼저 검증해야 한다.               |
| anomaly-to-alert automatic escalation | anomaly가 조건을 넘으면 escalation을 자동 시작한다.                    | false positive와 alert storm 완화가 필요하다.                |
| collaborative review room             | task/handoff 중심 리뷰 화면을 만든다.                                  | presence, notes, soft lock 안정화 후 확장하는 편이 안전하다. |
| hard sandbox mode                     | OS-level 강한 격리를 제공한다.                                         | 별도 플랫폼 설계와 큰 호환성 검증이 필요하다.                |
| hard per-user budget enforcement      | quota/cost 초과 시 실행을 강제 차단한다.                               | 비용 source 신뢰도와 override UX가 충분해야 한다.            |
| remote multi-room action surface      | aggregation view에서 다른 room action을 직접 수행한다.                 | 중앙 제어 위험이 커서 v1.20 scope에서 제외한다.              |

## 4. 실행 순서 제안

1. **V20-W1 sandbox v0 contract**: workspace/env/secret/temp model, best-effort limits, preview payload.
2. **V20-W2 sandbox implementation**: project opt-in, launcher env/path policy, violation audit, e2e.
3. **V20-W3 retro analytics**: taxonomy, parser, heatmap/digest, evidence links.
4. **V20-W4 usage trend/anomaly**: known/unknown cost, quota pressure, baseline, forecast bands.
5. **V20-W5 notification routing**: rule schema, simulation, digest/escalation, redacted payload preview.
6. **V20-W6 presence/collaboration**: coarse presence, focus/soft lock, shared notes, collaboration e2e.

## 5. 주요 리스크

- sandbox v0는 완전한 보안 경계가 아니다. best-effort, off-by-default, boundary preview, unsupported cases를 명확히 표시해야 한다.
- workspace/env 정책은 정상 작업을 깨뜨릴 수 있다. dry-run preview, violation reason, admin override, template defaults가 필요하다.
- retro analytics와 presence는 사람 평가/감시처럼 보일 수 있다. system theme, coarse activity, private mode, 짧은 retention을 기본으로 둔다.
- usage/cost 예측은 source가 불완전하다. known/unknown/estimate를 분리하고 hard block으로 연결하지 않는다.
- notification routing은 멀티유저에서 noise가 빠르게 늘어난다. simulation, digest, dedupe, escalation cap, per-rule audit을 기본으로 둔다.
- soft lock은 생산성을 막을 수 있다. timeout, override reason, warning-first 정책을 유지한다.
