# grove v1.11+ 브레인스토밍

작성일: 2026-06-04

## 전제

- v1.0~v1.9는 출시 완료 상태로 본다. v1.9는 import/export와 onboarding wizard v2로 재현 가능한 팀룸 기반을 만들었다.
- v1.10은 guarded autonomous pickup과 self-retro lane을 진행 중인 것으로 둔다.
- v1.11은 "한 번 claim하고 끝"을 넘어 **작은 자율 실행 루프**, **어느 노드에 위임할지 추천하는 planner**, **Slack/mobile action surface**, **read-only multi-machine view**를 현실적으로 묶는 단계다.
- 장기 모델은 실제 CLI 세션, 보드=위임 프로토콜, 사람이 최종 판단하는 guard, 로컬-퍼-멤버 실행, Tailscale 선택 공유다.

## 우선순위 기준

- **P0**: v1.11 핵심 후보. v1.10의 guarded pickup/self-retro 기반을 직접 확장한다.
- **P1**: v1.11 stretch 또는 v1.12 후보. 가치가 크지만 보안·신뢰·데이터 품질 확인이 더 필요하다.
- **P2**: v2.0+ 후보. cross-room 실행과 멀티머신 executor처럼 프로토콜 경계가 크다.

## 1. v1.11+ 후보 목록

| 우선 | 아이디어                                   | 한 줄                                                                                                         | 가치                                                             | 규모 | CLI/역할                                 | 의존성                                                            |
| ---- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- | ---- | ---------------------------------------- | ----------------------------------------------------------------- |
| P0   | **small autonomous execution loop v1**     | opt-in node가 ready task claim -> 실행 -> self-check -> comment/complete/block까지 제한된 루프를 수행한다.    | 사람이 매 turn 깨우지 않아도 보드 기반으로 작은 작업이 닫힌다.   | L    | bridge codex, maker codex/claude, qa agy | guarded pickup, pull executor, audit lane, recovery status        |
| P0   | **loop guard policy**                      | auto-loop의 max tasks, max runtime, max retries, allowed status, required verification을 설정한다.            | 자율 실행이 무한 반복이나 과도한 비용으로 번지는 것을 막는다.    | M    | bridge codex, security reviewer          | budget policy, notification rules, team roles                     |
| P0   | **routing planner v1**                     | task 특성, WIP, role, recent success, delegation chain, blocked age를 보고 최적 assignee를 추천한다.          | lead/sublead가 "어느 노드에 위임할지"를 근거와 함께 결정한다.    | L    | planner claude, bridge codex             | audit history, node workload, task metadata, self-retro summaries |
| P0   | **cost-aware planner v1**                  | routing 추천에 token/cost/credit source, confidence, budget impact를 붙인다.                                  | 비용과 credit을 보며 위임하되 불확실한 숫자는 정직하게 표시한다. | M/L  | planner claude, bridge codex             | cost panel, usage provenance, budget policy, routing planner      |
| P0   | **Slack command surface v1**               | Slack thread에서 status, comment, unblock, approve, assign, limited delegate를 role-gated command로 처리한다. | dashboard를 열지 않아도 사람 판단과 작은 운영 조정이 끝난다.     | L    | bridge codex, security reviewer          | Slack connector, team auth actor mapping, replay guard            |
| P0   | **mobile actions v1**                      | 모바일에서 decision inbox, status, comment, unblock, approve, assign을 좁은 action set으로 제공한다.          | 자리를 비운 상태에서도 병목 해소와 승인 처리가 가능하다.         | M    | FE claude, security reviewer             | mobile read view, CSRF/session model, role policy                 |
| P0   | **template marketplace v1 finish**         | local/repo template preview, install, update, provenance, smoke check, promote-from-room을 닫는다.            | 성공한 org/role/board 패턴을 다음 프로젝트에 재사용한다.         | L    | FE claude, core codex, qa agy            | import/export, onboarding wizard, template test harness           |
| P1   | **multi-machine read-only aggregation v0** | 여러 멤버의 local room이 org/board/health/cost summary를 Tailscale에서 read-only로 공유한다.                  | 중앙 서버 없이도 팀 전체 상태를 한 화면에 모으는 첫 단계다.      | L    | bridge codex, security reviewer          | signed summaries, project identity, aggregation privacy policy    |
| P1   | **aggregation privacy policy v1**          | summary에 포함할 fields, comments, costs, member names, redaction level을 project별로 정한다.                 | 멀티머신 view가 민감 정보를 과하게 공유하지 않게 한다.           | M    | security reviewer, bridge codex          | export redaction, team auth, signed summaries                     |
| P1   | **cross-room handoff v0**                  | task package를 다른 room으로 보내기 전 spec, context pack, expected result, callback contract를 만든다.       | 전문 node 공유를 위한 실행 책임과 추적 경계를 먼저 고정한다.     | M/L  | architect claude, bridge codex           | aggregation, context pack, signed handoff design                  |
| P1   | **handoff preview mode**                   | 실제 전송 없이 handoff package와 redaction 결과를 미리 보여준다.                                              | cross-room 실행 전에 privacy와 context 품질을 사람이 검토한다.   | M    | FE claude, security reviewer             | cross-room handoff v0, support bundle, template metadata          |
| P1   | **planner-to-delegate flow**               | routing planner 추천을 클릭해 board task 생성/assignee 변경으로 이어지게 한다.                                | 추천이 실제 위임 행동으로 자연스럽게 연결된다.                   | M    | FE claude, bridge codex                  | routing planner, dashboard delegate, audit actor                  |
| P1   | **autonomy scorecard**                     | auto-loop success, fallback, retries, blocked, review escapes, cost confidence를 주간 점수로 보여준다.        | 자율성 확대가 실제로 도움이 되는지 측정한다.                     | M    | reviewer claude, bridge codex            | self-retro, audit events, cost API                                |
| P1   | **Slack/mobile approval bundles**          | 여러 unblock/approve/comment 요청을 묶어 한 번에 처리한다.                                                    | 작은 판단이 쌓였을 때 처리 비용을 줄인다.                        | M    | FE claude, bridge codex                  | Slack command surface, mobile actions, decision inbox             |
| P2   | **cross-room handoff implementation**      | 다른 멤버 room으로 task package를 보내고 progress/result summary를 되받는다.                                  | 로컬-퍼-멤버 모델을 유지하면서 전문 node를 공유한다.             | L    | bridge codex, security reviewer          | handoff contract, signed callbacks, aggregation                   |
| P2   | **multi-machine executor routing**         | 다른 머신의 실제 CLI 세션이 내 board task를 처리하도록 opt-in 연결한다.                                       | 개인 credentials 경계를 유지하면서 팀 compute를 넓힌다.          | L    | bridge codex, ops reviewer               | cross-room handoff, trust policy, backpressure                    |
| P2   | **org simulator v0**                       | backlog와 template를 넣고 sublead/maker/reviewer 구성의 WIP, 비용, 리스크를 dry-run한다.                      | 큰 feature 착수 전 조직 설계를 실험한다.                         | L    | planner claude                           | routing planner, cost-aware planner, template marketplace         |

## 2. 제안 v1.11 스코프

v1.11의 권장 테마는 **"guided autonomy loop"**다. v1.10이 안전한 claim을 증명하면, v1.11은 opt-in node가 작은 task를 claim하고 실행하고 검증하고 닫는 루프까지 확장하되, routing/cost planner와 Slack/mobile action surface를 통해 사람이 계속 이해하고 제어할 수 있게 해야 한다.

### v1.11 핵심 항목

1. **small autonomous execution loop v1**
   - opt-in node만 claim -> execute -> self-check -> comment/complete/block 루프를 돈다.
   - loop guard policy로 max tasks, runtime, retries, allowed task kind, required verification을 제한한다.
   - 실패하거나 guard를 넘으면 fallback comment와 notification으로 사람에게 돌려준다.

2. **routing planner v1 + cost-aware planner v1**
   - 어느 노드에 위임하는 것이 좋은지 WIP, role, recent success, blocked age, review 결과, cost confidence로 추천한다.
   - 추천은 근거와 confidence를 반드시 보여주고, 자동 위임은 하지 않는다.
   - planner-to-delegate flow를 stretch로 붙여 추천에서 board action까지 이어지게 한다.

3. **Slack command surface v1 + mobile actions v1**
   - status/comment/unblock/approve/assign/limited delegate를 role-gated로 처리한다.
   - replay guard, audit actor, command confirmation을 기본으로 둔다.
   - destructive action과 secret 변경은 제외한다.

4. **template marketplace v1 finish**
   - preview/install/update/provenance/smoke check를 닫고, successful room을 sanitized template로 승격하는 flow를 추가한다.
   - onboarding/import-export와 연결해 "시작 가능한 template" 품질을 보장한다.

5. **multi-machine read-only aggregation v0 as stretch**
   - 실행 handoff가 아니라 signed summary + privacy policy + read-only dashboard prototype까지만 시도한다.
   - cross-room handoff는 contract/preview까지가 현실적인 v1.11 상한이다.

### v1.11 exit criteria

1. opt-in node가 ready task를 claim하고 실제 CLI 세션에서 실행한 뒤 complete/block/comment 중 하나로 닫는다.
2. loop guard가 max tasks, runtime, retries, required verification을 제한하고 초과 시 fallback comment를 남긴다.
3. routing planner가 추천 assignee, confidence, 근거를 보여준다.
4. cost-aware planner가 비용/credit source와 budget impact를 confidence와 함께 표시한다.
5. Slack command surface가 status/comment/unblock/approve/assign/limited delegate 중 최소 5개를 role-gated로 처리한다.
6. mobile actions가 decision inbox에서 status/comment/unblock/approve/assign을 수행한다.
7. template marketplace가 preview/install/update/provenance/smoke check와 promote-from-room을 제공한다.
8. multi-machine read-only aggregation은 signed summary prototype 또는 privacy-policy 설계로 마감한다.
9. cross-room handoff는 package schema와 preview mode를 제공하되 실제 실행 handoff는 후속으로 둔다.
10. 실제 서버 e2e가 autonomous loop, planner, Slack/mobile action, template marketplace 핵심 계약을 검증한다.

## 3. v1.12+ 백로그

| 후보                              | 설명                                                                   | 넘기는 이유                                                     |
| --------------------------------- | ---------------------------------------------------------------------- | --------------------------------------------------------------- |
| cross-room handoff implementation | task package를 다른 room으로 보내고 progress/result를 받는다.          | 실행 책임, 취소, retry, audit correlation, privacy 정책이 크다. |
| multi-machine executor routing    | 다른 머신의 실제 CLI 세션이 내 board task를 처리한다.                  | credentials 경계와 trust/backpressure 모델을 더 검증해야 한다.  |
| cost-aware execution budget       | planner 추천을 넘어 budget 초과 실행을 제한한다.                       | 비용 source 신뢰도와 팀별 정책이 더 필요하다.                   |
| org simulator                     | backlog 기반으로 subteam 구성을 dry-run한다.                           | routing/cost/template 데이터가 충분히 쌓인 뒤 효과가 크다.      |
| Slack destructive commands        | spawn/despawn, secret update, cross-room handoff를 Slack에서 처리한다. | replay, spoofing, approval UX 위험이 크다.                      |
| mobile command center             | 모바일에서 board/org/terminal action까지 넓힌다.                       | 작은 action set 안전성을 먼저 검증해야 한다.                    |

## 4. 실행 순서 제안

1. **V11-W1 loop guard policy**: task kind allowlist, runtime/retry/WIP limits, required verification, fallback comment.
2. **V11-W2 autonomous loop**: claim -> execute -> self-check -> complete/block loop, audit, e2e.
3. **V11-W3 planner**: routing/cost recommendation, confidence, budget impact, planner UI.
4. **V11-W4 action surfaces**: Slack command v1, mobile actions v1, replay/role/audit guard.
5. **V11-W5 marketplace finish**: update/provenance/smoke check/promote-from-room.
6. **V11-W6 stretch**: signed read-only aggregation prototype, cross-room handoff schema and preview.

## 5. 주요 리스크

- 자율 loop는 단일 claim보다 위험하다. 반드시 opt-in, short-loop, visible CLI session, audit, fallback, notification을 포함해야 한다.
- routing/cost planner는 데이터 품질이 낮으면 신뢰를 잃는다. 추천 근거와 confidence를 UI의 1급 정보로 둔다.
- Slack/mobile action은 replay와 권한 혼동이 핵심 위험이다. 작은 command set, confirmation, audit actor부터 시작한다.
- multi-machine과 cross-room handoff는 제품 비전의 핵심이지만 v1.11 core로 넣기엔 신뢰 경계가 크다. read-only summary와 handoff preview가 현실적인 첫 단계다.
