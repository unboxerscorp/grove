# grove 사용자 가이드

## 보드(dev-room)란

dev-room의 보드는 작업을 담는 칸반 컨테이너입니다. 각 보드는 `slug`로 식별되며, 같은 이름을 다시 쓰면 기존 보드를 재사용합니다. 기본 저장소는 SQLite 파일인 `~/.grove/boards/board.db`이고, 설정으로 다른 경로를 사용할 수 있습니다.

보드는 이름으로 자동 생성됩니다. 예를 들어 task 생성 API나 executor가 `main` 보드를 지정하면, 아직 없을 때 `main` 보드가 만들어집니다. 여러 보드를 동시에 둘 수 있으며, 현재 보드 목록은 `/api/boards`에서 읽습니다.

## 노드란

노드는 grove 에이전트 세션에 등록된 작업 실행 단위입니다. 레지스트리 파일은 `~/.grove/<tmux세션>/registry.json`이며, 각 항목은 실제 CLI 실행자가 붙어 있는 tmux pane을 가리킵니다. 예시는 `codex`, `claude`, `agy` 같은 실행자입니다.

대시보드가 어느 tmux 세션을 볼지는 `GROVE_VIEWER_SESSION`으로 정합니다. 기본값은 `dev10`입니다. 노드는 명시적인 `tmux_pane`이 있는 레지스트리 항목만 노출되며, lead pane인 `<session>:0.0`은 표시하거나 캡처하지 않습니다.

## executor 글루

executor는 보드의 task와 노드를 연결하는 실행 글루입니다. 흐름은 `claim -> 노드 실행 -> heartbeat -> complete/block`입니다. task의 assignee lane을 executor 설정의 node pool에 매핑하고, claim이 성공한 뒤에만 실제 노드를 획득합니다.

보드는 오케스트레이터에 직접 바인딩되지 않습니다. 어떤 보드와 lane을 어떤 노드에 보낼지는 executor 설정이 결정합니다. 따라서 같은 보드라도 설정을 바꾸면 다른 노드 풀로 실행할 수 있습니다.

## 칸반 항목 출처

칸반 항목은 보드 store의 task입니다. 데모에서는 테스트 데이터나 UI/API로 만든 task가 들어갈 수 있고, 실제 운용에서는 API, CLI, UI, 채널 인입, executor가 모두 같은 store에 task와 comment, run, event를 기록합니다.

새 task는 `/api/boards/{board_id}/tasks`로 만들 수 있습니다. 필수 값은 `title`이고, 선택 값은 `body`, `assignee`, `status`, `priority`입니다. 기본 status는 `ready`, 기본 priority는 `0`입니다.

## 대시보드 데이터 소스

dev-room 대시보드는 세 가지 소스를 읽습니다.

- 노드: `~/.grove/<tmux세션>/registry.json`
- 보드와 task: SQLite board store
- 터미널: `tmux capture-pane` 읽기 전용 캡처

터미널 뷰는 pane을 resize하거나 입력을 보내지 않습니다. 허용된 레지스트리 pane만 캡처하며, 캡처 결과는 WebSocket 프레임으로 전달됩니다.

## 실행법

웹 백엔드는 `grove-web` 콘솔 스크립트로 실행합니다.

```bash
grove-web --host 127.0.0.1 --port 8765 --session dev10
```

`--session`은 노드 레지스트리를 읽을 tmux 세션명입니다. `--host`와 `--port`는 웹 서버 바인딩 주소입니다.

SPA index에는 프로세스마다 생성된 세션 토큰이 자동 주입됩니다. REST API는 `X-Grove-Session-Token` 헤더를 요구하고, WebSocket은 `/api/ws-ticket`에서 받은 30초짜리 1회용 ticket으로 접속합니다. 터미널 WebSocket은 `/ws/terminal?ticket=<ticket>&pane_id=<session>:<window>.<pane>` 형식을 사용합니다.
