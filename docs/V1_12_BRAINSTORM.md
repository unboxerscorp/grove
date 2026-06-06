# grove v1.12+ 브레인스토밍

> Status: historical v1 brainstorm; superseded by the current v2 live cockpit model documented in `docs/design/MASTER_NODE.md` and `docs/agents/LEAD-HANDOFF.md`.
> 작성일: 2026-06-04

## 전제

- v1.0~v1.10은 출시 완료 상태로 본다. v1.10은 guarded autonomous pickup과 self-retro lane으로 안전한 자율성의 시작점을 만들었다.
- v1.11은 routing planner와 autonomy visibility를 진행 중인 것으로 둔다.
- v1.12는 planner 추천을 실제 위임 행동으로 연결하고, 자율 pickup을 사람이 명확히 켜고 끄며, Slack/mobile을 작은 운영 action surface로 확장하는 단계가 적합하다.
- 장기 모델은 실제 CLI 세션, 보드=위임 프로토콜, 사람 승인/감사 guard, 로컬-퍼-멤버 실행, Tailscale 선택 공유다.

## 우선순위 기준

- **P0**: v1.12 핵심 후보. v1.11의 planner/autonomy visibility 위에 바로 얹을 수 있고 사용자 행동을 줄인다.
- **P1**: v1.12 stretch 또는 v1.13 후보. 가치가 크지만 보안, privacy, cross-room 신뢰 모델 확인이 필요하다.
- **P2**: v2.0+ 후보. 멀티머신 실행, destructive remote command처럼 프로토콜 경계가 크다.

## 1. v1.12+ 후보 목록

| 우선 | 아이디어                                   | 한 줄                                                                                                            | 가치                                                                      | 규모 | CLI/역할                                 | 의존성                                                    |
| ---- | ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | ---- | ---------------------------------------- | --------------------------------------------------------- |
| P0   | **planner-to-delegate flow**               | routing planner 추천을 클릭해 assignee 지정, task 생성, 기존 task 재배정을 한 번에 수행한다.                     | "어느 노드가 적합한지" 추천이 실제 위임 행동으로 바로 이어진다.           | M    | FE claude, bridge codex                  | routing planner, dashboard delegate, audit actor          |
| P0   | **pickup-enable toggle UI**                | node/org/board 화면에서 auto-pickup opt-in, pause, cooldown, kill-switch를 조작한다.                             | 자율 pickup이 숨은 설정이 아니라 사람이 보고 켜는 운영 기능이 된다.       | M    | FE claude, bridge codex                  | guarded pickup, team roles, audit events                  |
| P0   | **small autonomous execution loop v1**     | opt-in node가 ready task claim -> execute -> self-check -> complete/block/comment까지 제한 루프를 돈다.          | 작은 작업은 사람이 매번 깨우지 않아도 보드 기반으로 닫힌다.               | L    | bridge codex, maker codex/claude, qa agy | pickup toggle, loop guard, pull executor, recovery status |
| P0   | **loop guard and stop controls**           | max tasks, runtime, retries, task kind allowlist, required verification, emergency stop을 제공한다.              | 자율 루프가 runaway, 비용 폭주, 잘못된 task claim으로 번지는 것을 막는다. | M    | bridge codex, security reviewer          | autonomous loop, notification rules, budget policy        |
| P0   | **Slack command surface v1**               | Slack thread에서 query/status/comment/unblock/assign/limited delegate를 role-gated command로 처리한다.           | dashboard를 열지 않아도 조회와 작은 위임·해제가 가능하다.                 | L    | bridge codex, security reviewer          | Slack connector, team auth actor mapping, replay guard    |
| P0   | **mobile actions v1**                      | 모바일에서 decision inbox 조회, status, comment, unblock, approve, assign을 좁은 action set으로 제공한다.        | 자리를 비운 상태에서도 병목 해소와 승인 처리가 가능하다.                  | M    | FE claude, security reviewer             | mobile shell, CSRF/session model, role policy             |
| P0   | **routing planner v2**                     | task type, WIP, role, recent success, blocked age, review signal, delegation chain을 종합해 assignee를 추천한다. | sublead/lead가 최적 위임 후보를 근거와 confidence로 판단한다.             | L    | planner claude, bridge codex             | routing planner v1, audit history, node workload          |
| P0   | **cost-aware planner v1**                  | cost/credit source, confidence, budget impact를 routing recommendation에 붙인다.                                 | 비용을 고려하되 불확실한 숫자를 확정값처럼 쓰지 않는다.                   | M/L  | planner claude, bridge codex             | cost API, usage provenance, budget policy                 |
| P1   | **autonomy visibility dashboard**          | pickup status, enabled nodes, running loops, fallback reasons, stop controls를 한 화면에 모은다.                 | 자율성이 늘어도 운영자가 현재 무엇이 자동으로 움직이는지 안다.            | M    | FE claude, bridge codex                  | pickup toggle, autonomy audit lane, node status           |
| P1   | **Slack delegate approval flow**           | Slack에서 delegate command를 만들면 preview와 confirm 후 board task를 생성한다.                                  | 채널에서 바로 위임하되 replay/spoofing 위험을 confirmation으로 줄인다.    | M/L  | bridge codex, security reviewer          | Slack command surface, planner-to-delegate, audit actor   |
| P1   | **mobile approval bundles**                | 여러 unblock/approve/comment 요청을 묶어 모바일에서 순차 처리한다.                                               | 사람 판단 요청이 몰렸을 때 처리 비용을 줄인다.                            | M    | FE claude, bridge codex                  | mobile actions, decision inbox, notification rules        |
| P1   | **multi-machine read-only aggregation v0** | 여러 로컬 room의 org/board/health/cost summary를 Tailscale에서 read-only로 모은다.                               | 중앙 서버 없이도 팀 전체 상태를 한 화면에서 본다.                         | L    | bridge codex, security reviewer          | signed summaries, project identity, privacy policy        |
| P1   | **aggregation privacy policy**             | summary에 포함할 fields, comments, costs, member names, redaction level을 project별로 정한다.                    | read-only aggregation이 민감 정보를 과하게 공유하지 않게 한다.            | M    | security reviewer, bridge codex          | export redaction, team auth, signed summaries             |
| P1   | **cross-room handoff contract**            | task package, context pack, expected result, callback, cancellation, audit correlation schema를 정의한다.        | 실행 handoff 전에 책임과 추적 경계를 고정한다.                            | M/L  | architect claude, bridge codex           | aggregation, support bundle, signed handoff               |
| P1   | **handoff preview mode**                   | 실제 전송 없이 handoff package, redaction, missing context, expected result를 미리 보여준다.                     | cross-room 실행 전에 사람이 privacy와 context 품질을 검토한다.            | M    | FE claude, security reviewer             | handoff contract, support bundle, template metadata       |
| P1   | **template marketplace v1 hardening**      | template update, provenance, smoke check history, promote-from-room, compatibility check를 강화한다.             | template가 늘어도 설치 실패와 운영 규약 누락을 줄인다.                    | M/L  | FE claude, core codex, qa agy            | template marketplace, import/export, onboarding wizard    |
| P2   | **cross-room handoff implementation**      | 다른 room으로 task package를 보내고 progress/result summary를 되받는다.                                          | 로컬-퍼-멤버 모델을 유지하면서 전문 node를 공유한다.                      | L    | bridge codex, security reviewer          | handoff contract, signed callbacks, aggregation           |
| P2   | **multi-machine executor routing**         | 다른 머신의 실제 CLI 세션이 내 board task를 처리하도록 opt-in 연결한다.                                          | 개인 credentials 경계를 유지하면서 팀 compute를 넓힌다.                   | L    | bridge codex, ops reviewer               | cross-room handoff, trust policy, backpressure            |
| P2   | **Slack destructive commands**             | spawn/despawn, secret update, cross-room handoff 같은 고위험 command를 Slack에서 처리한다.                       | dashboard 없이도 강한 운영 조작이 가능하다.                               | L    | bridge codex, security reviewer          | approval policy, replay guard, audit UX                   |

## 2. 제안 v1.12 스코프

v1.12의 권장 테마는 **"controlled delegation from everywhere"**다. v1.11이 planner와 autonomy visibility를 제공하면, v1.12는 추천을 한 클릭 위임으로 연결하고, 자율 pickup을 UI에서 명확히 제어하며, Slack/mobile에서 작은 운영 액션을 안전하게 수행하는 것이 가장 실용적이다.

### v1.12 핵심 항목

1. **planner-to-delegate flow + routing/cost-aware planner v2**
   - 추천 assignee를 클릭하면 board task 생성 또는 assignee 변경으로 이어진다.
   - cost/credit은 source와 confidence를 함께 표시하고 자동 결정을 하지 않는다.
   - 모든 planner-driven delegate는 audit actor와 recommendation id를 남긴다.

2. **pickup-enable toggle UI + loop guard controls**
   - node/org/board에서 auto-pickup enable, pause, cooldown, kill-switch를 조작한다.
   - max tasks, runtime, retries, task kind allowlist, required verification을 UI와 API에 노출한다.

3. **small autonomous execution loop v1**
   - opt-in node만 claim -> execute -> self-check -> complete/block/comment 루프를 돈다.
   - guard 실패, verification missing, budget hint 초과 시 fallback comment와 notification으로 사람에게 돌려준다.

4. **Slack command surface v1 + mobile actions v1**
   - query/status/comment/unblock/approve/assign/limited delegate를 role-gated로 제공한다.
   - destructive command와 secret/cross-room action은 제외한다.
   - replay guard, confirmation, audit actor를 기본으로 둔다.

5. **multi-machine read-only aggregation v0 + cross-room handoff contract as stretch**
   - v1.12 core는 read-only summary와 privacy policy까지다.
   - handoff는 package schema와 preview mode까지만 제공하고 실제 execution handoff는 후속으로 둔다.

6. **template marketplace v1 hardening**
   - update/provenance/smoke check history/promote-from-room/compatibility check를 추가한다.
   - marketplace는 v1.12 core의 보조 축이며, autonomous loop와 planner보다 우선순위는 낮다.

### v1.12 exit criteria

1. planner 추천에서 한 클릭으로 board task 생성 또는 assignee 변경을 수행한다.
2. planner action은 recommendation id, actor, target task/node, confidence를 audit에 남긴다.
3. node/org/board 화면에서 pickup enable/pause/kill-switch/cooldown을 조작할 수 있다.
4. loop guard가 max tasks, runtime, retries, task kind, required verification을 제한한다.
5. opt-in node가 작은 task를 claim, execute, self-check 후 complete/block/comment 중 하나로 닫는다.
6. Slack command가 query/status/comment/unblock/assign/limited delegate 중 최소 5개를 처리한다.
7. mobile actions가 decision inbox에서 status/comment/unblock/approve/assign을 수행한다.
8. multi-machine aggregation은 signed read-only summary prototype과 privacy policy를 제공한다.
9. cross-room handoff는 package schema와 preview mode를 제공하되 실제 handoff execution은 하지 않는다.
10. 실제 서버 e2e가 planner-to-delegate, pickup toggle, autonomous loop, Slack/mobile actions 핵심 계약을 검증한다.

## 3. v1.13+ 백로그

| 후보                              | 설명                                                                   | 넘기는 이유                                                     |
| --------------------------------- | ---------------------------------------------------------------------- | --------------------------------------------------------------- |
| cross-room handoff implementation | task package를 다른 room으로 보내고 progress/result를 되받는다.        | 실행 책임, 취소, retry, audit correlation, privacy 정책이 크다. |
| multi-machine executor routing    | 다른 머신의 실제 CLI 세션이 내 board task를 처리한다.                  | credentials 경계와 trust/backpressure 모델 검증이 더 필요하다.  |
| cost-aware execution limits       | budget 초과 시 planner 추천뿐 아니라 실행 자체를 제한한다.             | 비용 source 신뢰도와 팀별 예산 정책이 더 필요하다.              |
| Slack destructive commands        | spawn/despawn, secret update, cross-room handoff를 Slack에서 처리한다. | replay, spoofing, approval UX 위험이 크다.                      |
| mobile command center             | 모바일에서 board/org/terminal action까지 넓힌다.                       | 작은 action set 안전성을 먼저 검증해야 한다.                    |
| org simulator                     | backlog 기반으로 subteam 구성을 dry-run한다.                           | routing/cost/template 데이터가 충분히 쌓인 뒤 효과가 크다.      |

## 4. 실행 순서 제안

1. **V12-W1 planner-to-delegate**: recommendation id, audit payload, assign/create action, e2e.
2. **V12-W2 pickup controls**: enable/pause/kill-switch/cooldown UI, loop guard API.
3. **V12-W3 autonomous loop**: claim -> execute -> self-check -> complete/block/comment, fallback notification.
4. **V12-W4 action surfaces**: Slack command v1, mobile actions v1, role/replay/confirmation guard.
5. **V12-W5 aggregation stretch**: signed read-only summary, privacy policy, cross-room handoff contract/preview.
6. **V12-W6 marketplace hardening**: provenance/update/smoke history/promote-from-room/compatibility checks.

## 5. 주요 리스크

- planner-to-delegate는 추천을 실행으로 바꾸는 순간이다. recommendation id와 audit actor를 남겨 사후 설명 가능성을 보장해야 한다.
- pickup toggle UI는 안전장치다. hidden env/config만으로 자율성을 켜면 운영자가 현재 상태를 놓친다.
- Slack/mobile action은 replay와 권한 혼동이 핵심 위험이다. 작은 command set, confirmation, audit actor부터 유지한다.
- multi-machine과 cross-room handoff는 장기 핵심이지만 v1.12 core로 실제 실행까지 넣기엔 신뢰 경계가 크다. read-only summary와 preview가 현실적인 상한이다.
