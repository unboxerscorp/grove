# grove v1.10+ 브레인스토밍

> Status: historical v1 brainstorm; superseded by the current v2 live cockpit model documented in `docs/design/MASTER_NODE.md` and `docs/agents/LEAD-HANDOFF.md`.
> 작성일: 2026-06-04

## 전제

- v1.0~v1.8은 출시 완료 상태로 본다. v1.8은 presence와 notification rules로 협업 알림 기반을 만들었다.
- v1.9는 import/export, onboarding wizard v2, self-retro lane을 진행 중인 것으로 둔다.
- v1.10은 "재현 가능한 팀룸" 위에 **안전한 자율 claim, 근거 있는 라우팅, dashboard 밖 action surface**를 얹는 단계가 적합하다.
- 장기 모델은 실제 CLI 세션, 로컬-퍼-멤버 실행, 보드=위임 프로토콜, Tailscale 선택 공유, 사람이 최종 판단하는 24/7 팀룸이다.

## 우선순위 기준

- **P0**: v1.10 핵심 후보. v1.9 기반 위에서 제품 가치가 크고, 위험을 guard로 제한할 수 있다.
- **P1**: v1.10 stretch 또는 v1.11 후보. 가치가 크지만 권한, 비용 신뢰도, cross-room 신뢰 모델이 필요하다.
- **P2**: v2.0+ 후보. 멀티머신 실행과 handoff처럼 프로토콜 경계가 크다.

## 1. v1.10+ 후보 목록

| 우선 | 아이디어                                   | 한 줄                                                                                                         | 가치                                                                      | 규모 | CLI/역할                                 | 의존성                                                               |
| ---- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | ---- | ---------------------------------------- | -------------------------------------------------------------------- |
| P0   | **guarded autonomous pickup v1**           | opt-in node가 보드, 자기 assignee, WIP, health, role을 보고 적합 ready task를 claim한다.                      | 사람이 모든 node를 깨우지 않아도 실제 CLI 세션이 보드 기반으로 전진한다.  | L    | bridge codex, maker codex/claude, qa agy | pull executor, notification rules, recovery status, role drift guard |
| P0   | **unsafe fallback comment**                | claim 조건을 통과하지 못하면 자동 실행 대신 이유와 추천 조치를 task comment로 남긴다.                         | 자율성이 사용자가 모르는 실행으로 느껴지지 않고 투명하게 남는다.          | M    | bridge codex                             | guarded pickup, audit events, task comments                          |
| P0   | **routing planner v1**                     | assignee 후보를 WIP, role, delegation chain, 최근 실패, blocked age, review 결과로 추천한다.                  | lead/sublead가 위임할 때 감이 아니라 근거를 보고 고른다.                  | L    | planner claude, bridge codex             | audit history, node workload, self-retro summaries                   |
| P0   | **cost-aware planner v0**                  | token/cost/credit confidence와 budget hint를 routing planner 설명에 붙인다.                                   | 비용 폭주와 expensive lane 남용을 줄이되 숫자 신뢰도를 정직하게 표시한다. | M/L  | planner claude, bridge codex             | cost panel, price config, usage provenance                           |
| P0   | **Slack command surface v1**               | Slack thread에서 status, comment, unblock, approve, assign, limited delegate를 role-gated command로 처리한다. | dashboard를 열지 않아도 사람 판단과 작은 운영 조정을 끝낼 수 있다.        | L    | bridge codex, security reviewer          | Slack connector, team auth actor mapping, replay guard               |
| P0   | **mobile actions v1**                      | 모바일에서 decision inbox, comment, unblock, approve, assign, status를 좁은 action set으로 제공한다.          | 자리를 비운 상태에서도 병목 해소가 가능하다.                              | M    | FE claude, security reviewer             | mobile read view, CSRF/session model, role policy                    |
| P0   | **template marketplace v1**                | local folder/repo template를 preview, install, update, provenance, smoke check와 함께 제공한다.               | 좋은 org/role/board 패턴을 팀 자산으로 재사용한다.                        | L    | FE claude, core codex, qa agy            | import/export, onboarding wizard, template test harness              |
| P1   | **template promotion workflow**            | 현재 room의 org/roles/board lanes를 sanitized template 후보로 승격한다.                                       | 실제로 성공한 운영 방식을 다음 프로젝트 시작점으로 만든다.                | M    | core codex, reviewer claude              | template marketplace, import/export redaction, self-retro            |
| P1   | **multi-machine read-only aggregation v0** | 멤버별 로컬 room의 org/board/health/cost 요약을 Tailscale에서 읽기 전용으로 모은다.                           | 중앙 서버 없이도 팀 전체 상황을 한눈에 보는 첫 경로를 만든다.             | L    | bridge codex, security reviewer          | signed summaries, project identity, privacy policy                   |
| P1   | **aggregation privacy policy**             | 어떤 board fields, comments, costs, member names를 summary에 포함할지 project별로 정한다.                     | 멀티머신 view가 민감 정보 유출 없이 시작된다.                             | M    | security reviewer, bridge codex          | team auth, export redaction, aggregation prototype                   |
| P1   | **cross-room handoff v0 design**           | task spec, context pack, expected result, status callback만 정의하고 실행은 후속으로 둔다.                    | 전문 node 공유를 위한 프로토콜을 만들되 책임 경계를 먼저 고정한다.        | M    | architect claude, bridge codex           | multi-machine aggregation, context pack, signed handoff              |
| P1   | **autonomy audit lane**                    | 자동 claim, 추천, fallback, 사람이 override한 결정을 별도 timeline으로 보여준다.                              | 자율 실행이 늘어도 "왜 실행됐는지"를 사후 검토할 수 있다.                 | M    | FE claude, bridge codex                  | audit events, guarded pickup, routing planner                        |
| P1   | **budget policy v0**                       | node/group/CLI별 daily budget, max WIP, max auto-claim count를 설정한다.                                      | 자율 pickup과 cost-aware planning의 안전 한계를 제품에 명시한다.          | M    | bridge codex, FE claude                  | cost-aware planner, notification rules, team roles                   |
| P2   | **cross-room handoff implementation**      | 다른 멤버 room으로 task package를 보내고 progress summary와 completion result를 되받는다.                     | 로컬-퍼-멤버 모델을 유지하면서 전문성을 공유한다.                         | L    | bridge codex, security reviewer          | handoff design, signed callbacks, aggregation                        |
| P2   | **multi-machine executor routing**         | 특정 board task를 다른 머신의 실제 CLI 세션 executor가 처리하도록 opt-in 연결한다.                            | 개인 credentials 경계를 유지하면서 팀 compute를 넓힌다.                   | L    | bridge codex, ops reviewer               | cross-room handoff, trust policy, backpressure                       |
| P2   | **org simulator v0**                       | backlog와 template를 넣고 sublead/maker/reviewer 구성의 WIP, 비용, 리스크를 dry-run한다.                      | 큰 feature 착수 전 조직 설계를 실험한다.                                  | L    | planner claude                           | routing planner, cost-aware planner, template marketplace            |
| P2   | **mobile command center**                  | 모바일에서 board/org/notifications를 더 넓게 조작한다.                                                        | 원격 운영성을 높인다.                                                     | L    | FE claude, security reviewer             | mobile actions v1, role policy, audit UX                             |

## 2. 제안 v1.10 스코프

v1.10의 권장 테마는 **"safe autonomous operations"**다. v1.9가 room을 내보내고 시작하고 회고하는 기반을 만들면, v1.10은 node가 보드를 보고 적합한 일을 스스로 잡되, 추천·비용·권한·감사 guard를 통해 사람이 이해 가능한 방식으로 확장하는 것이 좋다.

### v1.10 핵심 항목

1. **guarded autonomous pickup v1 + autonomy audit lane**
   - opt-in node만 자동 claim한다.
   - health, WIP, role drift, budget, task priority를 통과해야 하며 실패 시 fallback comment를 남긴다.
   - 자동 claim과 사람이 override한 결정은 별도 timeline으로 추적한다.

2. **routing planner v1 + cost-aware planner v0**
   - assignee 추천을 근거와 confidence로 보여준다.
   - 비용은 확정값처럼 쓰지 않고 source/confidence와 budget hint로 표시한다.
   - 자동 위임은 하지 않고 사람이 승인하는 planner로 시작한다.

3. **Slack command surface v1 + mobile actions v1**
   - comment, unblock, approve, assign, status, limited delegate까지 작은 action set을 role-gated로 제공한다.
   - destructive action, secret 변경, cross-room handoff는 제외한다.

4. **template marketplace v1**
   - local/repo template preview, install, update, smoke check, provenance를 제공한다.
   - 성공한 room을 sanitized template로 승격하는 promotion workflow를 stretch로 둔다.

5. **multi-machine read-only aggregation v0 as stretch**
   - 실행 handoff가 아니라 summary aggregation과 privacy policy까지만 시도한다.
   - signed summary와 project identity가 준비되지 않으면 설계 문서로 마감한다.

### v1.10 exit criteria

1. opt-in node가 자기 assignee의 ready task를 자동 claim하고 실제 CLI 세션에서 실행한다.
2. unsafe 조건에서는 자동 claim하지 않고 task comment에 이유와 추천 조치를 남긴다.
3. autonomy audit lane에서 자동 claim, fallback, 사람이 override한 결정을 확인할 수 있다.
4. routing planner가 추천 assignee, confidence, 근거를 보여주고 자동 위임은 하지 않는다.
5. cost-aware planner가 cost/credit source와 confidence를 표시하며 budget hint를 제공한다.
6. Slack command surface가 comment/unblock/approve/assign/status 중 최소 5개를 role-gated로 처리한다.
7. mobile actions가 decision inbox에서 comment/unblock/approve/assign/status를 수행한다.
8. template marketplace가 local/repo template preview, install, update, smoke check를 제공한다.
9. multi-machine aggregation은 read-only prototype 또는 signed-summary 설계로 마감한다.
10. 실제 서버 e2e가 guarded pickup, planner, Slack/mobile actions, marketplace 핵심 계약을 검증한다.

## 3. v1.11+ 백로그

| 후보                              | 설명                                                                   | 넘기는 이유                                                     |
| --------------------------------- | ---------------------------------------------------------------------- | --------------------------------------------------------------- |
| cross-room handoff implementation | task package를 다른 멤버 room으로 보내고 status/result를 되받는다.     | 실행 책임, 취소, retry, audit correlation, privacy 정책이 크다. |
| multi-machine executor routing    | 다른 머신의 실제 CLI 세션이 내 board task를 처리한다.                  | credentials 경계와 trust/backpressure 모델을 더 검증해야 한다.  |
| cost-aware planner full           | budget policy에 따라 assignee 추천과 실행 제한을 자동화한다.           | 비용 source 신뢰도와 팀별 예산 정책을 더 쌓아야 한다.           |
| org simulator                     | backlog 기반으로 subteam 구성을 dry-run한다.                           | routing/cost/template 데이터가 충분해야 추천 품질이 나온다.     |
| mobile command center             | 모바일에서 board/org/terminal action을 폭넓게 수행한다.                | v1.10의 작은 action set 안전성을 먼저 검증해야 한다.            |
| Slack destructive commands        | spawn/despawn, secret update, cross-room handoff를 Slack에서 처리한다. | replay, spoofing, approval, audit UX 위험이 크다.               |

## 4. 실행 순서 제안

1. **V10-W1 autonomy guards**: opt-in policy, WIP/budget guard, role drift gate, fallback comment.
2. **V10-W2 pickup executor**: board scan, claim decision, audit lane, real-server e2e.
3. **V10-W3 routing and cost planner**: recommendation model, confidence, budget hints, UI integration.
4. **V10-W4 action surfaces**: Slack command v1, mobile actions v1, replay/role/audit guards.
5. **V10-W5 template marketplace**: preview/install/update/provenance/smoke check, promotion stretch.
6. **V10-W6 aggregation stretch**: read-only multi-machine summary prototype or signed-summary design.

## 5. 주요 리스크

- 자율 claim은 제품 비전과 맞지만, 사용자가 모르는 실행처럼 보이면 신뢰를 잃는다. opt-in, visible session, board/audit 기록, fallback comment를 반드시 포함한다.
- 비용 기반 추천은 source confidence가 낮으면 잘못된 최적화가 된다. v1.10은 추천과 budget hint까지만 두고 강제 실행 제한은 후속으로 둔다.
- Slack/mobile action은 편하지만 replay와 권한 혼동 위험이 있다. 작은 command set과 role-gated audit부터 시작한다.
- 멀티머신 aggregation은 장기 핵심이지만 privacy와 signed identity가 먼저다. read-only summary를 넘어서 실행 handoff로 바로 가지 않는다.
