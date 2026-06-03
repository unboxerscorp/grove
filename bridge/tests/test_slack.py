from __future__ import annotations

import subprocess
from pathlib import Path
from typing import cast

import pytest

from grove_bridge.slack import (
    GROVE_CHAT_TIMEOUT_SECONDS,
    ChatRouteConfig,
    FakeStatusProbe,
    GroveServeChatFacade,
    HumanGateConfig,
    SlackConfig,
    SlackConfigStore,
    SlackConnector,
    SlackEvent,
    mask_token,
)
from grove_bridge.store import SQLiteBoardStore


class FakeSlackClient:
    def __init__(self) -> None:
        self.posts: list[tuple[str, str, str | None]] = []

    def post_message(self, *, channel: str, text: str, thread_ts: str | None = None) -> str:
        ts = f"ts-{len(self.posts) + 1}"
        self.posts.append((channel, text, thread_ts))
        return ts


class FakeChatFacade:
    def __init__(self) -> None:
        self.calls: list[tuple[str, str, str]] = []

    def send(self, *, session_id: str, node: str, text: str) -> str:
        self.calls.append((session_id, node, text))
        return "grove reply"


def test_slack_config_store_validates_and_masks_tokens(tmp_path: Path) -> None:
    path = tmp_path / "slack.json"
    store = SlackConfigStore(path)

    store.save(
        SlackConfig(
            app_token="xapp-abc",
            bot_token="xoxb-def",
            default_channel="C123",
            default_node="grove-qa",
        )
    )

    loaded = store.load()
    assert loaded is not None
    assert loaded.app_token == "xapp-abc"
    assert loaded.bot_token == "xoxb-def"
    assert loaded.masked() == {
        "app_token": "xapp...abc",
        "bot_token": "xoxb...def",
        "default_channel": "C123",
        "default_node": "grove-qa",
    }
    assert path.stat().st_mode & 0o077 == 0
    assert mask_token("xoxb-1234567890") == "xoxb...7890"


def test_human_gate_posts_blocked_task_and_unblocks_on_thread_reply(tmp_path: Path) -> None:
    board = "main"
    store = SQLiteBoardStore(tmp_path / "board.db")
    task = store.create_task(
        board=board,
        title="Need human",
        body="What branch should I use?",
        assignee="grove-qa",
    )
    claimed = store.claim_next(board=board, assignee="grove-qa", node_id="grove-qa", ttl_seconds=60)
    assert claimed is not None
    assert store.block(
        board=board,
        task_id=task.id,
        run_id=claimed.run_id,
        claim_lock=claimed.claim_lock,
        reason="Need a branch decision",
        metadata={"question": "Which branch?"},
        needs_human=True,
    )
    slack = FakeSlackClient()
    chat = FakeChatFacade()
    connector = SlackConnector(
        store=store,
        slack_client=slack,
        chat_facade=chat,
        human_gate=HumanGateConfig(board=board, channel="C123"),
        chat_route=ChatRouteConfig(default_node="grove-qa"),
    )

    assert connector.poll_human_gates() == 1
    assert slack.posts[0][0] == "C123"
    assert "Need human" in slack.posts[0][1]
    assert "Which branch?" in slack.posts[0][1]
    assert store.list_notify_subs(board=board, task_id=task.id)[0].thread_id == "ts-1"
    assert store.list_slack_threads(task_id=task.id)[0].mode == "human_gate"

    handled = connector.handle_event(
        SlackEvent(
            team="T1",
            channel="C123",
            user="U1",
            text="Use branch feature/live.",
            ts="ts-reply",
            thread_ts="ts-1",
            event_type="message",
        )
    )

    assert handled is True
    updated = store.get_task(board=board, task_id=task.id)
    assert updated.status == "ready"
    comments = store.list_comments(board=board, task_id=task.id)
    assert comments[-1].author == "slack:U1"
    assert comments[-1].body == "Use branch feature/live."
    assert slack.posts[-1] == ("C123", "Recorded your reply and unblocked the task.", "ts-1")
    assert connector.handle_event(
        SlackEvent(
            team="T1",
            channel="C123",
            user="U1",
            text="same reply again",
            ts="ts-reply-2",
            thread_ts="ts-1",
            event_type="message",
        )
    )
    assert len(store.list_comments(board=board, task_id=task.id)) == len(comments)
    assert chat.calls == []


def test_chat_routing_uses_thread_session_and_posts_response(tmp_path: Path) -> None:
    slack = FakeSlackClient()
    chat = FakeChatFacade()
    connector = SlackConnector(
        store=SQLiteBoardStore(tmp_path / "board.db"),
        slack_client=slack,
        chat_facade=chat,
        human_gate=HumanGateConfig(board="main", channel="C123"),
        chat_route=ChatRouteConfig(
            default_node="chat-node",
            channel_nodes={"C123": "channel-node"},
        ),
    )

    handled = connector.handle_event(
        SlackEvent(
            team="T1",
            channel="C123",
            user="U2",
            text="<@BOT> summarize status",
            ts="111.222",
            thread_ts=None,
            event_type="app_mention",
        )
    )

    assert handled is True
    assert chat.calls == [
        ("slack:T1:C123:111.222", "channel-node", "summarize status"),
    ]
    assert slack.posts == [("C123", "grove reply", "111.222")]


def test_chat_routing_uses_mentioned_node_when_channel_has_no_route(tmp_path: Path) -> None:
    slack = FakeSlackClient()
    chat = FakeChatFacade()
    connector = SlackConnector(
        store=SQLiteBoardStore(tmp_path / "board.db"),
        slack_client=slack,
        chat_facade=chat,
        human_gate=HumanGateConfig(board="main", channel="C123"),
        chat_route=ChatRouteConfig(
            default_node="chat-node",
            mention_nodes={"qa": "grove-qa"},
        ),
    )

    handled = connector.handle_event(
        SlackEvent(
            team="T1",
            channel="C999",
            user="U2",
            text="@qa check this",
            ts="222.333",
            thread_ts=None,
            event_type="message",
        )
    )

    assert handled is True
    assert chat.calls == [("slack:T1:C999:222.333", "grove-qa", "@qa check this")]
    assert slack.posts == [("C999", "grove reply", "222.333")]


def test_status_probe_reports_bot_auth_ok_for_saved_tokens(tmp_path: Path) -> None:
    config_path = tmp_path / "slack.json"
    SlackConfigStore(config_path).save(SlackConfig(app_token="xapp-ok", bot_token="xoxb-ok"))

    status = FakeStatusProbe(config_path=config_path, bot_auth_ok=True).status()
    tokens = cast(dict[str, str | None], status["tokens"])

    assert status["status"] == "bot_auth_ok"
    assert "state" not in status
    assert tokens["app_token"] == "xapp...p-ok"
    assert tokens["bot_token"] == "xoxb...b-ok"


def test_grove_chat_facade_uses_timeout_and_literal_argv(monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[dict[str, object]] = []

    def fake_run(
        args: list[str],
        *,
        input: str,
        capture_output: bool,
        text: bool,
        timeout: float,
        check: bool,
    ) -> subprocess.CompletedProcess[str]:
        calls.append(
            {
                "args": args,
                "input": input,
                "capture_output": capture_output,
                "text": text,
                "timeout": timeout,
                "check": check,
            }
        )
        return subprocess.CompletedProcess(args=args, returncode=0, stdout="reply\n", stderr="")

    monkeypatch.setattr("grove_bridge.slack.subprocess.run", fake_run)

    assert GroveServeChatFacade().send(session_id="s1", node="worker", text="hello") == "reply"
    assert calls == [
        {
            "args": [
                "grove",
                "serve",
                "chat",
                "--node",
                "worker",
                "--session-id",
                "s1",
            ],
            "input": "hello",
            "capture_output": True,
            "text": True,
            "timeout": GROVE_CHAT_TIMEOUT_SECONDS,
            "check": False,
        }
    ]
