# grove v1.27+ 브레인스토밍

> Status: historical v1 brainstorm; superseded by the current v2 live cockpit model documented in `docs/design/MASTER_NODE.md` and `docs/agents/LEAD-HANDOFF.md`.
> 작성일: 2026-06-04

## 전제

- v1.24는 좌측 사이드바와 notification routing v2를 출시했다. routing은 dry-run default, operator-gated, audited다.
- v1.25는 Cmd-K command palette와 Slack digest/reminder를 출시했다. palette는 navigation-only이고, digest/reminder는 read-only/notify-only, dry-run default, default OFF다.
- v1.26은 board query/search/saved views를 진행 중인 것으로 둔다. 즉 큰 board에서 필요한 slice를 찾고 저장하는 기반은 생긴다.
- v1.27은 그 위에 장시간 사용성, 안전한 반복 작업, 새 room 진입 비용을 줄이는 단계가 적합하다.
- optional per-user sandbox v0는 완전 격리가 아니다. best-effort, default OFF, boundary preview, audit, limitation copy가 제품 계약의 일부여야 한다.
- board bulk-ops는 생산성을 올리지만 위험이 큰 mutation surface다. saved view 기반 preview, role gate, CSRF, audit, batch limit, partial result가 필수다.

## 우선순위 기준

- **P0**: v1.27 핵심 후보. daily cockpit ergonomics와 안전한 반복 작업을 직접 개선한다.
- **P1**: v1.27 stretch 또는 v1.28 후보. 가치가 크지만 정책/UX 검증이 필요하다.
- **P2**: v1.29+ 후보. hard isolation, 자동 mutation, cross-room write처럼 안전 경계가 큰 기능이다.

## 1. v1.27+ 후보 목록

| 우선 | 아이디어                               | 한 줄                                                                                                   | 가치                                                 | 규모 | 의존성                                         | 위험/완화                                                                                |
| ---- | -------------------------------------- | ------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- | ---- | ---------------------------------------------- | ---------------------------------------------------------------------------------------- |
| P0   | **Theme token foundation**             | color, surface, border, state, focus, terminal shell 주변 색을 design token으로 정리한다.               | dark/light/high-contrast를 안전하게 얹는 기반이다.   | M    | 현재 CSS 구조, 주요 화면 inventory             | 색상 drift. token-only 변경, screenshot review, contrast budget.                         |
| P0   | **Dark/light theme v1**                | 사용자별 dark/light preference를 저장하고 dashboard 전체에 적용한다.                                    | 장시간 작업과 환경별 가독성을 높인다.                | M    | theme token, member/local preference           | 일부 panel 누락. view inventory checklist와 e2e snapshot smoke.                          |
| P0   | **High-contrast theme v1**             | 저시력/강한 조명 환경을 위한 high-contrast palette와 focus ring을 제공한다.                             | 접근성 품질을 기능으로 끌어올린다.                   | M    | theme token, a11y smoke                        | 보기 불편한 과대 대비. WCAG 기준, manual review, opt-in.                                 |
| P0   | **Theme-aware terminal chrome**        | xterm 자체는 보수적으로 두고 주변 toolbar, tabs, status chip을 theme에 맞춘다.                          | 터미널 가독성을 해치지 않고 cockpit 일관성을 만든다. | S/M  | terminal pane styling, theme token             | 터미널 ANSI 색 왜곡. xterm palette 변경은 stretch로 분리.                                |
| P0   | **Onboarding wizard v3**               | project 생성/로드, template 선택, CLI/tmux 점검, dashboard auth, board smoke task를 한 흐름화한다.      | 새 멤버가 첫 성공까지 가는 시간을 줄인다.            | L    | 기존 onboarding, project switcher, status APIs | 과도한 wizard. skip/resume, validation-only, secrets never echoed.                       |
| P0   | **Setup health checklist v2**          | CLI availability, tmux, board DB, auth, notification dry-run, template readiness를 상태로 보여준다.     | 운영 전 누락을 빨리 찾는다.                          | M    | status probes, onboarding v3, redaction        | secret/path 노출. boolean/status 중심, operator-only detail, redacted hint.              |
| P0   | **Keyboard shortcuts v3**              | board query/search/saved views, drawer open, terminal focus, task drawer 이동 shortcut을 확장한다.      | palette 이후 keyboard-first 운영을 완성한다.         | M    | v1.25 palette, v1.26 board search              | terminal/input 충돌. focus guard, shortcut help, no global capture in inputs.            |
| P0   | **Shortcut discoverability**           | palette/help drawer에서 shortcut 목록과 현재 focus scope를 보여준다.                                    | 기능은 있는데 모르는 문제를 줄인다.                  | S/M  | command palette, i18n                          | UI noise. dismissible help, search-first, no tutorial wall.                              |
| P0   | **Task templates v1**                  | bug, feature, review, QA, doc, release 같은 task template를 title/body/labels/checklist로 제공한다.     | 반복 위임 품질을 높이고 board 입력 비용을 낮춘다.    | M    | board task create, labels, project preferences | 잘못된 template 남용. preview, editable fields, project-scoped template.                 |
| P0   | **Template from completed task**       | 완료 task를 sanitized template 후보로 승격하고 민감 필드를 제외한다.                                    | 실제 성공한 작업 형식을 재사용한다.                  | M    | completed task history, redaction, audit       | 민감 내용 복제. allowlist fields, redaction, operator confirm.                           |
| P0   | **Gated board bulk-ops v0**            | saved view나 선택된 task 집합에 label/add comment/assign/status change를 preview→confirm으로 적용한다.  | 큰 board 관리 시간을 크게 줄인다.                    | L    | v1.26 saved views, board mutation APIs, audit  | 대량 오조작. batch limit, role gate, CSRF, dry-run preview, partial result, audit trail. |
| P0   | **Bulk-op safety diff**                | 작업 전 대상 task 수, 필드별 변경 diff, 제외 사유, 예상 audit event를 보여준다.                         | bulk mutation의 불안감을 낮춘다.                     | M    | bulk-op planner, task read API, redaction      | diff가 실제 적용과 달라짐. operation lease/hash, revalidate before apply.                |
| P1   | **Optional per-user sandbox v0**       | workspace root, writable paths, temp dir, env allowlist, secret namespace를 opt-in으로 분리한다.        | shared host에서 피어 간 우발적 간섭을 줄인다.        | L    | team auth, project settings, process launcher  | 완전 격리 오해. best-effort label, default OFF, limitation banner, supported matrix.     |
| P1   | **Sandbox boundary preview**           | sandbox 적용 전 허용/차단 path, inherited env, secret scope를 redacted preview로 보여준다.              | 깨질 작업을 미리 발견하고 false safety를 줄인다.     | M    | sandbox policy, redaction, settings UI         | 민감 path 노출. operator-only detail, no raw secret values.                              |
| P1   | **Sandbox violation audit v0**         | 차단/경고된 path/env/secret 접근을 redacted audit event와 user-facing reason으로 남긴다.                | policy 튜닝과 신뢰 확보에 필요하다.                  | M/L  | sandbox wrapper, audit lane                    | false denial/노출. sampled detail, redaction tests, safe override path.                  |
| P1   | **Task template variables**            | `${project}`, `${node}`, `${branch}`, `${acceptance}` 같은 변수와 required field validation을 제공한다. | template를 재사용하면서도 task 품질을 유지한다.      | M    | task templates, form validation                | template 언어 복잡화. allowlist variables, preview render, no arbitrary code.            |
| P1   | **Template packs**                     | local folder에서 template pack을 preview/install/update하고 provenance를 보여준다.                      | 팀의 운영 패턴을 로컬-퍼-멤버 모델로 공유한다.       | M/L  | task templates, project import/export          | 신뢰할 수 없는 pack. local-only install, manifest checksum, no auto-enable.              |
| P1   | **Bulk-op undo helper**                | 적용 후 같은 batch의 inverse patch를 preview하고 제한 시간 안에 operator가 되돌릴 수 있게 한다.         | 실수 복구성을 높인다.                                | M/L  | bulk-op audit, field history                   | undo가 새 상태를 덮음. conflict detection, per-task skip, never undo comments blindly.   |
| P1   | **Board bulk-ops for templates**       | selected tasks에 checklist/comment template를 일괄 추가하되 preview와 confirm을 거친다.                 | release/review 준비 같은 반복 운영을 빠르게 한다.    | M    | bulk-ops, task templates                       | comment spam. max batch, duplicate detection, audit summary.                             |
| P2   | **Hard sandbox phase 1**               | OS 계정/컨테이너/권한 경계로 강한 격리를 제공한다.                                                      | 신뢰가 낮은 피어도 host를 쓸 수 있다.                | XL   | sandbox v0 learnings, platform design          | 호환성/운영 복잡도. 별도 security design과 platform matrix 필요.                         |
| P2   | **Automatic bulk cleanup suggestions** | stale query 결과에 label/comment/close 후보를 자동 제안한다.                                            | board 정리 비용을 줄인다.                            | L    | board query, retro/usage signals, confirm flow | 자동 mutation 압력. suggestion-only, no apply without human confirm.                     |
| P2   | **Cross-room template promotion**      | 한 room에서 성공한 task/template를 다른 room에 signed handoff로 추천한다.                               | 운영 패턴 재사용을 넓힌다.                           | L    | signed handoff, template packs, redaction      | 과공유. summary-only, receiver-local accept, no remote write.                            |

## 2. 제안 v1.27 스코프

v1.27의 권장 테마는 **"comfortable control, safe repetition"**이다. v1.26이 board를 찾고 저장하는 힘을 만들면, v1.27은 장시간 보기 좋은 cockpit과 반복 위임/정리 작업의 안전한 빠른 길을 닫는 편이 맞다.

### v1.27 핵심 항목

1. **Theming v1**
   - theme token foundation, dark/light, high-contrast를 제공한다.
   - user/member preference로 저장하고 loopback solo 사용에도 무마찰로 동작한다.
   - terminal ANSI 색은 기본 보수 유지, 주변 chrome만 먼저 theme-aware로 만든다.

2. **Onboarding wizard v3 + setup health checklist**
   - project 생성/로드, template 선택, CLI/tmux, auth, board smoke task를 한 흐름으로 점검한다.
   - Slack/notification 같은 outbound 기능은 live 전송이 아니라 dry-run/readiness만 보여준다.
   - secret 값은 절대 echo하지 않고 status와 redacted hint만 보여준다.

3. **Keyboard shortcuts v3**
   - board query/search/saved views, drawer, task drawer, terminal focus를 keyboard-first로 연결한다.
   - shortcut help와 focus scope 표시를 제공한다.
   - input/terminal focus에서는 global shortcut capture를 피한다.

4. **Task templates v1**
   - bug/feature/review/QA/doc/release template를 project-scoped로 제공한다.
   - 완료 task에서 sanitized template 후보를 만들 수 있게 한다.
   - 변수는 allowlist와 preview render만 허용하고 임의 코드는 없다.

5. **Gated board bulk-ops v0**
   - saved view 또는 manual selection에 label/comment/assign/status change를 preview→confirm으로 적용한다.
   - operator role, CSRF, batch limit, operation lease/hash, audit summary를 필수로 둔다.
   - partial success와 skipped reason을 명확히 보여준다.

6. **Sandbox v0 prep**
   - v1.27에서 full enforcement까지 무리하면 policy model, boundary preview, limitation copy를 먼저 닫는다.
   - opt-in best-effort라는 문구와 unsupported matrix를 제품 UI에 고정한다.
   - violation audit은 실제 enforcement와 같이 또는 바로 다음 버전으로 넘긴다.

### v1.27 exit criteria

1. dark/light/high-contrast가 주요 14 views + 3 drawers에서 적용되고 contrast smoke를 통과한다.
2. theme preference가 local/member scope로 저장되고 새로고침 뒤 유지된다.
3. onboarding wizard v3가 project/template/CLI/tmux/auth/board smoke readiness를 secrets 없이 점검한다.
4. setup health checklist가 notification dry-run, board DB, auth, process readiness를 redacted status로 보여준다.
5. keyboard shortcuts v3가 board/search/saved view/task drawer/terminal focus에서 충돌 없이 동작한다.
6. shortcut help가 현재 focus scope와 사용 가능한 shortcut을 설명한다.
7. task templates v1가 project-scoped template create/use/edit/delete와 preview render를 제공한다.
8. completed task 승격은 allowlist field만 복사하고 redaction/audit을 남긴다.
9. bulk-ops v0는 preview→confirm, role gate, CSRF, batch limit, operation lease/hash, partial result, audit을 제공한다.
10. bulk-op은 viewer에게 read-only preview만 제공하고 confirm/apply는 거부한다.
11. sandbox v0는 최소 policy model + boundary preview + limitation copy까지 닫고, enforcement 여부는 별도 flag로 남긴다.

## 3. v1.28+ 백로그

| 후보                            | 설명                                                            | 넘기는 이유                                                                 |
| ------------------------------- | --------------------------------------------------------------- | --------------------------------------------------------------------------- |
| sandbox enforcement + audit     | path/env/secret boundary를 실제 node launch context에 적용한다. | v1.27 preview와 compatibility 데이터를 먼저 봐야 한다.                      |
| bulk-op undo helper             | batch inverse patch를 제한적으로 제공한다.                      | field history와 conflict policy가 필요하다.                                 |
| template packs                  | local folder/repo template pack을 preview/install/update한다.   | v1.27 template schema와 redaction 정책 안정화가 먼저다.                     |
| board automation suggestions    | stale query 결과에 cleanup 후보를 제안한다.                     | bulk-op 안전 모델이 먼저 필요하다.                                          |
| hard sandbox phase 1            | OS-level 강한 격리를 제공한다.                                  | platform별 보안 설계와 큰 호환성 검증이 필요하다.                           |
| cross-room template promotion   | signed handoff로 task/template 후보를 공유한다.                 | template pack, handoff privacy, receiver-local accept 정책이 먼저 필요하다. |
| theme screenshot diff expansion | 모든 주요 route의 visual diff를 theme별로 확장한다.             | v1.27 smoke set을 안정화한 뒤 coverage를 넓히는 편이 낫다.                  |

## 4. 실행 순서 제안

1. **V27-W1 theme foundation**: token inventory, dark/light, high-contrast, preference persistence, contrast smoke.
2. **V27-W2 onboarding v3**: setup health checklist, project/template path, CLI/tmux/auth/board smoke readiness.
3. **V27-W3 keyboard shortcuts**: board/search/saved view/task drawer/terminal focus, shortcut help, focus guards.
4. **V27-W4 task templates**: template schema, preview render, create-from-completed-task, redaction/audit.
5. **V27-W5 gated bulk-ops**: target planner, safety diff, role/CSRF, operation lease, apply, partial result, audit.
6. **V27-W6 sandbox prep**: policy model, boundary preview, limitation copy, optional flag skeleton.
7. **V27-W7 hardening**: viewer denial tests, no hidden mutation, secret/path redaction, accessibility and theme screenshots.

## 5. 주요 리스크

- theme 작업은 눈에 띄지만 기능 안정성을 깨뜨릴 수 있다. token-only, 주요 route screenshot, contrast smoke로 회귀를 잡는다.
- onboarding은 길어지면 방해가 된다. skip/resume과 readiness-only 원칙으로 실사용 흐름을 막지 않는다.
- keyboard shortcuts는 terminal과 충돌하기 쉽다. focus scope를 명시하고 terminal/input 안에서는 global capture를 끈다.
- task templates는 잘못된 boilerplate를 확산시킬 수 있다. project-scoped, editable, preview-first, no arbitrary code로 제한한다.
- bulk-ops는 가장 위험한 v1.27 mutation surface다. preview→confirm, batch limit, lease/hash revalidation, audit, partial result 없이는 ship하지 않는다.
- sandbox v0는 이름 때문에 강한 보안처럼 보일 수 있다. best-effort/default OFF/unsupported matrix를 UI와 문서에 같이 둔다.
