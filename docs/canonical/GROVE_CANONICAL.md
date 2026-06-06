# GROVE Canonical

Status: operator-owned canonical source

This document is the current operator-authored canonical specification for GROVE. Update this file directly when the canonical model changes. The `whip` node audits the current repo/runtime state against this document until the operator explicitly stops it.

## 개요

GROVE는 Codex, Claude Code, Antigravity CLI 서비스들을 노드로서 구동하고, 조직도를 직접 설정하여 노드 간의 협업과 업무 자동화를 제공합니다. 기본적으로 원내의 24시간 구동되는 서버(기기명 chopin)의 로컬에서 모든 작업이 이루어지며, 외부와의 통신은 Tailscale을 통한 SSH 터널링을 통해 이루어집니다. 또한 Codex, Claude Code는 권프로의 Max 구독 auth로 구동되며, Antigravity는 언박서즈가 공용으로 사용 중인 API가 물려있습니다.

모든 노드는 하나의 tmux 위에서 구동되며, 웹 GUI를 통해 실시간 현황을 확인하고 조직도를 편하게 수정할 수 있습니다.

모든 노드의 root에는 GROVE MASTER 노드가 있으며, Slack이나 웹의 챗봇을 통해서는 CHAT MASTER와 통신하게 됩니다. CHAT MASTER는 외부와의 통신을 담당하며, 필요 시 task를 만들어 MASTER NODE에게 전달합니다.

CHAT MASTER의 사용자 응답 경로는 persistent CLI 노드에 동기 질의하는 방식이 아니라, Slack 스레드와 웹 챗봇 세션을 처리하는 bridge-native chatbot runtime으로 구현합니다. `chat-master` 노드는 이 런타임의 정체성, 정책, 감사, 운영자 대화용 presence를 소유하지만, 사용자-facing hot path가 단일 CLI 입력 버퍼에 막히면 안 됩니다.

CHAT MASTER는 각 Slack의 스레드, 그리고 웹 GUI 챗봇들 각 세션에 대해서 Queue로 관리하여 독립성을 보장합니다.

GROVE가 기존의 sub-agents들을 기본적으로 활용하는 서비스들과 다른 점은, 그로브 내에서 각 노드들은 독립적으로 24시간 구동 중인 CLI 서비스이기 때문에, 작업 기록을 언제든지 조회할 수 있고 실제로 해당 노드에 직접 명령을 내리거나 대화를 나눌 수 있다는 점입니다.

현재는 Tailscale의 보안에 의존하여, 웹 UI는 chopin에서 호스팅 하며 보안 토큰을 자동으로 주입하게 돌아가고 있습니다. Tailscale 내의 구성원이 모두 신뢰할 수 있는 멤버이기 때문에 추가적인 보안 조치(구성원 관리, 로그인 등...)는 후순위로 미루었습니다.

## 기본 조직도

```text
grove-master
- chat-master
- grove-dev
- project lead orchestrator1
-- Reviewer
-- FE master
-- Server master
-- Infra master
-- Documents master...
- project lead orchestrator2
- project lead orchestrator...
```

프로젝트별 조직도는 프로젝트를 생성하는 사람의 판단에 따라 조직됩니다. 모든 노드는 전체 조직도를 항상 인지할 수 있도록 자동 주입되게 되어있으며, 판단에 따라 조직도 내에서 다른 노드와 능동적으로 협업할 수 있도록 설계되었습니다.

## TMUX 배치

0번 윈도우

- 0번 pane: grove master
- 1번 pane: chat master

1번 윈도우: 필요한 모든 서버 구동용

- 웹 서버, 슬랙 봇 등 필요한 백그라운드 태스크는 모두 1번 윈도우에서 구동

2번 윈도우: 첫번째 프로젝트

- 리드 포함 해당 프로젝트의 모든 노드들은 이 윈도우 내부의 pane들로 구현

3번 윈도우: 두번째 프로젝트

- 리드 포함 해당 프로젝트의 모든 노드들은 이 윈도우 내부의 pane들로 구현

...

## 프로젝트

프로젝트는 기본적으로 작업 디렉토리 단위입니다. 프로젝트 생성 시 작업 디렉토리를 필수 필드로 받게 되며, 해당 프로젝트 내의 모든 노드는 해당 디렉토리에서 CLI가 실행됩니다.

프로젝트에는 필수적으로 lead 노드가 1:1로 매칭됩니다. 그로브 마스터는 사용자와 소통하며 판단하여, 각 프로젝트의 리드 노드에게 작업을 분배합니다. 작업이 완료되면 챗마스터를 통해 완료되었다는 메시지를 보내게 됩니다. 또는 웹 UI의 챗봇을 통해 입력한 태스크거나, 태스크 리스트에서 직접 작성한 태스크의 경우 별도의 메시지를 보내지는 않습니다.

그로브 마스터는 사용자와의 소통을 최종적으로 담당하는 역할입니다. 또한 그로브 시스템 자체의 개선을 위한 grove-dev 프로젝트도 존재하여, 그로브 마스터가 판단 하에 사용자의 불만이나 피드백이 있으면 grove-dev 프로젝트에 전달하여 자체적으로 그로브 개선을 실행합니다.

## Task Database

현재 태스크의 필드는 다음과 같습니다.

- 태스크 제목
- 태스크 내용
- 프로젝트
- 워크트리
- 현재 담당 노드
- 현재 상태

기본적으로 GUI 상으로 사용자가 직접 등록 또는 사용자가 챗마스터에게 요청, 또는 노드들이 직접 Task 리스트에 등록 후 작업을 시작합니다. 노드들은 조직도와 마찬가지로 Task DB를 늘 조회하고 열람하며, 상태와 담당 노드를 수정합니다.

조직도 조회와 마찬가지로 Task 조회도 rule-base로 노드에 강제 주입되지는 않습니다. 다만 AGENT.md 그리고 CLAUDE.md 파일에 강력하게 명시되어 있기 때문에, 노드들은 기본적으로 작업 시에 조직도와 현재 실시간 Task 목록을 항시 기억하고 수행합니다. 이는 각 서비스(Codex, Claude, Antigravity) skill로도 제작되어 있습니다.

"사람의 판단이 필요" 한 리스트도 태스크 보드의 한 섹션입니다. 각 노드들은 작업 중에 사람의 판단이 필요하다고 판단되면 이 리스트를 자율적으로 작성할 수 있습니다. 이는 사람이 Resolve 해주면 피드백에 따라 해당 노드가 작업을 재개합니다.

## 챗마스터

Slack에서는 기본적으로 @그로브 이렇게 직접 언급한 메시지에 대해서만 반응합니다. 직접 언급한 메시지 내부의 스레드에서 댓글을 달더라도, @그로브 라고 명시적인 언급을 하기 전에는 CHAT MASTER에게 메시지가 전달되지 않습니다. 언급을 감지하게 되면 CHAT MASTER chatbot runtime에는 전체 스레드의 메시지가 전송되고, 판단 하에 사용자에게 응답합니다.

웹 UI 상에서 우하단의 챗봇을 통해 말을 거는 경우도 Slack의 스레드 중 하나와 똑같이 취급합니다.

CHAT MASTER chatbot runtime은 Slack 스레드와 웹 챗봇 세션을 각각 독립적인 durable session으로 관리합니다. 각 세션의 transcript, pending confirm, mode는 DB에 저장하며, 사용자 응답은 bounded async chatbot worker가 생성합니다. 이 worker는 persistent CLI 노드의 입력 버퍼를 사용하지 않습니다.

사용자에게 보이는 채팅 응답 문구는 CHAT MASTER chatbot runtime이 생성한 표현이어야 합니다. bridge, connector, worker는 전송, queue, mention 감지, thread/session 분리, confirm plumbing을 담당하며, 임의의 템플릿 답변을 사용자-facing chat answer로 보내지 않습니다. 단, Slack reaction이나 명확히 구분되는 시스템 상태 표시는 채팅 답변과 분리된 보조 신호로 사용할 수 있습니다.

### 1. 단순 질문응답

CHAT MASTER가 판단하기에 이건 새로운 TASK가 아니고 단순한 잡담이거나, 본인이 충분히 대답할 수 있는 질문이라면 CHAT MASTER가 직접 plain text로 응답합니다.

### 2. 작업 Queue에 추가

챗 마스터가 판단하기에 사용자의 입력이 새로운 TASK라면, Block Kit을 통해 "다음과 같이 태스크를 생성할까요?" 라고 확인 메시지를 전송합니다. Block Kit에서는 다음과 같은 필드들을 입력받아야 합니다.

- 작업 제목(필수)
- 작업 내용(선택)
- 프로젝트(필수): 실제 프로젝트들 중 하나로 선택할 수 있는 UI가 가능하다면 best
- 작업 워크트리: default는 별도 브랜치 생성해서 한다고 설명, 자연어로 받아서 필요 시 브랜치 파서 작업할 수 있도록

위의 필드들을 입력하고 제출을 하면, DB 상의 TASK로 등록되며, 챗 마스터가 한 번 검수한 뒤 잘 접수되었다는 방향으로 답장을 하게 됩니다.

### 3. 완료 피드백 또는 사용자 판단이 필요한 태스크 알림

작업이 완료되거나 사용자의 판단이 필요한 부분이 있을 시, DB를 항상 모니터링 하고 있다가 이벤트 트리거 시 Slack 채널을 통해 알려줍니다. 기본 채널은 #베이스-제품개발팀 입니다.

## 연결

Tailscale에서 chopin-macmini의 IP 주소를 참조합니다. SSH 연결을 위한 Public Key를 만들어서 웹 UI 내에 등록 요청을 하거나, 챗마스터에게 제출하면 chopin에서 SSH Public Key 등록 프로세스가 진행되고 이후 SSH로 연결 가능합니다.

기본적으로 웹 UI는 Tailscale 내에 등록된 멤버들에게는 열려있으므로, SSH 연결 대신 웹을 통해서 작업을 조회하고, 명령을 내려도 됩니다.

## 웹 UI

웹에서는 각 프로젝트의 조직도와, 현재 상태를 조회하고, 각 노드의 터미널을 실시간 조회할 수 있습니다. 또한 태스크 보드에서 현재 태스크 DB의 상태를 조회, 수정할 수 있으며 사람의 판단이 필요한 목록을 조회하고 그에 대해 응답할 수 있습니다. 기본적으로 SSH 직접 연결을 통해 할 수 있는 모든 태스크는 웹 UI에서 모두 가능합니다.
