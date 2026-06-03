from __future__ import annotations

from collections.abc import Callable, Mapping
from contextlib import AbstractContextManager
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol, cast

import pytest

from grove_bridge.ask_human import (
    AskHumanConfig,
    AskHumanNotifier,
    AskHumanStartupError,
    SlackWebClient,
    build_ask_human_notifier,
)
from grove_bridge.config import BridgeConfig, LaneConfig
from grove_bridge.grove import GroveRunResult
from grove_bridge.legacy import load_kanban_db
from grove_bridge.plugins.ask_human_reply import handle_pre_gateway_dispatch
from grove_bridge.pull_executor import PullExecutor


class ClaimedTask(Protocol):
    current_run_id: int | None


class StoredTask(Protocol):
    status: str


class StoredComment(Protocol):
    author: str
    body: str


class KanbanDbForTests(Protocol):
    def init_db(self) -> None: ...

    def connect(self) -> AbstractContextManager[object]: ...

    def create_task(self, conn: object, *, title: str, assignee: str) -> str: ...

    def claim_task(
        self,
        conn: object,
        task_id: str,
        *,
        claimer: str | None = None,
    ) -> ClaimedTask | None: ...

    def block_task(
        self,
        conn: object,
        task_id: str,
        *,
        reason: str | None = None,
        expected_run_id: int | None = None,
    ) -> bool: ...

    def add_notify_sub(
        self,
        conn: object,
        *,
        task_id: str,
        platform: str,
        chat_id: str,
        thread_id: str | None = None,
    ) -> None: ...

    def list_notify_subs(
        self,
        conn: object,
        task_id: str | None = None,
    ) -> list[dict[str, object]]: ...

    def get_task(self, conn: object, task_id: str) -> StoredTask: ...

    def list_comments(self, conn: object, task_id: str) -> list[StoredComment]: ...


@dataclass
class Source:
    platform: str
    chat_id: str
    thread_id: str | None
    user_id: str | None = "U-human"
    user_name: str | None = "Human"


@dataclass
class Event:
    text: str
    source: Source


class FakeSlackClient:
    def __init__(self) -> None:
        self.posts: list[tuple[str, str, str | None]] = []

    def post_message(self, channel: str, text: str, thread_ts: str | None = None) -> str:
        self.posts.append((channel, text, thread_ts))
        return "1712345678.000900"


class FakeRunner:
    def run_task(
        self,
        *,
        node: str,
        prompt: str,
        env: Mapping[str, str],
        lane: LaneConfig,
        heartbeat: Callable[[], bool],
    ) -> GroveRunResult:
        heartbeat()
        return GroveRunResult(
            node=node,
            returncode=2,
            stdout="",
            stderr="Need human decision",
            session_id=None,
            transcript_path=None,
            turn_id=None,
            tmux_pane=None,
        )


@pytest.fixture
def kanban_db(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> KanbanDbForTests:
    home = tmp_path / ".legacy"
    home.mkdir()
    monkeypatch.setenv("LEGACY_HOME", str(home))
    kb = cast(KanbanDbForTests, load_kanban_db(Path("/Users/chopin/.legacy/legacy-agent")))
    kb.init_db()
    return kb


def test_block_success_posts_slack_root_and_stores_notify_sub(
    kanban_db: KanbanDbForTests,
) -> None:
    with kanban_db.connect() as conn:
        task_id = kanban_db.create_task(conn, title="Need approval", assignee="grove:codex")

    slack = FakeSlackClient()
    notifier = AskHumanNotifier(
        config=AskHumanConfig(enabled=True, dry_run=False, channel="C-ops"),
        slack_client=slack,
        kanban_db=kanban_db,
    )
    config = BridgeConfig(
        boards=("default",),
        lanes={"grove:codex": LaneConfig(assignee="grove:codex", nodes=("codex-a",))},
        ask_human=AskHumanConfig(enabled=True, dry_run=False, channel="C-ops"),
    )

    result = PullExecutor(
        config=config,
        kanban_db=kanban_db,
        grove_runner=FakeRunner(),
        ask_human_notifier=notifier,
    ).run_once()

    assert result.blocked == 1
    assert len(slack.posts) == 1
    channel, text, thread_ts = slack.posts[0]
    assert channel == "C-ops"
    assert thread_ts is None
    assert "Need approval" in text
    assert "Need human decision" in text
    with kanban_db.connect() as conn:
        subs = kanban_db.list_notify_subs(conn, task_id)
    assert subs == [
        {
            "task_id": task_id,
            "platform": "slack",
            "chat_id": "C-ops",
            "thread_id": "1712345678.000900",
            "user_id": None,
            "notifier_profile": None,
            "created_at": subs[0]["created_at"],
            "last_event_id": 0,
        }
    ]


def test_dry_run_does_not_post_or_store_notify_sub(kanban_db: KanbanDbForTests) -> None:
    with kanban_db.connect() as conn:
        task_id = kanban_db.create_task(conn, title="Dry run", assignee="grove:codex")

    slack = FakeSlackClient()
    notifier = AskHumanNotifier(
        config=AskHumanConfig(enabled=True, dry_run=True, channel="C-ops"),
        slack_client=slack,
        kanban_db=kanban_db,
    )
    config = BridgeConfig(
        boards=("default",),
        lanes={"grove:codex": LaneConfig(assignee="grove:codex", nodes=("codex-a",))},
        ask_human=AskHumanConfig(enabled=True, dry_run=True, channel="C-ops"),
    )

    result = PullExecutor(
        config=config,
        kanban_db=kanban_db,
        grove_runner=FakeRunner(),
        ask_human_notifier=notifier,
    ).run_once()

    assert result.blocked == 1
    assert slack.posts == []
    with kanban_db.connect() as conn:
        assert kanban_db.list_notify_subs(conn, task_id) == []


def test_ask_human_factory_returns_none_when_disabled(kanban_db: KanbanDbForTests) -> None:
    config = BridgeConfig(
        boards=("default",),
        lanes={"grove:codex": LaneConfig(assignee="grove:codex", nodes=("codex-a",))},
        ask_human=AskHumanConfig(enabled=False, dry_run=True, channel=None),
    )

    notifier = build_ask_human_notifier(config=config, kanban_db=kanban_db, env={})

    assert notifier is None


def test_ask_human_factory_creates_real_slack_client_without_posting(
    kanban_db: KanbanDbForTests,
) -> None:
    config = BridgeConfig(
        boards=("default",),
        lanes={"grove:codex": LaneConfig(assignee="grove:codex", nodes=("codex-a",))},
        ask_human=AskHumanConfig(enabled=True, dry_run=False, channel="C-ops"),
    )

    notifier = build_ask_human_notifier(
        config=config,
        kanban_db=kanban_db,
        env={"SLACK_BOT_TOKEN": "xoxb-test-token"},
    )

    assert isinstance(notifier, AskHumanNotifier)
    assert isinstance(notifier.slack_client, SlackWebClient)


def test_ask_human_factory_fails_fast_when_token_missing(
    kanban_db: KanbanDbForTests,
) -> None:
    config = BridgeConfig(
        boards=("default",),
        lanes={"grove:codex": LaneConfig(assignee="grove:codex", nodes=("codex-a",))},
        ask_human=AskHumanConfig(enabled=True, dry_run=False, channel="C-ops"),
    )

    with pytest.raises(AskHumanStartupError, match="SLACK_BOT_TOKEN"):
        build_ask_human_notifier(config=config, kanban_db=kanban_db, env={})


def test_slack_thread_reply_adds_comment_unblocks_and_skips_dispatch(
    kanban_db: KanbanDbForTests,
) -> None:
    with kanban_db.connect() as conn:
        task_id = kanban_db.create_task(conn, title="Reply target", assignee="grove:codex")
        claimed = kanban_db.claim_task(conn, task_id, claimer="test")
        assert claimed is not None
        assert kanban_db.block_task(
            conn,
            task_id,
            reason="need human",
            expected_run_id=claimed.current_run_id,
        )
        kanban_db.add_notify_sub(
            conn,
            task_id=task_id,
            platform="slack",
            chat_id="C-ops",
            thread_id="1712345678.000900",
        )

    event = Event(
        text="Approved, continue.",
        source=Source(platform="slack", chat_id="C-ops", thread_id="1712345678.000900"),
    )

    result = handle_pre_gateway_dispatch(event=event, kanban_db=kanban_db)

    assert result == {"action": "skip", "reason": "ask-human-reply"}
    with kanban_db.connect() as conn:
        task = kanban_db.get_task(conn, task_id)
        comments = kanban_db.list_comments(conn, task_id)
    assert task.status == "ready"
    assert comments[-1].author == "Human"
    assert "Approved, continue." in comments[-1].body


def test_non_matching_slack_thread_allows_dispatch_without_kanban_changes(
    kanban_db: KanbanDbForTests,
) -> None:
    with kanban_db.connect() as conn:
        task_id = kanban_db.create_task(conn, title="No match", assignee="grove:codex")
        kanban_db.add_notify_sub(
            conn,
            task_id=task_id,
            platform="slack",
            chat_id="C-ops",
            thread_id="known-thread",
        )

    event = Event(
        text="Unrelated reply",
        source=Source(platform="slack", chat_id="C-ops", thread_id="other-thread"),
    )

    result = handle_pre_gateway_dispatch(event=event, kanban_db=kanban_db)

    assert result == {"action": "allow"}
    with kanban_db.connect() as conn:
        assert kanban_db.list_comments(conn, task_id) == []
        assert kanban_db.get_task(conn, task_id).status == "ready"


def test_repeated_slack_thread_reply_is_safe_when_task_already_unblocked(
    kanban_db: KanbanDbForTests,
) -> None:
    with kanban_db.connect() as conn:
        task_id = kanban_db.create_task(conn, title="Repeat reply", assignee="grove:codex")
        kanban_db.add_notify_sub(
            conn,
            task_id=task_id,
            platform="slack",
            chat_id="C-ops",
            thread_id="repeat-thread",
        )

    event = Event(
        text="Same answer delivered twice.",
        source=Source(platform="slack", chat_id="C-ops", thread_id="repeat-thread"),
    )

    first = handle_pre_gateway_dispatch(event=event, kanban_db=kanban_db)
    second = handle_pre_gateway_dispatch(event=event, kanban_db=kanban_db)

    assert first == {"action": "skip", "reason": "ask-human-reply"}
    assert second == {"action": "skip", "reason": "ask-human-reply"}
    with kanban_db.connect() as conn:
        assert kanban_db.get_task(conn, task_id).status == "ready"
        assert len(kanban_db.list_comments(conn, task_id)) == 2
