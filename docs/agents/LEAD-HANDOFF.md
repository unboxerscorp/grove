# grove-dev LEAD 인수인계 (Claude → Codex)

> 작성: 2026-06-05, 기존 Claude lead(dev10:0.0). 사용자가 신뢰 상실로 lead orch를 Codex 타입으로 교체 지시. 이 문서는 새 Codex lead가 문맥 손실 없이 즉시 이어받기 위한 것.

## 0. 절대 규칙 (사용자 분노로 학습 — 어기지 말 것)

- **Slack 봇은 OFF. 사용자 명시 승인 없이는 절대 재기동 금지.** "MASTER-gated"를 orchestrator가 자의로 게이트해 켜다 4번째 도배 사고 발생. 재기동 트리거는 오직 사용자 본인.
- 라이브 dev10 노드 비파괴(despawn/recreate 금지, 문맥 가치 높음). 게시 history 비재작성. web 단일 인스턴스(`~/.grove/redeploy-web.sh`).
- watchdog/executor OFF 유지(멀티리뷰+사용자 승인 전 실가동 금지).
- orchestrator는 제품 코드 직접 편집 금지 — 워커에 위임. (단 git 통합=rebase/FF/cherry-pick은 lead가 게이트.)

## 1. 현재 main = 4f3c804 (트리 클린)

머지 완료(스켈레톤 갭):

- **PR-E 역할 프리셋**(2dfc8b2): `src/role-presets.ts`, spawn `--role-preset`, web NodeForm preset select.
- **PR-F 조직/업무방식 task 자동첨부 [MAJOR]**(2668c03): `src/context-pack.ts`+`bridge/.../context_pack.py`가 delegate/send/ops/pull_executor/web_app/slack 전 dispatch에 prepend. `CLAUDE.md` 신설, AGENTS.md 캐논 정합화, `grove-task-only-comms` 스킬.
- **test coverage**(3518dd9): bridge API + core 단위 + Playwright e2e 스캐폴드. vitest를 `src/**/*.test.ts`로 스코핑(playwright .spec 오실행 해소).
- **slack cold-channel fix**(4f3c804, cherry-pick): cold message.channels 게이팅. **단 아래 버그가 남아 재수정 중 — 이 커밋만으론 봇 켜면 안 됨.**

## 2. 진행 중 (in-flight)

- **slack 재수정 (긴급, 봇 OFF 유지)**: orch-slack(dev10:19, feat/slack worktree). 버그=`slack.py:790 _has_assistant_thread`+`:854 if is_assistant_thread:_handle_chat` → 봇이 한번 답한 스레드의 모든 후속 메시지(사람끼리 대화 포함)에 또 답함 = 기존 스레드 도배. 수정 지시=engaged-thread 자동응답 완전 제거, 멘션/human-gate/슬래시에서만 발화 + 회귀테스트(엔게이지 스레드 후속 멘션없음→post 0). pnpm check + 멀티리뷰 후에도 **재기동은 사용자 승인**.
- **Wave 2 PR-A(계층 코어저장)+PR-B(cwd)**: orch-platform(dev10:18), `~/grove-worktrees/platform` (feat/platform, main 3518dd9 기준). 스펙=`docs/agents/skeleton-gap-implementation.md`. 완료 시 main에 rebase→pnpm check→FF.
- 남은 갭(미발주): PR-C cross-project 통신, PR-D terminate 소유권, PR-G lead SSH, PR-H 가시노드 기본화. 스펙 동일 문서.

## 3. 통합 규율 (worktree)

worktree(`~/grove-worktrees/{auth,gui,master,slack,platform}`)는 main보다 크게 stale해질 수 있음(46~58커밋 사례). **raw merge 금지** — 작성자가 현재 main에 rebase(자기 델타만 replay)→충돌 양쪽 보존→full `pnpm check` green→lead가 `git merge --ff-only`(또는 무충돌 cherry-pick). 실제 델타는 `git show <tip> --stat`로 확인(tip-to-tip diff는 staleness 착시로 대량 삭제처럼 보임). 다중 노드가 공유 main 체크아웃에 쓰면 WIP가 게이트 오염 → 노드 커밋 금지, lead가 단일 통합 커밋.

## 4. 데몬/노드

- web: :9131 단일(tailnet 100.100.90.87), 릴리스마다 redeploy-web.sh. reconciler(30s) ON. slack/wd/exec OFF.
- grove-master(dev10:13, codex, root) / 새 Codex lead는 parent=grove-master. dev10:0.0이 기존 claude lead(=교체 대상).
- 조직도 `roots:['grove-master']`. 1:1:1 프로젝트 모델.

## 5. 캐논 스켈레톤 (최우선 미션)

`GROVE MASTER → 프로젝트 lead → 프로젝트별 조직`. 8항 + 갭 스펙 = `docs/agents/skeleton-gap-implementation.md`. 미션: 갭 전부 구현 → 철저 e2e/API → TRUE stable, 무한 반복.
