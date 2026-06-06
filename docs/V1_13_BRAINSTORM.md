# grove v1.13+ 브레인스토밍

> Status: historical v1 brainstorm; superseded by the current v2 live cockpit model documented in `docs/design/MASTER_NODE.md` and `docs/agents/LEAD-HANDOFF.md`.
> 작성일: 2026-06-04

## 전제

- v1.10은 guarded autonomous pickup과 self-retro lane을 출시했고, v1.11은 read-only routing planner와 autonomy visibility를 출시했다.
- v1.12는 pickup 토글 UI와 planner→delegate 흐름을 진행 중인 것으로 둔다.
- v1.13의 핵심은 **자가 claim한 task를 실제 실행까지 맡기는 guarded autonomous execution loop**다.
- 안전장치가 기능보다 우선이다. 기본값은 off, 동시성은 node당 1, 사람 승인 게이트와 kill-switch가 항상 우선해야 한다.
- 장기 모델은 실제 CLI 세션, 보드=위임 프로토콜, 사람이 최종 판단하는 guard, 로컬-퍼-멤버 실행, Tailscale 선택 공유다.

## 우선순위 기준

- **P0**: v1.13 핵심 후보. 실행 루프를 열기 위해 반드시 필요한 안전장치와 최소 기능이다.
- **P1**: v1.13 stretch 또는 v1.14 후보. 운영 편의는 크지만 core loop 이후가 더 적합하다.
- **P2**: v2.0+ 후보. cross-room 실행, 멀티머신 executor, destructive remote command처럼 신뢰 경계가 크다.

## 1. v1.13+ 후보 목록

| 우선 | 아이디어                                   | 한 줄                                                                                                               | 가치                                                               | 규모 | CLI/역할                                 | 의존성                                                | 위험/완화                                                                                           |
| ---- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ | ---- | ---------------------------------------- | ----------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| P0   | **guarded autonomous execution loop v1**   | opt-in node가 self-claimed task를 preflight -> execute -> verify -> complete/block/comment까지 처리한다.            | 사람이 매 turn 깨우지 않아도 작은 task가 실제 CLI 세션에서 닫힌다. | L    | bridge codex, maker codex/claude, qa agy | pickup toggle, pull executor, audit lane, node health | runaway/무단 실행 위험. node당 동시성 1, task kind allowlist, max runtime, kill-switch, audit 필수. |
| P0   | **preflight risk gate**                    | task를 실행 전 low/medium/high risk로 분류하고 high risk는 approval 없이는 실행하지 않는다.                         | 실행 전에 사람 판단이 필요한 일을 걸러낸다.                        | M    | bridge codex, security reviewer          | task metadata, planner, decision inbox                | 오분류 위험. 보수적 기본값, unknown은 high risk, reviewer 샘플링.                                   |
| P0   | **approval gate**                          | deploy, secret, auth, delete, cross-room, external side effect task는 decision inbox/Slack/mobile 승인 후 진행한다. | 자율 루프가 사람 최종 판단 원칙을 넘지 않는다.                     | M    | bridge codex, FE claude                  | decision inbox, Slack command, mobile actions         | 승인 우회 위험. server-side gate, audit actor, replay guard, TTL 있는 approval token.               |
| P0   | **concurrency-1 lease**                    | node당 하나의 autonomous run만 허용하고 기존 claim/run lease와 별도 loop lease를 둔다.                              | 중복 실행, 같은 pane 충돌, 비용 폭주를 막는다.                     | M    | bridge codex                             | board claim lock, run metadata, node status           | stale lease 위험. heartbeat, stale reclaim, kill-switch가 lease release.                            |
| P0   | **execution checkpoint**                   | 실행 전 git/workspace 상태, task metadata, transcript pointer, expected rollback plan을 기록한다.                   | 사후 감사와 복구 판단의 출발점을 만든다.                           | M    | bridge codex, core codex                 | workspace metadata, audit events, support bundle      | rollback 착각 위험. 자동 revert가 아니라 checkpoint+owned changes 판정으로 제한.                    |
| P0   | **rollback guard**                         | 실패 시 자동 rollback은 opt-in 작업공간/agent-owned changes에만 허용하고 기본은 rollback plan/comment를 남긴다.     | user 변경을 되돌리는 사고를 막으면서 복구 경로를 남긴다.           | M/L  | core codex, security reviewer            | execution checkpoint, git diff, task metadata         | 사용자 작업 삭제 위험. clean baseline 요구, user-owned diff 감지 시 block+ask-human.                |
| P0   | **verification gate**                      | complete 전 task가 요구한 검증 명령, changed files, summary, residual risk를 확인한다.                              | 자율 loop가 "끝났다"를 너무 쉽게 말하지 않게 한다.                 | M    | qa agy, bridge codex                     | task metadata, test command capture, audit            | flaky/missing test 위험. missing verification은 block 또는 human approval 요구.                     |
| P0   | **global/per-node kill-switch**            | global, board, node, task 단위 kill-switch와 pause/resume을 제공하고 loop가 checkpoint마다 확인한다.                | 위험 징후가 보이면 즉시 멈출 수 있다.                              | M    | bridge codex, FE claude                  | pickup toggle UI, node status, notification rules     | kill 지연 위험. submit 전/후, heartbeat, before-complete 등 safe point마다 확인.                    |
| P0   | **autonomy audit timeline**                | preflight, approval, execute, verify, complete/block, rollback, kill events를 timeline으로 보여준다.                | 왜 실행됐고 어디서 멈췄는지 사람이 추적한다.                       | M    | FE claude, bridge codex                  | audit events, task drawer, support bundle             | 로그 과다 위험. 요약 row + 상세 drawer + redaction.                                                 |
| P1   | **planner→delegate hardening**             | 추천→위임 action에 recommendation id, score factors, actor, selected/ignored 후보를 audit로 남긴다.                 | planner가 실제 위임으로 이어질 때 설명 가능성을 유지한다.          | M    | FE claude, bridge codex                  | planner→delegate, audit actor                         | 추천 맹신 위험. confidence 표시, alternative candidates 유지.                                       |
| P1   | **Slack command surface v1**               | Slack에서 query/status/comment/unblock/assign/limited delegate/pause node를 role-gated로 처리한다.                  | dashboard 밖에서 조회와 작은 운영 조정이 가능하다.                 | L    | bridge codex, security reviewer          | Slack connector, team auth, replay guard              | spoof/replay 위험. signed command context, confirm step, audit actor, narrow command set.           |
| P1   | **mobile actions v1**                      | 모바일에서 decision inbox, status, approve, pause, unblock, comment, assign을 제공한다.                             | 외부에서도 자율 loop를 승인/중단하고 병목을 푼다.                  | M    | FE claude, security reviewer             | mobile shell, CSRF/session, role policy               | 작은 화면 오조작 위험. destructive 제외, confirm, short labels, undo 없음 명시.                     |
| P1   | **autonomy incident bundle**               | 실패/kill/rollback 사건의 audit slice, transcript pointer, checkpoint, diff summary를 묶는다.                       | QA/reviewer가 자율 loop 사고를 빠르게 재현한다.                    | M    | bridge codex, qa agy                     | support bundle, audit timeline, checkpoint            | 민감 정보 유출 위험. path/secret redaction, opt-in detail, local-only default.                      |
| P1   | **multi-machine read-only aggregation v0** | 여러 로컬 room의 org/board/health/autonomy summary를 Tailscale에서 read-only로 모은다.                              | 분산된 팀룸 상태를 중앙 서버 없이 한눈에 본다.                     | L    | bridge codex, security reviewer          | signed summaries, project identity, privacy policy    | 민감 정보 공유 위험. summary-only, per-project allowlist, no comments by default.                   |
| P1   | **aggregation privacy policy**             | aggregation에 포함할 fields, autonomy events, costs, member names, redaction level을 정한다.                        | read-only aggregation의 노출 범위를 명시한다.                      | M    | security reviewer, bridge codex          | export redaction, team auth, signed summaries         | 과공유 위험. deny-by-default, preview, per-field toggles.                                           |
| P1   | **cross-room handoff contract**            | task package, context pack, expected result, callback, cancellation, audit correlation schema를 정의한다.           | 실행 handoff 전에 책임과 추적 경계를 고정한다.                     | M/L  | architect claude, bridge codex           | aggregation, support bundle, signed handoff           | 책임 불명확 위험. execution owner, cancel owner, result authority 필수.                             |
| P1   | **handoff preview mode**                   | 실제 전송 전 package, redaction, missing context, expected result를 보여준다.                                       | cross-room 실행 전에 사람이 privacy와 context 품질을 검토한다.     | M    | FE claude, security reviewer             | handoff contract, support bundle                      | 잘못된 context 전송 위험. preview approval, diffable package.                                       |
| P2   | **cross-room handoff implementation**      | 다른 room으로 task package를 보내고 progress/result summary를 되받는다.                                             | 로컬-퍼-멤버 모델을 유지하면서 전문 node를 공유한다.               | L    | bridge codex, security reviewer          | handoff contract, signed callbacks, aggregation       | retry/cancel/audit 복잡성. v1.13에서는 계약/preview까지만.                                          |
| P2   | **multi-machine executor routing**         | 다른 머신의 실제 CLI 세션이 내 board task를 처리하도록 opt-in 연결한다.                                             | 개인 credentials 경계를 유지하면서 팀 compute를 넓힌다.            | L    | bridge codex, ops reviewer               | cross-room handoff, trust policy, backpressure        | trust 경계 붕괴 위험. read-only aggregation 검증 후 후속.                                           |
| P2   | **Slack destructive commands**             | spawn/despawn, secret update, cross-room handoff 같은 고위험 command를 Slack에서 처리한다.                          | dashboard 없이 강한 운영 조작이 가능하다.                          | L    | bridge codex, security reviewer          | approval policy, replay guard, audit UX               | 오조작 피해 큼. v1.13 제외, 별도 approval chain 필요.                                               |

## 2. guarded autonomous execution loop 상세 설계

### 루프 상태

```text
idle
  -> eligible_task_found
  -> preflight
  -> awaiting_approval?   # high risk only
  -> executing
  -> verifying
  -> completing | blocking | rollback_needed | killed
  -> idle
```

각 상태 전환은 audit event를 남긴다. event payload는 task id, node, run id, loop id, risk level, gate result, actor, source confidence, redacted summary만 포함한다.

### 위험 게이트

| 게이트       | 자동 통과 조건                                   | 승인 필요 조건                                           | 실패 시 처리               |
| ------------ | ------------------------------------------------ | -------------------------------------------------------- | -------------------------- |
| task kind    | docs/test/small bugfix처럼 allowlist에 있는 종류 | deploy, auth, secret, data migration, delete, cross-room | block 또는 ask-human       |
| workspace    | project-contained workspace, baseline 기록 가능  | dirty baseline, unknown workspace, symlink escape 의심   | block + rollback plan 없음 |
| node health  | pane alive, transcript valid, no repair pending  | stale/recovering node                                    | pause + notification       |
| concurrency  | node loop lease 없음, in-flight 0                | in-flight 존재                                           | skip + comment optional    |
| budget       | daily auto count/cost hint 이하                  | budget 초과 또는 cost unknown high                       | approval 필요              |
| verification | task에 검증 명령 또는 self-check 기준 있음       | 검증 기준 없음                                           | approval 또는 block        |
| human risk   | no destructive/external side effect              | user data, deploy, secret, network write                 | approval 필요              |

### 실행 정책

- 동시성은 node당 1이다. task claim lease와 별개로 `autonomy_loop_lease`를 두고, heartbeat가 끊기면 stale 처리한다.
- loop는 한 번에 하나의 task만 처리한다. batch claim은 금지한다.
- task body나 metadata에 `auto_allowed=false`가 있으면 절대 실행하지 않는다.
- high risk task는 approval token이 있어야 `executing`으로 넘어간다.
- kill-switch는 global, board, node, task 단위로 평가한다.
- loop는 submit 전, submit 후, verification 전, complete/block 전 safe point마다 kill-switch를 확인한다.
- 실패 시 기본 행동은 rollback이 아니라 block + comment다. rollback은 opt-in clean workspace에서 agent-owned changes가 판정될 때만 허용한다.

### 롤백 정책

- 실행 전 checkpoint는 `git status`, tracked diff hash, untracked summary, current task/run metadata를 기록한다.
- user-owned diff가 있으면 자동 rollback은 금지한다.
- agent-owned diff는 loop가 만든 patch marker, task id, timestamp로 식별한다.
- 자동 rollback은 `--auto-rollback` opt-in node에서만 허용한다.
- rollback이 실행되면 rollback diff summary와 결과를 audit에 남긴다.
- rollback 불가 시 task를 blocked로 두고 rollback plan을 comment에 남긴다.

### 완료 정책

- `complete` 전 최소 요건: summary, changed files 또는 "no file changes", verification result, residual risks.
- verification failed 또는 missing이면 `block`이 기본이다.
- 사람 승인으로 완료하는 예외는 decision inbox/Slack/mobile actor가 audit에 남아야 한다.

## 3. 제안 v1.13 스코프

v1.13의 권장 테마는 **"guarded execution before distributed execution"**이다. cross-room과 멀티머신 실행으로 가기 전에, 단일 local room 안에서 자율 실행 루프가 안전하게 멈추고 설명되고 롤백 가능한지를 먼저 증명해야 한다.

### v1.13 핵심 항목

1. **guarded autonomous execution loop v1**
   - self-claimed task를 preflight -> execute -> verify -> complete/block/comment로 처리한다.
   - node당 동시성 1, loop lease, heartbeat, stale recovery를 포함한다.

2. **risk/approval/kill gate**
   - task kind, workspace, node health, budget, verification, human risk 게이트를 둔다.
   - high risk는 approval 없이는 실행하지 않는다.
   - global/board/node/task kill-switch가 모든 safe point에서 우선한다.

3. **checkpoint/rollback/audit**
   - 실행 전 checkpoint와 rollback plan을 기록한다.
   - 자동 rollback은 opt-in clean workspace와 agent-owned changes에만 허용한다.
   - preflight, approval, execute, verify, complete/block, rollback, kill 이벤트를 timeline으로 표시한다.

4. **Slack/mobile safety controls**
   - Slack/mobile은 query/status/comment/unblock/assign/limited delegate에 더해 approve/pause/kill node까지 작은 command set으로 제공한다.
   - destructive command와 secret/cross-room execution은 제외한다.

5. **multi-machine/cross-room stretch**
   - read-only aggregation과 handoff contract/preview까지가 v1.13 상한이다.
   - 실제 cross-room execution은 single-room autonomous loop가 검증된 뒤로 넘긴다.

### v1.13 exit criteria

1. opt-in node가 low-risk self-claimed task를 실제 CLI 세션에서 실행하고 complete/block/comment 중 하나로 닫는다.
2. node당 autonomous loop 동시성은 1을 넘지 않는다.
3. task kind, workspace, node health, budget, verification, human risk gate가 preflight에 기록된다.
4. high-risk task는 approval 없이는 executing 상태로 넘어가지 않는다.
5. global/board/node/task kill-switch가 safe point마다 loop를 멈춘다.
6. 실행 전 checkpoint와 rollback plan이 audit에 남는다.
7. 자동 rollback은 opt-in clean workspace에서만 실행되고, 그 외에는 block + rollback plan comment를 남긴다.
8. complete 전 verification result와 residual risk가 기록된다.
9. Slack/mobile에서 approve/pause/kill/status/comment 중 최소 5개 safety command가 role-gated로 동작한다.
10. 실제 서버 e2e가 success, approval-needed, kill, verification-fail, rollback-not-allowed 경로를 검증한다.

## 4. v1.14+ 백로그

| 후보                              | 설명                                                                   | 넘기는 이유                                                    |
| --------------------------------- | ---------------------------------------------------------------------- | -------------------------------------------------------------- |
| cross-room handoff implementation | task package를 다른 room으로 보내고 progress/result를 되받는다.        | single-room autonomous loop의 안전성이 먼저 검증되어야 한다.   |
| multi-machine executor routing    | 다른 머신의 실제 CLI 세션이 내 board task를 처리한다.                  | credentials 경계와 trust/backpressure 모델 검증이 더 필요하다. |
| cost-aware execution limits       | budget 초과 시 실행 자체를 제한한다.                                   | cost source 신뢰도와 팀별 정책이 더 필요하다.                  |
| Slack destructive commands        | spawn/despawn, secret update, cross-room handoff를 Slack에서 처리한다. | replay, spoofing, approval UX 위험이 크다.                     |
| mobile command center             | 모바일에서 board/org/terminal action까지 넓힌다.                       | safety command set 검증 후 확장하는 편이 안전하다.             |

## 5. 실행 순서 제안

1. **V13-W1 gate model**: risk classification, task kind allowlist, approval requirements, loop lease schema.
2. **V13-W2 execution loop**: preflight -> execute -> verify -> complete/block, heartbeat, concurrency 1.
3. **V13-W3 checkpoint and rollback**: baseline capture, rollback plan, safe rollback constraints, audit events.
4. **V13-W4 safety surfaces**: kill-switch UI, autonomy timeline, Slack/mobile approve/pause/kill commands.
5. **V13-W5 e2e hardening**: success, approval-needed, kill, verification-fail, stale lease, rollback-not-allowed.
6. **V13-W6 stretch**: read-only aggregation privacy policy, cross-room handoff contract and preview.

## 6. 주요 리스크

- 자율 실행은 claim보다 훨씬 위험하다. v1.13은 기능보다 gate, audit, kill-switch, rollback 제한을 먼저 세워야 한다.
- rollback은 특히 위험하다. 기본은 block+plan이고, 자동 rollback은 clean workspace와 agent-owned changes에만 허용한다.
- approval gate는 우회되면 안 된다. server-side gate와 audit actor가 source of truth여야 한다.
- Slack/mobile command는 편하지만 오조작 피해가 크다. safety command 중심으로 시작하고 destructive command는 제외한다.
- multi-machine/cross-room은 v1.13 core가 아니다. local room loop가 안전해야 분산 실행도 설계할 수 있다.
