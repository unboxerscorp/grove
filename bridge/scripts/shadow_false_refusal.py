"""Re-activation gate #3 — real-model shadow for the false-refusal incident.

Runs the REAL Gemini provider with the live hardened persona + the authority line on
the exact false-refusal scenario (a stale in-thread self-refusal + the operator's
"다시") and checks whether the model now CALLS create_task instead of repeating
"creation unsupported". Faithful: the user_text + tools come from a real
``SlackConnector`` (so the authority line + thread-context REPLACE match live). Safe:
creates land on a THROWAWAY temp store — no real board is written. Read-only on the
operator's persona/provider-config/project directory.

Usage:  uv run python scripts/shadow_false_refusal.py [N]   (default N=5)
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
from grove_bridge.slack import (
    ChatRouteConfig,
    HumanGateConfig,
    SlackCommandConfig,
    SlackCommandMember,
    SlackConnector,
)
from grove_bridge.store import SQLiteBoardStore


class _FakeSlack:
    def __init__(self, replies: dict[str, list[dict[str, object]]]) -> None:
        self.replies = replies
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
    trials = int(sys.argv[1]) if len(sys.argv) > 1 else 5
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
    replies = {
        "th": [
            {"user": "U03B147K2PR", "text": "base-web-admin 태스크를 생성해야 해", "ts": "1"},
            {"user": "BOT", "text": "태스크 직접 생성 기능은 미지원입니다", "ts": "2"},
            {"user": "U03B147K2PR", "text": "@그로브 다시", "ts": "3"},
        ]
    }
    slack = _FakeSlack(replies)
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
    item = store.enqueue_slack_chat_message(
        board="dev10",
        team_id="T",
        channel_id="C1",
        thread_ts="th",
        message_ts="3",
        user_id="U03B147K2PR",
        node="chat-master",
        text="@그로브 다시",
    )
    user_text = conn._chat_bridge_slack_user_text(item, conversation_id="slack:T:C1:th")

    # Wrap create_task to count real model invocations (most reliable signal).
    create_calls = [0]

    def _counting(tool: ChatTool) -> ChatTool:
        if tool.name != "create_task":
            return tool
        inner = tool.handler

        def handler(args: object) -> object:
            create_calls[0] += 1
            return inner(args)  # type: ignore[arg-type]

        return ChatTool(
            name=tool.name,
            description=tool.description,
            parameters=tool.parameters,
            handler=handler,  # type: ignore[arg-type]
        )

    tools = [_counting(t) for t in conn._chat_bridge_tools(item)]

    print("=== user_text (faithful: thread REPLACE + authority line) ===")
    print(user_text)
    print("=== tools ===", [t.name for t in tools])
    print(f"=== {trials} real-Gemini trials ({cfg['model']}) ===")
    created = 0
    refused = 0
    for i in range(trials):
        before = create_calls[0]
        try:
            text = adapter.generate(
                ProviderRequest(system_prompt=persona, user_text=user_text), tools=tools
            )
        except Exception as exc:  # noqa: BLE001 - report transport errors per trial
            print(f"  trial {i}: ERROR {type(exc).__name__}: {exc}")
            continue
        did_create = create_calls[0] > before
        low = text.lower()
        looks_refusal = (
            any(w in text for w in ("미지원", "지원하지", "할 수 없")) or "cannot" in low
        )
        created += 1 if did_create else 0
        refused += 1 if (not did_create and looks_refusal) else 0
        tag = "CREATE_TASK ✓" if did_create else ("REFUSAL ✗" if looks_refusal else "no-create")
        print(f"  trial {i}: {tag} | {text[:110]!r}")
    print(f"=== RESULT: create_task {created}/{trials} | refusals {refused}/{trials} ===")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
