from __future__ import annotations

import json
import subprocess
from collections.abc import Mapping
from pathlib import Path
from typing import cast

import pytest

import grove_bridge.slack as slack_module
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
    SlackSdkClient,
    mask_token,
)
from grove_bridge.store import SQLiteBoardStore, Task


class FakeSlackClient:
    def __init__(self) -> None:
        self.posts: list[tuple[str, str, str | None]] = []
        self.messages: dict[str, dict[str, object]] = {}
        self.history_failures = 0
        self.raise_after_post = False

    def post_message(
        self,
        *,
        channel: str,
        text: str,
        thread_ts: str | None = None,
        metadata: Mapping[str, object] | None = None,
    ) -> str:
        ts = f"ts-{len(self.posts) + 1}"
        self.posts.append((channel, text, thread_ts))
        if metadata is not None:
            self.messages[ts] = {"channel": channel, "metadata": dict(metadata)}
        if self.raise_after_post:
            raise RuntimeError("accepted but client failed")
        return ts

    def find_message_by_metadata(
        self,
        *,
        channel: str,
        event_type: str,
        dedup_key: str,
        oldest: str | None = None,
    ) -> str | None:
        _ = oldest
        if self.history_failures > 0:
            self.history_failures -= 1
            raise RuntimeError("history temporarily unavailable")
        for ts, message in self.messages.items():
            if message.get("channel") != channel:
                continue
            metadata = message.get("metadata")
            if not isinstance(metadata, Mapping) or metadata.get("event_type") != event_type:
                continue
            payload = metadata.get("event_payload")
            if isinstance(payload, Mapping) and payload.get("dedup_key") == dedup_key:
                return ts
        return None


class FakeChatFacade:
    def __init__(self) -> None:
        self.calls: list[tuple[str, str, str]] = []

    def send(self, *, session_id: str, node: str, text: str) -> str:
        self.calls.append((session_id, node, text))
        return "grove reply"


class FailingChatFacade:
    def __init__(self, message: str) -> None:
        self.message = message
        self.calls: list[tuple[str, str, str]] = []

    def send(self, *, session_id: str, node: str, text: str) -> str:
        self.calls.append((session_id, node, text))
        raise RuntimeError(self.message)


class FailingPostSlackClient(FakeSlackClient):
    def post_message(
        self,
        *,
        channel: str,
        text: str,
        thread_ts: str | None = None,
        metadata: Mapping[str, object] | None = None,
    ) -> str:
        _ = (channel, text, thread_ts, metadata)
        raise RuntimeError("post failed xoxb-" + ("c" * 44))


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


@pytest.mark.parametrize(
    ("payload", "message"),
    [
        (["not", "a", "dict"], "invalid slack config"),
        ({"bot_token": "xoxb-ok"}, "app_token is required"),
        ({"app_token": "bad", "bot_token": "xoxb-ok"}, "app_token must start"),
        ({"app_token": "xapp-ok", "bot_token": "bad"}, "bot_token must start"),
        (
            {"app_token": "xapp-ok", "bot_token": "xoxb-ok", "default_node": 123},
            "default_node must be a string",
        ),
    ],
)
def test_slack_config_store_rejects_invalid_saved_config(
    tmp_path: Path,
    payload: object,
    message: str,
) -> None:
    path = tmp_path / "slack.json"
    path.write_text(json.dumps(payload), encoding="utf-8")

    with pytest.raises(ValueError, match=message):
        SlackConfigStore(path).load()


def test_slack_status_probe_reports_not_configured_and_socket_connected(tmp_path: Path) -> None:
    missing_path = tmp_path / "missing.json"
    config_path = tmp_path / "slack.json"
    SlackConfigStore(config_path).save(SlackConfig(app_token="xapp-ok", bot_token="xoxb-ok"))

    missing_status = FakeStatusProbe(config_path=missing_path).status()
    connected_status = FakeStatusProbe(
        config_path=config_path,
        socket_connected=True,
        last_event_at=123,
        last_error="none",
    ).status()

    assert missing_status == {
        "status": "not_configured",
        "last_event_at": None,
        "last_error": None,
        "tokens": {},
    }
    assert connected_status["status"] == "socket_connected"
    assert connected_status["last_event_at"] == 123
    assert connected_status["last_error"] == "none"


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


def test_human_gate_stale_pending_before_post_retries(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr("grove_bridge.slack.HUMAN_GATE_PENDING_TTL_SECONDS", -1)
    board = "main"
    store = SQLiteBoardStore(tmp_path / "board.db")
    task = blocked_human_task(store, board=board)
    pending_key = f"pending:{task.id}"
    store.upsert_slack_thread(
        board=board,
        task_id=task.id,
        team_id="",
        channel_id="C123",
        thread_ts=pending_key,
        mode="human_gate_pending",
        node=task.assignee,
    )
    slack = FakeSlackClient()
    connector = SlackConnector(
        store=store,
        slack_client=slack,
        chat_facade=FakeChatFacade(),
        human_gate=HumanGateConfig(board=board, channel="C123"),
        chat_route=ChatRouteConfig(default_node="grove-qa"),
    )

    assert connector.poll_human_gates() == 1

    assert slack.posts[0][0] == "C123"
    assert store.list_notify_subs(board=board, task_id=task.id)[0].thread_id == "ts-1"
    threads = store.list_slack_threads(task_id=task.id)
    assert [(thread.mode, thread.thread_ts) for thread in threads] == [("human_gate", "ts-1")]


def test_human_gate_stale_pending_after_post_reconciles_without_duplicate(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr("grove_bridge.slack.HUMAN_GATE_PENDING_TTL_SECONDS", -1)
    board = "main"
    store = SQLiteBoardStore(tmp_path / "board.db")
    task = blocked_human_task(store, board=board)
    pending_key = f"pending:{task.id}"
    store.upsert_slack_thread(
        board=board,
        task_id=task.id,
        team_id="",
        channel_id="C123",
        thread_ts=pending_key,
        mode="human_gate_pending",
        node=task.assignee,
    )
    slack = FakeSlackClient()
    slack.messages["ts-orphan"] = {
        "channel": "C123",
        "metadata": {
            "event_type": "grove_human_gate",
            "event_payload": {"task_id": task.id, "dedup_key": pending_key},
        },
    }
    connector = SlackConnector(
        store=store,
        slack_client=slack,
        chat_facade=FakeChatFacade(),
        human_gate=HumanGateConfig(board=board, channel="C123"),
        chat_route=ChatRouteConfig(default_node="grove-qa"),
    )

    assert connector.poll_human_gates() == 0

    assert slack.posts == []
    assert store.list_notify_subs(board=board, task_id=task.id)[0].thread_id == "ts-orphan"
    threads = store.list_slack_threads(task_id=task.id)
    assert [(thread.mode, thread.thread_ts) for thread in threads] == [("human_gate", "ts-orphan")]


def test_human_gate_history_failure_keeps_pending_without_duplicate_post(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr("grove_bridge.slack.HUMAN_GATE_PENDING_TTL_SECONDS", -1)
    board = "main"
    store = SQLiteBoardStore(tmp_path / "board.db")
    task = blocked_human_task(store, board=board)
    pending_key = record_human_gate_pending(store, board=board, task=task)
    slack = FakeSlackClient()
    slack.history_failures = 1
    connector = SlackConnector(
        store=store,
        slack_client=slack,
        chat_facade=FakeChatFacade(),
        human_gate=HumanGateConfig(board=board, channel="C123"),
        chat_route=ChatRouteConfig(default_node="grove-qa"),
    )

    assert connector.poll_human_gates() == 0

    assert slack.posts == []
    assert slack_thread_modes(store, task=task) == [("human_gate_pending", pending_key)]


def test_human_gate_malformed_history_pagination_keeps_pending_without_repost(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr("grove_bridge.slack.HUMAN_GATE_PENDING_TTL_SECONDS", -1)
    board = "main"
    store = SQLiteBoardStore(tmp_path / "board.db")
    task = blocked_human_task(store, board=board)
    pending_key = record_human_gate_pending(store, board=board, task=task)

    class MalformedHistorySlackClient(FakeSlackClient):
        def find_message_by_metadata(
            self,
            *,
            channel: str,
            event_type: str,
            dedup_key: str,
            oldest: str | None = None,
        ) -> str | None:
            class MalformedWebClient:
                def chat_postMessage(
                    self,
                    *,
                    channel: str,
                    text: str,
                    thread_ts: str | None = None,
                    metadata: Mapping[str, object] | None = None,
                ) -> Mapping[str, object]:
                    _ = (channel, text, thread_ts, metadata)
                    return {"ts": "unused"}

                def conversations_history(
                    self,
                    *,
                    channel: str,
                    limit: int,
                    oldest: str | None = None,
                    inclusive: bool = True,
                    cursor: str | None = None,
                ) -> Mapping[str, object]:
                    _ = (channel, limit, oldest, inclusive, cursor)
                    return {"messages": [], "has_more": True, "response_metadata": {}}

            sdk = object.__new__(SlackSdkClient)
            sdk._client = MalformedWebClient()
            return sdk.find_message_by_metadata(
                channel=channel,
                event_type=event_type,
                dedup_key=dedup_key,
                oldest=oldest,
            )

    slack = MalformedHistorySlackClient()
    connector = SlackConnector(
        store=store,
        slack_client=slack,
        chat_facade=FakeChatFacade(),
        human_gate=HumanGateConfig(board=board, channel="C123"),
        chat_route=ChatRouteConfig(default_node="grove-qa"),
    )

    assert connector.poll_human_gates() == 0

    assert slack.posts == []
    assert slack_thread_modes(store, task=task) == [("human_gate_pending", pending_key)]


def test_human_gate_accepted_but_exception_reconciles_next_poll_without_duplicate(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr("grove_bridge.slack.HUMAN_GATE_PENDING_TTL_SECONDS", -1)
    board = "main"
    store = SQLiteBoardStore(tmp_path / "board.db")
    task = blocked_human_task(store, board=board)
    slack = FakeSlackClient()
    slack.raise_after_post = True
    connector = SlackConnector(
        store=store,
        slack_client=slack,
        chat_facade=FakeChatFacade(),
        human_gate=HumanGateConfig(board=board, channel="C123"),
        chat_route=ChatRouteConfig(default_node="grove-qa"),
    )

    assert connector.poll_human_gates() == 0
    slack.raise_after_post = False
    assert connector.poll_human_gates() == 0

    assert len(slack.posts) == 1
    assert slack.posts[0][0] == "C123"
    assert slack.posts[0][2] is None
    assert store.list_notify_subs(board=board, task_id=task.id)[0].thread_id == "ts-1"
    assert slack_thread_modes(store, task=task) == [("human_gate", "ts-1")]


def test_human_gate_notify_sub_only_restores_thread_and_cleans_pending(
    tmp_path: Path,
) -> None:
    board = "main"
    store = SQLiteBoardStore(tmp_path / "board.db")
    task = blocked_human_task(store, board=board)
    record_human_gate_pending(store, board=board, task=task)
    store.add_notify_sub(
        board=board,
        task_id=task.id,
        channel_kind="slack",
        room_id="C123",
        thread_id="ts-existing",
    )
    slack = FakeSlackClient()
    connector = SlackConnector(
        store=store,
        slack_client=slack,
        chat_facade=FakeChatFacade(),
        human_gate=HumanGateConfig(board=board, channel="C123"),
        chat_route=ChatRouteConfig(default_node="grove-qa"),
    )

    assert connector.poll_human_gates() == 0

    assert slack.posts == []
    assert slack_thread_modes(store, task=task) == [("human_gate", "ts-existing")]


def test_human_gate_completed_thread_cleans_pending(
    tmp_path: Path,
) -> None:
    board = "main"
    store = SQLiteBoardStore(tmp_path / "board.db")
    task = blocked_human_task(store, board=board)
    record_human_gate_pending(store, board=board, task=task)
    store.upsert_slack_thread(
        board=board,
        task_id=task.id,
        team_id="",
        channel_id="C123",
        thread_ts="ts-complete",
        mode="human_gate",
        node=task.assignee,
    )
    slack = FakeSlackClient()
    connector = SlackConnector(
        store=store,
        slack_client=slack,
        chat_facade=FakeChatFacade(),
        human_gate=HumanGateConfig(board=board, channel="C123"),
        chat_route=ChatRouteConfig(default_node="grove-qa"),
    )

    assert connector.poll_human_gates() == 0

    assert slack.posts == []
    assert slack_thread_modes(store, task=task) == [("human_gate", "ts-complete")]


def test_human_gate_poll_skips_when_channel_missing_or_task_not_marked_human(
    tmp_path: Path,
) -> None:
    board = "main"
    store = SQLiteBoardStore(tmp_path / "board.db")
    task = store.create_task(board=board, title="Plain block", body=None, assignee="grove-qa")
    claimed = store.claim_next(board=board, assignee="grove-qa", node_id="grove-qa", ttl_seconds=60)
    assert claimed is not None
    assert store.block(
        board=board,
        task_id=task.id,
        run_id=claimed.run_id,
        claim_lock=claimed.claim_lock,
        reason="plain block",
    )
    slack = FakeSlackClient()

    no_channel = SlackConnector(
        store=store,
        slack_client=slack,
        chat_facade=FakeChatFacade(),
        human_gate=HumanGateConfig(board=board, channel=None),
        chat_route=ChatRouteConfig(default_node="grove-qa"),
    )
    with_channel = SlackConnector(
        store=store,
        slack_client=slack,
        chat_facade=FakeChatFacade(),
        human_gate=HumanGateConfig(board=board, channel="C123"),
        chat_route=ChatRouteConfig(default_node="grove-qa"),
    )

    assert no_channel.poll_human_gates() == 0
    assert with_channel.poll_human_gates() == 0
    assert slack.posts == []


def test_slack_sdk_history_lookup_scans_all_pages() -> None:
    class FakePaginatedWebClient:
        def __init__(self) -> None:
            self.cursors: list[str | None] = []

        def chat_postMessage(
            self,
            *,
            channel: str,
            text: str,
            thread_ts: str | None = None,
            metadata: Mapping[str, object] | None = None,
        ) -> Mapping[str, object]:
            _ = (channel, text, thread_ts, metadata)
            return {"ts": "unused"}

        def conversations_history(
            self,
            *,
            channel: str,
            limit: int,
            oldest: str | None = None,
            inclusive: bool = True,
            cursor: str | None = None,
        ) -> Mapping[str, object]:
            _ = (channel, limit, oldest, inclusive)
            self.cursors.append(cursor)
            if cursor is None:
                return {
                    "messages": [],
                    "response_metadata": {"next_cursor": "next-page"},
                }
            return {
                "messages": [
                    {
                        "ts": "ts-page-2",
                        "metadata": {
                            "event_type": "grove_human_gate",
                            "event_payload": {"dedup_key": "pending:task-1"},
                        },
                    }
                ],
                "response_metadata": {"next_cursor": ""},
            }

    web_client = FakePaginatedWebClient()
    slack = object.__new__(SlackSdkClient)
    slack._client = web_client

    assert (
        slack.find_message_by_metadata(
            channel="C123",
            event_type="grove_human_gate",
            dedup_key="pending:task-1",
        )
        == "ts-page-2"
    )
    assert web_client.cursors == [None, "next-page"]


def test_slack_sdk_client_rejects_missing_post_ts_and_bad_history() -> None:
    class BadWebClient:
        def __init__(self, history_response: Mapping[str, object]) -> None:
            self.history_response = history_response

        def chat_postMessage(
            self,
            *,
            channel: str,
            text: str,
            thread_ts: str | None = None,
            metadata: Mapping[str, object] | None = None,
        ) -> Mapping[str, object]:
            _ = (channel, text, thread_ts, metadata)
            return {"ok": True}

        def conversations_history(
            self,
            *,
            channel: str,
            limit: int,
            oldest: str | None = None,
            inclusive: bool = True,
            cursor: str | None = None,
        ) -> Mapping[str, object]:
            _ = (channel, limit, oldest, inclusive, cursor)
            return self.history_response

    slack = object.__new__(SlackSdkClient)
    slack._client = BadWebClient({"messages": "bad"})

    with pytest.raises(RuntimeError, match="include ts"):
        slack.post_message(channel="C123", text="hello")
    with pytest.raises(RuntimeError, match="missing messages"):
        slack.find_message_by_metadata(
            channel="C123",
            event_type="grove_human_gate",
            dedup_key="pending:task-1",
        )

    slack._client = BadWebClient(
        {"messages": [], "has_more": True, "response_metadata": {"next_cursor": 123}}
    )
    with pytest.raises(RuntimeError, match="invalid cursor"):
        slack.find_message_by_metadata(
            channel="C123",
            event_type="grove_human_gate",
            dedup_key="pending:task-1",
        )


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


def test_chat_route_handles_facade_failure_and_post_failure_without_crashing(
    tmp_path: Path,
) -> None:
    store = SQLiteBoardStore(tmp_path / "board.db")
    chat = FailingChatFacade("failure at /Users/chopin/secret xoxb-" + ("d" * 44))
    slack = FakeSlackClient()
    connector = SlackConnector(
        store=store,
        slack_client=slack,
        chat_facade=chat,
        human_gate=HumanGateConfig(board="main", channel="C123"),
        chat_route=ChatRouteConfig(default_node="chat-node"),
    )

    assert connector.handle_event(
        SlackEvent(
            team="T1",
            channel="C123",
            user="U2",
            text="please help",
            ts="333.444",
            thread_ts=None,
            event_type="message",
        )
    )
    assert chat.calls == [("slack:T1:C123:333.444", "chat-node", "please help")]
    assert slack.posts == [
        (
            "C123",
            "I could not complete that request safely. Check grove logs for details.",
            "333.444",
        )
    ]

    failing_notice_connector = SlackConnector(
        store=store,
        slack_client=FailingPostSlackClient(),
        chat_facade=FailingChatFacade("safe failure"),
        human_gate=HumanGateConfig(board="main", channel="C123"),
        chat_route=ChatRouteConfig(default_node="chat-node"),
    )
    assert failing_notice_connector.handle_event(
        SlackEvent(
            team="T1",
            channel="C123",
            user="U2",
            text="please help",
            ts="333.555",
            thread_ts=None,
            event_type="message",
        )
    )


def test_slack_connector_ignores_non_message_events(tmp_path: Path) -> None:
    connector = SlackConnector(
        store=SQLiteBoardStore(tmp_path / "board.db"),
        slack_client=FakeSlackClient(),
        chat_facade=FakeChatFacade(),
        human_gate=HumanGateConfig(board="main", channel="C123"),
        chat_route=ChatRouteConfig(default_node="chat-node"),
    )

    assert not connector.handle_event(
        SlackEvent(
            team="T1",
            channel="C123",
            user="U2",
            text="ignored",
            ts="999.000",
            thread_ts=None,
            event_type="reaction_added",
        )
    )


def test_status_probe_reports_bot_auth_ok_for_saved_tokens(tmp_path: Path) -> None:
    config_path = tmp_path / "slack.json"
    SlackConfigStore(config_path).save(SlackConfig(app_token="xapp-ok", bot_token="xoxb-ok"))

    status = FakeStatusProbe(config_path=config_path, bot_auth_ok=True).status()
    tokens = cast(dict[str, str | None], status["tokens"])

    assert status["status"] == "bot_auth_ok"
    assert "state" not in status
    assert tokens["app_token"] == "xapp...p-ok"
    assert tokens["bot_token"] == "xoxb...b-ok"


def test_slack_main_connects_polls_and_closes_socket(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    config_path = tmp_path / "slack.json"
    board_db_path = tmp_path / "board.db"
    SlackConfigStore(config_path).save(
        SlackConfig(
            app_token="xapp-main",
            bot_token="xoxb-main",
            default_channel="C123",
            default_node="chat-node",
        )
    )

    class FakeSocket:
        def __init__(self) -> None:
            self.socket_mode_request_listeners: list[object] = []
            self.connected = False
            self.closed = False

        def connect(self) -> None:
            self.connected = True

        def close(self) -> None:
            self.closed = True

        def send_socket_mode_response(self, response: object) -> None:
            _ = response

    socket = FakeSocket()

    def fake_slack_sdk_client(*, bot_token: str) -> FakeSlackClient:
        assert bot_token == "xoxb-main"
        return FakeSlackClient()

    def fake_chat_facade() -> FakeChatFacade:
        return FakeChatFacade()

    def fake_build_socket_client(
        *,
        config: SlackConfig,
        connector: SlackConnector,
    ) -> FakeSocket:
        assert config.app_token == "xapp-main"
        assert connector.human_gate.channel == "C123"
        return socket

    def stop_after_poll(seconds: float) -> None:
        assert seconds == 0.1
        raise KeyboardInterrupt

    monkeypatch.setattr(slack_module, "SlackSdkClient", fake_slack_sdk_client)
    monkeypatch.setattr(slack_module, "GroveServeChatFacade", fake_chat_facade)
    monkeypatch.setattr(slack_module, "_build_socket_client", fake_build_socket_client)
    monkeypatch.setattr("grove_bridge.slack.time.sleep", stop_after_poll)

    with pytest.raises(KeyboardInterrupt):
        slack_module.main(
            [
                "--config-path",
                str(config_path),
                "--board-db-path",
                str(board_db_path),
                "--poll-interval",
                "0.1",
            ]
        )

    assert socket.connected is True
    assert socket.closed is True


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


def blocked_human_task(store: SQLiteBoardStore, *, board: str) -> Task:
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
    return task


def record_human_gate_pending(store: SQLiteBoardStore, *, board: str, task: Task) -> str:
    pending_key = f"pending:{task.id}"
    store.upsert_slack_thread(
        board=board,
        task_id=task.id,
        team_id="",
        channel_id="C123",
        thread_ts=pending_key,
        mode="human_gate_pending",
        node=task.assignee,
    )
    return pending_key


def slack_thread_modes(store: SQLiteBoardStore, *, task: Task) -> list[tuple[str, str]]:
    return [(thread.mode, thread.thread_ts) for thread in store.list_slack_threads(task_id=task.id)]
