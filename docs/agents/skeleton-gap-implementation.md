# GROVE 캐논 스켈레톤 — 갭 구현 발주서 (3-감사 합치)

> 출처: 외부 감사 3인(codex `rev-codex-xcut`, claude `claude`, claude `rev-claude-web`),
> `/tmp/skel_diag_*.txt`. 판정이 3인 모두 일치. 코드 file:line 근거 첨부됨.
> **목표: 어긋난 부분을 하나도 빠짐없이 구현 → 철저한 e2e/API 테스트 → TRUE stable.**

## 캐논 스켈레톤 8항 (기준)

1. 계층: `GROVE MASTER → 각 프로젝트 lead → 프로젝트별(가변) 조직도`.
2. 프로젝트는 자체 tmux 또는 공유 tmux 가능. 단 각 프로젝트의 lead+멤버 노드는 **그 프로젝트 디렉토리(cwd)** 에서 CLI 실행.
3. 노드는 계층과 무관하게 자유 통신. **다른 프로젝트** 노드에게도 질문/지시 가능.
4. 모든 노드는 하위 노드를 자유롭게 고용(spawn), 더 이상 안 쓰면 **본인 하위** 노드를 terminate.
5. 모든 노드는 역할 기재. 역할은 **템플릿(프리셋)** 으로 UI 생성 시 + 노드가 하위 생성 시 주입.
6. 모든 노드는 자기 역할 + GROVE 조직도 + 업무방식을 **항상** 인지(베이스 MD에 강하게). 그리고 **노드가 다른 노드에 task를 던질 때 task 내용만이 아니라 GROVE 업무방식 + 조직도를 항상 덧붙임**.
7. 사람은 Slack/웹 UI로 MASTER와 대화. 필요 시 각 프로젝트 lead 터미널에 SSH로 직접 대화.
8. (원아이디어) 은닉 서브에이전트 생성/삭제가 아니라, 역할+기억 유지되는 **지속 세션**이 업무를 주고받음.

---

## 판정 요약 (3-감사 합치)

| 항  | 영역                 | 판정                                                                                                                                                                                         |
| --- | -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A   | 계층/조직도          | ⚠️ 부분 — MASTER→lead→org가 /api/org 합성에만 존재, 코어 registry 미저장. `grove org`엔 계층 없음. lead가 합성 meta.                                                                         |
| B   | 프로젝트 cwd         | ⚠️ 부분/결함 — CLI는 OK. **웹 노드생성 `--cwd` 누락**, spawn `findGroveRoot` 폴백이 grove repo 루트로 드리프트, NodeRuntime에 cwd 필드 없음.                                                 |
| C   | cross-project 통신   | ⚠️ 부분 — 프로젝트 내 평면통신 OK. **프로젝트 간 direct send/ask 누락**(단일세션 스코프, `node@project` 주소 없음). 보드 delegate(--session)만 부분 충족.                                    |
| D   | 고용/해고            | ⚠️ 부분 — spawn 자유 OK. **terminate 소유권 미강제**(despawn이 caller/parent 무검사, --group/--all 임의 종료). **웹 terminate 엔드포인트 부재.**                                             |
| E   | 역할 템플릿          | ❌ 누락 — role은 free-text 라벨뿐. 프리셋/템플릿 라이브러리 전무.                                                                                                                            |
| F   | 조직인지 + task 첨부 | ❌ 누락(MAJOR) — dispatch(delegate/send/pull_executor)가 조직도/업무방식 **자동첨부 전무**. 베이스 MD도 부분/모순(AGENTS.md stream-scoped·read-only가 캐논 자유통신과 상충). CLAUDE.md 없음. |
| G   | 사람↔MASTER+SSH      | ⚠️ 부분 — Slack/웹 MASTER ✅. **lead SSH는 로컬 `tmux attach` 문자열 copy뿐**(ssh user@host 미생성), lead가 합성 meta라 connect 404. master-chat이 read도 operator-gated.                    |
| H   | 지속세션(은닉 아님)  | ⚠️ 대부분 OK. 단 assistant.py 직접 API 클라이언트(키 set 시)는 비가시 경로 → node-routed만 프로덕션 기본으로.                                                                                |

**리뷰어 합치 우선순위: ① F (조직/업무방식 task 자동첨부 + 영속 인지) ② E (역할 프리셋) ③ A+B+C (프로젝트 경계 모델).**

---

## 갭별 구현 지시 (file:line 근거 → 방향)

### PR-A 계층을 코어에 저장 (owner: orch-platform)

- `src/commands/new-project.ts`·`init.ts`: 새 세션 registry.json에 **실 lead 노드(parent:"")** 기록. 공유 `grove-master`를 cross-project 레지스트리(`~/.grove/.master/`)에 1회 기록.
- `bridge/.../web_app.py:7506-7543, 7599-7619, 7903-7916`: `_org_graph_parent`/`_external_lead_node` 합성을 **검증**으로 격하(레지스트리 권위). project-master.parent 하드코딩(`:7156` =lead) 제거 → 명시 parent.
- `web_app.py:7919-7930` **dead code `_org_parent` 제거**(호출처 0, `_org_graph_parent`만 사용).
- 단일프로젝트 `_org_payload(:7777)` vs cross-project `_org_graph_records(:7480)` **하나의 빌더로 통합**.
- `src/commands/org.ts buildOrg`가 동일 계층(MASTER/lead) 반영.

### PR-B 프로젝트 cwd 정확성 (owner: orch-platform)

- `src/registry.ts NodeRuntime`: **`cwd` 필드 추가** + spawn/registerExisting에서 persist. `src/context.ts`가 registry.cwd 우선 복원.
- `src/commands/spawn.ts:106-119`: cwd 우선순위 `input.cwd > registry.cwd(per-project) > project-dir > process.cwd`. **`findGroveRoot` 설치루트 폴백 제거/최후순위.**
- `bridge/.../web_app.py _spawn_node`: `args += ["--cwd", workspace]`. `NodeCreatePayload`에 cwd/workspace 필드(또는 서버가 `_project_workspace`로 도출).
- adoption(`src/ops.ts:494-497`) 시 `pane_current_path` 검증.

### PR-C cross-project direct 통신 (owner: orch-master)

- `src/commands/send.ts`·`ask.ts`·`gather.ts`: **`--project` 추가** → `loadRegistry(project)`로 외부 NodeCtx(외부 registry tmux_pane은 절대주소). 노드 주소 문법 `[project:]node`.
- `bridge/.../web_app.py`: `X-Grove-Target-Project` 헤더(감사는 호출 프로젝트 귀속, 노드 조회·send만 타깃). task assignee를 project-qualified 허용(`:7433-7444`).
- 스킬/`init.ts:38-61` 문구: 계층은 소유/조직용이지 통신제약 아님으로 정정.

### PR-D 고용/해고 소유권 (owner: orch-platform)

- `src/commands/despawn.ts:82-103`: `--caller` 추가, `registry.nodes[target].parent === caller` 강제(본인 하위만). 명시적 operator override 별도.
- `bridge/.../web_app.py`: **노드 terminate 엔드포인트 신설**(node-auth 또는 operator, subtree 검사 + 2단계 confirm + audit).
- `web/src/components/OrgChart.tsx`: terminate UI(확인 다이얼로그).

### PR-E 역할 프리셋 (owner: orch-gui)

- **신설 `src/role-presets.ts`**: 노드 타입별 페르소나 본문(lead/sub-orch/maker-py/maker-fe/reviewer/qa/test/docs 등) 카탈로그. 키→본문 확장.
- `src/commands/spawn.ts`: `--role-preset <type>` → 본문 확장해 `ops.ts:421 submitMessage`로 주입(자유 override 허용). 하위 spawn 동일 해석. preset id/version persist.
- `bridge/.../web_app.py`: NodeCreatePayload preset passthrough.
- `web/src/components/OrgChart.tsx NodeForm`: role을 **프리셋 select + preview + editable**로.

### PR-F 조직인지 + task 컨텍스트 자동첨부 (owner: orch-master) **[MAJOR]**

- **신설 공용 "grove context pack" 빌더**(예 `src/context-pack.ts` + bridge 대응): 호출노드 정체성 + 프로젝트 + 프로젝트 lead + 보이는 조직 요약 + 통신규약 + task 프로토콜 + 타깃 역할. size-cap + redaction(assistant facts-pack 패턴 재사용).
- 모든 dispatch에 자동 prepend: `src/commands/delegate.ts:218-225`(payload), `src/commands/send.ts:53`→`ops.ts:212`, `bridge/.../pull_executor.py:734-755 build_task_prompt`, `web_app.py create_task`.
- 베이스 MD 강화: `AGENTS.md`에 "기동 시 `grove org --json`로 자기 정체성 블록 고정" 강제 섹션 + **`CLAUDE.md` 신설**(역할+조직+업무방식 강하게). 캐논과 **모순 제거**: AGENTS.md `:16` "Makers scoped"·`:17` "Reviewers read-only"를 자유통신·자유spawn과 정합화.
- 스킬: `grove-task-only-comms` 신설(직접 API 우회 시에도 규약 명시).

### PR-G 사람↔lead SSH/터미널 (owner: orch-product)

- `web_app.py _node_connect_payload(:8104-8111)`: 로컬 `tmux attach`만 → **`ssh <host> "tmux attach -t <session>; select-pane"`** 형태 추가(호스트 메타 필요). 최소한 UI 라벨 "로컬 tmux attach"로 정정.
- lead를 **실 tmux 노드**로(`_external_lead_node` 폐기, registry에 실 pane). `web_app.py:7969-7971` pane(0,0) 입력거부 정책에 **안전한 직결 human→lead 경로**(operator confirm/SSH-only) 추가.
- `web_app.py:1410-1413` master-chat: **read-only/factual turn과 mutation confirm 분리**(뷰어도 사실질문 가능하게, 제품의도면).

### PR-H 가시 노드 기본화 (owner: orch-product)

- `assistant.py:198-255, 839-844`: direct Anthropic API 모드를 **명시 test/dev 폴백**으로 강등(상태 disclosure), node-routed가 유일 프로덕션 기본.
- default assignee가 합성 meta(project-master) 대신 **실 지속 노드**를 가리키도록(`web_app.py:7383-7394, 7887-7899`).

---

## 발주 규약 (캐논 item 6 — 본 발주서 자체가 모델링)

모든 워커 dispatch에는 **GROVE 업무방식 요약 + 현재 조직도 + 타깃 역할**을 task 내용과 함께 첨부한다.

- 게이트: 코드 변경 최종 게이트 `pnpm check`. PR-별 검증(아래) 통과 전 done 금지.
- 충돌방지: 공통 파일(web_app.py·ops.ts·registry.ts·context.ts) 동시편집 회피 → 본 발주서의 웨이브 순서 준수. worktree 격리 가능 PR은 격리.
- 상태: 노드 self-status(ready→running→review→done), 질문은 task body, 답변은 `ANSWER:` 댓글.
- 라이브 보호: dev10 흐름·세션 비파괴, 게시 history 비재작성, web 단일인스턴스 재배포.

## 검증 (PR별)

- A: `grove org`(CLI)·`/api/org` 모두 `MASTER→lead→nodes` 동일 계층. 새 프로젝트 생성 시 registry에 실 lead(parent:"") 기록.
- B: 웹 생성 노드 cwd=프로젝트 dir. grove repo 내부 `grove spawn`이 프로젝트 dir 유지. 재로드 후 cwd 보존.
- C: `grove ask <projB:node> "..."` 동작. 웹에서 타 프로젝트 노드 send.
- D: 비소유 노드 despawn 거부. 웹 terminate(confirm) 동작 + audit.
- E: 프리셋 select로 생성→해당 페르소나 본문 첫턴 주입. 하위 spawn 동일.
- F: send/delegate/executor 모든 dispatch에 조직+업무방식 prepend 확인. AGENTS.md/CLAUDE.md 모순 제거.
- G: connect가 ssh 형태 제공(or 라벨 정정). lead 직결 경로. master-chat read/write 분리.
- H: 키 set 환경에서도 node-routed 기본. default assignee=실 노드.
- 전 PR: `pnpm check` green + 해당 e2e/API 테스트 추가.
