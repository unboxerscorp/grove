from __future__ import annotations

from collections.abc import Sequence
from pathlib import Path

import pytest

import grove_bridge.slack as slack_module
from grove_bridge.chat_runtime import ChatTool, ProviderRequest
from grove_bridge.slack import (
    ChatRouteConfig,
    HumanGateConfig,
    SlackCommandConfig,
    SlackCommandMember,
    SlackConnector,
)
from grove_bridge.store import SQLiteBoardStore


class _FakeSlack:
    def __init__(self) -> None:
        self.posts: list[tuple[str, str]] = []
        self.post_kwargs: list[dict[str, object]] = []

    def post_message(self, *, channel: str, text: str, **kwargs: object) -> str:
        self.posts.append((channel, text))
        self.post_kwargs.append(dict(kwargs))
        return "ts"

    def find_message_by_metadata(self, **kwargs: object) -> None:
        _ = kwargs
        return None


class _FakeFacade:
    def __init__(self) -> None:
        self.calls: list[tuple[str, str, str]] = []

    def send(self, *, session_id: str, node: str, text: str) -> str:
        self.calls.append((session_id, node, text))
        return "node answer"


def _connector(
    store: SQLiteBoardStore,
    slack: _FakeSlack,
    facade: _FakeFacade,
    *,
    command_config: SlackCommandConfig | None = None,
) -> SlackConnector:
    return SlackConnector(
        store=store,
        slack_client=slack,
        chat_facade=facade,
        human_gate=HumanGateConfig(board="dev10", channel="C1"),
        chat_route=ChatRouteConfig(default_node="chat-master"),
        command_config=command_config,
        route_chat_to_node=True,
    )


def _enqueue(store: SQLiteBoardStore) -> None:
    store.enqueue_slack_chat_message(
        board="dev10",
        team_id="T",
        channel_id="C1",
        thread_ts="th",
        message_ts="1.1",
        user_id="U",
        node="chat-master",
        text="hi",
    )


def test_flag_off_runtime_not_constructed_and_existing_path_unchanged(tmp_path: Path) -> None:
    store = SQLiteBoardStore(tmp_path / "b.db")
    slack, facade = _FakeSlack(), _FakeFacade()
    conn = _connector(store, slack, facade)

    # Flag OFF (default): the new runtime component is NOT constructed.
    assert conn._chat_bridge_runtime is None

    _enqueue(store)
    processed = conn.poll_node_chat_queue()
    assert processed == 1
    # Existing path ran byte-identically: routed to the node + posted the answer.
    assert facade.calls and facade.calls[0][1] == "chat-master"
    assert slack.posts


class _FakeAdapter:
    def __init__(self) -> None:
        self.calls: list[str] = []

    def generate(self, request: ProviderRequest, *, tools: Sequence[ChatTool] = ()) -> str:
        self.calls.append(request.user_text)
        return "shadow answer"


class _RaisingAdapter:
    def generate(self, request: ProviderRequest, *, tools: Sequence[ChatTool] = ()) -> str:
        _ = (request, tools)
        raise RuntimeError("provider unavailable")


def test_flag_on_generation_failure_defers_without_cli_fallback(tmp_path: Path) -> None:
    store = SQLiteBoardStore(tmp_path / "b.db")
    store.set_gui_feature_enabled(board="dev10", feature="chat_bridge_runtime", enabled=True)
    slack, facade = _FakeSlack(), _FakeFacade()
    conn = _connector(store, slack, facade)

    # Flag ON: runtime constructed; the guarded branch takes over.
    assert conn._chat_bridge_runtime is not None
    conn._chat_bridge_adapter = _RaisingAdapter()  # deterministic: no real API call

    _enqueue(store)
    conn.poll_node_chat_queue()

    # Runtime ON owns the turn. A provider failure leaves the durable queue
    # retryable and never calls the persistent CLI node fallback.
    assert facade.calls == []
    assert slack.posts == []
    due = store.list_due_slack_chat_messages(
        board="dev10", now=9_999_999_999, running_stale_before=9_999_999_999, limit=10
    )
    assert len(due) == 1
    assert due[0].attempts == 1
    assert due[0].last_error == "provider unavailable"


class _DegradeProposalAdapter:
    def generate(self, request: ProviderRequest, *, tools: Sequence[ChatTool] = ()) -> str:
        _ = request
        return '<<<GROVE_TASK_PROPOSAL>>>{"title": "정리", "card_text": "태스크로 만들까요?"}'


def test_flag_on_unconfirmable_proposal_degrades_to_plain_and_completes(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    # A task_proposal turn whose confirmable preview cannot be built MUST degrade to
    # a plain answer + COMPLETE — never raise→defer→infinite-retry (the live stuck-queue).
    store = SQLiteBoardStore(tmp_path / "b.db")
    store.set_gui_feature_enabled(board="dev10", feature="chat_bridge_runtime", enabled=True)
    slack, facade = _FakeSlack(), _FakeFacade()
    conn = _connector(store, slack, facade)
    assert conn._chat_bridge_runtime is not None
    conn._chat_bridge_adapter = _DegradeProposalAdapter()
    # Force the confirmable-preview build to fail.
    monkeypatch.setattr(conn, "_chat_bridge_runtime_task_preview", lambda *a, **k: None)

    _enqueue(store)
    conn.poll_node_chat_queue()

    # Degraded to a plain answer (LLM-authored text) + posted; no CLI fallback.
    assert facade.calls == []
    assert slack.posts and slack.posts[0][0] == "C1"
    # Completed — NOT left on the durable queue (no infinite-retry stuck).
    due = store.list_due_slack_chat_messages(
        board="dev10", now=9_999_999_999, running_stale_before=9_999_999_999, limit=10
    )
    assert due == []


def test_flag_on_missing_provider_defers_without_cli_fallback(tmp_path: Path) -> None:
    store = SQLiteBoardStore(tmp_path / "b.db")
    store.set_gui_feature_enabled(board="dev10", feature="chat_bridge_runtime", enabled=True)
    slack, facade = _FakeSlack(), _FakeFacade()
    conn = _connector(store, slack, facade)

    _enqueue(store)
    conn.poll_node_chat_queue()

    assert facade.calls == []
    assert slack.posts == []
    due = store.list_due_slack_chat_messages(
        board="dev10", now=9_999_999_999, running_stale_before=9_999_999_999, limit=10
    )
    assert len(due) == 1
    assert due[0].attempts == 1
    assert due[0].last_error == "chat bridge runtime unavailable"


def test_flag_on_gemini_runtime_generates_and_publishes_without_cli_node(tmp_path: Path) -> None:
    store = SQLiteBoardStore(tmp_path / "b.db")
    store.set_gui_feature_enabled(board="dev10", feature="chat_bridge_runtime", enabled=True)
    slack, facade = _FakeSlack(), _FakeFacade()
    conn = _connector(store, slack, facade)
    assert conn._chat_bridge_runtime is not None
    adapter = _FakeAdapter()
    conn._chat_bridge_adapter = adapter  # inject (avoid real API)
    conversation_id = "slack:T:C1:th"
    store.append_master_chat_message(
        board="dev10",
        conversation_id=conversation_id,
        role="user",
        text="earlier question",
        request_id="prev-1",
        origin_surface="slack",
    )
    store.append_master_chat_message(
        board="dev10",
        conversation_id=conversation_id,
        role="assistant",
        text="earlier answer",
        request_id="prev-1",
        origin_surface="slack",
    )

    _enqueue(store)
    conn.poll_node_chat_queue()

    # Runtime live path: generated via the adapter and posted directly; the CLI
    # node route is not called.
    assert len(adapter.calls) == 1
    assert "Conversation history:" in adapter.calls[0]
    assert "earlier question" in adapter.calls[0]
    assert "earlier answer" in adapter.calls[0]
    assert "Current user message:\nhi" in adapter.calls[0]
    assert facade.calls == []
    assert slack.posts == [("C1", "shadow answer")]
    history = store.list_master_chat_messages(board="dev10", conversation_id=conversation_id)
    assert [(message.role, message.text) for message in history] == [
        ("user", "earlier question"),
        ("assistant", "earlier answer"),
        ("user", "hi"),
        ("assistant", "shadow answer"),
    ]
    due = store.list_due_slack_chat_messages(
        board="dev10", now=9_999_999_999, running_stale_before=9_999_999_999, limit=10
    )
    assert due == []


class _ProposalAdapter:
    def generate(self, request: ProviderRequest, *, tools: Sequence[ChatTool] = ()) -> str:
        assert "Current user message:\nhi" in request.user_text
        return (
            '<<<GROVE_TASK_PROPOSAL>>>{"title":"Slack task",'
            '"body":"Slack에서 요청한 작업","project":"dev10","worktree":null,'
            '"card_text":"이 요청을 Slack task로 등록할까요?"}'
        )


def test_flag_on_runtime_task_proposal_uses_confirm_without_intake_flag(
    tmp_path: Path,
) -> None:
    store = SQLiteBoardStore(tmp_path / "b.db")
    store.set_gui_feature_enabled(board="dev10", feature="chat_bridge_runtime", enabled=True)
    store.set_gui_feature_enabled(board="dev10", feature="intake", enabled=False)
    slack, facade = _FakeSlack(), _FakeFacade()
    command_config = SlackCommandConfig(
        board="dev10",
        members={
            "U": SlackCommandMember(
                member_id="lead",
                name="lead",
                role="operator",
            )
        },
    )
    conn = _connector(store, slack, facade, command_config=command_config)
    conn._chat_bridge_adapter = _ProposalAdapter()

    _enqueue(store)
    conn.poll_node_chat_queue()

    assert facade.calls == []
    assert slack.posts == [("C1", "이 요청을 Slack task로 등록할까요?")]
    blocks = slack.post_kwargs[0]["blocks"]
    assert isinstance(blocks, tuple)
    confirmation_id = blocks[1]["elements"][0]["value"]
    handled = conn.handle_interaction(
        {
            "type": "block_actions",
            "team": {"id": "T"},
            "channel": {"id": "C1"},
            "user": {"id": "U"},
            "message": {"ts": "1.2", "thread_ts": "th"},
            "actions": [
                {
                    "action_id": slack_module.INTAKE_CONFIRM_ACTION_ID,
                    "value": confirmation_id,
                }
            ],
        }
    )

    assert handled is True
    tasks = store.list_tasks(board="dev10")
    assert [task.title for task in tasks] == ["Slack task"]
    runtime_meta = tasks[0].metadata["chat_runtime"]
    assert isinstance(runtime_meta, dict)
    assert runtime_meta["source"] == "slack"
    assert len(slack.posts) == 2


def test_runtime_flag_and_provider_refresh_without_slack_restart(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("HOME", str(tmp_path))
    store = SQLiteBoardStore(tmp_path / "b.db")
    slack, facade = _FakeSlack(), _FakeFacade()
    conn = _connector(store, slack, facade)
    assert conn._chat_bridge_runtime is None

    provider_dir = tmp_path / ".grove" / "dev10"
    provider_dir.mkdir(parents=True)
    (provider_dir / "chat-provider.json").write_text(
        '{"provider":"gemini","model":"gemini-test","api_key":"AIza-test-key"}',
        encoding="utf-8",
    )

    class _FakeGeminiAdapter:
        def __init__(self, *, api_key: str, model: str) -> None:
            self.api_key = api_key
            self.model = model

        def generate(self, request: ProviderRequest, *, tools: Sequence[ChatTool] = ()) -> str:
            assert "Current user message:\nhi" in request.user_text
            return "runtime answer"

    monkeypatch.setattr(slack_module, "GeminiChatProviderAdapter", _FakeGeminiAdapter)
    store.set_gui_feature_enabled(board="dev10", feature="chat_bridge_runtime", enabled=True)

    _enqueue(store)
    conn.poll_node_chat_queue()

    assert facade.calls == []
    assert slack.posts == [("C1", "runtime answer")]


def test_flag_on_passes_get_project_tasks_tool_to_adapter(tmp_path: Path) -> None:
    # The shadow worker must hand the read-only get_project_tasks tool to the
    # provider so real-state questions are answered from the board, not guessed.
    store = SQLiteBoardStore(tmp_path / "b.db")
    store.set_gui_feature_enabled(board="dev10", feature="chat_bridge_runtime", enabled=True)
    slack, facade = _FakeSlack(), _FakeFacade()
    conn = _connector(store, slack, facade)
    assert conn._chat_bridge_runtime is not None
    seen: list[str] = []

    class _RecordingToolsAdapter:
        def generate(self, request: ProviderRequest, *, tools: Sequence[ChatTool] = ()) -> str:
            _ = request
            seen.extend(t.name for t in tools)
            return "shadow answer"

    conn._chat_bridge_adapter = _RecordingToolsAdapter()

    _enqueue(store)
    conn.poll_node_chat_queue()

    assert "get_project_tasks" in seen
