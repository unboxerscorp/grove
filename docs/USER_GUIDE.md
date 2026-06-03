# grove 사용자 가이드 v1

grove는 여러 AI CLI 세션을 tmux 안에서 실제로 띄우고, 그 세션들을 보드, 프로젝트, 대시보드, Slack 채널과 연결하는 로컬 cockpit입니다.

중요한 운영 모델은 하나입니다. grove는 중앙 서버가 아닙니다. 각 팀원은 자기 머신에서 자기 `codex`, `claude`, `agy` CLI와 자기 인증으로 실행합니다. 팀 재사용은 공유 가능한 템플릿과 `grove.project.json`으로 합니다. transcript와 CLI session id는 머신 로컬 상태라서 다른 머신으로 그대로 이동하지 않습니다.

## 설치와 온보딩

### 전제 조건

각자 사용할 실행자를 먼저 설치하고 인증합니다.

- AI CLI: `codex`, `claude`, `agy` 중 본인이 쓰는 것. `agy`는 grove의 `antigravity` 에이전트 타입에 대응합니다.
- 터미널 런타임: `tmux`
- TypeScript 런타임: Node.js 20 이상, `pnpm`
- Python bridge: Python 3.11 이상, `uv`
- 선택 도구: `gh`는 `--clone <owner/repo>` 프로젝트 생성과 인증상태 패널에 쓰입니다. Cloudflare 토큰은 인증상태 패널에서 확인만 합니다.

인증은 중앙 계정이 아니라 각자 로컬 계정입니다.

```bash
codex auth status   # 또는 codex login
claude auth status  # 또는 claude login
agy auth status     # 또는 agy를 실행해 OAuth 로그인
gh auth status      # clone 기능을 쓸 때
```

### 로컬 설치

```bash
git clone <repo-url> grove
cd grove
pnpm install
pnpm build
pnpm link --global
grove --help
```

`pnpm link --global`에서 global bin 경로 오류가 나면 `pnpm setup`을 실행하고 쉘을 다시 연 뒤 다시 시도합니다. 글로벌 등록을 하지 않고 확인할 때는 `pnpm build` 후 `node dist/cli.js --help`를 사용할 수 있습니다.

### Python bridge 셋업

```bash
uv sync --project bridge --group dev
uv run --project bridge grove-web --help
```

`grove-web`은 대시보드/API 서버입니다. 정적 dashboard 번들은 `web/dist`에 있어야 합니다. 해당 산출물이 없으면 UI 빌드 담당 lane의 산출물을 먼저 준비합니다.

### 대시보드 실행

프로젝트 세션이 이미 있거나 `grove new-project`로 만든 뒤, 로컬에서 웹 서버를 띄웁니다.

```bash
uv run --project bridge grove-web --host 127.0.0.1 --port 8765 --session dev10
```

브라우저에서 `http://127.0.0.1:8765`에 접속합니다. 서버 프로세스가 생성한 `X-Grove-Session-Token`은 SPA index에 주입되고, REST API 호출에 자동으로 붙습니다.

팀 접근은 나중에 Mac mini와 Tailscale로 묶는 방식이 기준입니다. 인터넷에 직접 공개하지 말고 Tailscale IP 또는 로컬 네트워크 안에서만 열어야 합니다.

### 채널 facade 실행

대시보드와 별개로, OpenAI 호환 chat completions SSE facade가 필요하면 `grove serve`를 사용합니다.

```bash
grove serve lead maker --host 127.0.0.1 --port 8787
```

이 endpoint는 `POST /v1/chat/completions`를 제공하고, `X-Grove-Session-Id`로 sticky 세션을 유지합니다. 대시보드 서버인 `grove-web`과 역할이 다릅니다.

## 프로젝트 플로우

### 새 프로젝트 만들기

`grove new-project`는 새 tmux 세션과 워크스페이스 폴더를 만들고, 템플릿 또는 기본 scaffold로 노드를 spawn합니다.

```bash
grove new-project alpha --template team --json
grove new-project alpha --clone owner/repo --json
grove new-project alpha --dir ~/work/alpha --json
```

기본 폴더는 `~/grove-projects/<name>`입니다. `--clone`은 `gh auth status`가 통과할 때 `gh repo clone <owner/repo> <folder>`를 실행합니다. 인증이 없으면 clone은 건너뛰고 프로젝트 생성은 계속됩니다.

### 프로젝트 파일

프로젝트 루트에는 `grove.project.json`이 저장됩니다.

```json
{
  "name": "alpha",
  "created_at": "2026-06-04T00:00:00.000Z",
  "updated_at": "2026-06-04T00:00:00.000Z",
  "workspace": ".",
  "nodes": [
    {
      "name": "lead",
      "agent": "claude",
      "role": "Lead the alpha project.",
      "description": "프로젝트 조율자",
      "parent": "root",
      "group": "core",
      "session_id": "local-session-id"
    }
  ],
  "board": { "slug": "alpha" }
}
```

`workspace`는 프로젝트 파일 기준 상대경로입니다. 절대경로나 프로젝트 루트 밖으로 나가는 `../` 경로는 `grove load-project`에서 거부됩니다. `session_id`는 로컬 resume을 위한 힌트일 뿐이며, 다른 머신에서는 없는 것이 정상입니다.

### 프로젝트 불러오기

```bash
grove load-project ~/grove-projects/alpha --json
grove load-project ~/grove-projects/alpha/grove.project.json --json
```

`load-project`는 파일을 읽고, workspace 존재 여부와 노드별 로컬 session/transcript 존재 여부를 확인합니다. 로컬 session 파일이 있으면 `restored`, 없으면 `fresh`로 노드를 다시 띄웁니다. 조직도, role, description, parent, group, board slug는 프로젝트 파일에서 복원됩니다.

대시보드의 프로젝트 스위처와 불러오기 UI는 이 명령을 API로 감싼 것입니다. 생성은 `grove new-project --json`, 불러오기는 `grove load-project --json` 결과를 사용합니다.

## 노드와 조직도

노드는 실제 CLI 실행자가 붙어 있는 tmux pane입니다. grove registry는 `~/.grove/<session>/registry.json`에 저장됩니다. 주요 필드는 다음과 같습니다.

- `name`, `agent`: 노드 이름과 실행자 타입. 실행자 타입은 `codex`, `claude`, `antigravity`입니다.
- `role`: 에이전트에 주입하는 역할 프롬프트입니다.
- `description`: 사람이 읽는 짧은 메모입니다. role과 다르게 실행자 지시문이 아니라 대시보드/조직도 표시용입니다.
- `parent`, `children`, `group`: 팀 그래프 필드입니다.
- `sessionId`, `transcript`: 각 CLI의 로컬 session과 transcript 바인딩입니다.
- `tmux_pane`: `<session>:<window>.<pane>` 형식의 전체 tmux target입니다.

노드는 config, spawn, project file 모두에서 만들 수 있습니다.

```yaml
nodes:
  lead:
    agent: claude
    role: "팀 리드"
    description: "요구사항 정리와 위임"
    children: [maker]
    group: core
  maker:
    agent: codex
    role: "TypeScript 구현"
    description: "src/ 변경 담당"
    parent: lead
    group: core
```

```bash
grove spawn --name maker --agent codex --role "TypeScript 구현" \
  --description "src/ 변경 담당" --parent lead --group core --session alpha --json
grove org --json
grove org
```

`grove spawn`은 detached tmux pane을 만들고 특정 target에만 키를 보냅니다. 기존 창 포커스를 바꾸지 않는 것이 계약입니다.

## 보드와 task

보드는 작업을 담는 칸반 컨테이너입니다. 각 보드는 `slug`로 식별되며, 같은 이름을 다시 쓰면 기존 보드를 재사용합니다. 기본 저장소는 SQLite 파일인 `~/.grove/boards/board.db`이고, `grove-web --board-db-path <path>`로 다른 경로를 줄 수 있습니다.

새 task는 REST API, UI, Slack, executor가 같은 store에 기록합니다. task의 주요 값은 `title`, `body`, `assignee`, `status`, `priority`입니다. 기본 status는 `ready`, 기본 priority는 `0`입니다.

칸반 항목의 출처는 보드 store입니다. 데모 데이터, UI/API 생성 task, 채널 인입, executor run/event가 모두 같은 SQLite store에 모입니다.

## executor 글루

executor는 보드의 task와 노드를 연결하는 실행 글루입니다. 흐름은 `claim -> 노드 실행 -> heartbeat -> complete/block`입니다. task의 assignee lane을 executor 설정의 node pool에 매핑하고, claim이 성공한 뒤에만 실제 노드를 획득합니다.

보드는 오케스트레이터에 직접 바인딩되지 않습니다. 어떤 보드와 lane을 어떤 노드에 보낼지는 executor 설정이 결정합니다. 따라서 같은 보드라도 설정을 바꾸면 다른 노드 풀로 실행할 수 있습니다.

실행 중 실패하거나 사람 확인이 필요한 task는 `blocked`가 될 수 있습니다. notifier가 live로 설정된 경우 `needs_human` metadata와 notify subscription이 생기고, Slack ask-human 게이트가 thread를 만들어 사람 답변을 기다립니다.

## 대시보드 데이터 소스

대시보드는 다음 소스를 읽습니다.

- 프로젝트 목록: `~/.grove/*/registry.json`
- 현재 프로젝트 노드: `~/.grove/<session>/registry.json`
- 보드와 task: SQLite board store
- 조직도: registry의 `parent`, `children`, `group`, `role`, `description`
- 터미널: 허용된 `tmux_pane`에 대한 `tmux capture-pane` 읽기 전용 캡처
- 인증상태: bridge의 `collect_auth_status()` 결과
- Slack 설정: `~/.grove/slack.json`

터미널 뷰는 pane을 resize하거나 입력을 보내지 않습니다. registry에 있고 현재 프로젝트에 속한 pane만 캡처합니다. lead pane인 `<session>:0.0`은 노출하지 않습니다.

## 프로젝트별 API와 WebSocket 격리

대시보드 REST API는 `X-Grove-Session-Token`을 요구합니다. SPA는 서버가 주입한 token을 자동으로 사용합니다.

프로젝트를 지정할 때는 `X-Grove-Project: <session>` 헤더를 사용합니다. 이 헤더는 `/api/status`, `/api/boards`, `/api/nodes`, `/api/org`, `/api/ws-ticket` 등에서 현재 프로젝트를 고릅니다.

WebSocket은 직접 프로젝트 헤더를 신뢰하지 않습니다. 먼저 REST로 ticket을 발급받습니다.

```http
POST /api/ws-ticket
X-Grove-Session-Token: <token>
X-Grove-Project: alpha
```

서버는 30초짜리 1회용 ticket을 발급하고, 그 ticket 안에 프로젝트를 묶습니다. 터미널 WebSocket은 `/ws/terminal?ticket=<ticket>&pane_id=<session>:<window>.<pane>` 형식입니다. 보드 WebSocket은 `/ws/board?ticket=<ticket>&cursor=<cursor>` 형식입니다. ticket이 묶인 프로젝트 밖의 pane이나 board event는 전달되지 않습니다.

## Slack 연동

Slack 설정은 대시보드 API에서 다룹니다.

- `GET /api/slack/manifest`: Slack app manifest를 내려받습니다.
- `POST /api/slack/config`: Socket Mode app token(`xapp-...`)과 bot token(`xoxb-...`)을 저장합니다.
- `GET /api/slack/config/status`: 토큰 저장 상태를 확인합니다.
- `GET /api/slack/threads`: task와 연결된 Slack thread를 조회합니다.

토큰은 `~/.grove/slack.json`에 저장됩니다. 파일은 bridge가 `0600` 권한으로 씁니다. Slack app은 Socket Mode를 켜고, manifest의 bot scopes와 event subscriptions를 사용합니다.

connector를 직접 실행할 때는 다음 명령을 씁니다.

```bash
uv run --project bridge grove-slack \
  --board alpha \
  --channel C0123456789 \
  --default-node lead
```

ask-human 게이트는 blocked task를 Slack thread로 보냅니다. 사람이 thread에 답하면 bridge가 comment를 추가하고 task를 unblock합니다. 일반 Slack mention/chat은 route된 노드로 전달되고, 같은 thread는 같은 channel session으로 이어집니다.

## 인증상태 패널

대시보드의 인증상태 패널은 `/api/auth-status`에서 읽습니다. 확인 대상은 다음입니다.

- `codex`: `codex auth status`, `OPENAI_API_KEY`, Codex auth file
- `claude`: `claude auth status`, `ANTHROPIC_API_KEY`, Claude credential file
- `agy`: `agy auth status`, `ANTIGRAVITY_API_KEY`, `GEMINI_API_KEY`, agy auth file
- `gh`: `gh auth status`
- `cf`: `CLOUDFLARE_API_TOKEN` 또는 macOS Keychain token

이 패널은 공유 인증을 제공하지 않습니다. 각자 머신의 로컬 인증 상태를 보여주는 진단 패널입니다.

## CLI 명령 요약

| 명령                                 | 용도                                             |
| ------------------------------------ | ------------------------------------------------ |
| `grove init`                         | `grove.yaml`과 delegation protocol 문서 scaffold |
| `grove up [-c file]`                 | config의 모든 노드를 tmux 세션에 bring-up        |
| `grove down [-c file]`               | tmux 세션 종료                                   |
| `grove status [-c file]`             | 노드 상태 요약                                   |
| `grove org [-c file] [--json]`       | registry 기반 조직도 출력                        |
| `grove spawn --name n --agent a ...` | 새 노드 pane 생성, launch, registry 등록         |
| `grove new-project <name>`           | 새 프로젝트 세션/폴더/scaffold/project file 생성 |
| `grove load-project <path>`          | `grove.project.json`을 검증하고 프로젝트 복원    |
| `grove send <node> <message...>`     | 노드에 비동기 task 전송                          |
| `grove wait [nodes...]`              | turn 완료 대기                                   |
| `grove ask <node> <message...>`      | send + wait                                      |
| `grove gather <nodes...>`            | 여러 노드 fan-in 요약                            |
| `grove watch`                        | durable turn completion event log 작성           |
| `grove tail <node>`                  | 완료 turn stream                                 |
| `grove session <node>`               | session id와 transcript path 출력                |
| `grove rebind`                       | registry session/transcript 바인딩 복구          |
| `grove serve [nodes...]`             | OpenAI 호환 SSE channel facade 실행              |

## 운영 팁

- `grove.project.json`은 이동 가능한 구조 정보입니다. transcript, tmux pane, agent-native session 파일은 로컬 상태입니다.
- 프로젝트별 workspace는 project root 안의 상대경로로 유지합니다.
- 로컬 dashboard를 외부에 열 때는 Tailscale 같은 사설 네트워크만 사용합니다.
- node `description`은 사람이 이해하기 쉬운 짧은 메모로 유지하고, 실제 행동 지시는 `role`에 둡니다.
- 최종 로컬 검증은 repo root에서 `pnpm check`입니다. TypeScript만 확인할 때는 `pnpm check:ts`, bridge만 확인할 때는 `pnpm check:py`를 사용합니다.
