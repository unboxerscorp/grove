# grove v1.14+ 브레인스토밍

작성일: 2026-06-04

## 전제

- v1.11은 read-only routing planner와 autonomy visibility를 출시했고, v1.12는 pickup 토글과 planner→delegate를 출시했다.
- v1.13은 guarded execution loop를 진행 중인 것으로 둔다.
- v1.14는 자율 실행 루프 자체를 더 키우기보다, 사람이 어디서든 **조회, 승인, 중단, kill-switch**를 안전하게 수행하고 실행 흐름을 이해하는 surface를 강화하는 단계가 적합하다.
- Slack/mobile은 고위험 command를 여는 통로가 아니라 safety command와 작은 운영 조정부터 시작한다.
- 장기 모델은 실제 CLI 세션, 보드=위임 프로토콜, 사람 승인/감사 guard, 로컬-퍼-멤버 실행, Tailscale 선택 공유다.

## 우선순위 기준

- **P0**: v1.14 핵심 후보. v1.13 guarded loop 운영에 즉시 필요한 safety surface와 timeline이다.
- **P1**: v1.14 stretch 또는 v1.15 후보. 가치가 크지만 privacy, cross-room 신뢰 모델, UX 검증이 더 필요하다.
- **P2**: v2.0+ 후보. 실제 cross-room execution, 멀티머신 executor, destructive command처럼 신뢰 경계가 크다.

## 1. v1.14+ 후보 목록

| 우선 | 아이디어                                   | 한 줄                                                                                                                    | 가치                                                                  | 규모 | CLI/역할                        | 의존성                                                | 위험/완화                                                                                            |
| ---- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------- | ---- | ------------------------------- | ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| P0   | **Slack safety command surface v1**        | Slack thread에서 status, approve, abort, pause-node, kill-switch, comment를 role-gated로 처리한다.                       | dashboard를 열지 않아도 자율 실행을 승인하거나 즉시 멈출 수 있다.     | L    | bridge codex, security reviewer | guarded loop, Slack connector, team auth, audit actor | spoof/replay 위험. signed command context, confirm step, short TTL, audit actor, narrow command set. |
| P0   | **Slack query commands**                   | `/status task`, `/status node`, `/why blocked`, `/timeline task` 같은 조회 명령을 제공한다.                              | 안전 command 전에 현재 상태와 이유를 확인할 수 있다.                  | M    | bridge codex                    | audit timeline, node status, task API                 | 정보 유출 위험. project scope, redaction, role gate, no raw errors.                                  |
| P0   | **Slack approve/abort handshake**          | approve/abort/kill은 preview -> confirm 2단계로 처리하고 command id를 audit에 남긴다.                                    | 오조작과 replay를 줄이면서 원격 safety action을 가능하게 한다.        | M    | bridge codex, security reviewer | Slack safety commands, approval gate                  | confirm 누락/중복 위험. idempotency key, TTL, one-shot token.                                        |
| P0   | **mobile approval queue**                  | 모바일에서 approval-needed, kill-waiting, verification-failed task만 빠르게 처리한다.                                    | 외부에서도 사람 판단 대기열을 줄이고 자율 loop를 진행/중단할 수 있다. | M    | FE claude, bridge codex         | decision inbox, guarded loop, auth session            | 작은 화면 오조작 위험. action grouping, confirmation, destructive 제외.                              |
| P0   | **mobile kill-switch controls**            | node/task/global kill-switch와 pause/resume을 모바일에서 제한적으로 제공한다.                                            | 긴급 상황에서 노트북 없이도 자율 실행을 멈춘다.                       | M    | FE claude, security reviewer    | kill-switch API, node status, role policy             | 잘못된 kill 위험. clear scope labels, confirm, audit actor, undo 대신 resume 명시.                   |
| P0   | **execution timeline visualization**       | preflight, approval, execute, verify, rollback, kill, complete/block 이벤트를 task drawer와 audit drawer에서 시각화한다. | 자율 실행이 왜 진행/중단됐는지 사람이 빠르게 이해한다.                | L    | FE claude, bridge codex         | guarded loop audit events, task drawer, audit API     | 로그 과다 위험. summary lane, filters, redacted details.                                             |
| P0   | **timeline diff/checkpoint cards**         | 실행 checkpoint, changed files, verification result, rollback plan을 timeline card로 보여준다.                           | rollback/검증 판단에 필요한 근거를 한 화면에 둔다.                    | M    | FE claude, qa agy               | checkpoint events, verification gate, support bundle  | 민감 diff 노출 위험. path/secret redaction, content opt-in, summary-first.                           |
| P0   | **abort semantics**                        | abort가 running loop를 어떻게 멈추고 task 상태를 block/comment로 남기는지 명확히 정의한다.                               | abort 후 task가 유실되거나 running으로 방치되는 것을 막는다.          | M    | bridge codex                    | loop lease, kill-switch, task lifecycle               | half-written 상태 위험. safe point abort, heartbeat timeout, forced block comment.                   |
| P0   | **safety notification routing**            | approval-needed, abort-requested, killed, rollback-needed를 Slack/mobile/dashboard에 중복 없이 라우팅한다.               | 안전 이벤트가 묻히지 않고 적절한 사람에게 간다.                       | M    | bridge codex                    | notification rules, notify_subs, team roles           | 알림 폭주 위험. dedupe, severity, per-member preference, quiet hours bypass only for kill.           |
| P1   | **Slack limited delegate**                 | Slack에서 planner 후보를 조회하고 limited delegate를 preview/confirm으로 생성한다.                                       | 채널에서 작은 위임까지 가능해진다.                                    | L    | bridge codex, security reviewer | planner→delegate, Slack command, audit actor          | 잘못된 위임 위험. planner evidence 표시, confirm, no destructive task kinds.                         |
| P1   | **mobile assign/comment/unblock bundle**   | 모바일에서 여러 작은 승인/댓글/assign 작업을 묶어 처리한다.                                                              | 판단 요청이 쌓였을 때 처리 비용을 줄인다.                             | M    | FE claude, bridge codex         | mobile approval queue, decision inbox                 | bulk 오조작 위험. item별 preview, final confirm, partial success audit.                              |
| P1   | **multi-machine read-only aggregation v0** | 여러 local room의 org/board/health/autonomy summary를 Tailscale에서 read-only로 모은다.                                  | 분산된 팀룸 상태를 중앙 서버 없이 한눈에 본다.                        | L    | bridge codex, security reviewer | signed summaries, project identity, privacy policy    | 민감 정보 공유 위험. summary-only, deny-by-default, no comments/diffs by default.                    |
| P1   | **aggregation privacy policy**             | aggregation에 포함할 fields, autonomy events, costs, member names, redaction level을 project별로 정한다.                 | read-only aggregation의 노출 범위를 명시한다.                         | M    | security reviewer, bridge codex | export redaction, team auth, signed summaries         | 과공유 위험. per-field toggles, preview, audit of share changes.                                     |
| P1   | **cross-room handoff contract v1**         | task package, context pack, expected result, callback, cancellation, audit correlation schema를 정의한다.                | 실제 handoff 전에 책임과 추적 경계를 고정한다.                        | M/L  | architect claude, bridge codex  | aggregation, support bundle, signed handoff           | 책임 불명확 위험. owner/cancel/result authority 필수, no execution yet.                              |
| P1   | **handoff preview mode**                   | 실제 전송 전 package, redaction, missing context, expected result, receiving room requirement를 보여준다.                | cross-room 실행 전에 privacy와 context 품질을 사람이 검토한다.        | M    | FE claude, security reviewer    | handoff contract, support bundle                      | 잘못된 context 전송 위험. preview approval, diffable package, redaction report.                      |
| P1   | **timeline export for incidents**          | 특정 task/run의 timeline, checkpoint, safety command, transcript pointer를 support bundle로 내보낸다.                    | 자율 실행 사고를 QA/reviewer가 재현한다.                              | M    | bridge codex, qa agy            | execution timeline, support bundle                    | 민감 정보 유출 위험. local-only default, redaction, no raw transcript by default.                    |
| P2   | **cross-room handoff implementation**      | 다른 room으로 task package를 보내고 progress/result summary를 되받는다.                                                  | 로컬-퍼-멤버 모델을 유지하면서 전문 node를 공유한다.                  | L    | bridge codex, security reviewer | handoff contract, signed callbacks, aggregation       | retry/cancel/audit 복잡성. v1.14에서는 계약/preview까지만.                                           |
| P2   | **multi-machine executor routing**         | 다른 머신의 실제 CLI 세션이 내 board task를 처리하도록 opt-in 연결한다.                                                  | 개인 credentials 경계를 유지하면서 팀 compute를 넓힌다.               | L    | bridge codex, ops reviewer      | cross-room handoff, trust policy, backpressure        | trust 경계 붕괴 위험. read-only aggregation 후 후속.                                                 |
| P2   | **Slack destructive commands**             | spawn/despawn, secret update, cross-room handoff 같은 고위험 command를 Slack에서 처리한다.                               | dashboard 없이 강한 운영 조작이 가능하다.                             | L    | bridge codex, security reviewer | approval policy, replay guard, audit UX               | 오조작 피해 큼. v1.14 제외, 별도 approval chain 필요.                                                |

## 2. 제안 v1.14 스코프

v1.14의 권장 테마는 **"safety controls everywhere"**다. v1.13에서 guarded execution loop가 들어오면, 다음 병목은 실행 기능이 아니라 사람이 멀리서도 상태를 이해하고 멈추고 승인하는 표면이다.

### v1.14 핵심 항목

1. **Slack safety command surface v1**
   - `status`, `timeline`, `approve`, `abort`, `pause-node`, `kill-switch`, `comment` 중심으로 시작한다.
   - 모든 state-changing command는 preview -> confirm 2단계와 one-shot command id를 요구한다.
   - limited delegate는 stretch로 두고 destructive command는 제외한다.

2. **mobile approval queue + kill-switch controls**
   - 모바일은 decision inbox 전체가 아니라 approval-needed, kill-waiting, verification-failed 같은 안전 큐를 우선한다.
   - node/task/global kill-switch와 pause/resume을 명확한 scope label과 confirm으로 제공한다.

3. **execution timeline visualization**
   - task drawer와 audit drawer에 preflight, approval, execute, verify, rollback, kill, complete/block timeline을 표시한다.
   - checkpoint, changed files, verification result, rollback plan은 redacted card로 요약한다.

4. **abort/safety notification semantics**
   - abort가 task state, run lease, loop lease, comment, notification을 어떻게 남기는지 명확히 한다.
   - approval-needed, killed, rollback-needed는 notify_subs로 dedupe하고 severity별 라우팅을 둔다.

5. **multi-machine read-only aggregation + cross-room handoff contract as stretch**
   - read-only summary와 privacy policy까지만 core 근처에서 다룬다.
   - handoff는 contract와 preview까지만 제공하고 실제 execution handoff는 후속으로 둔다.

### v1.14 exit criteria

1. Slack에서 status/timeline 조회가 project-scoped, redacted, role-gated로 동작한다.
2. Slack approve/abort/kill/pause/comment 중 최소 5개 safety command가 preview -> confirm으로 처리된다.
3. command id는 one-shot이며 TTL 만료/중복 실행이 audit에 안전하게 남는다.
4. 모바일 approval queue에서 approval-needed, verification-failed, kill-waiting item을 처리할 수 있다.
5. 모바일에서 task/node/global kill-switch 또는 pause/resume을 scope label과 confirm으로 수행한다.
6. task drawer에 guarded execution timeline이 표시된다.
7. timeline card가 checkpoint, verification, rollback plan, kill reason을 redacted summary로 보여준다.
8. abort된 run은 task를 block/comment 상태로 정리하고 loop lease를 남기지 않는다.
9. read-only aggregation은 signed summary prototype 또는 privacy-policy 설계로 마감한다.
10. 실제 서버 e2e가 Slack safety command, mobile safety action, timeline, abort semantics를 검증한다.

## 3. v1.15+ 백로그

| 후보                              | 설명                                                                   | 넘기는 이유                                                       |
| --------------------------------- | ---------------------------------------------------------------------- | ----------------------------------------------------------------- |
| Slack limited delegate full       | Slack에서 planner 추천 기반 delegate까지 처리한다.                     | safety command 안정화 후 위임 command를 여는 편이 안전하다.       |
| mobile assign/comment bundle      | 여러 item을 묶어 assign/comment/unblock한다.                           | 단일 safety action의 UX와 audit을 먼저 검증해야 한다.             |
| cross-room handoff implementation | task package를 다른 room으로 보내고 progress/result를 되받는다.        | local loop safety와 read-only aggregation이 먼저 안정되어야 한다. |
| multi-machine executor routing    | 다른 머신의 실제 CLI 세션이 내 board task를 처리한다.                  | credentials 경계와 trust/backpressure 모델 검증이 더 필요하다.    |
| Slack destructive commands        | spawn/despawn, secret update, cross-room handoff를 Slack에서 처리한다. | replay, spoofing, approval UX 위험이 크다.                        |
| mobile command center             | 모바일에서 board/org/terminal action까지 넓힌다.                       | safety queue 중심 UX가 검증된 뒤 확장해야 한다.                   |

## 4. 실행 순서 제안

1. **V14-W1 command safety model**: Slack command id, preview/confirm, TTL, replay guard, audit actor.
2. **V14-W2 Slack safety commands**: status/timeline/approve/abort/kill/pause/comment.
3. **V14-W3 mobile safety queue**: approval-needed, verification-failed, kill-waiting, scoped kill/pause controls.
4. **V14-W4 execution timeline**: task drawer/audit drawer cards, checkpoint/verification/rollback summaries.
5. **V14-W5 abort semantics and notifications**: task/run/loop lease cleanup, block/comment policy, notification dedupe.
6. **V14-W6 stretch**: read-only aggregation privacy policy, handoff contract/preview, incident timeline export.

## 5. 주요 리스크

- Slack은 편하지만 replay/spoofing 위험이 크다. state change는 preview/confirm, one-shot id, short TTL, audit actor가 필수다.
- 모바일 kill-switch는 오조작 피해가 크다. scope label, confirm, immediate audit, resume path를 함께 제공해야 한다.
- timeline은 민감 정보가 섞이기 쉽다. 기본은 redacted summary이고 raw transcript/diff는 opt-in support bundle로만 둔다.
- aggregation과 handoff는 v1.14의 주제가 아니다. 안전 명령과 timeline을 먼저 안정화해야 분산 실행으로 갈 수 있다.
