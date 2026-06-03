"""Slack connector for grove board and chat workflows."""

from __future__ import annotations

import argparse
import importlib
import json
import logging
import os
import re
import secrets
import subprocess
import threading
import time
from collections.abc import Callable, Mapping, MutableSequence, Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Protocol, cast

from grove_bridge.auth_status import redact_secret_text
from grove_bridge.config import default_board_db_path
from grove_bridge.store import SlackThread, SQLiteBoardStore, Task

LOGGER = logging.getLogger(__name__)
SLACK_CONFIG_PATH = Path("~/.grove/slack.json").expanduser()
GROVE_CHAT_TIMEOUT_SECONDS = 120.0
HUMAN_GATE_PENDING_TTL_SECONDS = 60
HUMAN_GATE_MODE = "human_gate"
HUMAN_GATE_PENDING_MODE = "human_gate_pending"
HUMAN_GATE_METADATA_EVENT_TYPE = "grove_human_gate"
SLACK_SCOPES = (
    "app_mentions:read",
    "channels:history",
    "chat:write",
    "groups:history",
    "im:history",
    "mpim:history",
)
NODE_MENTION_RE = re.compile(r"(?<![A-Za-z0-9_-])@(?P<node>[A-Za-z0-9_-]+)")


class SlackClientProtocol(Protocol):
    def post_message(
        self,
        *,
        channel: str,
        text: str,
        thread_ts: str | None = None,
        metadata: Mapping[str, object] | None = None,
    ) -> str: ...

    def find_message_by_metadata(
        self,
        *,
        channel: str,
        event_type: str,
        dedup_key: str,
        oldest: str | None = None,
    ) -> str | None: ...


class ChatFacadeProtocol(Protocol):
    def send(self, *, session_id: str, node: str, text: str) -> str: ...


class SlackWebClientProtocol(Protocol):
    def chat_postMessage(
        self,
        *,
        channel: str,
        text: str,
        thread_ts: str | None = None,
        metadata: Mapping[str, object] | None = None,
    ) -> Mapping[str, object]: ...

    def conversations_history(
        self,
        *,
        channel: str,
        limit: int,
        oldest: str | None = None,
        inclusive: bool = True,
        cursor: str | None = None,
    ) -> Mapping[str, object]: ...


class SlackWebClientFactory(Protocol):
    def __call__(self, *, token: str) -> SlackWebClientProtocol: ...


class SocketRequestProtocol(Protocol):
    type: str
    payload: object
    envelope_id: str


class SocketClientProtocol(Protocol):
    socket_mode_request_listeners: MutableSequence[
        Callable[[SocketClientProtocol, SocketRequestProtocol], None]
    ]

    def connect(self) -> None: ...

    def close(self) -> None: ...

    def send_socket_mode_response(self, response: object) -> None: ...


class SocketClientFactory(Protocol):
    def __call__(
        self, *, app_token: str, web_client: SlackWebClientProtocol
    ) -> SocketClientProtocol: ...


class SocketResponseFactory(Protocol):
    def __call__(self, *, envelope_id: str) -> object: ...


@dataclass(frozen=True)
class SlackConfig:
    app_token: str
    bot_token: str
    default_channel: str | None = None
    default_node: str | None = None

    def __post_init__(self) -> None:
        if not self.app_token.startswith("xapp-"):
            raise ValueError("app_token must start with xapp-")
        if not self.bot_token.startswith("xoxb-"):
            raise ValueError("bot_token must start with xoxb-")

    def masked(self) -> dict[str, str | None]:
        return {
            "app_token": mask_token(self.app_token),
            "bot_token": mask_token(self.bot_token),
            "default_channel": self.default_channel,
            "default_node": self.default_node,
        }


@dataclass(frozen=True)
class HumanGateConfig:
    board: str
    channel: str | None = None


@dataclass(frozen=True)
class ChatRouteConfig:
    default_node: str
    channel_nodes: Mapping[str, str] = field(default_factory=dict)
    mention_nodes: Mapping[str, str] = field(default_factory=dict)


@dataclass(frozen=True)
class SlackEvent:
    team: str
    channel: str
    user: str
    text: str
    ts: str
    thread_ts: str | None
    event_type: str


class SlackConfigStore:
    def __init__(self, path: Path = SLACK_CONFIG_PATH) -> None:
        self.path = path.expanduser()

    def load(self) -> SlackConfig | None:
        if not self.path.is_file():
            return None
        loaded = json.loads(self.path.read_text(encoding="utf-8"))
        if not isinstance(loaded, dict):
            raise ValueError("invalid slack config")
        return SlackConfig(
            app_token=_required_str(loaded, "app_token"),
            bot_token=_required_str(loaded, "bot_token"),
            default_channel=_optional_str(loaded, "default_channel"),
            default_node=_optional_str(loaded, "default_node"),
        )

    def save(self, config: SlackConfig) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        payload = {
            "app_token": config.app_token,
            "bot_token": config.bot_token,
            "default_channel": config.default_channel,
            "default_node": config.default_node,
        }
        temp_path = self.path.with_name(f".{self.path.name}.{secrets.token_hex(8)}.tmp")
        fd = os.open(temp_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as handle:
                fd = -1
                handle.write(json.dumps(payload, indent=2) + "\n")
            os.replace(temp_path, self.path)
        except Exception:
            if fd >= 0:
                os.close(fd)
            try:
                temp_path.unlink()
            except FileNotFoundError:
                pass
            raise


class FakeStatusProbe:
    def __init__(
        self,
        *,
        config_path: Path = SLACK_CONFIG_PATH,
        bot_auth_ok: bool = False,
        socket_connected: bool = False,
        last_event_at: int | None = None,
        last_error: str | None = None,
    ) -> None:
        self.config_path = config_path
        self.bot_auth_ok = bot_auth_ok
        self.socket_connected = socket_connected
        self.last_event_at = last_event_at
        self.last_error = last_error

    def status(self) -> dict[str, object]:
        config = SlackConfigStore(self.config_path).load()
        if config is None:
            status = "not_configured"
            tokens: dict[str, str | None] = {}
        elif self.socket_connected:
            status = "socket_connected"
            tokens = config.masked()
        elif self.bot_auth_ok:
            status = "bot_auth_ok"
            tokens = config.masked()
        else:
            status = "tokens_saved"
            tokens = config.masked()
        return {
            "status": status,
            "last_event_at": self.last_event_at,
            "last_error": self.last_error,
            "tokens": tokens,
        }


class SlackSdkClient:
    def __init__(self, *, bot_token: str) -> None:
        web_module = importlib.import_module("slack_sdk.web")
        web_client = cast(SlackWebClientFactory, web_module.WebClient)
        self._client = web_client(token=bot_token)

    def post_message(
        self,
        *,
        channel: str,
        text: str,
        thread_ts: str | None = None,
        metadata: Mapping[str, object] | None = None,
    ) -> str:
        response = self._client.chat_postMessage(
            channel=channel,
            text=text,
            thread_ts=thread_ts,
            metadata=metadata,
        )
        ts = response.get("ts") if isinstance(response, dict) else None
        if not isinstance(ts, str):
            raise RuntimeError("Slack response did not include ts")
        return ts

    def find_message_by_metadata(
        self,
        *,
        channel: str,
        event_type: str,
        dedup_key: str,
        oldest: str | None = None,
    ) -> str | None:
        cursor: str | None = None
        while True:
            response = self._client.conversations_history(
                channel=channel,
                limit=100,
                oldest=oldest,
                inclusive=True,
                cursor=cursor,
            )
            messages = response.get("messages")
            if not isinstance(messages, Sequence) or isinstance(messages, str | bytes):
                raise RuntimeError("Slack history response missing messages")
            for raw_message in messages:
                if not isinstance(raw_message, Mapping):
                    continue
                metadata = raw_message.get("metadata")
                if not isinstance(metadata, Mapping):
                    continue
                if not _message_metadata_matches(
                    metadata,
                    event_type=event_type,
                    dedup_key=dedup_key,
                ):
                    continue
                ts = raw_message.get("ts")
                if isinstance(ts, str) and ts.strip():
                    return ts
            cursor = _next_history_cursor(response)
            if cursor is None:
                return None


class GroveServeChatFacade:
    def __init__(self, *, grove_binary: str = "grove") -> None:
        self.grove_binary = grove_binary

    def send(self, *, session_id: str, node: str, text: str) -> str:
        proc = subprocess.run(
            [
                self.grove_binary,
                "serve",
                "chat",
                "--node",
                node,
                "--session-id",
                session_id,
            ],
            input=text,
            capture_output=True,
            text=True,
            timeout=GROVE_CHAT_TIMEOUT_SECONDS,
            check=False,
        )
        if proc.returncode != 0:
            raise RuntimeError(proc.stderr.strip() or f"grove serve exited {proc.returncode}")
        return proc.stdout.strip()


class SlackConnector:
    def __init__(
        self,
        *,
        store: SQLiteBoardStore,
        slack_client: SlackClientProtocol,
        chat_facade: ChatFacadeProtocol,
        human_gate: HumanGateConfig,
        chat_route: ChatRouteConfig,
    ) -> None:
        self.store = store
        self.slack_client = slack_client
        self.chat_facade = chat_facade
        self.human_gate = human_gate
        self.chat_route = chat_route
        self._locks: dict[str, threading.Lock] = {}

    def poll_human_gates(self) -> int:
        channel = self.human_gate.channel
        if channel is None:
            return 0
        posted = 0
        for task in self.store.list_tasks(board=self.human_gate.board, status="blocked"):
            if not _needs_human(task):
                continue
            pending = _pending_human_gate_thread(self.store, task, channel=channel)
            if self._existing_human_gate_thread(task=task, channel=channel) is not None:
                if pending is not None:
                    self._delete_pending_human_gate(task=task, channel=channel)
                continue
            if pending is not None and self._recover_pending_human_gate(
                task=task,
                channel=channel,
                pending=pending,
            ):
                continue
            text = _human_gate_text(task)
            pending_thread_ts = _pending_thread_key(task)
            self.store.upsert_slack_thread(
                board=self.human_gate.board,
                task_id=task.id,
                team_id="",
                channel_id=channel,
                thread_ts=pending_thread_ts,
                mode=HUMAN_GATE_PENDING_MODE,
                node=task.assignee,
            )
            try:
                thread_ts = self.slack_client.post_message(
                    channel=channel,
                    text=text,
                    metadata=_human_gate_metadata(task),
                )
            except Exception as exc:
                LOGGER.warning("Slack human gate post failed: %s", _safe_log_error(exc))
                continue
            self._record_human_gate_thread(task=task, channel=channel, thread_ts=thread_ts)
            self._delete_pending_human_gate(task=task, channel=channel)
            posted += 1
        return posted

    def _recover_pending_human_gate(
        self,
        *,
        task: Task,
        channel: str,
        pending: SlackThread,
    ) -> bool:
        if self._existing_human_gate_thread(task=task, channel=channel) is not None:
            self._delete_pending_human_gate(task=task, channel=channel)
            return True
        if not _pending_stale(pending):
            return True
        try:
            thread_ts = self.slack_client.find_message_by_metadata(
                channel=channel,
                event_type=HUMAN_GATE_METADATA_EVENT_TYPE,
                dedup_key=_pending_thread_key(task),
                oldest=str(max(0, _pending_created_at(pending) - HUMAN_GATE_PENDING_TTL_SECONDS)),
            )
        except Exception as exc:
            LOGGER.warning("Slack human gate reconciliation failed: %s", _safe_log_error(exc))
            return True
        if thread_ts is not None:
            self._record_human_gate_thread(task=task, channel=channel, thread_ts=thread_ts)
            self._delete_pending_human_gate(task=task, channel=channel)
            return True
        self._delete_pending_human_gate(task=task, channel=channel)
        return False

    def _existing_human_gate_thread(self, *, task: Task, channel: str) -> str | None:
        for thread in self.store.list_slack_threads(task_id=task.id, mode=HUMAN_GATE_MODE):
            if thread.channel_id == channel:
                return thread.thread_ts
        for sub in self.store.list_notify_subs(board=self.human_gate.board, task_id=task.id):
            if sub.channel_kind != "slack" or sub.room_id != channel or not sub.thread_id:
                continue
            self.store.upsert_slack_thread(
                board=self.human_gate.board,
                task_id=task.id,
                team_id="",
                channel_id=channel,
                thread_ts=sub.thread_id,
                mode=HUMAN_GATE_MODE,
                node=task.assignee,
            )
            return sub.thread_id
        return None

    def _record_human_gate_thread(self, *, task: Task, channel: str, thread_ts: str) -> None:
        self.store.add_notify_sub(
            board=self.human_gate.board,
            task_id=task.id,
            channel_kind="slack",
            room_id=channel,
            thread_id=thread_ts,
        )
        self.store.upsert_slack_thread(
            board=self.human_gate.board,
            task_id=task.id,
            team_id="",
            channel_id=channel,
            thread_ts=thread_ts,
            mode=HUMAN_GATE_MODE,
            node=task.assignee,
        )

    def _delete_pending_human_gate(self, *, task: Task, channel: str) -> None:
        self.store.delete_slack_thread(
            board=self.human_gate.board,
            task_id=task.id,
            team_id="",
            channel_id=channel,
            thread_ts=_pending_thread_key(task),
            mode=HUMAN_GATE_PENDING_MODE,
        )

    def handle_event(self, event: SlackEvent) -> bool:
        if event.event_type not in {"app_mention", "message"}:
            return False
        thread_ts = event.thread_ts or event.ts
        if event.thread_ts is not None and self._handle_human_reply(event, thread_ts=thread_ts):
            return True
        return self._handle_chat(event, thread_ts=thread_ts)

    def _handle_human_reply(self, event: SlackEvent, *, thread_ts: str) -> bool:
        sub = self.store.find_notify_sub(
            channel_kind="slack",
            room_id=event.channel,
            thread_id=thread_ts,
        )
        if sub is None:
            return False
        task = self.store.get_task_by_id(sub.task_id)
        if task.status != "blocked" or not _needs_human(task):
            return True
        author = f"slack:{event.user}"
        self.store.add_comment_to_task(task_id=task.id, author=author, body=event.text)
        if self.store.unblock_task_by_id(task_id=task.id, actor=author):
            self.slack_client.post_message(
                channel=event.channel,
                text="Recorded your reply and unblocked the task.",
                thread_ts=thread_ts,
            )
        return True

    def _handle_chat(self, event: SlackEvent, *, thread_ts: str) -> bool:
        node = _select_chat_node(event, self.chat_route)
        session_id = f"slack:{event.team}:{event.channel}:{thread_ts}"
        text = _normalize_slack_text(event.text)
        lock = self._locks.setdefault(session_id, threading.Lock())
        try:
            with lock:
                response = self.chat_facade.send(session_id=session_id, node=node, text=text)
        except Exception as exc:
            LOGGER.warning("Slack chat facade failed: %s", _safe_log_error(exc))
            try:
                self.slack_client.post_message(
                    channel=event.channel,
                    text="I could not complete that request safely. Check grove logs for details.",
                    thread_ts=thread_ts,
                )
            except Exception as post_exc:
                LOGGER.warning(
                    "Slack failure notice could not be posted: %s",
                    _safe_log_error(post_exc),
                )
            return True
        self.store.upsert_slack_thread(
            board=self.human_gate.board,
            task_id=None,
            team_id=event.team,
            channel_id=event.channel,
            thread_ts=thread_ts,
            mode="chat",
            node=node,
        )
        self.slack_client.post_message(channel=event.channel, text=response, thread_ts=thread_ts)
        return True


def slack_manifest() -> dict[str, object]:
    return {
        "display_information": {"name": "grove"},
        "features": {
            "bot_user": {
                "display_name": "grove",
                "always_online": True,
                "oauth_scopes": list(SLACK_SCOPES),
            },
        },
        "oauth_config": {"scopes": {"bot": list(SLACK_SCOPES)}},
        "settings": {
            "socket_mode_enabled": True,
            "event_subscriptions": {
                "bot_events": ["app_mention", "message.channels"],
            },
        },
    }


def config_status(config_path: Path = SLACK_CONFIG_PATH) -> dict[str, object]:
    return FakeStatusProbe(config_path=config_path).status()


def mask_token(value: str) -> str:
    if len(value) <= 7:
        return value[:4] + "..." + value[-4:]
    if len(value) <= 8:
        return value[:4] + "..." + value[-3:]
    return value[:4] + "..." + value[-4:]


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Run the grove Slack connector.")
    parser.add_argument("--config-path", type=Path, default=SLACK_CONFIG_PATH)
    parser.add_argument("--board", default="default")
    parser.add_argument("--channel")
    parser.add_argument("--default-node")
    parser.add_argument("--board-db-path", type=Path, default=default_board_db_path())
    parser.add_argument("--poll-interval", type=float, default=5.0)
    args = parser.parse_args(argv)

    config = SlackConfigStore(args.config_path).load()
    if config is None:
        raise SystemExit("Slack config not found; save tokens first")
    channel = args.channel or config.default_channel
    node = args.default_node or config.default_node
    if channel is None:
        raise SystemExit("Slack default channel is required")
    if node is None:
        raise SystemExit("Slack default node is required")
    connector = SlackConnector(
        store=SQLiteBoardStore(args.board_db_path),
        slack_client=SlackSdkClient(bot_token=config.bot_token),
        chat_facade=GroveServeChatFacade(),
        human_gate=HumanGateConfig(board=args.board, channel=channel),
        chat_route=ChatRouteConfig(default_node=node),
    )
    socket_client = _build_socket_client(config=config, connector=connector)
    socket_client.connect()
    try:
        while True:
            connector.poll_human_gates()
            time.sleep(args.poll_interval)
    finally:
        socket_client.close()


def _build_socket_client(*, config: SlackConfig, connector: SlackConnector) -> SocketClientProtocol:
    socket_module = importlib.import_module("slack_sdk.socket_mode")
    response_module = importlib.import_module("slack_sdk.socket_mode.response")
    socket_client_cls = cast(
        SocketClientFactory,
        socket_module.SocketModeClient,
    )
    response_cls = cast(
        SocketResponseFactory,
        response_module.SocketModeResponse,
    )
    web_module = importlib.import_module("slack_sdk.web")
    web_client_cls = cast(SlackWebClientFactory, web_module.WebClient)
    socket_client = socket_client_cls(
        app_token=config.app_token,
        web_client=web_client_cls(token=config.bot_token),
    )

    def listener(client: SocketClientProtocol, request: SocketRequestProtocol) -> None:
        if request.type == "events_api":
            event = _event_from_socket_payload(cast(Mapping[str, object], request.payload))
            if event is not None:
                connector.handle_event(event)
        client.send_socket_mode_response(response_cls(envelope_id=request.envelope_id))

    socket_client.socket_mode_request_listeners.append(listener)
    return socket_client


def _event_from_socket_payload(payload: Mapping[str, object]) -> SlackEvent | None:
    raw_event = payload.get("event")
    if not isinstance(raw_event, dict):
        return None
    event = cast(Mapping[str, object], raw_event)
    team = payload.get("team_id")
    channel = event.get("channel")
    user = event.get("user")
    text = event.get("text")
    ts = event.get("ts")
    if not all(isinstance(value, str) for value in (team, channel, user, text, ts)):
        return None
    thread_ts = event.get("thread_ts")
    event_type = event.get("type")
    return SlackEvent(
        team=cast(str, team),
        channel=cast(str, channel),
        user=cast(str, user),
        text=cast(str, text),
        ts=cast(str, ts),
        thread_ts=thread_ts if isinstance(thread_ts, str) else None,
        event_type=event_type if isinstance(event_type, str) else "message",
    )


def _needs_human(task: Task) -> bool:
    return bool(task.metadata.get("needs_human"))


def _pending_human_gate_thread(
    store: SQLiteBoardStore,
    task: Task,
    *,
    channel: str,
) -> SlackThread | None:
    for thread in store.list_slack_threads(task_id=task.id, mode=HUMAN_GATE_PENDING_MODE):
        if thread.channel_id == channel and thread.thread_ts == _pending_thread_key(task):
            return thread
    return None


def _pending_thread_key(task: Task) -> str:
    return f"pending:{task.id}"


def _pending_stale(pending: SlackThread) -> bool:
    return _pending_created_at(pending) + HUMAN_GATE_PENDING_TTL_SECONDS <= int(time.time())


def _pending_created_at(pending: SlackThread) -> int:
    return pending.created_at or pending.updated_at


def _human_gate_metadata(task: Task) -> dict[str, object]:
    return {
        "event_type": HUMAN_GATE_METADATA_EVENT_TYPE,
        "event_payload": {
            "task_id": task.id,
            "dedup_key": _pending_thread_key(task),
        },
    }


def _message_metadata_matches(
    metadata: Mapping[object, object],
    *,
    event_type: str,
    dedup_key: str,
) -> bool:
    if metadata.get("event_type") != event_type:
        return False
    payload = metadata.get("event_payload")
    return isinstance(payload, Mapping) and payload.get("dedup_key") == dedup_key


def _next_history_cursor(response: Mapping[str, object]) -> str | None:
    raw_metadata = response.get("response_metadata")
    if raw_metadata is None:
        if response.get("has_more") is True:
            raise RuntimeError("Slack history response missing cursor")
        return None
    if not isinstance(raw_metadata, Mapping):
        raise RuntimeError("Slack history response has invalid pagination metadata")
    raw_cursor = raw_metadata.get("next_cursor")
    if raw_cursor is None:
        if response.get("has_more") is True:
            raise RuntimeError("Slack history response missing cursor")
        return None
    if not isinstance(raw_cursor, str):
        raise RuntimeError("Slack history response has invalid cursor")
    cursor = raw_cursor.strip()
    if not cursor and response.get("has_more") is True:
        raise RuntimeError("Slack history response missing cursor")
    return cursor or None


def _has_slack_thread(store: SQLiteBoardStore, task: Task) -> bool:
    return bool(store.list_slack_threads(task_id=task.id, mode=HUMAN_GATE_MODE)) or bool(
        store.list_slack_threads(task_id=task.id, mode=HUMAN_GATE_PENDING_MODE)
    )


def _safe_log_error(exc: Exception) -> str:
    clean = " ".join(str(exc).replace("\r", "\n").split())
    return redact_secret_text(clean)[:300] or exc.__class__.__name__


def _human_gate_text(task: Task) -> str:
    question = task.metadata.get("question")
    question_text = question if isinstance(question, str) and question.strip() else task.body or ""
    return (
        f"*{task.title}*\n"
        f"Task: `{task.id}`\n"
        f"Blocked node: `{task.assignee or 'unassigned'}`\n\n"
        f"{question_text}\n\n"
        "Reply in this thread to unblock the task."
    )


def _normalize_slack_text(text: str) -> str:
    return " ".join(part for part in text.split() if not part.startswith("<@"))


def _select_chat_node(event: SlackEvent, route: ChatRouteConfig) -> str:
    channel_node = route.channel_nodes.get(event.channel)
    if channel_node is not None:
        return channel_node
    for match in NODE_MENTION_RE.finditer(event.text):
        mentioned = match.group("node")
        return route.mention_nodes.get(mentioned, mentioned)
    return route.default_node


def _required_str(mapping: Mapping[str, object], key: str) -> str:
    value = mapping.get(key)
    if not isinstance(value, str) or not value:
        raise ValueError(f"{key} is required")
    return value


def _optional_str(mapping: Mapping[str, object], key: str) -> str | None:
    value = mapping.get(key)
    if value is None:
        return None
    if not isinstance(value, str):
        raise ValueError(f"{key} must be a string")
    return value or None


if __name__ == "__main__":
    raise SystemExit(main())
