# grove delegate 현재 운영 메모

상태: v2 운영 모델. 이 문서는 과거 v1.3의 자동 위임/board-task 실행 설계를 대체한다.

## 현재 의미

`grove delegate`는 이름은 남아 있지만, 노드 간 통신 프로토콜이 아니다. 현재 의미는 특정 grove node와 연결된 **사람용 TODO/feedback/ask-human 항목**을 만드는 legacy alias다.

- 노드끼리는 `grove send`, `grove ask`, tmux capture/send, 직접 대화 등으로 자유롭게 소통한다.
- 사람이 나중에 봐야 하는 할 일, 피드백, 판단 대기만 human-facing item으로 남긴다.
- 조직도 변경은 사람이 명시 지시한 operator 경로에서만 수행한다.
- board/task/store라는 이름은 기존 DB/API 호환을 위한 내부 구현 명칭이다. 사용자-facing copy에서는 human-facing item으로 표현한다.

## 명령 spec

```bash
grove delegate <node> "<title>" [--body <text>] [--board <board>] [--session <session>] [--allow-remote] [--json]
```

의미:

- `<node>`는 항목과 연결할 기존 grove node 이름이다. 이 값은 자동 실행 제한이나 통신 권한을 의미하지 않는다.
- `<title>`은 사람이 볼 항목 제목이다. CLI는 기존 `send`/`ask`처럼 variadic title을 받아 quote 실수를 줄인다.
- `--body <text>`는 human-facing item body다. 필요한 맥락, 요청, 검증 메모, 사람이 판단할 질문을 넣는다.
- `--board <board>` 기본값은 `default`다. 현재 live 운영에서는 active project board로 해석된다.
- `--session <session>`은 대상 grove project/session이다. 생략하면 현재 설정과 runtime env를 따른다.
- `--allow-remote`는 non-loopback grove-web URL로 dashboard token을 보낼 때만 필요한 명시 opt-in이다.
- `--json`은 생성된 항목 payload를 그대로 출력한다.

text 출력은 다음처럼 짧고 사용자-facing이어야 한다.

```text
created human-facing item <id> for <node> on <board> (<session>)
```

## 저장/API 경로

기존 bridge API와 DB 스키마는 아직 task 이름을 쓴다.

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

이 endpoint는 호환 계층이다. 제품 의미는 “node-to-node delegated task”가 아니라 “operator-visible human-facing item”이다.

## 실행 흐름

1. 사용자가 `grove delegate maker-1 "Review this bug" --body "..."`
   를 실행한다.
2. CLI가 session, local grove-web URL, dashboard token을 결정한다.
3. CLI가 `/api/org`로 `<node>`가 현재 org에 있는지 확인한다. 이는 항목의 assignee/연결 대상을 정확히 하기 위한 검증이지, 노드 간 통신 권한 강제가 아니다.
4. CLI가 `/api/boards/{board}/tasks`에 ready item을 만든다.
5. web UI는 이 항목을 “피드백 및 할 일” 또는 “사람 판단 필요” 흐름에서 보여준다.
6. 노드는 이 항목과 별개로 직접 대화할 수 있다. 항목이 있다고 해서 자동 executor가 필수로 실행되거나, 노드 간 통신이 board를 거쳐야 하는 것은 아니다.

## 정책

- **직접 소통 우선**: 구현, 리뷰, blocker 논의는 필요하면 노드가 직접 통신한다.
- **human-facing item만 durable 기록**: 사람이 나중에 확인할 TODO, feedback, ask-human만 기록한다.
- **자동 실행 강제 없음**: pull executor나 lane 기반 task 실행은 현재 기본 운영 모델이 아니다. 나중에 재도입한다면 명시 opt-in과 별도 UI copy가 필요하다.
- **remote token 보호**: non-loopback URL로 dashboard token을 보내려면 `--allow-remote` 또는 `GROVE_DELEGATE_ALLOW_REMOTE=1`이 필요하고 warning을 남긴다.
- **org 변경 금지**: `grove delegate`는 org를 만들거나 바꾸지 않는다. node가 없으면 항목을 만들지 않고 오류를 낸다.
- **중복 허용**: 같은 title/body 항목은 허용한다. 사람이 쌓는 TODO/feedback 기록이므로 중복 판단은 UI/운영자가 한다.

## 테스트/회귀 가드

- `src/commands/delegate.test.ts`는 node 검증, context pack prepend, remote-token opt-in, non-2xx error, text/JSON rendering을 검증한다.
- `src/cli.test.ts`는 help copy가 human-facing item으로 유지되는지 검증한다.
- gate는 repo 공통 `pnpm check`다.
