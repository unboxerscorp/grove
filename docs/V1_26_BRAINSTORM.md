# grove v1.26+ 브레인스토밍

> Status: historical v1 brainstorm; superseded by the current v2 live cockpit model documented in `docs/design/MASTER_NODE.md` and `docs/agents/LEAD-HANDOFF.md`.
> 작성일: 2026-06-04

## 전제

- v1.23은 usage/cost trend, deterministic anomaly, "예측 아님" forecast를 advisory-only signal로 출시했다.
- v1.24는 grouped left sidebar와 notification routing v2를 출시했다. routing은 dry-run default, operator-gated, audited다.
- v1.25는 command palette와 Slack digest/reminder를 진행 중인 것으로 둔다. 즉 반복 알림과 빠른 이동의 1차 루프는 생겼고, v1.26은 실제 daily use에서 남는 마찰을 줄이는 단계가 적합하다.
- v1.26의 핵심 방향은 shared host 안전성, multi-room 관측, board 탐색성, keyboard/a11y, theme/onboarding polish다.
- optional per-user sandbox v0는 best-effort 경계다. hard isolation, 원격 제어, 자동 remediation은 v1.26 범위 밖이다.
- multi-room alert overlay는 read-only 원칙을 유지한다. 다른 room action을 중앙에서 실행하지 않는다.

## 우선순위 기준

- **P0**: v1.26 핵심 후보. 공유 host 안전성, board 탐색성, daily cockpit ergonomics를 직접 개선한다.
- **P1**: v1.26 stretch 또는 v1.27 후보. 가치가 크지만 UX/정책 안정화가 더 필요하다.
- **P2**: v1.28+ 후보. hard sandbox, remote action, 자동 enforcement처럼 위험 경계가 큰 기능이다.

## 1. v1.26+ 후보 목록

| 우선 | 아이디어                           | 한 줄                                                                                               | 가치                                                        | 규모 | 의존성                                                  | 위험/완화                                                                          |
| ---- | ---------------------------------- | --------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- | ---- | ------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| P0   | **Optional per-user sandbox v0**   | workspace root, writable paths, temp dir, env allowlist, secret namespace를 best-effort로 분리한다. | shared host에서 피어 간 파일/환경 실수를 줄인다.            | L    | team auth, project settings, spawn/executor context     | hard isolation 오해. default OFF, limitation copy, supported/unsupported matrix.   |
| P0   | **Sandbox boundary preview**       | sandbox 적용 전 허용/차단 path, inherited env, secret scope를 redacted preview로 보여준다.          | 정책 적용 전 breakage와 false safety를 줄인다.              | M    | sandbox policy, redaction, settings UI                  | 민감 path 노출. operator-only detail, no raw secret values, preview copy review.   |
| P0   | **Sandbox violation audit v0**     | 차단/경고된 path/env/secret 접근을 redacted audit event와 사용자 reason으로 남긴다.                 | sandbox policy 디버깅과 신뢰도 확보에 필요하다.             | M/L  | sandbox wrappers, audit lane                            | false denial과 정보 노출. sampled detail, safe fallback, redaction tests.          |
| P0   | **Multi-room alert overlay v1**    | signed read-only summaries 위에 blocked/stale/quota/anomaly/handoff alert를 모아 보여준다.          | 여러 room의 운영 위험을 한 화면에서 본다.                   | M/L  | signed aggregation, notification summaries, privacy     | 중앙 제어 surface로 오해. read-only only, local deep-link, no remote mutation.     |
| P0   | **Alert correlation v1**           | room, task chain, handoff id, anomaly source가 같은 alert를 incident group으로 묶는다.              | multi-room alert noise를 줄이고 원인 파악을 빠르게 한다.    | M    | multi-room overlay, audit correlation, handoff metadata | 잘못된 grouping. confidence, source list, manual split/merge.                      |
| P0   | **Board filter builder v2**        | status, assignee, label, age, blocked reason, created_by, stale/run state를 조합 필터로 만든다.     | 큰 board에서도 필요한 work slice를 바로 찾는다.             | M    | board API, sidebar/search, task metadata                | query 복잡도. saved presets, visible chips, URL/shareable state.                   |
| P0   | **Board full-text search v1**      | title/body/comment/summary를 project-scoped index로 검색하고 task drawer로 deep-link한다.           | 오래된 결정과 실행 근거를 빠르게 찾는다.                    | M    | board store, comments, redaction, UI search             | 민감 정보 노출. role/project scope, redacted snippets, no raw secret/path.         |
| P0   | **Saved board views**              | 자주 쓰는 filter/search/sort 조합을 sidebar favorite이나 board preset으로 저장한다.                 | lead와 operator가 반복 운영 화면을 빠르게 복원한다.         | S/M  | board filter builder, local/member preferences          | stale saved view. missing field 표시, project-scoped 저장, easy reset.             |
| P0   | **Keyboard shortcuts v2**          | board/search/palette/drawers/terminal에 discoverable shortcuts와 focus mode를 제공한다.             | mouse 없이 daily ops를 빠르게 처리한다.                     | M    | command palette, sidebar, terminal focus model          | input/terminal 충돌. shortcut help, focus guards, no global capture in inputs.     |
| P0   | **A11y regression pass**           | visible focus, skip links, ARIA labels, drawer focus trap, contrast를 smoke/e2e로 고정한다.         | sidebar/palette 이후 접근성 회귀를 막는다.                  | M    | web e2e, selectors, theme tokens                        | 테스트 취약. stable data attrs, focused subset, manual checklist 병행.             |
| P0   | **Light/dark theme v1**            | dark/light/high-contrast theme를 design token 기반으로 제공한다.                                    | 장시간 cockpit 사용과 다양한 환경의 가독성을 높인다.        | M    | CSS tokens, local/member preferences                    | 색상 난립. token-only theming, contrast budget, reviewer screenshot pass.          |
| P0   | **Density preference v1**          | comfortable/compact density로 board rows, sidebar, panels의 정보 밀도를 조절한다.                   | 큰 board와 작은 화면에서 스캔 효율을 높인다.                | S/M  | theme tokens, layout CSS, preferences                   | 레이아웃 겹침. fixed row heights, responsive checks, no font scaling by viewport.  |
| P0   | **Onboarding wizard v3**           | 첫 실행에서 project, agents, dashboard, Slack, team auth, safe defaults를 단계별로 확인한다.        | 새 멤버가 room을 올리고 안전 설정을 이해하는 시간을 줄인다. | M/L  | existing onboarding, project templates, config status   | 과도한 wizard. skip/resume, validation-only, secrets never echoed.                 |
| P0   | **Setup health checklist**         | dashboard에서 CLI availability, tmux, tokens, Slack, board DB, web auth, routing 상태를 점검한다.   | 운영 전 누락된 준비를 빠르게 찾는다.                        | M    | status APIs, onboarding, Slack/config probes            | secret leak. boolean/status only, redacted hints, local-only detail.               |
| P1   | **Sandbox policy templates**       | personal, shared-review, read-only-reference preset을 제공한다.                                     | sandbox 설정을 빠르게 시작한다.                             | M    | sandbox v0, boundary preview                            | template 과신. editable policy, explicit writable roots, limitation copy.          |
| P1   | **Multi-room alert digest**        | overlay alert를 daily/weekly signed-summary digest로 묶는다.                                        | 여러 room operator가 정기적으로 위험을 훑는다.              | M    | multi-room overlay, digest renderer                     | 과공유. signed summary only, raw body 제외, room allowlist.                        |
| P1   | **Board query language v0**        | `status:blocked assignee:maker age:>2d` 같은 간단한 query syntax를 제공한다.                        | power user가 board slice를 빠르게 저장/공유한다.            | M    | board filter builder, parser, docs                      | syntax 혼란. UI builder가 canonical, query는 advanced mode.                        |
| P1   | **Command palette board actions**  | palette에서 filter apply, saved view open, task open, node terminal open을 처리한다.                | board 탐색과 terminal 접근이 더 빨라진다.                   | M    | command palette, board search, role model               | mutation 우회. read/open action 중심, write는 confirm surface deep-link.           |
| P1   | **Onboarding sample room**         | 예제 board/tasks/agents를 안전한 sample project로 제공한다.                                         | 새 사용자가 실제 흐름을 체험한다.                           | M    | project templates, import/export, docs                  | sample이 실제 설정처럼 오해. sample badge, no real credentials, delete path.       |
| P1   | **Theme-aware screenshots check**  | 주요 화면을 dark/light/high-contrast에서 screenshot diff로 검증한다.                                | theme 회귀를 빨리 잡는다.                                   | M    | web verify, browser screenshots                         | flaky screenshot. constrained smoke set, visual threshold, manual review fallback. |
| P1   | **A11y shortcut tutor**            | first-run 또는 help panel에서 핵심 keyboard shortcuts를 보여준다.                                   | keyboard workflow adoption을 높인다.                        | S/M  | keyboard shortcuts, help panel                          | UI noise. dismissible, searchable command palette help.                            |
| P2   | **Hard sandbox phase 1**           | OS-level 계정/컨테이너/권한 경계로 강한 격리를 제공한다.                                            | 신뢰가 낮은 피어도 host를 쓸 수 있다.                       | XL   | sandbox v0 learnings, platform-specific design          | 호환성/운영 복잡도. 별도 platform matrix와 security review 필요.                   |
| P2   | **Remote multi-room actions**      | overlay에서 다른 room의 approve/abort/kill-switch를 직접 수행한다.                                  | 중앙 운영 편의가 크다.                                      | L/XL | auth federation, signed command, remote audit           | 중앙 제어 위험. read-only 원칙 이후 별도 security design 필요.                     |
| P2   | **Automatic board triage actions** | search/filter 결과를 바탕으로 stale task label/comment/assignment를 자동 제안 또는 실행한다.        | 큰 board 관리 비용을 줄인다.                                | L    | board search, planner, confirm workflow                 | 자동 mutation 남용. v1.26 제외, suggestion-only부터 검증.                          |

## 2. 제안 v1.26 스코프

v1.26의 권장 테마는 **"safe shared cockpit polish"**다. v1.25가 command palette와 Slack digest로 운영 loop를 닫는다면, v1.26은 공유 host에서 안전하게 쓰고, 큰 board와 여러 room을 빠르게 훑고, UI를 키보드/테마/온보딩까지 제품 수준으로 다듬는 단계가 맞다.

### v1.26 핵심 항목

1. **Optional per-user sandbox v0**
   - workspace/writable/temp/env/secret boundary를 best-effort로 적용한다.
   - boundary preview와 violation audit을 함께 제공한다.
   - default OFF, limitation copy, supported/unsupported matrix를 명확히 둔다.

2. **Multi-room alert overlay**
   - signed read-only summary에서 alert만 모아 보여준다.
   - alert correlation으로 중복을 줄이고 source list와 confidence를 표시한다.
   - local deep-link만 제공하고 remote mutation은 제공하지 않는다.

3. **Board filter/search 고도화**
   - status/assignee/label/age/blocked reason/stale/run state 필터 builder를 제공한다.
   - title/body/comment/summary full-text search를 project scope와 redacted snippet으로 제공한다.
   - saved board views로 반복 운영 화면을 복원한다.

4. **Keyboard shortcuts + a11y**
   - board/search/palette/drawers/terminal에 discoverable shortcuts와 focus mode를 제공한다.
   - visible focus, skip links, ARIA labels, drawer focus trap, contrast를 smoke/e2e로 고정한다.
   - terminal/input focus에서는 global shortcut capture를 피한다.

5. **Theme/density + onboarding**
   - dark/light/high-contrast와 compact/comfortable density를 token 기반으로 제공한다.
   - onboarding wizard v3와 setup health checklist로 project, agents, dashboard, Slack, team auth, safe defaults를 점검한다.
   - secrets는 표시하지 않고 status/hint만 보여준다.

### v1.26 exit criteria

1. sandbox v0가 best-effort/default OFF로 boundary preview와 violation audit을 제공한다.
2. multi-room alert overlay가 signed summary 기반 read-only view와 local deep-link만 제공한다.
3. alert correlation이 source list와 confidence를 보여주고 manual split/merge를 허용한다.
4. board filter builder가 status/assignee/label/age/blocked reason/stale/run state를 조합한다.
5. board full-text search가 project scope, role scope, redacted snippets를 지킨다.
6. saved board views가 project-scoped로 저장되고 stale target을 안전하게 표시한다.
7. keyboard shortcuts v2가 board/search/palette/drawers/terminal에서 충돌 없이 동작한다.
8. a11y smoke가 visible focus, skip link, ARIA, focus trap, contrast를 검증한다.
9. dark/light/high-contrast theme와 density preference가 token 기반으로 저장된다.
10. onboarding wizard v3와 setup health checklist가 secrets 없이 readiness를 점검한다.
11. e2e는 sandbox preview/audit, multi-room overlay, board filters/search, saved views, keyboard/a11y, theme persistence, onboarding checklist를 검증한다.

## 3. v1.27+ 백로그

| 후보                           | 설명                                                             | 넘기는 이유                                                        |
| ------------------------------ | ---------------------------------------------------------------- | ------------------------------------------------------------------ |
| sandbox policy templates       | personal/shared-review/read-only-reference preset을 제공한다.    | v0 false denial과 compatibility 데이터를 먼저 봐야 한다.           |
| board query language v0        | text query syntax로 필터를 표현한다.                             | UI filter builder 안정화가 먼저다.                                 |
| command palette board actions  | palette에서 board filter/search action을 더 많이 실행한다.       | v1.26 search/palette UX 데이터를 봐야 한다.                        |
| onboarding sample room         | 안전한 sample project를 제공한다.                                | wizard v3의 기본 completion rate를 먼저 측정해야 한다.             |
| multi-room alert digest        | overlay alert를 정기 digest로 묶는다.                            | overlay redaction schema와 correlation 품질 안정화가 먼저다.       |
| hard sandbox phase 1           | OS-level 강한 격리를 제공한다.                                   | best-effort v0 검증 전에는 호환성 위험이 크다.                     |
| remote multi-room actions      | 다른 room action을 중앙에서 수행한다.                            | read-only aggregation 원칙을 깨므로 별도 security 설계가 필요하다. |
| automatic board triage actions | stale/blocked board 항목에 자동 label/comment/assignment를 한다. | filter/search 품질과 confirm workflow가 먼저 필요하다.             |

## 4. 실행 순서 제안

1. **V26-W1 sandbox v0**: policy model, boundary preview, violation audit, limitation copy.
2. **V26-W2 multi-room overlay**: signed alert summary, correlation, source list, local deep-link.
3. **V26-W3 board filters**: filter builder, URL state, saved views, role/project scope.
4. **V26-W4 board search**: full-text index, redacted snippets, task drawer deep-link, tests.
5. **V26-W5 keyboard/a11y**: shortcuts, focus mode, skip links, ARIA, focus trap, e2e smoke.
6. **V26-W6 theming**: dark/light/high-contrast, density tokens, preference persistence, contrast review.
7. **V26-W7 onboarding**: wizard v3, setup health checklist, redacted readiness hints.
8. **V26-W8 hardening**: no secret leaks, no remote mutation, shortcut conflict review, sandbox expectation review.

## 5. 주요 리스크

- sandbox v0는 완전 격리가 아니다. best-effort/default OFF, limitation copy, boundary preview, violation audit로 기대치를 관리한다.
- multi-room overlay는 중앙 action surface로 확장하고 싶은 압력이 크다. v1.26은 read-only와 local deep-link만 허용한다.
- board search는 민감 내용을 snippet으로 노출할 수 있다. project/role scope와 redaction을 backend/frontend 양쪽에서 고정한다.
- keyboard shortcuts는 terminal/input과 충돌할 수 있다. focus guards와 shortcut help를 제공하고 terminal focus mode에서는 global capture를 피한다.
- theme/density는 layout 겹침과 contrast 회귀를 만들 수 있다. design token, fixed constraints, screenshot/contrast smoke를 같이 둔다.
- onboarding은 과하면 방해가 된다. skip/resume, validation-only, no secret echo 원칙을 유지한다.
