# grove delegate 설계

상태: v1.3 설계안. 구현은 후속 작업에서 진행한다.

## 근거 맵

- CLI subcommand 등록은 `src/cli.ts`의 commander 구조에 붙인다. 현재 `spawn`, `send`, `ask` 등록 패턴은 `src/cli.ts:93`부터 `src/cli.ts:156`까지다.
- node와 session 검증은 registry/org 모델을 따른다. runtime registry는 `src/registry.ts:32`, 저장 위치 유틸은 `src/util/paths.ts:7`부터 `src/util/paths.ts:57`까지다.
- dashboard token은 bridge web config가 `~/.grove/<session>/dashboard-token`에서 만들고 읽는다. 경로와 생성은 `bridge/src/grove_bridge/web_app.py:564`부터 `bridge/src/grove_bridge/web_app.py:588`까지다.
- board task 생성 HTTP endpoint는 `POST /api/boards/{board_id}/tasks`이고, payload는 `title`, `body`, `assignee`, `status`, `priority`를 받는다. 근거는 `bridge/src/grove_bridge/web_app.py:123`부터 `bridge/src/grove_bridge/web_app.py:128`, endpoint는 `bridge/src/grove_bridge/web_app.py:303`부터 `bridge/src/grove_bridge/web_app.py:322`까지다.
- store의 실제 task 생성은 `create_task(board, title, body, assignee, status, priority, workspace_*, created_by, metadata)`다. 근거는 `bridge/src/grove_bridge/store.py:171`부터 `bridge/src/grove_bridge/store.py:224`까지다.
- pull executor는 ready task를 assignee별로 찾고 claim한 뒤 node에 실행시킨다. scan/claim은 `bridge/src/grove_bridge/pull_executor.py:166`부터 `bridge/src/grove_bridge/pull_executor.py:205`, 실행/complete는 `bridge/src/grove_bridge/pull_executor.py:213`부터 `bridge/src/grove_bridge/pull_executor.py:280`까지다.
- executor가 node lane을 만드는 기준은 registry의 pane 있는 node다. 근거는 `bridge/src/grove_bridge/pull_executor.py:392`부터 `bridge/src/grove_bridge/pull_executor.py:429`, registry node 추출은 `bridge/src/grove_bridge/pull_executor.py:432`부터 `bridge/src/grove_bridge/pull_executor.py:452`까지다.
- 기존 skill은 오래 남는 위임을 board task로 만들고 `ask/send`와 구분한다. 근거는 `skills-src/grove-delegate/SKILL.md:8`부터 `skills-src/grove-delegate/SKILL.md:35`까지다.

## 명령 spec

```bash
grove delegate <node> "<title>" [--body <text>] [--board <board>] [--session <session>] [--json]
```

의미:

- `<node>`는 위임받을 persistent grove node 이름이다.
- `<title>`은 board task title이다. CLI 구현은 기존 `send`/`ask`처럼 variadic title을 받아 quote 실수를 줄일 수 있다.
- `--body <text>`는 task body다. 목표, 범위, 금지 파일, workspace, 검증 명령, 보고 형식을 넣는 곳이다.
- `--board <board>` 기본값은 `default`다. project header와 함께 보낼 때 현재 bridge는 `default`, `main`, `<session>`을 session board로 해석한다.
- `--session <session>`은 대상 grove room/session이다. 생략하면 현재 `grove.yaml`의 `session`, 그 다음 `GROVE_VIEWER_SESSION`, 마지막으로 `dev10`을 사용한다.
- `--json`은 생성된 task payload를 그대로 출력한다. text 출력은 `delegated <task_id> -> <node> on <board>` 정도로 짧게 둔다.

HTTP 요청 형태:

```http
POST /api/boards/{board}/tasks
X-Grove-Session-Token: <token>
X-Grove-Project: <session>
Origin: <base-url>

{
  "title": "...",
  "body": "...",
  "assignee": "<node>",
  "status": "ready",
  "priority": 0
}
```

`Origin`은 loopback에서는 없어도 현재 gate를 통과하지만, CLI는 항상 base URL을 넣어 브라우저/remote 검증과 같은 모양을 유지한다. 현재 state-change gate는 token 뒤 Host/Origin을 확인한다.

## 통합 경로 비교

| 경로                                 | 장점                                                                                                                                                                                            | 단점                                                                                                                                                          | 판단                                                                                               |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| TS CLI가 local grove-web에 HTTP POST | dashboard와 같은 public API를 사용한다. task.created event, project scoping, 현재 token gate, 향후 team-auth/audit와 자연스럽게 붙는다. Node 20 global `fetch`를 쓰면 새 npm dependency가 없다. | grove-web이 실행 중이어야 한다. CLI가 URL/port/token을 찾아야 한다. 현재 endpoint가 metadata/workspace/created_by를 받지 않아 v1.3 MVP는 title/body 중심이다. | **권장 1차 경로**. control plane 단일화를 위해 이 경로로 구현한다.                                 |
| TS CLI가 bridge subprocess 호출      | web 서버 없이 task를 만들 수 있다. Python store의 schema/event 구현을 재사용한다.                                                                                                               | `uv`/bridge 환경에 CLI가 강하게 묶인다. subprocess 실패/속도가 나빠진다. web auth/audit/project contract를 우회한다. 별도 task-create CLI가 현재 없다.        | v1.3 fallback으로 넣지 않는다. 나중에 offline mode가 필요하면 bridge 쪽 공식 helper를 먼저 만든다. |
| TS CLI가 sqlite store 직접 쓰기      | web 서버와 Python 런타임이 필요 없다.                                                                                                                                                           | TS에 sqlite dependency와 Python store schema/event 로직을 복제해야 한다. migration, event, board slug, metadata 정합성이 깨지기 쉽고 auth/audit를 우회한다.   | 배제한다. board store의 유일 writer contract를 깨뜨린다.                                           |

권장안: v1.3 MVP는 HTTP POST만 지원하고, grove-web이 없으면 명확한 오류를 낸다. “서버가 없으면 DB에 몰래 쓰는” fallback은 만들지 않는다. 위임 기록을 남기려면 control plane이 떠 있어야 한다는 운영 전제를 명확히 한다. 이후 `grove room start`가 web/executor를 같이 띄우면 이 단점은 줄어든다.

## 토큰/URL 해석

CLI discovery 순서:

1. `--url <url>`은 v1.3 spec에는 넣지 않지만 테스트 seam과 future escape hatch로 내부 함수는 URL override를 받게 한다.
2. `GROVE_WEB_URL`이 있으면 우선 사용한다.
3. `~/.grove/<session>/web.json`을 읽는다. 이 파일은 후속 web 구현에서 startup 시 작성하는 runtime registry로 설계한다.
4. 없으면 `http://127.0.0.1:8765`를 기본 후보로 probe한다.
5. probe는 `/api/health` public endpoint로 서버 생존을 보고, `/api/org`를 token과 project header로 호출해 올바른 session인지 확인한다.

`web.json` 제안 schema:

```json
{
  "url": "http://127.0.0.1:8765",
  "host": "127.0.0.1",
  "port": 8765,
  "session": "dev10",
  "pid": 12345,
  "started_at": "2026-06-04T00:00:00.000Z",
  "token_path": "~/.grove/dev10/dashboard-token"
}
```

Token discovery:

1. `GROVE_SESSION_TOKEN`이 있으면 사용한다.
2. 아니면 `~/.grove/<session>/dashboard-token`을 읽는다.
3. token 파일이 없으면 “grove-web을 먼저 시작하라”는 오류를 낸다.

현재 bridge web은 port registry를 쓰지 않으므로 v1.3 구현에는 web startup에서 `web.json` 쓰기까지 포함하는 편이 좋다. 다만 이 문서의 구현 범위는 delegate command 설계이며, 실제 파일 쓰기는 web 후속 작업이다.

## 실행 흐름

1. Orchestrator가 `grove delegate maker-1 "Fix auth test" --body "...검증: pnpm test..." --session dev10`을 실행한다.
2. CLI가 session을 결정하고 token/URL을 찾는다.
3. CLI가 `/api/org`로 node 목록을 읽어 `<node>`가 존재하는지 확인한다. 현재 org endpoint는 `bridge/src/grove_bridge/web_app.py:388`부터 `bridge/src/grove_bridge/web_app.py:391`까지다.
4. CLI가 `POST /api/boards/{board}/tasks`에 `assignee=<node>`, `status=ready`로 task를 만든다.
5. dashboard board는 `task.created` event를 통해 위임 기록을 보여준다.
6. pull executor가 실행 중이면 board와 assignee lane을 scan하고 claim한다.
7. executor는 task body와 환경 값을 prompt로 만들어 해당 grove node에 `grove ask`를 실행한다. 환경 키는 `GROVE_BOARD_TASK`, `GROVE_BOARD_RUN_ID`, `GROVE_BOARD_BOARD`, `GROVE_BOARD_WORKSPACE`, `GROVE_BOARD_ASSIGNEE`, `GROVE_BOARD_CLAIM_LOCK`, `GROVE_BOARD_DB` 등이다.
8. 성공하면 `complete`, 실패하면 `block`으로 board에 결과가 남는다.
9. executor가 꺼져 있거나 해당 node lane이 없으면 task는 `ready`로 남아 가시적인 위임 기록이 된다.

## 엣지와 정책

- **board 해석**: MVP는 project-scoped board를 기본으로 한다. `--board` 생략 또는 `default`는 `<session>` board로 해석된다. 현재 bridge는 project header가 있을 때 임의 board slug를 거부하므로, custom board 지원은 bridge `_resolve_board_id` 확장 후에 허용한다.
- **node 검증**: CLI는 `/api/org` 결과에 `<node>`가 없으면 task를 만들지 않는다. registry에는 있지만 pane이 없으면 org에 안 나올 수 있으므로, 그 경우 사용자는 먼저 `grove rebind` 또는 `grove spawn`을 해야 한다.
- **executor 미실행**: 오류가 아니다. delegate command의 책임은 ready task 생성까지다. 실행 여부는 pull executor/health surface가 보여준다.
- **grove-web 미실행**: MVP는 실패한다. 오류에는 시도한 URL, session, 기대 token path, 시작 예시를 포함한다. DB 직접 fallback은 금지한다.
- **권한**: 현재 local-token 모델에서는 “누가 누구에게”를 강제할 identity가 부족하다. v1.3 MVP는 target node 존재만 검증하고, parent-child 규약은 `grove:delegate` skill과 org 확인에 맡긴다. team-auth 이후에는 `member role`과 `from_node`를 audit에 묶는다.
- **자식 제한**: 후속 옵션으로 `--from <node>` 또는 `GROVE_CURRENT_NODE`를 도입하면 `<node>`가 `from_node.children`에 있는지 강제할 수 있다. 이 spec에는 넣지 않는다.
- **중복 위임**: 같은 title/body 중복은 허용한다. board task id가 원장 역할을 한다.
- **body 길이**: 현재 endpoint body max는 20,000자다. 긴 spec은 v1.3 이후 `--body-file` 또는 artifact link로 확장한다.
- **metadata/workspace**: store는 metadata/workspace 필드를 갖고 있지만 현재 HTTP create payload는 받지 않는다. MVP는 body에 workspace를 명시한다. 후속으로 `metadata`, `workspace_kind`, `workspace_path`, `created_by`를 endpoint에 추가하면 delegate가 더 구조화된다.

## grove:delegate 스킬 정합

스킬은 “짧은 대화는 ask, durable work는 board task”라는 사용 규약이다. `grove delegate`는 이 규약의 구현 명령이다.

- `grove ask <node> "<question>"`: 짧은 질의, durable tracking 없음.
- `grove send` + `grove wait`: interactive exchange, durable task 원장 없음.
- `grove delegate <node> "<title>" --body "<spec>"`: 구현/검증/리뷰/멀티스텝/재시작 내구성이 필요한 위임.

스킬 문서의 task spec 항목은 `--body`에 그대로 들어간다. 명령은 skill을 대체하지 않고, skill이 권장한 board operation을 안전한 CLI로 감싼다.

## grove-ts 구현 노트

- `src/commands/delegate.ts`를 새로 만들고, `cmdDelegate(node, title, opts, deps)` 형태로 구현한다. deps에는 `fetch`, `readFile`, `exists`, `now`를 주입해 unit test를 쉽게 한다.
- `src/cli.ts`에는 `cmdDelegate` import와 `.command("delegate <node> <title...>")`를 추가한다. title은 `rawVariadicMessage`를 재사용한다.
- node/session 이름은 `validateGroveName`을 사용한다. `--board`도 같은 name validator를 쓰되, custom board policy는 위 edge 규칙을 따른다.
- session default는 config가 있으면 `loadConfig(...).config.session`, 없으면 `GROVE_VIEWER_SESSION`, 마지막으로 `dev10`이다. command가 board 작업만 하므로 config 파일 부재 자체를 hard error로 만들지 않는다.
- HTTP client는 Node 20 global `fetch`를 사용한다. `package.json`은 이미 `node >=20`을 요구하므로 새 dependency가 필요 없다.
- API request header는 `X-Grove-Session-Token`, `X-Grove-Project`, `Origin`, `Content-Type: application/json`을 사용한다.
- 성공 JSON은 web endpoint의 task payload를 그대로 pass-through한다. text render는 id/title/assignee/status/board/session만 출력한다.
- 테스트는 `delegate.test.ts`에서 token path discovery, web.json discovery, default port fallback, org node missing, POST payload, non-2xx error formatting, `--json` rendering을 다룬다. CLI help smoke는 기존 `src/cli.test.ts` 패턴에 한 줄 추가한다.
- bridge 쪽 후속 테스트는 `POST /api/boards/{id}/tasks`가 `assignee`를 저장하고 board WS event가 흐르는지 이미 있는 web/store 테스트 위에 delegate e2e를 얹는다.
