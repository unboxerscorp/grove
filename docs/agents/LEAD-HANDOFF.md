# grove-dev LEAD 인수인계 (Claude → Codex)

> 작성: 2026-06-05, 기존 Claude lead(dev10:0.0). 사용자가 신뢰 상실로 lead orch를 Codex 타입으로 교체 지시. 이 문서는 새 Codex lead가 문맥 손실 없이 즉시 이어받기 위한 것.

## 2026-06-05 현재 운영 업데이트 (Codex master)

이 섹션이 아래의 과거 인수인계보다 우선한다.

- 2026-06-06 05:03 KST 기준 최신 live 운영:
  - 현재 노드는 `grove-master`이며 `dev10:0.0`, cwd `/Users/chopin/dev/grove`에서 실행된다.
  - 단일 tmux 세션 `dev10`만 사용한다. panes: `dev10:0.0 grove-master`, `dev10:1.0 web`, `dev10:2.0 slack`, `dev10:3.0 advisor`.
  - web은 `dev10:1.0`에서 `/Users/chopin/.grove/dev10/run-web-loop.sh`로 실행한다. 명령은 `0.0.0.0:8765`, `--unsafe-bind`, `--enable-node-input`, `--enable-intake`, `--allow-host 100.100.90.87,192.168.1.186`를 포함한다.
  - 원격 접속 URL은 tailnet `http://100.100.90.87:8765`, LAN `http://192.168.1.186:8765`이다. remote terminal은 tailnet URL에서 실제 Chrome smoke로 `.dr-conn is-live`, xterm 렌더, 기본 선택 `grove-master`/`dev10:0.0`을 확인했다. `~/.grove/dev10/web.json`도 `allowed_hosts`와 `remote_urls`를 노출한다.
  - Slack은 `dev10:2.0`에서 `/Users/chopin/.grove/dev10/run-slack-loop.sh`로 실행한다. `/api/slack/config/status`는 `socket_connected`, `~/.grove/dev10/slack-runtime.json` heartbeat가 갱신된다. 2026-06-06 05:03 KST 기준 Slack pane은 `dev10:2.0`, runtime pid는 `84491`, heartbeat fresh이다.
  - advisor는 `dev10:3.0`의 Claude 노드이며 약 5분마다 `grove-master`를 점검한다. 사용자가 명시 중단하기 전까지 루프를 멈추지 않는다.
  - `/api/projects`는 `dev10` 하나만 반환해야 한다. `/api/boards`는 프로젝트 헤더가 없어도 현재 active project board만 반환해야 하며, 과거 `p2-test` 같은 stale board가 섞이면 회귀다. `/api/org`의 `default_assignee`와 `master_org.project_master.name`은 `grove-master`여야 하며 advisor가 default가 되면 회귀다.
  - `~/.grove/boards/board.db`의 stale `p2-test` board/task 찌꺼기는 삭제했다. 삭제 전 백업은 `~/.grove/boards/board.db.bak.pre-p2-cleanup-1780682270`이다. 이후 DB 전체 `tasks=0`, live `/api/boards/default/tasks=[]`, `/api/inbox.total=0`을 확인했다.
  - 최신 product-code 커밋은 `dbbd742 fix: describe role preset items as human lists`이다. live web code 기준 최신 재배포 반영 커밋도 `dbbd742`이다. 이후 docs-only handoff 커밋이 HEAD에 추가될 수 있으므로 `git log --oneline -5`로 현재 HEAD를 확인한다.
  - 최신 검증: `pnpm check` green(TS/Vitest 54 files 286 tests, bridge pytest 444 passed), `web npm run build && npm run verify` green. core verify는 mock `/api/status`에서도 node status `active -> running` alias를 검사한다(`2 실행 중/3 대기`에서 frontend를 active로 바꾼 뒤 `3 실행 중/2 대기`). role preset preview/source도 `보드 task` 대신 `사람용 목록 항목`으로 설명하며 `web/verify.mjs`가 해당 copy 회귀를 막는다. live web 재배포 health 200(started_at `1780689758`). live Chrome smoke에서 NodeStatusBar `4 실행 중 / 0 대기 / 4 전체`, sidebar `4/4 실시간`, active rows `활성/실행 중`, Team delayed `/api/org` 로딩 중 `노드 불러오는 중`, 완료 후 4 nodes/3 edges/3 groups 확인. `/api/status`는 running=4/idle=0, summary export node status도 `active -> running` alias 적용, master chat fallback/fact summary는 board count를 `Human items`로 설명한다. `/api/nodes`와 `/api/org` 모두 4개 노드 `pane_exists:true`, `/api/projects=[dev10]`, token-only `/api/boards=[dev10 task_count=0]`, explicit `X-Grove-Project: dev10` `/api/boards`는 호환 alias `dev-room`과 `dev10`만 반환, `/api/inbox.total=0`, `grove org --json` nodes 4개 pane live, Slack `socket_connected`, heartbeat fresh.
- 현재 노드는 `grove-master`이며 `dev10:0.0`, cwd `/Users/chopin/dev/grove`에서 실행된다.
- 앞으로 기본 운영은 `dev10` tmux 하나를 쓴다. 현재 서비스 창은 `dev10:1.0 web`, `dev10:2.0 slack`이다.
- 프로젝트 ID와 host tmux 세션은 분리됐다. web 프로젝트 생성은 `grove new-project --tmux-session dev10`로 새 프로젝트 registry를 만들고 pane은 `dev10`에 둔다.
- 사용자가 Slack 재가동을 명시 승인했다. Slack은 `grove-master`와 직접 대화하도록 켜져 있으며, 긴 응답은 Slack thread 안에서 chunking한다.
- web은 원격 접속을 위해 `0.0.0.0:8765`에 떠 있어야 한다. 현재 tailnet URL은 `http://100.100.90.87:8765`, LAN URL은 `http://192.168.1.186:8765`이다.
- 보드 task는 노드 간 통신 프로토콜이 아니다. 사람 TODO, 사람 피드백, ask-human/판단 대기 기록으로만 취급한다.
- 2026-06-05 23:06 KST 기준 모든 board의 `task_count=0`, `/api/boards/default/tasks == []`이다. 웹 보드는 "피드백 및 할 일" / "사람 판단 필요" 두 목록만 기본 노출한다.
- 노드 간 통신은 직접 대화, tmux capture/send, CLI ask/send 등 각 노드 판단에 맡긴다.
- 조직도 변경은 사람 소유다. GUI/API/CLI에서 명시 operator 경로(`--operator`, `--operator-override`)로만 수행한다.
- 모든 노드는 조직도, 역할, tmux pane, cwd를 볼 수 있어야 한다. `grove org --json`과 `/api/org`가 이 필드를 노출한다. tmux pane liveness는 `list-panes`의 canonical `session:window.pane` 목록과 완전 일치로 검증한다. missing pane은 CLI에서 `pane_exists:false/status:pane-missing`, web API에서 `status:dead/unavailable_reason:"tmux pane missing"`으로 보여야 한다.
- 2026-06-05 23:12 KST 기준 `/opt/homebrew/bin/grove -> /Users/chopin/dev/grove/dist/cli.js` symlink를 생성했다. 새 셸에서 `grove org --json`이 바로 동작한다.
- web 기본 sidebar는 `목록`, `Team`, `터미널`, `Slack integration`, `Connect`, `Inbox`, `Audit`, `Setup`만 노출한다. 구형 execution/cost/ledger/aggregation/handoff/routing/chain 표면은 기본 UI에서 제거됐다.
- 터미널 탭은 선택 pane이 없으면 첫 viewable pane에 자동 연결한다. 2026-06-05 23:19 KST 장애 원인=첫 방문 onboarding overlay가 실제 클릭을 가로막음. 수정=onboarding은 수동 튜토리얼 버튼으로만 열림. live 검증: 실제 Chrome 클릭으로 `터미널` 탭 진입, `/api/ws-ticket` terminal ticket 200, `/ws/terminal` frame 수신, xterm text 렌더 확인.
- `build_assistant_facts`는 현재 `dev10` registry 기준 live nodes를 반환한다. facts는 참고 컨텍스트이며 응답의 유일한 상태 소스가 아니다.
- Slack/web master 응답 프롬프트와 사용자-facing 차단 사유에서 내부 구현어가 새지 않도록 정리했다. facts/decision JSON은 이벤트 컨텍스트일 뿐이며 자연 대화와 직접 런타임 확인을 막지 않는다. 2026-06-05 23:35 KST live 반영됨(PID web 51497, slack 50643 확인).
- 검증: `npm run build`, `npm run verify`(core UI), `GROVE_VERIFY_FULL=1 npm run verify`(현재 core로 수렴), `pnpm check` green. 과거 전체 패널 검증은 `GROVE_VERIFY_FULL=1 GROVE_VERIFY_LEGACY_FULL=1 npm run verify`로만 실행한다.

## 0. 과거 사고 기록 (현재 운영 규칙 아님)

- 과거에는 Slack 봇이 사용자 승인 전 OFF였다. 2026-06-05에 사용자가 재가동을 명시 승인했고, 현재는 `grove-master` 직통 라우팅으로 실행 중이다.
- 라이브 dev10 노드 비파괴(despawn/recreate 금지, 문맥 가치 높음). 게시 history 비재작성. web 단일 인스턴스(`~/.grove/redeploy-web.sh`).
- watchdog/executor OFF 유지(멀티리뷰+사용자 승인 전 실가동 금지).
- 과거 handoff에는 lead가 통합만 맡는 운영 제한이 있었다. 현재 사용자는 필요하면 master가 직접 작업해도 된다고 정정했다.

## 1. 현재 product-code = dbbd742 (트리 클린)

최근 완료된 안정화:

- `dbbd742 fix: describe role preset items as human lists`: CLI canonical role preset과 web NodeForm preset preview에서 `보드 task` 문구를 제거하고 `사람용 목록 항목` 모델로 정렬했다. `src/role-presets.test.ts`와 `web/verify.mjs`에 회귀 가드를 추가했다. RED(`보드 task` 노출) 확인 후 `pnpm vitest run src/role-presets.test.ts`, `web npm run build && npm run verify`, `pnpm check` green. live web 재배포 health 200, Slack pid `84491` 유지 및 heartbeat fresh 확인.
- `b6aa03d fix: describe executor prompts as human items`: pull executor가 노드에 넘기는 프롬프트 헤더를 `grove board task 실행`이 아니라 `grove human-facing item 작업`으로 정렬했다. env 변수명은 호환성 때문에 유지했다. RED(`You are executing a grove board task`) 확인 후 pull executor regression, `tests/test_pull_executor.py` 34 passed, `pnpm check` green.
- `f1070ae fix: describe master chat counts as human items`: master chat fallback/fact summary와 web mock answer에서 board count를 `Board tasks`가 아니라 `Human items`로 설명한다. board를 노드 간 통신 프로토콜처럼 보이게 하는 잔여 copy를 제거했다. RED(`Board tasks:` 노출) 확인 후 bridge regression test 추가, `web npm run build && npm run verify`, `pnpm check` green, live web 재배포 health 200.
- `99386c1 test: guard active node liveness in web mock`: live product fix 이후 mock `/api/status`도 registry `active`를 `running`으로 정규화하게 맞췄다. core `web/verify.mjs`가 상태를 `active`로 바꾼 뒤 NodeStatusBar가 `3 실행 중/2 대기`로 바뀌는지 확인한다. RED(`2 실행 중/3 대기` 고정) 확인 후 fix, `web npm run build && npm run verify && npm run typecheck`, `pnpm check` green.
- `42ad5c4 fix: normalize active nodes in summary counts`: summary export/aggregate의 node `by_status`에서도 `active`를 `running`으로 정규화한다. 외부 리포트에서 active 서비스 노드가 `other`로 빠지는 것을 막는다. bridge summary privacy test와 `pnpm check`, live web 재배포 health 200 확인.
- `c954317 fix: classify active nodes as live in status`: `/api/status`가 registry `active` 서비스 노드를 idle로 분류해 상단 NodeStatusBar가 `running=1/idle=3`처럼 보이던 문제를 고쳤다. summary와 detail 모두 `active`를 running/live 계열로 정규화한다. bridge regression test, `pnpm check`, live API/DOM smoke green.
- `2faab47 fix: expose pane exists in web node payloads`: CLI `grove org --json`와 동일하게 web API `/api/nodes`, `/api/org`, project creation `project_master` payload에도 `pane_exists`를 명시 노출한다. node-count/status만으로 pane 소실을 놓치지 않도록 외부/웹 소비자가 같은 liveness 신호를 쓸 수 있다. bridge tests와 web type을 갱신했고 `pnpm check`, live API smoke green.
- `5d7bd69 fix: count live nodes by pane availability`: sidebar live count가 `status==="running"`만 세서 live dev10의 `active` 서비스 노드들을 누락하던 문제를 고쳤다. terminal pane이 있고 `dead/error/stale`가 아닌 노드를 live로 세며, `active` 상태 label/dot도 사용자-facing `활성/active`로 정렬했다. core verify에 `4/6` live count 회귀 가드를 추가했고, live web smoke에서 `4/4 실시간`을 확인했다.
- `d8b021b fix: avoid empty org flash while loading`: Team 패널이 `/api/org` 응답 대기 중 초기 `nodes=[]`를 실제 빈 조직처럼 보여 `노드가 없습니다`/0-node로 오인되던 문제를 고쳤다. `OrgChart`에 loading 상태를 분리하고 `web/verify.mjs` 기본 core verify에 delayed org response 회귀 가드를 추가했다. `web npm run build && npm run verify`, `pnpm check`, live web 재배포, live delayed-org Chrome smoke green.
- `2d63562 fix: align web item assignment copy`: web Team/Planner의 `위임/Delegate task/Assign task` 사용자 문구를 사람용 항목 생성·배정 copy로 정렬했다. `web/verify.mjs`에 해당 회귀 가드를 추가했고, `web npm run build && npm run verify`, `pnpm check`, live web 재배포 health 200을 확인했다.
- `a5305b6 fix: match tmux pane liveness exactly`: tmux target fuzzy matching 때문에 `dev10:2.0`이 없어도 `display-message`가 `dev10:1.0`을 반환하던 오인을 제거했다. CLI/bridge 모두 `tmux list-panes -a -F "#{session_name}:#{window_index}.#{pane_index}"` 결과와 완전 일치로 pane 존재를 판단한다. `pnpm check` green, live CLI build 및 web 재배포 완료.
- `bd9d6f7 fix: detect missing tmux panes in org views`: registry node가 active여도 실제 tmux pane이 사라지면 `grove org`와 `/api/org`/`/api/nodes`에서 missing 상태로 노출한다. advisor가 제기한 "node-count로 pane 소실 감지 불가" 리스크를 닫기 위한 1차 fix였고, 이후 `a5305b6`에서 fuzzy matching까지 교정했다.
- `0f0ae07 fix: describe Slack intake as human-facing item`: Slack intake preview/confirm/denial/audit copy를 `task`가 아니라 사람용 item 생성으로 정렬했다. live Slack은 pid `84491`로 재시작되어 해당 코드가 반영됐다.
- `277964c fix: keep Slack human decision copy item-focused`: Slack 사람 판단 필요 안내에서 `task unblock` copy와 completed notice reason의 `task_unblocked` 표현을 제거하고, 사람 판단 항목에 답변을 남기는 copy로 정리했다. `tests/test_slack.py`에 회귀 가드를 추가했고 `pnpm check` green. live Slack은 코드 반영을 위해 재시작했고 `dev10:2.0` pane 복구, pid `79225`, `socket_connected`, heartbeat fresh를 확인했다.
- `6a23595 fix: keep inbox answer copy item-focused`: Decision inbox 답변 UI와 `/api/inbox.answer` metadata에서 `unblock task/board events` 중심 copy를 제거하고, 사람 판단 항목에 답변을 남기는 모델로 정리했다. web verify와 bridge pytest에 회귀 가드를 추가했고, live web 재배포 후 health 200, Slack heartbeat, dev10-only project/board, terminal WS frame 수신을 확인했다.
- `23fca58 fix: describe delegate as human-facing item`: `grove delegate` CLI/help/error/warning/test copy를 node-to-node delegated task가 아니라 사람용 TODO/feedback item 생성으로 정렬했다. `pnpm check` green.
- `33418d0 fix: remove read-only copy from Slack intake UI`: 기본 Slack integration 화면의 intake 안내에서 `읽기 전용/read-only` 표현을 제거하고 core verify에 회귀 가드를 추가했다. `pnpm check` green.
- `29a2978 fix: allow master terminal input in web mock`: web terminal mock/verify를 v2 모델에 맞춰 root/master pane도 입력 가능하게 정렬하고, 터미널 라벨에서 `읽기 전용/read-only` 노출을 `실시간 미러/live mirror`로 교체했다. `npm run check`(web)와 `pnpm check` green.
- `49564c2 fix: keep master fallback copy user-facing`: MASTER deterministic fallback/feedback preview 문구에서 `read-only`, future route, internal module name 같은 구현 중심 표현이 사용자에게 새지 않도록 정리하고 회귀 테스트를 추가했다. `pnpm check` green.
- `cc0ec74 fix: align role preset copy with v2 org model`: web 노드 생성 role preset preview에서 reviewer/QA/maker 능력을 제한처럼 보이게 하던 copy를 제거하고, v2의 자유 작업/직접 검증 모델에 맞췄다. live web 재배포 후 health 200, org/board/Slack 정상 확인.
- `defeb46 fix: keep Slack human-decision notice user-facing`: Slack의 사람 판단 필요 알림이 assistant notice에 내부 `human gate requested...` 문구를 넘기지 않고, 사용자-facing `Human decision needed...` 문구를 넘기도록 했다. live Slack은 재시작 후 `socket_connected`와 heartbeat를 확인했다.
- `137d66f fix: scope board listing to active project`: 기본 세션 `/api/boards`도 현재 project board로 스코프를 걸어 과거/다른 프로젝트 board가 UI 선택지에 섞이지 않게 했다. 명시적 `dev10` project header에서만 기존 `dev-room` 별칭 목록을 유지한다.
- `e042622 fix: guard node-routed master chat`: isolated e2e/temp server가 실제 `grove-master` pane으로 `grove ask`를 보내지 않도록, node-routed master chat은 target node가 현재 `GROVE_HOME` registry에 terminal-viewable로 있을 때만 CLI를 호출한다.
- `5dec69d fix: expose remote web companion urls`: `~/.grove/dev10/web.json`에 `allowed_hosts`와 `remote_urls`를 기록해 remote/headless 접속 정보를 노드가 직접 확인할 수 있게 했다.
- `7100279 fix: prefer master terminal by default`: terminal view 첫 진입 시 raw node 배열 순서가 아니라 `grove-master`/lead/root 우선순위로 기본 pane을 선택한다.
- `407c84e docs: refresh live dev10 handoff`: live dev10 운영 상태를 문서화했다.
- `c5a037a fix: keep grove master as default assignee`: advisor가 생겨도 `/api/org` default assignee는 `grove-master`로 유지한다.
- `3e9e739 fix: report live slack socket heartbeat`: Slack socket heartbeat를 runtime 파일로 기록하고 `/api/slack/config/status`에 반영한다.

과거 스켈레톤 갭 완료 기록:

- **PR-E 역할 프리셋**(2dfc8b2): `src/role-presets.ts`, spawn `--role-preset`, web NodeForm preset select.
- 과거 **PR-F 조직/업무방식 context prepend**(2668c03): `src/context-pack.ts`+`bridge/.../context_pack.py`가 dispatch 전 context를 prepend했다. 현재는 보드 task 중심 통신 모델이 폐기됐고, context pack은 org/pane/cwd 인지 보조로만 해석한다.
- **test coverage**(3518dd9): bridge API + core 단위 + Playwright e2e 스캐폴드. vitest를 `src/**/*.test.ts`로 스코핑(playwright .spec 오실행 해소).
- **slack cold-channel fix**(4f3c804, cherry-pick): cold message.channels 게이팅. 이후 engaged-thread 자동응답 제거와 Slack runtime heartbeat까지 추가됐고, 현재 Slack은 사용자 승인 후 `grove-master` 직통으로 켜져 있다.

## 2. 진행 중 (in-flight)

- 현재 별도 worker in-flight는 없다. live 운영은 `grove-master`가 직접 관리하고, advisor가 5분마다 비차단 점검한다.
- 계속할 작업은 장시간 steady-state 검증과 작은 회귀 제거다. 우선순위: web 재시작 루프 유지, Slack heartbeat/소켓 freshness 유지, remote terminal ticket 200 유지, `/api/projects` 단일 dev10 유지, `/api/org` default assignee `grove-master` 유지.
- 새 프로젝트/노드 생성, 조직도 변경, 노드 종료는 사람이 명시 지시할 때만 operator 경로로 수행한다.

## 3. 통합 규율 (worktree)

worktree(`~/grove-worktrees/{auth,gui,master,slack,platform}`)는 main보다 크게 stale해질 수 있음(46~58커밋 사례). **raw merge 금지** — 작성자가 현재 main에 rebase(자기 델타만 replay)→충돌 양쪽 보존→full `pnpm check` green→lead가 `git merge --ff-only`(또는 무충돌 cherry-pick). 실제 델타는 `git show <tip> --stat`로 확인(tip-to-tip diff는 staleness 착시로 대량 삭제처럼 보임). 다중 노드가 공유 main 체크아웃에 쓰면 WIP가 게이트 오염 → 노드 커밋 금지, lead가 단일 통합 커밋.

## 4. 데몬/노드

- web: `dev10:1.0`, `0.0.0.0:8765`, tailnet `100.100.90.87`, LAN `192.168.1.186`, `/Users/chopin/.grove/dev10/run-web-loop.sh`가 재시작 루프를 담당한다.
- slack: `dev10:2.0`, `/Users/chopin/.grove/dev10/run-slack-loop.sh`가 재시작 루프를 담당한다.
- grove-master: `dev10:0.0`, codex, root.
- advisor: `dev10:3.0`, claude, `grove-master`의 advisory child. 5분 점검 루프를 유지한다.
- 조직도 `roots:['grove-master']`. 기본 live 프로젝트는 `dev10` 하나다.

## 5. 캐논 스켈레톤 (최우선 미션)

`GROVE MASTER → 프로젝트 lead → 프로젝트별 조직`. 8항 + 갭 스펙 = `docs/agents/skeleton-gap-implementation.md`. 미션: 갭 전부 구현 → 철저 e2e/API → TRUE stable, 무한 반복.
