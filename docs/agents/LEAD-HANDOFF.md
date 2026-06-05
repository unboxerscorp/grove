# grove-dev LEAD 인수인계 (Claude → Codex)

> 작성: 2026-06-05, 기존 Claude lead(dev10:0.0). 사용자가 신뢰 상실로 lead orch를 Codex 타입으로 교체 지시. 이 문서는 새 Codex lead가 문맥 손실 없이 즉시 이어받기 위한 것.

## 2026-06-05 현재 운영 업데이트 (Codex master)

이 섹션이 아래의 과거 인수인계보다 우선한다.

- 2026-06-06 02:07 KST 기준 최신 live 운영:
  - 현재 노드는 `grove-master`이며 `dev10:0.0`, cwd `/Users/chopin/dev/grove`에서 실행된다.
  - 단일 tmux 세션 `dev10`만 사용한다. panes: `dev10:0.0 grove-master`, `dev10:1.0 web`, `dev10:2.0 slack`, `dev10:3.0 advisor`.
  - web은 `dev10:1.0`에서 `/Users/chopin/.grove/dev10/run-web-loop.sh`로 실행한다. 명령은 `0.0.0.0:8765`, `--unsafe-bind`, `--enable-node-input`, `--enable-intake`, `--allow-host 100.100.90.87,192.168.1.186`를 포함한다.
  - 원격 접속 URL은 tailnet `http://100.100.90.87:8765`, LAN `http://192.168.1.186:8765`이다. remote terminal은 tailnet URL에서 실제 Chrome smoke로 `.dr-conn is-live`와 xterm 렌더를 확인했다.
  - Slack은 `dev10:2.0`에서 `/Users/chopin/.grove/dev10/run-slack-loop.sh`로 실행한다. `/api/slack/config/status`는 `socket_connected`, `~/.grove/dev10/slack-runtime.json` heartbeat가 갱신된다.
  - advisor는 `dev10:3.0`의 Claude 노드이며 약 5분마다 `grove-master`를 점검한다. 사용자가 명시 중단하기 전까지 루프를 멈추지 않는다.
  - `/api/projects`는 `dev10` 하나만 반환해야 한다. `/api/org`의 `default_assignee`와 `master_org.project_master.name`은 `grove-master`여야 하며 advisor가 default가 되면 회귀다.
  - 최신 검증: `pnpm check` green, `web npm run check` green, tailnet browser terminal smoke green.
- 현재 노드는 `grove-master`이며 `dev10:0.0`, cwd `/Users/chopin/dev/grove`에서 실행된다.
- 앞으로 기본 운영은 `dev10` tmux 하나를 쓴다. 현재 서비스 창은 `dev10:1.0 web`, `dev10:2.0 slack`이다.
- 프로젝트 ID와 host tmux 세션은 분리됐다. web 프로젝트 생성은 `grove new-project --tmux-session dev10`로 새 프로젝트 registry를 만들고 pane은 `dev10`에 둔다.
- 사용자가 Slack 재가동을 명시 승인했다. Slack은 `grove-master`와 직접 대화하도록 켜져 있으며, 긴 응답은 Slack thread 안에서 chunking한다.
- web은 원격 접속을 위해 `0.0.0.0:8765`에 떠 있어야 한다. 현재 tailnet URL은 `http://100.100.90.87:8765`, LAN URL은 `http://192.168.1.186:8765`이다.
- 보드 task는 노드 간 통신 프로토콜이 아니다. 사람 TODO, 사람 피드백, ask-human/판단 대기 기록으로만 취급한다.
- 2026-06-05 23:06 KST 기준 모든 board의 `task_count=0`, `/api/boards/default/tasks == []`이다. 웹 보드는 "피드백 및 할 일" / "사람 판단 필요" 두 목록만 기본 노출한다.
- 노드 간 통신은 직접 대화, tmux capture/send, CLI ask/send 등 각 노드 판단에 맡긴다.
- 조직도 변경은 사람 소유다. GUI/API/CLI에서 명시 operator 경로(`--operator`, `--operator-override`)로만 수행한다.
- 모든 노드는 조직도, 역할, tmux pane, cwd를 볼 수 있어야 한다. `grove org --json`과 `/api/org`가 이 필드를 노출한다.
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

## 1. 현재 main = 4f3c804 (트리 클린)

머지 완료(스켈레톤 갭):

- **PR-E 역할 프리셋**(2dfc8b2): `src/role-presets.ts`, spawn `--role-preset`, web NodeForm preset select.
- 과거 **PR-F 조직/업무방식 context prepend**(2668c03): `src/context-pack.ts`+`bridge/.../context_pack.py`가 dispatch 전 context를 prepend했다. 현재는 보드 task 중심 통신 모델이 폐기됐고, context pack은 org/pane/cwd 인지 보조로만 해석한다.
- **test coverage**(3518dd9): bridge API + core 단위 + Playwright e2e 스캐폴드. vitest를 `src/**/*.test.ts`로 스코핑(playwright .spec 오실행 해소).
- **slack cold-channel fix**(4f3c804, cherry-pick): cold message.channels 게이팅. **단 아래 버그가 남아 재수정 중 — 이 커밋만으론 봇 켜면 안 됨.**

## 2. 진행 중 (in-flight)

- **slack 재수정 (긴급, 봇 OFF 유지)**: orch-slack(dev10:19, feat/slack worktree). 버그=`slack.py:790 _has_assistant_thread`+`:854 if is_assistant_thread:_handle_chat` → 봇이 한번 답한 스레드의 모든 후속 메시지(사람끼리 대화 포함)에 또 답함 = 기존 스레드 도배. 수정 지시=engaged-thread 자동응답 완전 제거, 멘션/human-gate/슬래시에서만 발화 + 회귀테스트(엔게이지 스레드 후속 멘션없음→post 0). pnpm check + 멀티리뷰 후에도 **재기동은 사용자 승인**.
- **Wave 2 PR-A(계층 코어저장)+PR-B(cwd)**: orch-platform(dev10:18), `~/grove-worktrees/platform` (feat/platform, main 3518dd9 기준). 스펙=`docs/agents/skeleton-gap-implementation.md`. 완료 시 main에 rebase→pnpm check→FF.
- 남은 갭(미발주): PR-C cross-project 통신, PR-D terminate 소유권, PR-G lead SSH, PR-H 가시노드 기본화. 스펙 동일 문서.

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
