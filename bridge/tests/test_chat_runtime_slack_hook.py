from __future__ import annotations

from pathlib import Path

from grove_bridge.chat_runtime import ProviderRequest
from grove_bridge.slack import ChatRouteConfig, HumanGateConfig, SlackConnector
from grove_bridge.store import SQLiteBoardStore


class _FakeSlack:
    def __init__(self) -> None:
        self.posts: list[tuple[str, str]] = []

    def post_message(self, *, channel: str, text: str, **kwargs: object) -> str:
        _ = kwargs
        self.posts.append((channel, text))
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


def _connector(store: SQLiteBoardStore, slack: _FakeSlack, facade: _FakeFacade) -> SlackConnector:
    return SlackConnector(
        store=store,
        slack_client=slack,
        chat_facade=facade,
        human_gate=HumanGateConfig(board="dev10", channel="C1"),
        chat_route=ChatRouteConfig(default_node="chat-master"),
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

    def generate(self, request: ProviderRequest) -> str:
        self.calls.append(request.user_text)
        return "shadow answer"


class _RaisingAdapter:
    def generate(self, request: ProviderRequest) -> str:
        _ = request
        raise RuntimeError("provider unavailable")


def test_flag_on_generation_failure_falls_through_to_existing_answer(tmp_path: Path) -> None:
    store = SQLiteBoardStore(tmp_path / "b.db")
    store.set_gui_feature_enabled(board="dev10", feature="chat_bridge_runtime", enabled=True)
    slack, facade = _FakeSlack(), _FakeFacade()
    conn = _connector(store, slack, facade)

    # Flag ON: runtime constructed; the guarded branch takes over.
    assert conn._chat_bridge_runtime is not None
    conn._chat_bridge_adapter = _RaisingAdapter()  # deterministic: no real API call

    _enqueue(store)
    conn.poll_node_chat_queue()

    # Generation failed in SHADOW → existing live node route still answers.
    assert facade.calls and facade.calls[0][1] == "chat-master"
    assert slack.posts == [("C1", "node answer")]
    due = store.list_due_slack_chat_messages(
        board="dev10", now=9_999_999_999, running_stale_before=9_999_999_999, limit=10
    )
    assert due == []


def test_flag_on_shadow_generates_without_publish(tmp_path: Path) -> None:
    store = SQLiteBoardStore(tmp_path / "b.db")
    store.set_gui_feature_enabled(board="dev10", feature="chat_bridge_runtime", enabled=True)
    slack, facade = _FakeSlack(), _FakeFacade()
    conn = _connector(store, slack, facade)
    assert conn._chat_bridge_runtime is not None
    adapter = _FakeAdapter()
    conn._chat_bridge_adapter = adapter  # inject (avoid real API)

    _enqueue(store)
    conn.poll_node_chat_queue()

    # SHADOW: generated via the adapter, but existing node answer remains live.
    assert adapter.calls == ["hi"]
    assert facade.calls and facade.calls[0][1] == "chat-master"
    assert slack.posts == [("C1", "node answer")]
    due = store.list_due_slack_chat_messages(
        board="dev10", now=9_999_999_999, running_stale_before=9_999_999_999, limit=10
    )
    assert due == []
