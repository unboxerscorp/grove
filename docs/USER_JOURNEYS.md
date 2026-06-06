# grove 사용자 여정 (User Journeys) — v1.1

> Status: historical v1.1 coverage map. Do not use this file as the current
> product model. Current grove uses direct node communication, a human-facing
> list for operator TODO/feedback/ask-human records, concrete project lead nodes,
> and a shared host tmux session such as `dev10`. Legacy terms below such as
> board/task/delegation describe old API/test names or historical journeys, not a
> required node-to-node protocol.

로컬 dev-room 제품 **grove**의 대표 사용자 여정을 기록하고, 각 여정을 자동 테스트가 어디까지
커버하는지(또는 신규 테스트가 필요한지)를 환류하기 위한 문서다. 코드는 수정하지 않는다.

## 목적

- 제품을 "기능 목록"이 아니라 "사람이 끝까지 해내는 흐름"으로 본다.
- 각 단계가 **자동 테스트로 보장되는지** 매핑해, 회귀 위험과 테스트 공백을 드러낸다.
- 문서 끝의 **신규 테스트 필요(백로그)** 를 다음 테스트 패스의 입력으로 쓴다.

## 테스트 자산 개요

| 자산              | 종류                          | 무엇을 검증하나                                                                                                                                                                                                                                                                                                                               |
| ----------------- | ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `web/verify.mjs`  | 헤드리스 UI E2E (mock 백엔드) | SPA 렌더·상호작용 전체: 보드/태스크/드로어/보드 라이브(claim→running→done)/조직도 드래그·그룹·detach·hover-+·info·description/터미널 미러/Slack/인증 패널/프로젝트 스위처/WS 프로젝트 바인딩/i18n                                                                                                                                             |
| `web/e2e/api.mjs` | 실 백엔드 HTTP·WS 계약 E2E    | 인증 게이팅(401), `/api/status`·`auth-status`·`projects`·`boards` 프로젝트 스코프, 경로 traversal/미존재 거부, ws-ticket 단발·프로젝트 바인딩, board WS ticket 필터/누락 거부, 비밀 미노출 스캔                                                                                                                                               |
| `bridge/tests/*`  | 백엔드 단위·통합 (pytest)     | web_app(스코프·노드 CRUD·reparent/cycle·ws-ticket·터미널 allowlist/injection/프레임·board WS tail), pull_executor(claim→complete·block→notify·lease 상실), store(CAS·heartbeat·release-stale·의존성), slack(manifest/config/threads·human-gate 스레드 답글·chat 라우팅·status probe), auth_status(cli/env/file·cloudflare keychain), notifier |
| `src/*.test.ts`   | CLI 단위 (vitest)             | new-project·load-project·org·spawn·send·rebind(transcript 재바인딩)·bringup-registry·tmux(detached pane)·fanin·events(durable JSONL)·watch·serve(SSE facade·sticky session)·project-file 스키마·argv/paths                                                                                                                                    |

**상태 범례:** `covered` = 기존 테스트가 충분히 커버 · `partial` = 일부만 커버(보완 권장) · `needs-test` = 신규 테스트 필요 · `N/A` = 현재 제품 범위 밖(백로그 제품화 후 테스트).

---

## 여정 1 — 솔로 개발자: 0에서 완료까지

- **페르소나:** 혼자 사이드 프로젝트를 모는 개발자.
- **목표:** 새 프로젝트를 만들고, 에이전트 노드를 하나 띄워, 태스크를 위임하고, 그 노드의 터미널을 실시간으로 보며 완료를 확인한다.
- **흐름:** 스위처에서 "새 프로젝트" → 조직도에서 노드 추가 → 노드/보드에서 태스크 부여 → 노드 선택 후 터미널 라이브 관찰 → 보드에서 ready→running→done 이동 확인.
- **화면에서 보는 것:** 헤더의 프로젝트 스위처(상태 dot), 조직도 캔버스의 새 노드 카드, 보드의 태스크 카드, 터미널 패널의 라이브 스트림(LIVE), 보드 카드의 컬럼 이동.
- **성공 기준:** 프로젝트가 생성·선택되고, 노드가 조직도에 영구적으로 나타나며, 위임한 태스크가 해당 노드에서 실행되어 done으로 이동, 터미널에 출력이 흐른다.

| 단계                | 화면                                  | 성공 기준                                                       | 커버 테스트                                                                                                                                                          | 상태                |
| ------------------- | ------------------------------------- | --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| 새 프로젝트 생성    | 스위처 → "새 프로젝트" 모달           | `POST /api/projects` 성공, 그 프로젝트로 전환                   | `web/verify.mjs`(projAfterNew), `bridge::test_create_project_invokes_new_project_with_literal_argv`, `src/commands/new-project.test.ts`, `web/e2e/api.mjs`(projects) | covered             |
| 노드 추가           | 조직도 hover-+ / "노드 추가"          | `POST /api/nodes`(이름/agent/role/description)로 노드 생성·표시 | `web/verify.mjs`(plusCreated, plusDesc), `bridge::test_create_node_invokes_spawn_with_literal_argv`, `src/commands/spawn.test.ts`                                    | covered             |
| 태스크 위임         | 노드 드로어 "작업 부여" / 보드 "추가" | `POST /api/boards/{id}/tasks`(assignee=노드)                    | `web/verify.mjs`(addOk, assignedAssignee), `bridge::test_rest_creates_task_on_board`                                                                                 | covered             |
| 위임된 작업 실행    | (백엔드) 노드가 태스크 claim          | assignee 노드가 claim→실행→완료                                 | `bridge::test_run_once_claims_assignee_node_task_and_completes_with_grove_metadata`, `bridge::test_claim_next_has_one_cas_winner_for_concurrent_claims`              | covered             |
| 터미널 라이브 관찰  | 노드 선택 → 터미널 패널               | ws-ticket→`/ws/terminal` 프레임이 xterm에 흐름                  | `web/verify.mjs`(터미널 미러, termChars/markerCount), `bridge::test_terminal_streams_worker_pane_frame`                                                              | covered             |
| 완료 확인           | 보드 라이브                           | 카드가 ready→running→done 이동, 라이브 spark 점등               | `web/verify.mjs`(boardLiveOk: claimColBefore=ready→running→done), `bridge::test_heartbeat_complete_and_block_require_current_run_and_claim`                          | covered             |
| 생성 직후 빈 조직도 | 신규 프로젝트로 전환 직후             | 새(빈) 프로젝트로 조직도/보드가 재로드                          | — (전환 이름만 검증, 빈 컨텍스트 재로드 미검증)                                                                                                                      | **needs-test (N1)** |

---

## 여정 2 — 팀 리드: 조직도를 직접 빚고 추적

- **페르소나:** 여러 에이전트를 지휘하는 팀 리드.
- **목표:** 드래그로 상하 위계와 토론 그룹을 구성하고, 노드에 태스크를 배정한 뒤 보드에서 진행을 추적한다.
- **흐름:** 조직도에서 노드를 다른 노드 위로 드롭(자식화) / 근처로 끌어 그룹화 / 그룹 밖으로 빼 해제 / 연결선 ✕로 부모 끊기 → 각 노드에 태스크 배정 → 보드에서 컬럼별 진행 관찰.
- **화면에서 보는 것:** 베지어 연결선, 드래그 중 의도 배지("…의 하위로" / "…와 같은 그룹"), 그룹 색상 클러스터+범례, 보드 컬럼.
- **성공 기준:** 드래그 한 번이 정확히 reparent/group/ungroup/detach로 반영(순환은 거부), 배정 태스크가 보드에 보인다.

| 단계                     | 화면                        | 성공 기준                                                | 커버 테스트                                                                                                                                   | 상태                 |
| ------------------------ | --------------------------- | -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- |
| 드래그로 reparent        | 조직도 캔버스               | 대상 위 드롭→`PATCH /api/nodes/{n}{parent}`, 순환은 거부 | `web/verify.mjs`(patchedParent), `bridge::test_update_node_reparents_and_preserves_runtime_fields`, `bridge::test_update_node_rejects_cycles` | covered              |
| 근접 그룹화              | 조직도 캔버스               | 근처 드롭→`PATCH {group}`, 배지 "같은 그룹"              | `web/verify.mjs`(patchedGroup, dragLabelsOk)                                                                                                  | covered              |
| 그룹 이탈                | 조직도 캔버스               | 반경 밖 드롭→`PATCH {group:null}`                        | `web/verify.mjs`(groupExit)                                                                                                                   | covered              |
| 부모 끊기                | 연결선 ✕ / 노드 "부모 끊기" | `PATCH {parent:null}`→root로                             | `web/verify.mjs`(cutAffordance, cutParent), `bridge::test_update_node_can_clear_parent_and_group`                                             | covered              |
| 노드별 태스크 배정       | 노드 드로어                 | assignee=노드명으로 태스크 생성                          | `web/verify.mjs`(assignedAssignee), `bridge::test_rest_creates_task_on_board`                                                                 | covered              |
| 보드에서 추적            | 보드 뷰                     | 컬럼별 카운트·카드, 라이브 갱신                          | `web/verify.mjs`(board, boardLiveOk)                                                                                                          | covered              |
| 그룹 단위 일괄 배정/필터 | (미구현)                    | 그룹 선택→일괄 태스크, 보드 그룹 필터                    | —                                                                                                                                             | **N/A (백로그 N10)** |

---

## 여정 3 — 비개발 이해관계자: 보고 묻고 풀어준다

- **페르소나:** 코드는 모르지만 진행을 보고, 에이전트의 질문에 답해야 하는 PM/디자이너.
- **목표:** 보드만 관찰하다가, 에이전트가 막혀 올린 ask-human 질문을 Slack 스레드 답글로 해소해 작업을 재개시킨다.
- **흐름:** 보드 관찰 → 어떤 태스크가 blocked(사람 대기)로 전환 → Slack 채널에 질문 스레드 게시 → 사람이 스레드에 답글 → 태스크 unblock → 진행 재개.
- **화면에서 보는 것:** 보드의 blocked 컬럼 카드, Slack의 질문 스레드, (재개 후) 카드가 running으로 복귀.
- **성공 기준:** 막힌 태스크가 알림되고, 스레드 답글이 정확한 세션으로 라우팅되어 unblock, 실행이 이어진다.

| 단계                     | 화면            | 성공 기준                                          | 커버 테스트                                                                                                                                        | 상태                |
| ------------------------ | --------------- | -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| 보드 읽기 전용 관찰      | 보드 뷰         | 컬럼/카드 렌더                                     | `web/verify.mjs`(board)                                                                                                                            | covered             |
| ask-human 차단 발생      | (백엔드)        | 실패/대기 태스크가 block + 알림                    | `bridge::test_run_once_blocks_failed_task_and_notifies_after_block`, `bridge::test_human_gate_posts_blocked_task_and_unblocks_on_thread_reply`     | covered             |
| Slack 스레드 답글로 해소 | Slack           | 스레드 답글이 세션으로 라우팅·unblock              | `bridge::test_chat_routing_uses_thread_session_and_posts_response`, `bridge::test_chat_routing_uses_mentioned_node_when_channel_has_no_route`      | covered             |
| 진행 재개                | 보드            | unblock 후 ready→running                           | `bridge::test_dependencies_promote_children_only_after_parents_done_or_force_unblock`, `bridge::test_release_stale_returns_running_tasks_to_ready` | covered             |
| 웹에서 ask-human 가시화  | 보드/Slack 패널 | blocked 카드가 "사람 대기" 표시 + 스레드 링크 노출 | — (웹 UI 없음; `bridge::test_slack_threads_endpoint_lists_task_threads`만 백엔드 커버)                                                             | **needs-test (N2)** |

---

## 여정 4 — 인수인계: 다른 머신/사람이 이어받기

- **페르소나:** 동료의 프로젝트를 자기 머신에서 이어받는 개발자.
- **목표:** 기존 프로젝트를 load해 무결성(복원됨/stale/fresh)을 확인하고 이어서 작업한다.
- **흐름:** 스위처 "기존 프로젝트 불러오기" → 폴더 경로 입력 → 무결성 결과 표시 → 그 프로젝트로 전환 → 작업 지속.
- **화면에서 보는 것:** 불러오기 모달, restored/stale/fresh 색상 버킷 + OK 배지, 전환 후 조직도/보드.
- **성공 기준:** 무결성 결과가 정확히 분류되고, 전환 후 그 프로젝트 컨텍스트로 재스코프된다.

| 단계                   | 화면             | 성공 기준                                   | 커버 테스트                                                                                                                                                 | 상태                              |
| ---------------------- | ---------------- | ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| 불러오기 실행          | 불러오기 모달    | `POST /api/projects/load{path}`→무결성 결과 | `web/verify.mjs`(loadResult buckets/ok), `bridge::test_load_project_invokes_load_project_and_returns_integrity_result`, `src/commands/load-project.test.ts` | covered                           |
| 무결성 분류 표시       | 결과 패널        | restored/stale/fresh 분리 표시              | `web/verify.mjs`(buckets≥3), `src/rebind.test.ts`(전사 rebind 계획)                                                                                         | covered                           |
| 프로젝트 전환·재스코프 | 헤더/조직도/보드 | 전환 후 `X-Grove-Project`로 데이터 재스코프 | `web/verify.mjs`(projAfterLoad, projectHeader), `bridge::test_project_header_scopes_status_org_nodes_boards_and_tasks`                                      | covered                           |
| stale 노드 후속 처리   | (웹 액션 없음)   | stale 노드 rebind 안내/실행 진입점          | — (웹은 표시만; rebind는 CLI `src/rebind.test.ts`)                                                                                                          | **needs-test (N6, 제품 갭 동반)** |

---

## 여정 5 — 멀티 프로젝트 전환

- **페르소나:** 여러 grove를 오가는 개발자.
- **목표:** 스위처로 프로젝트를 바꾸면 조직도·보드·터미널이 그 프로젝트로 재스코프되고 WS도 재연결된다.
- **흐름:** 스위처에서 다른 프로젝트 선택 → 보드/조직도/노드 목록 재로드 → board/terminal WS가 새 프로젝트 ticket으로 재연결.
- **화면에서 보는 것:** 헤더 현재 프로젝트명 변경, 보드/조직도 내용 교체, 라이브 spark 재점등.
- **성공 기준:** REST는 새 프로젝트 헤더로, WS는 새 프로젝트 ticket으로 재연결되어 이전 프로젝트 데이터가 남지 않는다.

| 단계                   | 화면             | 성공 기준                                      | 커버 테스트                                                                                                                                                                         | 상태                               |
| ---------------------- | ---------------- | ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| 프로젝트 목록·전환     | 스위처 드롭다운  | `GET /api/projects` 목록, 선택 시 현재명 변경  | `web/verify.mjs`(projItems, projAfterSwitch), `bridge::test_projects_endpoint_lists_registry_sessions_with_tmux_status`                                                             | covered                            |
| REST 재스코프          | 조직도/보드/노드 | 전환 후 모든 REST에 `X-Grove-Project`          | `web/verify.mjs`(projectHeader), `web/e2e/api.mjs`(스코프), `bridge::test_project_header_*`                                                                                         | covered                            |
| board WS 재연결        | 보드 라이브      | 새 프로젝트 ticket으로 board WS 재연결         | `web/verify.mjs`(wsBindOk: boardWsConnects↑, wsTicketProject), `bridge::test_board_ws_filters_events_by_ticket_project`, `bridge::test_ws_ticket_binds_project_from_request_header` | covered                            |
| in-flight fetch 무효화 | 조직도           | 전환 중 이전 프로젝트 응답이 화면에 안 남음    | (코드: OrgChart per-run `alive` 플래그) — 전환 경합 회귀 테스트 없음                                                                                                                | **partial → needs-test (N1 동반)** |
| terminal WS 재연결     | 터미널           | 전환 후 노드 선택 시 새 프로젝트 ticket로 연결 | — (board WS만 검증; terminal 전환 후 재연결 미검증)                                                                                                                                 | **needs-test (N3)**                |

---

## 여정 6 — 장애 복구

- **페르소나:** tmux가 죽거나 transcript가 어긋난 상황을 수습하는 개발자.
- **목표:** 노드/페인/transcript 유실·tmux kill 후 재기동/재바인딩으로 작업을 지속한다.
- **흐름:** 장애 발생 → 레지스트리 기준 재기동·페인 재바인딩 / 전사(transcript) 재매칭 / 끊긴 lease 회수 → 보드·터미널이 다시 흐름.
- **화면에서 보는 것:** 노드 상태 dot(error/idle), 터미널 패널의 연결 상태(연결 중/재연결/오류), 복구 후 라이브 재개.
- **성공 기준:** 죽은 작업의 lease가 회수되어 ready로 돌아가고, 페인/전사가 안전 규칙으로 재바인딩되며, WS는 폭주 없이 재연결한다.

| 단계                     | 화면        | 성공 기준                                 | 커버 테스트                                                                                                                                                                                                      | 상태                |
| ------------------------ | ----------- | ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| 끊긴 lease 회수          | (백엔드)    | running→ready 복귀, 중복 claim 방지       | `bridge::test_release_stale_returns_running_tasks_to_ready`, `bridge::test_run_once_skips_terminal_writes_when_heartbeat_loses_lease`, `bridge::test_subprocess_runner_aborts_when_heartbeat_reports_lost_lease` | covered             |
| 페인/레지스트리 재바인딩 | (CLI)       | 페인 재타깃, 레지스트리 노드 복구         | `src/rebind.test.ts`, `src/bringup-registry.test.ts`, `src/tmux.test.ts`                                                                                                                                         | covered             |
| transcript 재매칭        | (CLI)       | 모호하면 보수적으로 skip, 유일하면 rebind | `src/rebind.test.ts`(unique 매칭/다중 skip)                                                                                                                                                                      | covered             |
| 변경분만 캡처            | 터미널      | 동일 캡처 프레임은 재전송 안 함           | `bridge::test_terminal_skips_unchanged_capture_frames`                                                                                                                                                           | covered             |
| WS 재연결+지수 백오프    | 보드/터미널 | 소켓 close 시 백오프(상한), 4401은 중단   | (코드: app.tsx board WS 백오프 + 4401 stop, TerminalPane 백오프) — mock이 close를 시뮬레이트 안 해 미검증                                                                                                        | **needs-test (N4)** |
| 터미널 연결상태 전이     | 터미널 패널 | connecting→live→reconnecting→error 표시   | —                                                                                                                                                                                                                | **needs-test (N5)** |

---

## 여정 7 — 인증 셋업

- **페르소나:** 머신을 처음 셋업하는 개발자.
- **목표:** 인증 패널에서 codex/claude/antigravity/gh/cf 인증 상태를 확인하고, 로그인 힌트를 따라 인증한다.
- **흐름:** "인증" 탭 → 도구별 상태 LED·detail 확인 → 미인증 도구의 "로그인"으로 명령 힌트 노출(복사) 또는 URL 새 탭 → 인증 후 "새로고침".
- **화면에서 보는 것:** 도구 행(녹/주황 LED), detail(비밀 없음), 로그인 힌트 명령/링크, 새로고침.
- **성공 기준:** 5개 도구 상태가 정확히 표시되고, 힌트가 안전하게(비밀 미노출) 제공되며, 새로고침이 재조회한다.

| 단계              | 화면      | 성공 기준                                  | 커버 테스트                                                                                                                                            | 상태    |
| ----------------- | --------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ------- |
| 상태 조회·게이팅  | 인증 패널 | 토큰 없으면 401, 있으면 도구 배열          | `web/e2e/api.mjs`(auth-status 401/200), `bridge::test_auth_status_endpoint_is_token_gated_and_returns_tool_array`                                      | covered |
| 5개 도구 LED 표시 | 인증 패널 | authed=녹/미인증=주황, detail 표시         | `web/verify.mjs`(authRows=5, LED ok/warn)                                                                                                              | covered |
| 상태 판정 로직    | (백엔드)  | cli/env/file 상태로 인증 판정, cf keychain | `bridge::test_auth_status_checker_reports_cli_env_and_file_states`, `bridge::test_cloudflare_keychain_check_uses_literal_argv_without_exposing_secret` | covered |
| 로그인 힌트       | 인증 패널 | 명령 힌트 노출·복사 / URL은 새 탭          | `web/verify.mjs`(codexHint="codex login", cfHref=https…)                                                                                               | covered |
| 새로고침          | 인증 패널 | 재조회(언어 토글로는 재조회 안 함)         | `web/verify.mjs`(authStatusFetched≥2)                                                                                                                  | covered |

---

## 여정 8 — Slack 연동 셋업

- **페르소나:** 팀 알림/ask-human을 Slack으로 받으려는 운영자.
- **목표:** manifest로 앱을 만들고, 토큰을 등록하고, 채널↔노드 매핑을 설정한다.
- **흐름:** "연동" 탭 → manifest 다운로드 → Slack에서 앱 생성/설치 → App/Bot 토큰 입력·저장 → 채널·기본 노드 매핑 → 테스트로 소켓 연결 확인.
- **화면에서 보는 것:** 흐름 리본(①~④), 상태 배지(미설정→토큰 저장됨→소켓 연결됨), 토큰 입력/마스킹, 채널·노드 셀렉트.
- **성공 기준:** 토큰 접두사 검증·마스킹, 저장·테스트로 상태 전이, 노드 셀렉트가 현재 프로젝트 노드로 채워진다.

| 단계                | 화면      | 성공 기준                                              | 커버 테스트                                                                                                               | 상태    |
| ------------------- | --------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- | ------- |
| manifest 다운로드   | 연동 패널 | `GET /api/slack/manifest` 파일                         | `web/verify.mjs`(manifestFetched), `bridge::test_slack_manifest_and_config_endpoints`                                     | covered |
| 토큰 입력·검증·저장 | 연동 패널 | xapp-/xoxb- 검증, 마스킹, `POST /api/slack/config`     | `web/verify.mjs`(validationErr, masked 1234/5678, slackCfg), `bridge::test_slack_config_store_validates_and_masks_tokens` | covered |
| 연결 상태·테스트    | 연동 패널 | 상태 전이 not_configured→tokens_saved→socket_connected | `web/verify.mjs`(statusAfterSave, liveAfterTest), `bridge::test_status_probe_reports_bot_auth_ok_for_saved_tokens`        | covered |
| 채널↔노드 매핑      | 연동 패널 | 기본 채널+노드 저장, 노드는 현재 프로젝트 기준         | `web/verify.mjs`(nodeOptions, default_node), (전환 시 재로드: SlackPanel projectTick)                                     | covered |
| 스레드 보기 링크    | 연동 패널 | `GET /api/slack/threads` 진입점                        | `bridge::test_slack_threads_endpoint_lists_task_threads` (웹 렌더 테스트는 N2)                                            | partial |

---

## 여정 9 — 다국어/접근성 (창의 추가)

- **페르소나:** 한/영 혼용 팀, 키보드 사용자.
- **목표:** KO/EN 토글로 모든 UI가 전환되고, 핵심 흐름을 키보드로도 쓸 수 있다.
- **성공 기준:** 토글 시 라벨이 즉시 전환(localStorage 지속), 드래그/캔버스에 키보드 대안·ARIA 제공.

| 단계           | 화면            | 성공 기준                           | 커버 테스트                            | 상태                |
| -------------- | --------------- | ----------------------------------- | -------------------------------------- | ------------------- |
| 언어 토글      | 헤더 KO/EN      | 토글 시 라벨 전환, 새로고침 후 유지 | `web/verify.mjs`(i18nOk: 브랜드 ko/en) | partial             |
| 전체 라벨 전환 | 탭/패널/폼 전반 | 브랜드 외 모든 라벨도 전환 검증     | —                                      | **needs-test (N7)** |
| 키보드 접근성  | 조직도/드로어   | 드래그 대안·포커스·ARIA             | — (lead가 다음 패스로 명시)            | **needs-test (N8)** |

---

## 여정 10 — 보안/세션 경계 (창의 추가)

- **페르소나:** 내부 네트워크에 grove를 띄우는 운영자(내부 서비스도 SSRF/IDOR 표적이 됨).
- **목표:** 토큰 없는 요청은 거부되고, 비밀은 응답/로그에 노출되지 않으며, 프로젝트 경로 주입이 막힌다.
- **성공 기준:** 보호 엔드포인트 401, ws-ticket 단발·만료, 토큰 마스킹, 경로 traversal 거부.

| 단계                  | 화면     | 성공 기준                                          | 커버 테스트                                                                                                                                    | 상태    |
| --------------------- | -------- | -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| 미인증 거부           | (API)    | auth-status/projects/ws-ticket 토큰 없으면 401     | `web/e2e/api.mjs`(401), `bridge::test_*_token_gated`                                                                                           | covered |
| 비밀 미노출           | (API)    | 응답 본문에 토큰/시크릿 없음                       | `web/e2e/api.mjs`(secret 스캔), `bridge::test_slack_config_store_validates_and_masks_tokens`                                                   | covered |
| ws-ticket 단발·바인딩 | (API/WS) | ticket 1회용·만료, 프로젝트 바인딩                 | `web/e2e/api.mjs`(단발/바인딩), `bridge::test_ws_ticket_is_single_use_and_expires`                                                             | covered |
| 경로/페인 주입 차단   | (API/WS) | traversal·미존재 프로젝트·lead-pane·injection 거부 | `web/e2e/api.mjs`(`../etc`/`ghost_proj`), `bridge::test_terminal_rejects_*`, `bridge::test_project_header_rejects_invalid_or_traversal_values` | covered |

---

## 여정 11 — 읽기 전용 터미널 안전성 (창의 추가)

- **페르소나:** 남의 노드를 관찰만 하려는 사용자.
- **목표:** 터미널은 보기 전용이라 실수로도 노드에 키 입력이 전달되지 않는다.
- **성공 기준:** 프런트는 stdin 비활성, 백엔드 터미널 경로는 단방향 캡처만.

| 단계             | 화면        | 성공 기준                             | 커버 테스트                                                       | 상태                |
| ---------------- | ----------- | ------------------------------------- | ----------------------------------------------------------------- | ------------------- |
| 단방향 스트림    | 터미널 패널 | 프레임 수신만, 입력 미전송            | `bridge::test_terminal_streams_worker_pane_frame`(송신 경로 없음) | partial             |
| 프런트 입력 차단 | 터미널 패널 | xterm `disableStdin`로 키 미전달 보장 | —                                                                 | **needs-test (N9)** |

---

## 신규 테스트 필요 / 커버리지 갱신

다음 테스트 패스의 입력. 우선순위는 사용자 영향 기준. `covered` 항목은
이 문서 작성 이후 테스트가 추가되어 백로그에서 닫힌 항목이다.

| ID  | 대상                    | 무엇을 검증                                                                                       | 권장/실제 위치                                                                                   | 우선 | 상태    |
| --- | ----------------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ---- | ------- |
| N1  | 신규/전환 직후 컨텍스트 | 새 프로젝트 생성·전환 직후 조직도/보드가 그 프로젝트(빈 컨텍스트)로 재로드, 이전 데이터 잔존 없음 | `web/verify.mjs` `#N1 project switch re-scope + no residue`                                      | P1   | covered |
| N2  | ask-human 웹 가시화     | blocked/사람대기 카드 표시 + Slack 스레드 링크 렌더                                               | `web/verify.mjs` `#N2`, `web/e2e/live.mjs` inbox journey, `web/e2e/api.mjs` `/api/inbox` journey | P1   | partial |
| N3  | 터미널 WS 재스코프      | 프로젝트 전환 후 노드 선택 시 새 프로젝트 ticket으로 terminal WS 재연결                           | `web/verify.mjs` `wsBindOk`, `web/e2e/api.mjs` ws-ticket project binding                         | P1   | covered |
| N4  | WS 재연결·백오프        | 소켓 close 시 지수 백오프(상한), 4401은 재연결 중단                                               | `web/verify.mjs` `n4Ok` close/reconnect/4401 assertions                                          | P2   | covered |
| N5  | 터미널 상태 전이        | connecting→live→reconnecting→error UI 라벨/LED 전이                                               | `web/verify.mjs` `#N5 terminal connection-state transitions`                                     | P2   | covered |
| N6  | stale 후속 액션         | 무결성 stale 노드에 대한 rebind 진입점(제품화 후 테스트)                                          | `web` + `src/rebind.test.ts` 연계                                                                | P2   | backlog |
| N7  | 전체 i18n               | 브랜드 외 탭/패널/폼 라벨까지 KO/EN 전환 스냅샷                                                   | `web/verify.mjs`                                                                                 | P2   | backlog |
| N8  | 접근성                  | 드래그 키보드 대안·포커스 순서·ARIA(다음 패스)                                                    | `web` a11y                                                                                       | P3   | backlog |
| N9  | 읽기 전용 터미널        | xterm 입력 비전달 보장(키 입력→무전송)                                                            | `web/verify.mjs`                                                                                 | P3   | backlog |
| N10 | 그룹 일괄 작업          | 그룹 단위 일괄 배정/보드 그룹 필터(제품화 후)                                                     | `web` + `bridge`                                                                                 | P3   | backlog |

N2는 blocked/ask-human 카드, inbox API, live inbox answer 흐름은 커버됐지만,
Slack thread link를 drawer에 렌더하는 전용 SPA 표면은 아직 제품화되지 않아 `partial`로 남긴다.
