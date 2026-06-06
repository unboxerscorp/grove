# grove v1.16+ 브레인스토밍

> Status: historical v1 brainstorm; superseded by the current v2 live cockpit model documented in `docs/design/MASTER_NODE.md` and `docs/agents/LEAD-HANDOFF.md`.
> 작성일: 2026-06-04

## 전제

- v1.13은 guarded execution loop를 출시했고, v1.14는 안전 명령 surface를 출시했다.
- v1.15는 execution timeline 시각화와 usage 리포트를 진행 중인 것으로 둔다.
- v1.16은 로컬-퍼-멤버 실행 모델을 유지하면서 여러 room의 상태를 읽기 전용으로 모으고, room 간 인계를 안전하게 정의하는 단계가 적합하다.
- 핵심 원칙은 실제 CLI 세션, 보드=위임 프로토콜, 사람 승인/감사 guard, signed summary 기반 공유, privacy deny-by-default다.
- v1.16에서 state-changing remote command나 cross-machine executor routing은 하지 않는다. 먼저 요약, 신뢰, 인계 계약, 리포팅 품질을 안정화한다.

## 우선순위 기준

- **P0**: v1.16 핵심 후보. 여러 room을 읽기 전용으로 모으는 데 필요한 신뢰, privacy, 관측성 기반이다.
- **P1**: v1.16 stretch 또는 v1.17 후보. 데이터 모델은 연결되지만 UI/정책/신뢰도 검증이 더 필요하다.
- **P2**: v1.18+ 후보. 실제 cross-room 실행, remote action, hard enforcement처럼 운영 경계가 큰 기능이다.

## 1. v1.16+ 후보 목록

| 우선 | 아이디어                                 | 한 줄                                                                                                                   | 가치                                                                | 규모 | CLI/역할                        | 의존성                                             | 위험/완화                                                                                       |
| ---- | ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- | ---- | ------------------------------- | -------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| P0   | **multi-machine signed summary v0**      | 여러 local room이 org/board/health/autonomy/cost 요약을 서명해 read-only aggregator에 제공한다.                         | 각 멤버는 자기 머신에서 실행하면서 팀 전체 상태를 한 화면에서 본다. | L    | bridge codex, security reviewer | project identity, stable token, summary exporter   | 민감 정보 공유 위험. summary-only, no raw transcript/comment/diff, signer/freshness 표시.       |
| P0   | **aggregation privacy policy v1**        | summary에 포함할 fields, member 이름, cost 가시성, path redaction, board detail level을 정책으로 고른다.                | 읽기 전용 공유가 과공유로 변질되지 않게 한다.                       | M    | security reviewer, bridge codex | export redaction, team auth, project settings      | 기본값 실수 위험. deny-by-default, preview, policy change audit.                                |
| P0   | **freshness and trust badges**           | 각 remote summary에 signer, project id, generated_at, age, last fetch, confidence를 표시한다.                           | stale/불완전/미검증 데이터를 운영자가 즉시 구분한다.                | M    | FE claude, bridge codex         | signed summaries, aggregator API                   | stale 데이터로 판단하는 위험. stale threshold, stale badge, stale summary는 action 불가.        |
| P0   | **unified read-only operations view**    | 여러 room의 node status, board counts, blocked age, autonomy state, usage summary를 한 대시보드에 묶는다.               | 팀 리드가 직접 각 머신에 접속하지 않아도 운영 리스크를 본다.        | L    | FE claude, bridge codex         | signed summary ingest, privacy policy              | 중앙 control plane처럼 오해될 위험. read-only UI copy, no mutating endpoint, local deep-link만. |
| P0   | **cross-room handoff contract v1**       | task package, context pack, expected output, owner, receiver, cancel authority, callback, audit correlation을 정의한다. | 실제 room 간 인계 전에 책임과 추적 경계를 고정한다.                 | M/L  | architect claude, bridge codex  | board task schema, support bundle, signed identity | 책임 불명확 위험. owner/result/cancel 필수, v1.16은 contract와 preview까지만.                   |
| P0   | **handoff preview and redaction report** | 인계 전 package 내용, 누락 context, redacted fields, receiver requirements를 사람이 검토한다.                           | 잘못된 context나 민감 정보 전송을 실제 전송 전에 잡는다.            | M    | FE claude, security reviewer    | handoff contract, privacy policy                   | 전송 착각 위험. preview-only label, explicit export button 없음, diffable report.               |
| P0   | **retro analytics v1**                   | self-retro를 failure cause, repeated blocker, verification issue, cost issue, improvement action으로 집계한다.          | 개별 회고를 팀 운영 개선 항목으로 바꾼다.                           | M    | reviewer claude, agy reviewer   | self-retro lane, audit events, task metadata       | 노이즈가 결론처럼 보일 위험. sample size, confidence, source links 표시.                        |
| P0   | **deeper reporting trends v1**           | throughput, blocked age, verification failure, rollback, kill, cost, idle time의 주간 추세를 보여준다.                  | 단발 리포트를 운영 의사결정 가능한 추세로 만든다.                   | M/L  | bridge codex, FE claude         | timeline events, usage report, cost attribution    | 추세 왜곡 위험. time window, missing-data badge, raw count와 rate 병기.                         |
| P0   | **notification routing v2**              | severity, target role, quiet hours, digest, dedupe, escalation rule로 알림을 라우팅한다.                                | 알림 피로를 줄이고 진짜 사람 판단만 빠르게 올린다.                  | M    | bridge codex, FE claude         | notification rules, member roles, inbox            | 과소/과다 알림 위험. dry-run mode, preview, per-rule audit, safe defaults.                      |
| P1   | **predictive risk alerts**               | blocked age, repeated verify failure, rising cost, stale node를 보고 위험 가능성을 표시한다.                            | 문제가 터지기 전에 사람이 개입할 수 있다.                           | M    | reviewer claude, bridge codex   | trend reporting, node status, retro analytics      | 과신 위험. prediction label, confidence, no auto action.                                        |
| P1   | **usage forecast v1**                    | 최근 run/cost 추세로 이번 주 token/credit 소진 가능성을 예측한다.                                                       | 비용 폭주를 사전에 파악하고 위임 전략을 조정한다.                   | M    | bridge codex, planner claude    | usage report, cost source confidence               | 비용 source 부정확 위험. estimate/unknown 분리, hard block 금지.                                |
| P1   | **notification escalation graph**        | blocker severity가 올라가면 node owner -> project operator -> admin digest 순서로 escalation한다.                       | 사람이 놓친 ask-human이나 safety item을 장시간 방치하지 않는다.     | M    | bridge codex, security reviewer | notification v2, member roles, audit               | 불필요한 escalation 위험. cooldown, max escalation, manual silence with audit.                  |
| P1   | **cross-room handoff dry-run**           | 실제 전송 없이 sender/receiver 양쪽 schema validation과 context sufficiency check를 수행한다.                           | contract가 실제 운영에 충분한지 초기에 검증한다.                    | M    | bridge codex, qa agy            | handoff contract, receiver capability profile      | receiver mismatch 위험. capability requirements, dry-run result only.                           |
| P1   | **per-room report digest**               | room별 weekly summary를 signed digest로 만들고 aggregator에서 비교한다.                                                 | 리드가 팀 전체 건강도와 병목을 빠르게 리뷰한다.                     | S/M  | reviewer claude, FE claude      | signed summary, deeper reporting                   | ranking 문화 위험. comparative view는 health-first, no individual blame metric.                 |
| P1   | **privacy policy simulator**             | 정책 변경 전 어떤 field가 summary/handoff에 포함되는지 preview한다.                                                     | 운영자가 공유 범위를 이해하고 결정한다.                             | M    | security reviewer, FE claude    | privacy policy, redaction report                   | UI 복잡도 위험. example-based preview, defaults 강조.                                           |
| P1   | **retro-to-action suggestions**          | 회고 집계에서 반복 개선안을 board candidate로 제안하되 자동 생성하지 않는다.                                            | 회고가 다음 작업으로 연결된다.                                      | M    | planner claude, reviewer claude | retro analytics, board create flow                 | 무분별한 task 증가 위험. suggestion-only, owner confirm, dedupe.                                |
| P2   | **cross-room handoff implementation**    | contract package를 다른 room에 보내고 progress/result summary를 되받는다.                                               | local-per-member 모델을 유지하며 전문 room 간 협업을 시작한다.      | L    | bridge codex, security reviewer | contract, dry-run, signed callbacks                | trust/cancel/retry 복잡성. v1.16에서는 구현하지 않음.                                           |
| P2   | **multi-machine executor routing**       | 내 board task를 다른 머신의 실제 CLI 세션이 처리하도록 opt-in routing한다.                                              | 팀 compute와 전문성을 넓힌다.                                       | L    | bridge codex, ops reviewer      | handoff implementation, backpressure, trust policy | credential 경계 붕괴 위험. read-only와 handoff 안정화 뒤 검토.                                  |
| P2   | **remote aggregator actions**            | aggregator view에서 approve/abort/kill 같은 action을 원격 room에 전달한다.                                              | 운영자는 한 화면에서 모든 안전 action을 처리할 수 있다.             | L    | security reviewer, FE claude    | signed command, auth, audit federation             | 중앙 제어 위험. v1.16에서는 금지, local deep-link만.                                            |
| P2   | **hard predictive budget enforcement**   | forecast가 예산 초과를 예측하면 autonomous execution을 차단한다.                                                        | 비용 폭주를 강하게 막는다.                                          | M/L  | bridge codex, security reviewer | reliable cost data, budget policy                  | 잘못된 차단 위험. 먼저 hint/report만, hard gate는 후속.                                         |

## 2. 제안 v1.16 스코프

v1.16의 권장 테마는 **"trusted read-only federation"**이다. v1.15가 timeline과 usage report를 안정화하면, v1.16은 여러 local room의 운영 상태를 signed summary로 모아 보되 원격 제어는 하지 않는 신뢰 계층을 만드는 것이 가장 작은 확장이다. 동시에 cross-room handoff는 실제 실행이 아니라 contract, preview, redaction report까지로 제한해 후속 실행의 안전 기반을 만든다.

### v1.16 핵심 항목

1. **multi-machine signed summary v0**
   - room별 exporter가 project id, signer, generated_at, org summary, board counts, blocked age, node health, autonomy state, usage summary를 만든다.
   - aggregator는 summary를 ingest하고 signer/freshness/trust badge를 붙인다.
   - raw transcript, comments, diffs, absolute paths, secrets, unredacted errors는 기본 제외한다.

2. **aggregation privacy policy v1**
   - per-room 정책으로 board detail level, member display, cost visibility, path redaction, autonomy event granularity를 설정한다.
   - 정책 변경은 preview와 audit을 남긴다.
   - 기본값은 최소 공유: counts, health, stale/blocked risk, usage confidence만.

3. **unified read-only operations view**
   - 여러 room을 cards/table로 보여주고 room별 freshness, trust, blocked, stale node, cost risk, autonomy gates를 비교한다.
   - 클릭 시 local room deep-link 또는 exported detail view로 이동한다.
   - aggregator에는 mutating endpoint를 두지 않는다.

4. **cross-room handoff contract and preview**
   - task package schema, context pack schema, expected result, owner/receiver/cancel authority, callback contract, audit correlation id를 문서화한다.
   - UI/CLI는 preview와 redaction report를 만들 수 있지만 실제 send/execute는 v1.16 scope에서 제외한다.

5. **retro analytics and deeper reporting**
   - self-retro를 theme, failure cause, blocker, verification issue, cost issue, proposed improvement로 집계한다.
   - throughput, blocked age, verification failure, rollback, kill, cost, idle time 추세와 confidence를 표시한다.
   - prediction은 label과 confidence를 붙이고 자동 action으로 이어지지 않는다.

6. **notification routing v2**
   - severity, role target, quiet hours, digest, dedupe, escalation, dry-run preview를 갖춘 알림 규칙을 제공한다.
   - safety/ask-human item은 escalation 가능, 일반 status는 digest 중심으로 보낸다.

### v1.16 exit criteria

1. 최소 2개의 local room summary를 aggregator가 읽기 전용으로 수집해 하나의 view에 표시한다.
2. summary에는 signer, project id, generated_at, freshness, trust status가 포함된다.
3. 기본 privacy policy에서는 raw transcript, comments, diffs, absolute paths, secrets가 summary에 포함되지 않는다.
4. privacy policy 변경 preview가 어떤 field가 공유되는지 보여주고 audit에 남긴다.
5. aggregation view는 mutating action을 제공하지 않고 stale summary를 명확히 표시한다.
6. cross-room handoff contract schema가 task/context/result/cancel/callback/audit correlation을 포함한다.
7. handoff preview와 redaction report가 민감 field, 누락 context, receiver requirement를 보여준다.
8. retro analytics가 self-retro를 반복 blocker, failure cause, improvement action으로 집계한다.
9. deeper reporting이 throughput, blocked age, verification failure, rollback/kill, usage trend를 confidence와 함께 표시한다.
10. notification routing v2가 severity, role target, dedupe, quiet hours, digest, escalation dry-run을 지원한다.
11. e2e는 summary ingest, privacy redaction, freshness badge, handoff preview, retro analytics, notification dry-run을 검증한다.

## 3. v1.17+ 백로그

| 후보                                        | 설명                                                                                  | 넘기는 이유                                                      |
| ------------------------------------------- | ------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| cross-room handoff implementation           | preview된 package를 receiver room에 실제로 보내고 progress/result summary를 되받는다. | contract와 privacy preview가 먼저 실제 운영에서 검증되어야 한다. |
| cross-room handoff dry-run 강화             | sender/receiver 양쪽 capability와 context sufficiency를 자동 검사한다.                | v1.16 contract 후 receiver profile 모델이 필요하다.              |
| multi-machine executor routing              | 다른 머신의 실제 CLI 세션으로 task 실행을 opt-in 위임한다.                            | credential, trust, backpressure 경계가 크다.                     |
| predictive risk alert 자동 ticket           | 위험 예측을 board candidate로 제안하거나 생성한다.                                    | prediction confidence와 dedupe가 먼저 안정되어야 한다.           |
| hard budget enforcement                     | usage forecast가 임계치를 넘으면 autonomous execution을 차단한다.                     | cost source 신뢰도와 false-positive 완화가 필요하다.             |
| remote aggregator actions                   | aggregator에서 원격 approve/abort/kill을 수행한다.                                    | 중앙 제어 모델이므로 별도 보안 설계가 필요하다.                  |
| template marketplace with signed provenance | template을 signed publisher/provenance와 함께 공유한다.                               | aggregation identity와 privacy policy가 먼저 필요하다.           |

## 4. 실행 순서 제안

1. **V16-W1 summary contract**: signed summary schema, privacy defaults, redaction policy, freshness/trust model.
2. **V16-W2 aggregator ingest**: local file/HTTP ingest, project identity, stale handling, read-only API.
3. **V16-W3 aggregation UI**: unified operations view, trust/freshness badges, room drilldown, local deep-link.
4. **V16-W4 handoff contract**: task/context/result/cancel/callback/audit schema, preview, redaction report.
5. **V16-W5 retro/reporting**: retro analytics, trend reports, usage forecast hints with confidence.
6. **V16-W6 notification routing**: severity/role/digest/dedupe/escalation dry-run, e2e, privacy review.

## 5. 주요 리스크

- read-only aggregation도 privacy 위험이 크다. summary-only, deny-by-default, no raw transcript/comment/diff, per-field policy가 기본이어야 한다.
- signed summary가 stale이면 잘못된 운영 판단을 만든다. freshness badge, last fetch, stale threshold, stale action lock을 함께 둔다.
- aggregator가 중앙 control plane으로 변질될 수 있다. v1.16에서는 mutating endpoint를 만들지 않고 local deep-link만 제공한다.
- cross-room handoff는 책임 경계가 모호해지기 쉽다. owner, receiver, cancel authority, expected result, callback, audit correlation을 필수로 둔다.
- retro analytics와 prediction은 근거 없는 자동 결론이 될 수 있다. confidence, sample size, source links, no auto action 원칙을 유지한다.
- notification routing은 알림 피로와 누락이 동시에 위험하다. dry-run, dedupe, quiet hours, escalation cap, per-rule audit을 먼저 제공한다.
