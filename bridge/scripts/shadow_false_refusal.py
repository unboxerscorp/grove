"""Re-activation gate #3 — real-model shadow for the false-refusal incident.

Runs the REAL Gemini provider with the live hardened persona + the authority line on
false-refusal scenarios (a stale in-thread self-refusal + a retry) and checks whether
the model now CALLS create_task instead of repeating "creation unsupported". Faithful:
the user_text + tools come from a real ``SlackConnector`` (so the authority line +
thread-context REPLACE match live). Safe: creates land on a THROWAWAY temp store — no
real board is written. Read-only on the operator's persona/provider-config/directory.

Variants (lead request): retry phrasings ("다시" / "그거 해줘" / "아까 그거 만들어줘"
/ "again"), a different stale-refusal phrasing, and a cross-project ask.

Usage:  uv run python scripts/shadow_false_refusal.py [PER]   (trials per scenario, default 3)
"""

from __future__ import annotations

import sys
import tempfile
from pathlib import Path

from grove_bridge.chat_runtime import (
    ChatTool,
    GeminiChatProviderAdapter,
    ProviderRequest,
    RedactingProviderAdapter,
    load_chat_bridge_persona,
    load_gemini_provider_config,
)
from grove_bridge.project_directory import ProjectDirectory
from grove_bridge.slack import (
    ChatRouteConfig,
    HumanGateConfig,
    SlackCommandConfig,
    SlackCommandMember,
    SlackConnector,
)
from grove_bridge.store import SQLiteBoardStore

STALE_MIJI = "태스크 직접 생성 기능은 미지원입니다"
STALE_MOTHAE = "죄송하지만 제가 직접 태스크를 생성하는 건 못 해요. 요청만 받을 수 있어요."
REQ = "base-web-admin 태스크를 생성해야 해"

SCENARIOS = [
    {"name": "retry=다시", "req": REQ, "stale": STALE_MIJI, "cur": "@그로브 다시"},
    {"name": "retry=그거 해줘", "req": REQ, "stale": STALE_MIJI, "cur": "@그로브 그거 해줘"},
    {
        "name": "retry=아까 그거 만들어줘",
        "req": REQ,
        "stale": STALE_MIJI,
        "cur": "@그로브 아까 그거 만들어줘",
    },
    {"name": "retry=again(en)", "req": REQ, "stale": STALE_MIJI, "cur": "@그로브 again"},
    {"name": "stale=못해요", "req": REQ, "stale": STALE_MOTHAE, "cur": "@그로브 다시"},
    {
        "name": "cross-project",
        "req": "다른 프로젝트에 태스크 추가하고 싶어",
        "stale": STALE_MIJI,
        "cur": "@그로브 base-web-admin 프로젝트에 추가해줘",
    },
    {
        "name": "cross-project+제목",
        "req": "base-web-admin 프로젝트 작업이 필요해",
        "stale": STALE_MIJI,
        "cur": "@그로브 base-web-admin 프로젝트에 '관리자 대시보드 초안' 태스크 추가해줘",
    },
]


class _FakeSlack:
    def __init__(self) -> None:
        self.replies: dict[str, list[dict[str, object]]] = {}
        self.posts: list[tuple[str, str]] = []

    def post_message(self, *, channel: str, text: str, **kwargs: object) -> str:
        self.posts.append((channel, text))
        return "ts"

    def find_message_by_metadata(self, **kwargs: object) -> None:
        return None

    def conversations_replies(self, *, channel: str, thread_ts: str) -> list[dict[str, object]]:
        return self.replies.get(thread_ts, [])


class _FakeFacade:
    def send(self, *, session_id: str, node: str, text: str) -> str:
        return "node"


def main() -> int:
    per = int(sys.argv[1]) if len(sys.argv) > 1 else 3
    home = Path("~/.grove").expanduser()
    cfg = load_gemini_provider_config(home / "dev10" / "chat-provider.json")
    if not cfg["api_key"]:
        print("NO GEMINI KEY — cannot run shadow")
        return 2
    adapter = RedactingProviderAdapter(
        inner=GeminiChatProviderAdapter(api_key=cfg["api_key"], model=cfg["model"])
    )
    persona = load_chat_bridge_persona(home / "dev10" / "chat-persona.md")

    store = SQLiteBoardStore(Path(tempfile.mkdtemp()) / "shadow.db")
    store.set_gui_feature_enabled(board="dev10", feature="chat_bridge_runtime", enabled=True)
    store.set_gui_feature_enabled(board="dev10", feature="chat_write_tools", enabled=True)
    directory = ProjectDirectory(home, default_session="dev10")
    slack = _FakeSlack()
    command_config = SlackCommandConfig(
        board="dev10",
        members={"U03B147K2PR": SlackCommandMember("operator", "권성민", "operator")},
    )
    conn = SlackConnector(
        store=store,
        slack_client=slack,
        chat_facade=_FakeFacade(),
        human_gate=HumanGateConfig(board="dev10", channel="C1"),
        chat_route=ChatRouteConfig(default_node="chat-master"),
        command_config=command_config,
        route_chat_to_node=True,
        bot_user_id="BOT",
    )

    name_filter = sys.argv[2] if len(sys.argv) > 2 else None
    create_calls = [0]
    last_result: dict[str, object] = {}

    def _counting(tool: ChatTool) -> ChatTool:
        if tool.name != "create_task":
            return tool
        inner = tool.handler

        def handler(args: object) -> object:
            create_calls[0] += 1
            res = inner(args)  # type: ignore[arg-type]
            last_result.clear()
            if isinstance(res, dict):
                last_result.update(res)
            return res

        return ChatTool(
            name=tool.name,
            description=tool.description,
            parameters=tool.parameters,
            handler=handler,  # type: ignore[arg-type]
        )

    scenarios = [s for s in SCENARIOS if not name_filter or name_filter in str(s["name"])]
    print(f"=== shadow: {len(scenarios)} scenarios x {per} trials ({cfg['model']}) ===")
    total_called = 0
    total_refused = 0
    total = 0
    for s_idx, sc in enumerate(scenarios):
        thread = f"th{s_idx}"
        slack.replies = {
            thread: [
                {"user": "U03B147K2PR", "text": sc["req"], "ts": f"{thread}.1"},
                {"user": "BOT", "text": sc["stale"], "ts": f"{thread}.2"},
                {"user": "U03B147K2PR", "text": sc["cur"], "ts": f"{thread}.3"},
            ]
        }
        item = store.enqueue_slack_chat_message(
            board="dev10",
            team_id="T",
            channel_id="C1",
            thread_ts=thread,
            message_ts=f"{thread}.3",
            user_id="U03B147K2PR",
            node="chat-master",
            text=str(sc["cur"]),
        )
        user_text = conn._chat_bridge_slack_user_text(item, conversation_id=f"slack:T:C1:{thread}")
        tools = [_counting(t) for t in conn._chat_bridge_tools(item)]
        called = 0
        refused = 0
        for _ in range(per):
            before = create_calls[0]
            try:
                text = adapter.generate(
                    ProviderRequest(system_prompt=persona, user_text=user_text), tools=tools
                )
            except Exception as exc:  # noqa: BLE001 - report transport errors per trial
                print(f"  [{sc['name']}] ERROR {type(exc).__name__}: {exc}")
                total += 1
                continue
            did = create_calls[0] > before
            refusal_words = ("미지원", "지원하지", "직접 생성", "못 해", "못해", "할 수 없")
            looks_refusal = any(w in text for w in refusal_words) or "cannot" in text.lower()
            called += 1 if did else 0
            refused += 1 if (not did and looks_refusal) else 0
            total += 1
            tag = "CREATE ✓" if did else ("REFUSAL ✗" if looks_refusal else "no-create")
            detail = ""
            if did and last_result.get("ok") is True:
                proj = last_result.get("project")
                tid = str(last_result.get("task_id"))
                board = directory.resolve(str(proj)) if proj else None
                status = ""
                if board:
                    try:
                        status = store.get_task(board=board, task_id=tid).status
                    except Exception:  # noqa: BLE001
                        status = "?"
                detail = f" [project={proj} board={board} status={status} id={tid}]"
            print(f"  [{sc['name']}] {tag}{detail} | {text[:80]!r}")
        total_called += called
        total_refused += refused
        print(f"  --> {sc['name']}: create {called}/{per}, refusals {refused}/{per}")
    print(f"=== TOTAL: create_task {total_called}/{total} | refusals {total_refused}/{total} ===")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
