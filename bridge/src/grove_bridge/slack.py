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
import urllib.request
from collections import deque
from collections.abc import Callable, Mapping, MutableSequence, Sequence
from dataclasses import dataclass, field, replace
from pathlib import Path
from typing import Literal, Protocol, cast

from grove_bridge.assistant import (
    ASSISTANT_TRANSPORT_FALLBACK_TEXT,
    AssistantActor,
    AssistantBroker,
    AssistantContentBlocked,
    AssistantContext,
    AssistantScope,
    AssistantTransportError,
    AssistantUnavailable,
)
from grove_bridge.auth_status import redact_secret_text
from grove_bridge.config import default_board_db_path
from grove_bridge.context_pack import ContextPackNode, prepend_grove_context_pack
from grove_bridge.master import MasterChatResponse, MasterChatResponseType
from grove_bridge.project_directory import ProjectDirectory
from grove_bridge.store import BoardEvent, SlackChatQueueItem, SlackThread, SQLiteBoardStore, Task

LOGGER = logging.getLogger(__name__)
SLACK_CONFIG_PATH = Path("~/.grove/slack.json").expanduser()
SLACK_RUNTIME_STATUS_FILENAME = "slack-runtime.json"
SLACK_RUNTIME_STATUS_TTL_SECONDS = 30
SLACK_COMMAND_MEMBERS_FILENAME = "slack-command-members.json"
# Cap on prior-turn lines folded into the node-direct per-thread context-pack.
_NODE_CHAT_HISTORY_LIMIT = 12
GROVE_CHAT_TIMEOUT_SECONDS = 120.0
HUMAN_GATE_PENDING_TTL_SECONDS = 60
HUMAN_GATE_MODE = "human_gate"
HUMAN_GATE_PENDING_MODE = "human_gate_pending"
HUMAN_GATE_METADATA_EVENT_TYPE = "grove_human_gate"
TASK_COMPLETION_METADATA_EVENT_TYPE = "grove_task_completed"
DIGEST_REMINDER_MODE = "digest_reminder"
INTAKE_CONFIRM_ACTION_ID = "grove_intake_confirm"
INTAKE_ANSWER_ONLY_ACTION_ID = "grove_intake_answer_only"
# Cap on live-thread messages folded into the chat-bridge context (recent N).
_CHAT_THREAD_MESSAGE_CAP = 30
SLACK_EVENT_DEDUPE_MAX = 1000
SLACK_ASSISTANT_RESPONSE_CHUNK_CHARS = 3000
SLACK_NODE_CHAT_INPUT_BUSY_MARKER = "target pane has unsent prompt input"
SLACK_NODE_CHAT_INPUT_BUSY_RETRY_SECONDS = 10
SLACK_NODE_CHAT_WAIT_TEXT = "잠시만 기다리세요!"
SLACK_NODE_CHAT_WAIT_UPDATE_SECONDS = 3.0
SLACK_NODE_CHAT_RUNNING_STALE_SECONDS = 300
SLACK_NODE_CHAT_QUEUE_LIMIT = 5
SLACK_NODE_CHAT_FILE_CONTEXT_LIMIT = 5
SLACK_NODE_CHAT_FILE_DOWNLOAD_MAX_BYTES = 25 * 1024 * 1024
SLACK_SOCKET_DISCONNECTED_RESTART_SECONDS = 60.0
SLACK_SCOPES = (
    "app_mentions:read",
    "channels:history",
    "chat:write",
    "groups:history",
    "im:history",
    "mpim:history",
)
NODE_MENTION_RE = re.compile(r"(?<![A-Za-z0-9_-])@(?P<node>[A-Za-z0-9_-]+)")
SLACK_USER_MENTION_RE = re.compile(r"<@[^>]+>")
SLACK_COMMAND_TASK_RE = re.compile(r"^[A-Za-z0-9_.:-]+$")
ABSOLUTE_PATH_RE = re.compile(r"(?<![A-Za-z0-9_./-])/(?!/)[^\s'\"()<>]+")
TMUX_TARGET_RE = re.compile(r"^(?P<session>[A-Za-z0-9_-]+):(?P<window>\d+)\.(?P<pane>\d+)$")
EMAIL_RE = re.compile(r"\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b")
COMMAND_CONFIRM_TTL_SECONDS = 300
SlackCommandRole = Literal["admin", "operator", "viewer"]
SlackCommandName = Literal["approve", "abort", "killswitch", "task_create"]
SlackIntentName = Literal["bug", "feedback", "task_request", "question", "command"]
TASK_INTENTS = frozenset({"bug", "feedback", "task_request"})


def _slack_assistant_response_chunks(text: str) -> tuple[str, ...]:
    if len(text) <= SLACK_ASSISTANT_RESPONSE_CHUNK_CHARS:
        return (text,)
    return tuple(
        text[index : index + SLACK_ASSISTANT_RESPONSE_CHUNK_CHARS]
        for index in range(0, len(text), SLACK_ASSISTANT_RESPONSE_CHUNK_CHARS)
    )


def _node_chat_wait_text(elapsed_seconds: int) -> str:
    minutes, seconds = divmod(max(0, elapsed_seconds), 60)
    return f"{SLACK_NODE_CHAT_WAIT_TEXT}\n답변 생성 중... {minutes}분 {seconds:02d}초 경과"


class SlackClientProtocol(Protocol):
    def post_message(
        self,
        *,
        channel: str,
        text: str,
        thread_ts: str | None = None,
        metadata: Mapping[str, object] | None = None,
        blocks: Sequence[Mapping[str, object]] | None = None,
    ) -> str: ...

    def find_message_by_metadata(
        self,
        *,
        channel: str,
        event_type: str,
        dedup_key: str,
        oldest: str | None = None,
    ) -> str | None: ...

    def conversations_replies(
        self, *, channel: str, thread_ts: str
    ) -> Sequence[Mapping[str, object]]: ...


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
        blocks: Sequence[Mapping[str, object]] | None = None,
    ) -> object: ...

    def chat_update(
        self,
        *,
        channel: str,
        ts: str,
        text: str,
        blocks: Sequence[Mapping[str, object]] | None = None,
    ) -> object: ...

    def conversations_history(
        self,
        *,
        channel: str,
        limit: int,
        oldest: str | None = None,
        inclusive: bool = True,
        cursor: str | None = None,
    ) -> Mapping[str, object]: ...

    def conversations_replies(
        self,
        *,
        channel: str,
        ts: str,
        limit: int,
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

    def is_connected(self) -> bool: ...

    def send_socket_mode_response(self, response: object) -> None: ...


class SocketClientFactory(Protocol):
    def __call__(
        self, *, app_token: str, web_client: SlackWebClientProtocol
    ) -> SocketClientProtocol: ...


class SocketResponseFactory(Protocol):
    def __call__(self, *, envelope_id: str) -> object: ...


class AssistantBrokerProtocol(Protocol):
    def handle_turn(self, message: str, context: AssistantContext) -> MasterChatResponse: ...

    def handle_notice(
        self,
        message: str,
        context: AssistantContext,
        *,
        decision: str,
        reason: str,
        response_type: MasterChatResponseType = "answer",
        requires_confirmation: bool = False,
        metadata: Mapping[str, object] | None = None,
    ) -> MasterChatResponse: ...


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
class SlackCommandMember:
    member_id: str
    name: str
    role: SlackCommandRole


@dataclass(frozen=True)
class SlackCommandConfig:
    board: str
    members: Mapping[str, SlackCommandMember] = field(default_factory=dict)
    node_names: frozenset[str] = field(default_factory=frozenset)
    confirmation_ttl_seconds: int = COMMAND_CONFIRM_TTL_SECONDS
    clock: Callable[[], float] = time.time
    intake_enabled: bool = False
    intake_assignee: str | None = None


@dataclass(frozen=True)
class SlackDigestConfig:
    board: str
    channel: str | None = None
    enabled: bool = False
    dry_run: bool = True
    interval_seconds: int = 300
    reminder_enabled: bool = False
    reminder_after_seconds: int = 3600
    max_reminders: int = 1
    node_names: frozenset[str] = field(default_factory=frozenset)
    clock: Callable[[], float] = time.time

    def __post_init__(self) -> None:
        if self.interval_seconds <= 0:
            raise ValueError("digest interval must be positive")
        if self.reminder_after_seconds < 0:
            raise ValueError("reminder window must be non-negative")
        if self.max_reminders < 0:
            raise ValueError("max reminders must be non-negative")


@dataclass(frozen=True)
class SlackIntentClassification:
    intent: SlackIntentName
    confidence: float
    title: str
    summary: str
    labels: tuple[str, ...] = ()
    reason: str = ""


@dataclass(frozen=True)
class SlackIntakeProposal:
    intent: SlackIntentName
    title: str
    body: str
    labels: tuple[str, ...]
    priority: int
    assignee: str | None
    confidence: float
    reason: str
    slack: Mapping[str, object]

    def to_json(self) -> dict[str, object]:
        return {
            "intent": self.intent,
            "title": self.title,
            "body": self.body,
            "labels": list(self.labels),
            "priority": self.priority,
            "assignee": self.assignee,
            "confidence": self.confidence,
            "reason": self.reason,
            "slack": dict(self.slack),
        }


@dataclass(frozen=True)
class SlackBlockMessage:
    text: str
    blocks: tuple[Mapping[str, object], ...]


@dataclass(frozen=True)
class SlackFileAttachment:
    file_id: str
    title: str
    name: str
    mimetype: str
    filetype: str
    pretty_type: str
    size: int | None
    url_private: str | None
    url_private_download: str | None


@dataclass(frozen=True)
class SlackPendingCommand:
    confirmation_id: str
    command: SlackCommandName
    args: tuple[str, ...]
    event: SlackEvent
    actor: SlackCommandMember
    expires_at: float


@dataclass(frozen=True)
class SlackEvent:
    team: str
    channel: str
    user: str
    text: str
    ts: str
    thread_ts: str | None
    event_type: str
    event_id: str | None = None
    client_msg_id: str | None = None
    bot_id: str | None = None
    app_id: str | None = None
    subtype: str | None = None
    files: tuple[SlackFileAttachment, ...] = field(default_factory=tuple)


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
        intake_enabled: bool = False,
    ) -> None:
        self.config_path = config_path
        self.bot_auth_ok = bot_auth_ok
        self.socket_connected = socket_connected
        self.last_event_at = last_event_at
        self.last_error = last_error
        self.intake_enabled = intake_enabled

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
            "intake": {"enabled": self.intake_enabled},
        }


class SlackSdkClient:
    def __init__(self, *, bot_token: str) -> None:
        self._bot_token = bot_token
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
        blocks: Sequence[Mapping[str, object]] | None = None,
    ) -> str:
        response = self._client.chat_postMessage(
            channel=channel,
            text=text,
            thread_ts=thread_ts,
            metadata=metadata,
            blocks=blocks,
        )
        get_value = getattr(response, "get", None)
        ts = get_value("ts") if callable(get_value) else None
        if not isinstance(ts, str):
            raise RuntimeError("Slack response did not include ts")
        return ts

    def update_message(
        self,
        *,
        channel: str,
        ts: str,
        text: str,
        blocks: Sequence[Mapping[str, object]] | None = None,
    ) -> None:
        self._client.chat_update(channel=channel, ts=ts, text=text, blocks=blocks)

    def download_file(self, *, url: str, destination: Path) -> None:
        destination.parent.mkdir(parents=True, exist_ok=True)
        request = urllib.request.Request(
            url,
            headers={"Authorization": f"Bearer {self._bot_token}"},
        )
        downloaded = 0
        with urllib.request.urlopen(request, timeout=20) as response, destination.open("wb") as out:
            while True:
                chunk = response.read(1024 * 1024)
                if not chunk:
                    break
                downloaded += len(chunk)
                if downloaded > SLACK_NODE_CHAT_FILE_DOWNLOAD_MAX_BYTES:
                    raise RuntimeError("Slack file exceeds download limit")
                out.write(chunk)

    def bot_user_id(self) -> str | None:
        auth_test = getattr(self._client, "auth_test", None)
        if not callable(auth_test):
            return None
        response = cast(Callable[[], object], auth_test)()
        if not isinstance(response, Mapping):
            return None
        user_id = response.get("user_id")
        return user_id if isinstance(user_id, str) and user_id else None

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

    def conversations_replies(
        self, *, channel: str, thread_ts: str
    ) -> Sequence[Mapping[str, object]]:
        response = self._client.conversations_replies(channel=channel, ts=thread_ts, limit=100)
        messages = response.get("messages")
        if not isinstance(messages, Sequence) or isinstance(messages, str | bytes):
            return []
        return [message for message in messages if isinstance(message, Mapping)]


class GroveServeChatFacade:
    def __init__(self, *, grove_binary: str | None = None) -> None:
        self.grove_binary = grove_binary or _default_grove_binary()

    def send(self, *, session_id: str, node: str, text: str) -> str:
        _ = session_id
        proc = subprocess.run(
            [
                self.grove_binary,
                "ask",
                node,
                "--timeout",
                f"{int(GROVE_CHAT_TIMEOUT_SECONDS)}s",
                text,
            ],
            capture_output=True,
            text=True,
            timeout=GROVE_CHAT_TIMEOUT_SECONDS,
            check=False,
        )
        if proc.returncode != 0:
            raise RuntimeError(proc.stderr.strip() or f"grove ask exited {proc.returncode}")
        return proc.stdout.strip()


def _default_grove_binary() -> str:
    configured = os.environ.get("GROVE_BINARY")
    if configured is not None and configured.strip():
        return configured.strip()
    local_cli = _assistant_workspace_path() / "dist" / "cli.js"
    if local_cli.is_file():
        return str(local_cli)
    return "grove"


class SlackConfirmationStore:
    def __init__(
        self,
        *,
        ttl_seconds: int,
        clock: Callable[[], float],
        token_factory: Callable[[], str] | None = None,
    ) -> None:
        self.ttl_seconds = ttl_seconds
        self.clock = clock
        self.token_factory = token_factory or (lambda: secrets.token_urlsafe(8))
        self._pending: dict[str, SlackPendingCommand] = {}
        self._lock = threading.Lock()

    def create(
        self,
        *,
        command: SlackCommandName,
        args: tuple[str, ...],
        event: SlackEvent,
        actor: SlackCommandMember,
    ) -> SlackPendingCommand:
        now = self.clock()
        with self._lock:
            confirmation_id = self.token_factory()
            while confirmation_id in self._pending:
                confirmation_id = self.token_factory()
            pending = SlackPendingCommand(
                confirmation_id=confirmation_id,
                command=command,
                args=args,
                event=event,
                actor=actor,
                expires_at=now + max(1, self.ttl_seconds),
            )
            self._pending[confirmation_id] = pending
            self._cleanup(now=now)
            return pending

    def consume(self, confirmation_id: str) -> tuple[SlackPendingCommand | None, str | None]:
        now = self.clock()
        with self._lock:
            pending = self._pending.pop(confirmation_id, None)
            self._cleanup(now=now)
            if pending is None:
                return None, "confirmation_unknown_or_used"
            if pending.expires_at <= now:
                return None, "confirmation_expired"
            return pending, None

    def consume_for_owner(
        self,
        confirmation_id: str,
        *,
        member_id: str,
    ) -> tuple[SlackPendingCommand | None, str | None]:
        now = self.clock()
        with self._lock:
            pending = self._pending.get(confirmation_id)
            if pending is None:
                self._cleanup(now=now)
                return None, "confirmation_unknown_or_used"
            if pending.expires_at <= now:
                self._pending.pop(confirmation_id, None)
                self._cleanup(now=now)
                return None, "confirmation_expired"
            if pending.actor.member_id != member_id:
                self._cleanup(now=now)
                return None, "confirmation_owner_mismatch"
            self._pending.pop(confirmation_id, None)
            self._cleanup(now=now)
            return pending, None

    def _cleanup(self, *, now: float) -> None:
        expired = [
            confirmation_id
            for confirmation_id, pending in self._pending.items()
            if pending.expires_at <= now
        ]
        for confirmation_id in expired:
            self._pending.pop(confirmation_id, None)


class SlackConnector:
    def __init__(
        self,
        *,
        store: SQLiteBoardStore,
        slack_client: SlackClientProtocol,
        chat_facade: ChatFacadeProtocol,
        human_gate: HumanGateConfig,
        chat_route: ChatRouteConfig,
        command_config: SlackCommandConfig | None = None,
        digest_config: SlackDigestConfig | None = None,
        confirmation_store: SlackConfirmationStore | None = None,
        assistant_broker: AssistantBrokerProtocol | None = None,
        bot_user_id: str | None = None,
        route_chat_to_node: bool = True,
        node_chat_retry_delay_seconds: int = SLACK_NODE_CHAT_INPUT_BUSY_RETRY_SECONDS,
    ) -> None:
        self.store = store
        self.slack_client = slack_client
        self.chat_facade = chat_facade
        self._uses_default_assistant_broker = assistant_broker is None
        self.assistant_broker = assistant_broker or AssistantBroker()
        self.human_gate = human_gate
        self.chat_route = chat_route
        self.command_config = command_config
        self.digest_config = digest_config
        self.bot_user_id = bot_user_id or None
        _ = route_chat_to_node
        self.route_chat_to_node = True
        self.node_chat_retry_delay_seconds = node_chat_retry_delay_seconds
        self.confirmations = confirmation_store or (
            SlackConfirmationStore(
                ttl_seconds=command_config.confirmation_ttl_seconds,
                clock=command_config.clock,
            )
            if command_config is not None
            else None
        )
        self._locks: dict[str, threading.Lock] = {}
        self._node_chat_queue_lock = threading.Lock()
        self._seen_event_keys: set[str] = set()
        self._seen_event_order: deque[str] = deque()

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
            gate_event = SlackEvent(
                team="",
                channel=channel,
                user="slack-human-gate",
                text=_human_gate_notice_text(task),
                ts=pending_thread_ts,
                thread_ts=None,
                event_type="message",
            )
            try:
                if self._uses_default_assistant_broker:
                    thread_ts = self._post_human_gate_notice(
                        gate_event,
                        task=task,
                        slack_metadata=_human_gate_metadata(task),
                    )
                else:
                    thread_ts = self._post_assistant_notice(
                        gate_event,
                        decision="human_gate",
                        reason="human_gate_required",
                        thread_ts=pending_thread_ts,
                        metadata={
                            "task_id": task.id,
                            "title": task.title,
                            "assignee": task.assignee,
                            "question": task.metadata.get("question"),
                            "body": task.body,
                        },
                        slack_metadata=_human_gate_metadata(task),
                        reply_in_thread=False,
                    )
            except Exception as exc:
                LOGGER.warning("Slack human gate post failed: %s", _safe_log_error(exc))
                continue
            if not thread_ts:
                self._delete_pending_human_gate(task=task, channel=channel)
                continue
            self._record_human_gate_thread(task=task, channel=channel, thread_ts=thread_ts)
            self._delete_pending_human_gate(task=task, channel=channel)
            posted += 1
        return posted

    def poll_completion_notices(self) -> int:
        channel = self.human_gate.channel
        if channel is None:
            return 0
        board = self.human_gate.board
        cursor_state = self.store.slack_completion_notice_cursor(board=board)
        if cursor_state["configured"] is not True:
            self.store.set_slack_completion_notice_cursor(
                board=board,
                cursor=self.store.latest_event_cursor(board=board),
            )
            return 0
        cursor_raw = cursor_state["cursor"]
        cursor = cursor_raw if isinstance(cursor_raw, int) else 0
        max_cursor = cursor
        posted = 0
        for event in self.store.list_events_after(cursor=cursor, board=board, limit=100):
            if not _is_task_completion_event(event):
                max_cursor = event.cursor
                continue
            if event.task_id is None:
                max_cursor = event.cursor
                continue
            try:
                task = self.store.get_task(board=board, task_id=event.task_id)
            except KeyError:
                max_cursor = event.cursor
                continue
            if task.status != "done":
                max_cursor = event.cursor
                continue
            dedup_key = _completion_notice_dedup_key(event)
            try:
                existing = self.slack_client.find_message_by_metadata(
                    channel=channel,
                    event_type=TASK_COMPLETION_METADATA_EVENT_TYPE,
                    dedup_key=dedup_key,
                    oldest=str(max(0, event.created_at - 60)),
                )
            except Exception as exc:
                LOGGER.warning(
                    "Slack completion notice reconciliation failed: %s", _safe_log_error(exc)
                )
                break
            if existing is None:
                try:
                    self.slack_client.post_message(
                        channel=channel,
                        text=_completion_notice_text(task, event=event),
                        metadata=_completion_notice_metadata(task, event=event),
                    )
                except Exception as exc:
                    LOGGER.warning("Slack completion notice post failed: %s", _safe_log_error(exc))
                    break
                posted += 1
            max_cursor = event.cursor
        if max_cursor > cursor:
            self.store.set_slack_completion_notice_cursor(board=board, cursor=max_cursor)
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

    def _event_dedupe_key(self, event: SlackEvent) -> str | None:
        if event.client_msg_id:
            return f"client:{event.team}:{event.channel}:{event.client_msg_id}"
        if event.event_id:
            return f"event:{event.team}:{event.event_id}"
        return None

    def _should_ignore_event(self, event: SlackEvent) -> bool:
        if event.bot_id or event.app_id or event.subtype:
            return True
        return self.bot_user_id is not None and event.user == self.bot_user_id

    def _remember_event(self, event: SlackEvent) -> bool:
        key = self._event_dedupe_key(event)
        if key is None:
            return True
        if key in self._seen_event_keys:
            LOGGER.info("Slack duplicate event ignored: %s", key)
            return False
        self._seen_event_keys.add(key)
        self._seen_event_order.append(key)
        while len(self._seen_event_order) > SLACK_EVENT_DEDUPE_MAX:
            expired = self._seen_event_order.popleft()
            self._seen_event_keys.discard(expired)
        return True

    def _has_human_reply_thread(self, event: SlackEvent, *, thread_ts: str) -> bool:
        return (
            self.store.find_notify_sub(
                channel_kind="slack",
                room_id=event.channel,
                thread_id=thread_ts,
            )
            is not None
        )

    def _event_was_seen(self, event: SlackEvent) -> bool:
        key = self._event_dedupe_key(event)
        if key is None or key not in self._seen_event_keys:
            return False
        LOGGER.info("Slack duplicate event ignored: %s", key)
        return True

    def handle_event(self, event: SlackEvent) -> bool:
        if event.event_type not in {"app_mention", "message"}:
            return False
        if self._should_ignore_event(event):
            return False
        if self._event_was_seen(event):
            return True
        thread_ts = event.thread_ts or event.ts
        is_thread_reply = event.thread_ts is not None
        is_addressed = _assistant_mentioned(event, bot_user_id=self.bot_user_id)
        is_human_reply_thread = is_thread_reply and self._has_human_reply_thread(
            event,
            thread_ts=thread_ts,
        )
        is_slash_command = _normalize_slack_text(event.text).startswith("/")
        if not is_addressed and not is_human_reply_thread and not is_slash_command:
            return False
        if not self._remember_event(event):
            return True
        if is_addressed and not _explicit_reserved_command_text(event.text):
            return self._handle_chat(event, thread_ts=thread_ts)
        if is_human_reply_thread and self._handle_human_reply(event, thread_ts=thread_ts):
            return True
        if _explicit_reserved_command_text(event.text) and self._handle_command(
            event, thread_ts=thread_ts
        ):
            return True
        return False

    def _assistant_priority_event(self, event: SlackEvent) -> bool:
        if not _assistant_mentioned(event, bot_user_id=self.bot_user_id):
            return False
        return not _explicit_reserved_command_text(event.text)

    def handle_interaction(self, payload: Mapping[str, object]) -> bool:
        action = _first_block_action(payload)
        if action is None:
            return False
        action_id = action.get("action_id")
        if action_id not in {INTAKE_CONFIRM_ACTION_ID, INTAKE_ANSWER_ONLY_ACTION_ID}:
            return False
        confirmation_id = action.get("value")
        event = _event_from_interaction_payload(payload, action_id=str(action_id))
        if not isinstance(confirmation_id, str) or event is None:
            return False
        thread_ts = event.thread_ts or event.ts
        config = self.command_config
        if config is None:
            self._post_assistant_notice(
                event,
                decision="deny",
                reason="slack control commands disabled",
                response_type="denied",
                thread_ts=thread_ts,
            )
            return True
        actor = config.members.get(event.user)
        if actor is None:
            self._audit_slack_command(
                command="intake",
                event=event,
                actor=_slack_actor(event.user, role="none"),
                status="denied",
                summary="unmapped slack identity",
            )
            self._post_assistant_notice(
                event,
                decision="deny",
                reason="unmapped slack identity",
                response_type="denied",
                thread_ts=thread_ts,
            )
            return True
        if self.confirmations is None:
            self._post_assistant_notice(
                event,
                decision="deny",
                reason="pending_confirmations_unavailable",
                response_type="denied",
                thread_ts=thread_ts,
            )
            return True
        pending, error = self.confirmations.consume_for_owner(
            confirmation_id,
            member_id=actor.member_id,
        )
        if pending is None:
            self._audit_slack_command(
                command="confirm",
                event=event,
                actor=_slack_member_actor(event.user, actor),
                status="denied",
                summary=error or "confirmation failed",
            )
            self._post_assistant_notice(
                event,
                decision="deny",
                reason=error or "confirmation failed",
                response_type="denied",
                thread_ts=thread_ts,
            )
            return True
        if action_id == INTAKE_ANSWER_ONLY_ACTION_ID:
            self._audit_slack_command(
                command="intake",
                event=event,
                actor=_slack_member_actor(event.user, actor),
                status="rejected",
                summary="answer-only selected",
            )
            self._post_assistant_notice(
                event,
                decision="answer_only",
                reason="answer_only: no task created",
                thread_ts=thread_ts,
            )
            return True
        result = self._execute_pending_command(pending)
        self._post_assistant_notice(
            event,
            decision=_slack_notice_decision_from_result(result),
            reason=_slack_notice_reason_from_result(result),
            response_type=_slack_notice_response_type_from_result(result),
            thread_ts=thread_ts,
        )
        return True

    def poll_digest(self) -> int:
        config = self.digest_config
        if config is None or not config.enabled or not self._digest_gui_enabled(config.board):
            return 0
        if config.reminder_enabled:
            return self.poll_digest_reminders()
        return 0

    def poll_digest_reminders(self) -> int:
        config = self.digest_config
        if (
            config is None
            or not config.enabled
            or not self._digest_gui_enabled(config.board)
            or not config.reminder_enabled
            or config.dry_run
            or config.max_reminders <= 0
        ):
            return 0
        target_channel = config.channel or self.human_gate.channel
        if target_channel is None:
            return 0
        now = int(config.clock())
        sent = 0
        for task in self.store.list_tasks(board=config.board, status="blocked"):
            if task.updated_at + config.reminder_after_seconds > now:
                continue
            reminders = [
                thread
                for thread in self.store.list_slack_threads(
                    task_id=task.id,
                    mode=DIGEST_REMINDER_MODE,
                )
                if thread.channel_id == target_channel
            ]
            if len(reminders) >= config.max_reminders:
                continue
            latest = max((thread.created_at for thread in reminders), default=task.updated_at)
            if reminders and latest + config.reminder_after_seconds > now:
                continue
            step = len(reminders) + 1
            pending_thread_ts = _digest_reminder_pending_key(task=task, step=step)
            task_thread_ts = _task_slack_thread_ts(
                self.store,
                board=config.board,
                task=task,
                channel=target_channel,
            )
            reminder_event = SlackEvent(
                team="",
                channel=target_channel,
                user="slack-digest",
                text=f"digest reminder for task {task.id}",
                ts=pending_thread_ts,
                thread_ts=task_thread_ts,
                event_type="message",
            )
            try:
                text = self._assistant_notice_text(
                    reminder_event,
                    thread_ts=task_thread_ts or pending_thread_ts,
                    decision="digest_reminder",
                    reason=_digest_reminder_notice_reason(
                        task=task,
                        step=step,
                        max_reminders=config.max_reminders,
                    ),
                    metadata={
                        "task_id": task.id,
                        "title": task.title,
                        "status": task.status,
                        "needs_human": _needs_human(task),
                        "step": step,
                        "max_reminders": config.max_reminders,
                    },
                )
            except AssistantUnavailable as exc:
                LOGGER.warning("Slack digest reminder hidden: %s", _safe_log_error(exc))
                continue
            try:
                self.store.upsert_slack_thread(
                    board=config.board,
                    task_id=task.id,
                    team_id="",
                    channel_id=target_channel,
                    thread_ts=pending_thread_ts,
                    mode=DIGEST_REMINDER_MODE,
                    node=f"pending:{step}",
                )
            except Exception as exc:
                LOGGER.warning(
                    "Slack digest reminder pending record failed: %s",
                    _safe_log_error(exc),
                )
                continue
            try:
                ts = self.slack_client.post_message(
                    channel=target_channel,
                    text=text,
                    thread_ts=task_thread_ts,
                )
            except Exception as exc:
                LOGGER.warning("Slack digest reminder post failed: %s", _safe_log_error(exc))
                continue
            try:
                self.store.upsert_slack_thread(
                    board=config.board,
                    task_id=task.id,
                    team_id="",
                    channel_id=target_channel,
                    thread_ts=ts,
                    mode=DIGEST_REMINDER_MODE,
                    node=f"reminder:{step}",
                )
                self.store.delete_slack_thread(
                    board=config.board,
                    task_id=task.id,
                    team_id="",
                    channel_id=target_channel,
                    thread_ts=pending_thread_ts,
                    mode=DIGEST_REMINDER_MODE,
                )
            except Exception as exc:
                LOGGER.warning(
                    "Slack digest reminder record failed after post: %s",
                    _safe_log_error(exc),
                )
                continue
            self._audit_digest(
                action="digest_reminder",
                status="ok",
                task_id=task.id,
                summary=f"reminder {step}",
                payload={"step": step, "max_reminders": config.max_reminders},
            )
            sent += 1
        return sent

    def _digest_gui_enabled(self, board: str) -> bool:
        try:
            state = self.store.gui_feature_flags(board=board, features=("digest",))["digest"]
        except Exception as exc:
            LOGGER.warning("Slack digest gui flag lookup failed: %s", _safe_log_error(exc))
            return False
        return state.get("enabled") is True

    def _audit_digest(
        self,
        *,
        action: str,
        status: str,
        task_id: str | None = None,
        summary: str | None = None,
        payload: Mapping[str, object] | None = None,
    ) -> None:
        config = self.digest_config
        if config is None:
            return
        self.store.add_audit_event(
            board=config.board,
            kind="audit.slack.digest",
            actor={"kind": "system", "id": "slack-digest", "login": "slack-digest"},
            action=_safe_slack_text(action),
            target={"type": "slack_digest", "id": _safe_slack_text(config.channel or "")},
            task_id=task_id,
            status=status,
            summary=_safe_slack_text(summary or action),
            payload={str(key): _safe_slack_text(value) for key, value in (payload or {}).items()},
        )

    def _handle_command(self, event: SlackEvent, *, thread_ts: str) -> bool:
        command_text = _normalize_slack_command_text(event.text)
        parts = command_text.split()
        if not parts:
            return False
        command = parts[0].lower()
        if command not in {
            "status",
            "approve",
            "abort",
            "killswitch",
            "confirm",
            "bug",
            "feedback",
            "task",
            "digest",
        }:
            return False
        config = self.command_config
        if config is None:
            self._post_assistant_notice(
                event,
                decision="deny",
                reason="slack control commands disabled",
                response_type="denied",
                thread_ts=thread_ts,
            )
            return True
        actor = config.members.get(event.user)
        if command == "status":
            self._audit_slack_command(
                command="status",
                event=event,
                actor=(
                    _slack_member_actor(event.user, actor)
                    if actor is not None
                    else _slack_actor(event.user, role="read-only")
                ),
                status="ok",
                summary="status",
            )
            self._post_assistant_notice(
                event,
                decision="status",
                reason=self._command_status_text(config.board),
                thread_ts=thread_ts,
            )
            return True
        if actor is None:
            self._audit_slack_command(
                command=command,
                event=event,
                actor=_slack_actor(event.user, role="none"),
                status="denied",
                summary="unmapped slack identity",
            )
            self._post_assistant_notice(
                event,
                decision="deny",
                reason="unmapped slack identity",
                response_type="denied",
                thread_ts=thread_ts,
            )
            return True
        if command == "confirm":
            self._handle_command_confirm(event, actor=actor, thread_ts=thread_ts, parts=parts)
            return True
        if command in {"bug", "feedback", "task"}:
            self._handle_intake_command(
                event,
                actor=actor,
                thread_ts=thread_ts,
                command=command,
                args=tuple(parts[1:]),
            )
            return True
        if command == "digest":
            self._handle_digest_command(
                event,
                actor=actor,
                thread_ts=thread_ts,
                args=tuple(parts[1:]),
            )
            return True
        if actor.role not in {"admin", "operator"}:
            self._audit_slack_command(
                command=command,
                event=event,
                actor=_slack_member_actor(event.user, actor),
                status="denied",
                summary="insufficient role",
            )
            self._post_assistant_notice(
                event,
                decision="deny",
                reason="insufficient role: operator or admin role is required for this command",
                response_type="denied",
                thread_ts=thread_ts,
            )
            return True
        preview = self._preview_command(
            command=command,
            args=tuple(parts[1:]),
            event=event,
            actor=actor,
        )
        self._post_assistant_notice(
            event,
            decision=_slack_notice_decision_from_result(preview),
            reason=_slack_notice_reason_from_result(preview),
            response_type=_slack_notice_response_type_from_result(preview),
            thread_ts=thread_ts,
            requires_confirmation="confirm " in preview,
        )
        return True

    def _handle_digest_command(
        self,
        event: SlackEvent,
        *,
        actor: SlackCommandMember,
        thread_ts: str,
        args: tuple[str, ...],
    ) -> None:
        if actor.role not in {"admin", "operator"}:
            self._audit_slack_command(
                command="digest",
                event=event,
                actor=_slack_member_actor(event.user, actor),
                status="denied",
                summary="insufficient role",
            )
            self._post_assistant_notice(
                event,
                decision="deny",
                reason="insufficient role: operator or admin role is required for digest config",
                response_type="denied",
                thread_ts=thread_ts,
            )
            return
        if self.digest_config is None:
            self._audit_slack_command(
                command="digest",
                event=event,
                actor=_slack_member_actor(event.user, actor),
                status="denied",
                summary="digest is not configured",
            )
            self._post_assistant_notice(
                event,
                decision="deny",
                reason="digest not configured",
                response_type="denied",
                thread_ts=thread_ts,
            )
            return
        action = args[0].lower() if args else "status"
        if action == "status":
            response = _digest_config_status_text(self.digest_config)
        elif action == "enable":
            self.digest_config = replace(self.digest_config, enabled=True)
            response = "completed: digest enabled"
        elif action == "disable":
            self.digest_config = replace(self.digest_config, enabled=False)
            response = "completed: digest disabled"
        elif action in {"dry-run-on", "dryrun-on"}:
            self.digest_config = replace(self.digest_config, dry_run=True)
            response = "completed: digest dry-run enabled"
        elif action in {"dry-run-off", "dryrun-off", "live-on"}:
            self.digest_config = replace(self.digest_config, dry_run=False)
            response = "completed: digest dry-run disabled"
        else:
            response = "deny: digest usage [status|enable|disable|dry-run-on|dry-run-off]"
        self._audit_slack_command(
            command="digest",
            event=event,
            actor=_slack_member_actor(event.user, actor),
            status="ok",
            summary=response,
            payload={
                "enabled": self.digest_config.enabled,
                "dry_run": self.digest_config.dry_run,
                "digest_action": action,
            },
        )
        self._post_assistant_notice(
            event,
            decision=_slack_notice_decision_from_result(response),
            reason=_slack_notice_reason_from_result(response),
            response_type=_slack_notice_response_type_from_result(response),
            thread_ts=thread_ts,
        )

    def _handle_intake_command(
        self,
        event: SlackEvent,
        *,
        actor: SlackCommandMember,
        thread_ts: str,
        command: str,
        args: tuple[str, ...],
    ) -> None:
        config = self.command_config
        if config is None or not self._intake_enabled(config):
            self._post_assistant_notice(
                event,
                decision="deny",
                reason="slack intake disabled",
                response_type="denied",
                thread_ts=thread_ts,
            )
            return
        if actor.role not in {"admin", "operator"}:
            self._audit_slack_command(
                command="intake",
                event=event,
                actor=_slack_member_actor(event.user, actor),
                status="denied",
                summary="insufficient role",
                payload={"intent": command},
            )
            self._post_assistant_notice(
                event,
                decision="deny",
                reason=(
                    "insufficient role: operator or admin role is required to create "
                    "human-facing items"
                ),
                response_type="denied",
                thread_ts=thread_ts,
            )
            return
        intent = _intent_from_intake_command(command)
        body = " ".join(args).strip() or _normalize_slack_text(event.text)
        classification = SlackIntentClassification(
            intent=intent,
            confidence=1.0,
            title=_strip_intake_prefix(body),
            summary=body,
            labels=_labels_for_intent(intent),
            reason="explicit_intake_command",
        )
        preview = self._preview_intake_task(
            event=event,
            actor=actor,
            classification=classification,
        )
        if preview is None:
            self._post_assistant_notice(
                event,
                decision="deny",
                reason="slack intake disabled",
                response_type="denied",
                thread_ts=thread_ts,
            )
            return
        self._post_assistant_notice(
            event,
            decision="preview",
            reason=preview.text,
            thread_ts=thread_ts,
            requires_confirmation=True,
        )

    def _preview_intake_task(
        self,
        *,
        event: SlackEvent,
        actor: SlackCommandMember,
        classification: SlackIntentClassification,
    ) -> SlackBlockMessage | None:
        if self.command_config is None or self.confirmations is None:
            return None
        proposal = _build_intake_task_proposal(
            event=event,
            classification=classification,
            config=self.command_config,
        )
        pending = self.confirmations.create(
            command="task_create",
            args=(json.dumps(proposal.to_json(), sort_keys=True),),
            event=event,
            actor=actor,
        )
        self._audit_slack_command(
            command="intake",
            event=event,
            actor=_slack_member_actor(event.user, actor),
            status="preview",
            summary=_pending_command_summary(pending),
            payload={
                "confirmation_id": pending.confirmation_id,
                "intent": proposal.intent,
                "confidence": proposal.confidence,
            },
        )
        text = (
            f"preview: create {_safe_slack_text(proposal.intent)} item "
            f"title={_safe_slack_text(proposal.title)}; "
            f"confirm {pending.confirmation_id}; "
            f"ttl_seconds={self.command_config.confirmation_ttl_seconds}"
        )
        return SlackBlockMessage(
            text=text,
            blocks=(),
        )

    def _handle_command_confirm(
        self,
        event: SlackEvent,
        *,
        actor: SlackCommandMember,
        thread_ts: str,
        parts: Sequence[str],
    ) -> None:
        if len(parts) != 2:
            self._post_assistant_notice(
                event,
                decision="usage",
                reason="deny: confirm usage confirm <confirmation-id>",
                response_type="denied",
                thread_ts=thread_ts,
            )
            return
        if self.confirmations is None:
            self._post_assistant_notice(
                event,
                decision="deny",
                reason="pending_confirmations_unavailable",
                response_type="denied",
                thread_ts=thread_ts,
            )
            return
        pending, error = self.confirmations.consume_for_owner(parts[1], member_id=actor.member_id)
        if pending is None:
            self._audit_slack_command(
                command="confirm",
                event=event,
                actor=_slack_member_actor(event.user, actor),
                status="denied",
                summary=error or "confirmation failed",
            )
            response = _safe_slack_text(error or "confirmation failed")
            self._post_assistant_notice(
                event,
                decision="deny",
                reason=response,
                response_type="denied",
                thread_ts=thread_ts,
            )
            return
        result = self._execute_pending_command(pending)
        self._post_assistant_notice(
            event,
            decision=_slack_notice_decision_from_result(result),
            reason=_slack_notice_reason_from_result(result),
            response_type=_slack_notice_response_type_from_result(result),
            thread_ts=thread_ts,
        )

    def _preview_command(
        self,
        *,
        command: str,
        args: tuple[str, ...],
        event: SlackEvent,
        actor: SlackCommandMember,
    ) -> str:
        parsed = _parse_mutating_command(command, args)
        if parsed is None:
            return (
                "deny: invalid command; expected approve <item>, abort <item>, killswitch <on|off>"
            )
        if self.command_config is None or self.confirmations is None:
            return "deny: slack control commands disabled"
        node_denial = self._node_killswitch_denial(parsed[0], parsed[1])
        if node_denial is not None:
            self._audit_slack_command(
                command=parsed[0],
                event=event,
                actor=_slack_member_actor(event.user, actor),
                status="denied",
                summary=node_denial,
            )
            return node_denial
        pending = self.confirmations.create(
            command=parsed[0],
            args=parsed[1],
            event=event,
            actor=actor,
        )
        self._audit_slack_command(
            command=parsed[0],
            event=event,
            actor=_slack_member_actor(event.user, actor),
            status="preview",
            summary=_pending_command_summary(pending),
            payload={"confirmation_id": pending.confirmation_id},
        )
        return (
            f"preview: {_pending_command_summary(pending)}; "
            f"confirm {pending.confirmation_id}; "
            f"ttl_seconds={self.command_config.confirmation_ttl_seconds}"
        )

    def _execute_pending_command(self, pending: SlackPendingCommand) -> str:
        if self.command_config is None:
            return "deny: slack control commands disabled"
        actor = _slack_member_actor(pending.event.user, pending.actor)
        try:
            if pending.command == "approve":
                return self._execute_approve(pending, actor=actor)
            if pending.command == "abort":
                return self._execute_abort(pending, actor=actor)
            if pending.command == "task_create":
                return self._execute_task_create(pending, actor=actor)
            return self._execute_killswitch(pending, actor=actor)
        except KeyError:
            self._audit_slack_command(
                command=pending.command,
                event=pending.event,
                actor=actor,
                status="denied",
                summary="task or board not found",
            )
            return "deny: task outside project scope"

    def _execute_task_create(
        self,
        pending: SlackPendingCommand,
        *,
        actor: Mapping[str, object],
    ) -> str:
        config = self.command_config
        if config is None:
            return "deny: slack control commands disabled"
        proposal = _decode_intake_proposal(pending.args)
        if not self._intake_enabled(config):
            return "deny: slack intake disabled"
        if pending.actor.role not in {"admin", "operator"}:
            self._audit_slack_command(
                command="intake",
                event=pending.event,
                actor=actor,
                status="denied",
                summary="insufficient role",
            )
            return "deny: operator or admin role required to create human-facing items"
        if proposal is None:
            self._audit_slack_command(
                command="intake",
                event=pending.event,
                actor=actor,
                status="denied",
                summary="invalid intake proposal",
            )
            return "deny: invalid intake proposal"
        assignee = proposal.assignee
        if assignee is not None and not self._command_node_exists(assignee):
            assignee = None
        task = self.store.create_task(
            board=config.board,
            title=proposal.title,
            body=_slack_task_body_with_grove_context(
                proposal.body,
                config=config,
                target_node=assignee,
            ),
            assignee=assignee,
            status="ready",
            priority=proposal.priority,
            created_by=pending.actor.member_id,
            metadata={
                "labels": list(proposal.labels),
                "intake": {
                    "source": "slack",
                    "intent": proposal.intent,
                    "confidence": proposal.confidence,
                    "reason": proposal.reason,
                },
                "slack": dict(proposal.slack),
            },
        )
        self.store.add_audit_event(
            board=config.board,
            kind="audit.task.create",
            actor=actor,
            action="slack_intake_create",
            target={"type": "task", "id": task.id},
            task_id=task.id,
            status="ok",
            summary=f"created {proposal.intent} item",
            payload={
                "intent": proposal.intent,
                "labels": list(proposal.labels),
                "assignee": assignee,
            },
        )
        self._audit_slack_command(
            command="intake",
            event=pending.event,
            actor=actor,
            status="ok",
            summary="created human-facing item",
            target={"type": "task", "id": task.id},
            task_id=task.id,
            payload={
                "intent": proposal.intent,
            },
        )
        return (
            f"completed: created human-facing item id={_safe_slack_text(task.id)} "
            f"title={_safe_slack_text(task.title)}"
        )

    def _intake_enabled(self, config: SlackCommandConfig) -> bool:
        try:
            state = self.store.gui_feature_flags(board=config.board, features=("intake",))["intake"]
        except Exception as exc:
            LOGGER.warning("Slack intake gui flag lookup failed: %s", _safe_log_error(exc))
            return False
        configured = state.get("configured")
        enabled = state.get("enabled")
        if configured is True and isinstance(enabled, bool):
            return enabled
        return False

    def _execute_approve(
        self,
        pending: SlackPendingCommand,
        *,
        actor: Mapping[str, object],
    ) -> str:
        assert self.command_config is not None
        task_id = pending.args[0]
        if not _valid_task_ref(task_id):
            return "deny: invalid item id"
        task = self.store.get_task(board=self.command_config.board, task_id=task_id)
        node = _execution_node_for_task(task)
        if node is None:
            return "deny: item has no execution node"
        gate = self.store.execution_gate_state(
            board=self.command_config.board,
            node=node,
            task_id=task.id,
        )
        if not bool(gate["allowed"]):
            self._audit_slack_command(
                command="approve",
                event=pending.event,
                actor=actor,
                status="denied",
                summary="execution gate is blocked",
                task_id=task.id,
                run_id=task.current_run_id,
            )
            return "deny: execution gate is blocked"
        if not self.store.approve_execution(
            board=self.command_config.board,
            task_id=task.id,
            actor=actor,
        ):
            return "deny: item is not awaiting approval"
        self._audit_slack_command(
            command="approve",
            event=pending.event,
            actor=actor,
            status="ok",
            summary="approved",
            task_id=task.id,
            run_id=task.current_run_id,
        )
        return f"completed: approved item id={_safe_slack_text(task.id)}"

    def _execute_abort(
        self,
        pending: SlackPendingCommand,
        *,
        actor: Mapping[str, object],
    ) -> str:
        assert self.command_config is not None
        task_id = pending.args[0]
        if not _valid_task_ref(task_id):
            return "deny: invalid item id"
        task = self.store.get_task(board=self.command_config.board, task_id=task_id)
        reason = "slack command abort"
        if not self.store.abort_execution(
            board=self.command_config.board,
            task_id=task.id,
            actor=actor,
            reason=reason,
        ):
            return "deny: item execution is already terminal"
        self._audit_slack_command(
            command="abort",
            event=pending.event,
            actor=actor,
            status="ok",
            summary=reason,
            task_id=task.id,
            run_id=task.current_run_id,
        )
        return f"completed: aborted item id={_safe_slack_text(task.id)}"

    def _execute_killswitch(
        self,
        pending: SlackPendingCommand,
        *,
        actor: Mapping[str, object],
    ) -> str:
        assert self.command_config is not None
        scope, target, enabled_text = _parse_killswitch_args(pending.args)
        enabled = enabled_text == "on"
        if scope == "node":
            if target is None or not self._command_node_exists(target):
                self._audit_slack_command(
                    command="killswitch",
                    event=pending.event,
                    actor=actor,
                    status="denied",
                    summary="node is not in this project",
                )
                return "deny: node outside project"
            self.store.set_execution_kill_switch(
                board=self.command_config.board,
                level="node",
                node=target,
                enabled=enabled,
            )
            summary = f"node {target} kill-switch {'enabled' if enabled else 'disabled'}"
            target_payload = {"type": "node", "id": target, "node": target}
        elif scope == "board":
            self.store.set_execution_kill_switch(
                board=self.command_config.board,
                level="board",
                enabled=enabled,
            )
            summary = f"board kill-switch {'enabled' if enabled else 'disabled'}"
            target_payload = {"type": "board", "id": self.command_config.board}
        else:
            self.store.set_execution_kill_switch(
                board=self.command_config.board,
                level="global",
                enabled=enabled,
            )
            summary = f"global kill-switch {'enabled' if enabled else 'disabled'}"
            target_payload = {"type": "board", "id": self.command_config.board}
        self._audit_slack_command(
            command="killswitch",
            event=pending.event,
            actor=actor,
            status="ok",
            summary=summary,
            target=target_payload,
            payload={"enabled": enabled, "scope": scope},
        )
        return f"completed: {summary}"

    def _node_killswitch_denial(
        self,
        command: SlackCommandName,
        args: tuple[str, ...],
    ) -> str | None:
        if command != "killswitch":
            return None
        try:
            scope, target, _enabled = _parse_killswitch_args(args)
        except ValueError:
            return None
        if scope == "node" and (target is None or not self._command_node_exists(target)):
            return "deny: node outside project"
        return None

    def _command_node_exists(self, node: str) -> bool:
        return self.command_config is not None and node in self.command_config.node_names

    def _command_status_text(self, board: str) -> str:
        ready = len(self.store.list_tasks(board=board, status="ready"))
        running = len(self.store.list_tasks(board=board, status="running"))
        blocked = len(self.store.list_tasks(board=board, status="blocked"))
        gate = self.store.execution_global_state(board=board)
        return _safe_slack_text(
            f"status board={board} ready={ready} running={running} blocked={blocked} "
            f"execution={'on' if gate['enabled'] else 'off'} "
            f"kill_switch={'on' if gate['kill_switch'] else 'off'} "
            f"board_execution={'on' if gate['board_enabled'] else 'off'} "
            f"board_kill_switch={'on' if gate['board_kill_switch'] else 'off'}"
        )

    def _audit_slack_command(
        self,
        *,
        command: str,
        event: SlackEvent,
        actor: Mapping[str, object],
        status: str,
        summary: str,
        target: Mapping[str, object] | None = None,
        task_id: str | None = None,
        run_id: str | None = None,
        payload: Mapping[str, object] | None = None,
    ) -> None:
        board = (
            self.command_config.board if self.command_config is not None else self.human_gate.board
        )
        safe_summary = _safe_slack_text(summary)
        extra = {
            "team": _safe_slack_text(event.team),
            "channel": _safe_slack_text(event.channel),
            **(dict(payload) if payload is not None else {}),
        }
        self.store.add_audit_event(
            board=board,
            kind="audit.slack.command",
            actor=actor,
            action=_safe_slack_text(command),
            target=target or {"type": "slack_command", "id": _safe_slack_text(command)},
            task_id=task_id,
            run_id=run_id,
            status=status,
            summary=safe_summary,
            payload=extra,
        )

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
        self.store.add_comment_to_task(
            task_id=task.id,
            author=author,
            body=_answer_comment_body(event.text),
        )
        if self.store.unblock_task_by_id(task_id=task.id, actor=author):
            self._post_assistant_notice(
                event,
                decision="completed",
                reason="human_reply_recorded_answer",
                thread_ts=thread_ts,
            )
        return True

    def _assistant_context(self, event: SlackEvent, *, thread_ts: str) -> AssistantContext:
        board = self._assistant_board()
        display = self._project_directory().display_name(board)
        actor = self._assistant_member(event.user)
        actor_role = actor.role if actor is not None else "slack-unmapped"
        return AssistantContext(
            conversation_id=_slack_assistant_conversation_id(event, thread_ts=thread_ts),
            request_id=_slack_assistant_request_id(event),
            actor=AssistantActor(
                id=f"slack:{_safe_slack_text(event.user)}",
                role=actor_role,
                is_operator=actor_role in {"admin", "operator"},
                display_name=actor.name if actor is not None else None,
            ),
            scope=AssistantScope(
                selected_project=board,
                board=board,
                visible_projects=(board,),
                origin_surface="slack",
                origin_page=(
                    f"slack://{_safe_slack_text(event.team)}/"
                    f"{_safe_slack_text(event.channel)}/{_safe_slack_text(thread_ts)}"
                ),
                display_project=display,
                display_visible=(display,),
            ),
            store=self.store,
            workspace_path=_assistant_workspace_path(),
        )

    def _assistant_member(self, user: str) -> SlackCommandMember | None:
        if self.command_config is None:
            return None
        return self.command_config.members.get(user)

    def _assistant_actor_payload(self, event: SlackEvent) -> Mapping[str, object]:
        actor = self._assistant_member(event.user)
        if actor is not None:
            return _slack_member_actor(event.user, actor)
        return _slack_actor(event.user, role="read-only")

    def _assistant_notice_text(
        self,
        event: SlackEvent,
        *,
        thread_ts: str,
        decision: str,
        reason: str,
        response_type: MasterChatResponseType = "answer",
        requires_confirmation: bool = False,
        metadata: Mapping[str, object] | None = None,
    ) -> str:
        context = self._assistant_context(event, thread_ts=thread_ts)
        message = _normalize_slack_text(event.text)
        try:
            response = self.assistant_broker.handle_notice(
                message,
                context,
                decision=decision,
                reason=reason,
                response_type=response_type,
                requires_confirmation=requires_confirmation,
                metadata=metadata,
            )
        except AssistantContentBlocked:
            raise
        except AssistantTransportError as exc:
            LOGGER.warning("Slack assistant notice transport failed: %s", _safe_log_error(exc))
            return ASSISTANT_TRANSPORT_FALLBACK_TEXT
        except AssistantUnavailable as exc:
            raise AssistantContentBlocked(
                "assistant notice unavailable without transport signal"
            ) from exc
        except Exception as exc:
            LOGGER.warning("Slack assistant notice failed: %s", _safe_log_error(exc))
            raise AssistantContentBlocked("assistant notice failed") from exc
        return _assistant_response_text(response)

    def _post_assistant_notice(
        self,
        event: SlackEvent,
        *,
        thread_ts: str,
        decision: str,
        reason: str,
        response_type: MasterChatResponseType = "answer",
        requires_confirmation: bool = False,
        metadata: Mapping[str, object] | None = None,
        slack_metadata: Mapping[str, object] | None = None,
        reply_in_thread: bool = True,
    ) -> str:
        try:
            text = self._assistant_notice_text(
                event,
                thread_ts=thread_ts,
                decision=decision,
                reason=reason,
                response_type=response_type,
                requires_confirmation=requires_confirmation,
                metadata=metadata,
            )
        except AssistantContentBlocked as exc:
            LOGGER.warning("Slack assistant notice hidden: %s", _safe_log_error(exc))
            return ""
        return self.slack_client.post_message(
            channel=event.channel,
            text=text,
            thread_ts=thread_ts if reply_in_thread else None,
            metadata=slack_metadata,
        )

    def _post_human_gate_notice(
        self,
        event: SlackEvent,
        *,
        task: Task,
        slack_metadata: Mapping[str, object],
    ) -> str:
        return self.slack_client.post_message(
            channel=event.channel,
            text=_human_gate_notice_text(task),
            thread_ts=None,
            metadata=slack_metadata,
        )

    def _assistant_board(self) -> str:
        if self.command_config is not None:
            return self.command_config.board
        if self.digest_config is not None:
            return self.digest_config.board
        return self.human_gate.board

    def _handle_chat(self, event: SlackEvent, *, thread_ts: str) -> bool:
        text = self._node_chat_event_text(event, thread_ts=thread_ts)
        node = _select_chat_node(event, self.chat_route)
        item = self.store.enqueue_slack_chat_message(
            board=self.human_gate.board,
            team_id=event.team,
            channel_id=event.channel,
            thread_ts=thread_ts,
            message_ts=event.ts,
            user_id=event.user,
            node=node,
            text=text,
        )
        self._post_initial_node_chat_placeholder(item)
        self.store.upsert_slack_thread(
            board=self.human_gate.board,
            task_id=None,
            team_id=event.team,
            channel_id=event.channel,
            thread_ts=thread_ts,
            mode="chat",
            node=node,
        )
        return True

    def _node_chat_event_text(self, event: SlackEvent, *, thread_ts: str) -> str:
        text = _normalize_slack_text(event.text)
        file_context = self._node_chat_file_context(event, thread_ts=thread_ts)
        parts = [part for part in (text, file_context) if part.strip()]
        return "\n\n".join(parts) if parts else "(Slack message with attachment)"

    def _node_chat_file_context(self, event: SlackEvent, *, thread_ts: str) -> str:
        if not event.files:
            return ""
        lines = ["Attached Slack files:"]
        for attachment in event.files[:SLACK_NODE_CHAT_FILE_CONTEXT_LIMIT]:
            label = attachment.title or attachment.name or attachment.file_id or "file"
            details = []
            if attachment.mimetype:
                details.append(attachment.mimetype)
            elif attachment.filetype:
                details.append(attachment.filetype)
            if attachment.pretty_type:
                details.append(attachment.pretty_type)
            if attachment.size is not None:
                details.append(f"{attachment.size} bytes")
            local_path = self._cache_slack_file_attachment(
                attachment,
                team_id=event.team,
                channel_id=event.channel,
                thread_ts=thread_ts,
            )
            suffix = f" ({', '.join(details)})" if details else ""
            if local_path is not None:
                lines.append(f"- {label}{suffix}; local_path={local_path}")
            elif _slack_file_is_image(attachment):
                lines.append(f"- {label}{suffix}; image attachment present, local copy unavailable")
            else:
                lines.append(f"- {label}{suffix}")
        if len(event.files) > SLACK_NODE_CHAT_FILE_CONTEXT_LIMIT:
            remaining = len(event.files) - SLACK_NODE_CHAT_FILE_CONTEXT_LIMIT
            lines.append(f"- ... {remaining} more file(s)")
        return "\n".join(lines)

    def _cache_slack_file_attachment(
        self,
        attachment: SlackFileAttachment,
        *,
        team_id: str,
        channel_id: str,
        thread_ts: str,
    ) -> Path | None:
        if not _slack_file_is_image(attachment):
            return None
        download_url = attachment.url_private_download or attachment.url_private
        if not download_url:
            return None
        download_file = getattr(self.slack_client, "download_file", None)
        if not callable(download_file):
            return None
        file_id = attachment.file_id or "file"
        filename = _safe_slack_file_name(attachment.name or attachment.title or file_id)
        path = (
            Path("~/.grove").expanduser()
            / self.human_gate.board
            / "slack-files"
            / _safe_slack_file_name(team_id)
            / _safe_slack_file_name(channel_id)
            / _safe_slack_file_name(thread_ts)
            / f"{_safe_slack_file_name(file_id)}-{filename}"
        )
        try:
            download_file(url=download_url, destination=path)
        except Exception as exc:
            LOGGER.warning("Slack file attachment download skipped: %s", _safe_log_error(exc))
            return None
        return path

    def _post_initial_node_chat_placeholder(self, item: SlackChatQueueItem) -> None:
        if item.placeholder_ts:
            return
        try:
            ts = self.slack_client.post_message(
                channel=item.channel_id,
                text=SLACK_NODE_CHAT_WAIT_TEXT,
                thread_ts=item.thread_ts,
            )
            self.store.store_slack_chat_message_placeholder_ts(
                item.id,
                placeholder_ts=ts,
                now=int(time.time()),
            )
        except Exception as exc:
            LOGGER.warning(
                "Slack node chat initial placeholder skipped: %s",
                _safe_log_error(exc),
            )

    def poll_node_chat_queue(self) -> int:
        if not self._node_chat_queue_lock.acquire(blocking=False):
            return 0
        processed = 0
        try:
            now = int(time.time())
            stale_before = now - SLACK_NODE_CHAT_RUNNING_STALE_SECONDS
            for item in self.store.list_due_slack_chat_messages(
                board=self.human_gate.board,
                now=now,
                running_stale_before=stale_before,
                limit=SLACK_NODE_CHAT_QUEUE_LIMIT,
            ):
                self._process_node_chat_queue_item(item, now=now)
                processed += 1
        finally:
            self._node_chat_queue_lock.release()
        return processed

    def node_chat_queue_summary(self, *, now: int) -> dict[str, int | None]:
        return self.store.slack_chat_queue_summary(board=self.human_gate.board, now=now)

    def _node_chat_context_pack(self, item: SlackChatQueueItem, *, conversation_id: str) -> str:
        """Per-thread context-pack injected into the node-direct chat-master turn — matches
        the persona's ``[GROVE CHAT — THREAD CONTEXT]`` format. Prior turns of THIS thread
        (``role: text``, oldest→newest, capped, [R]-redacted) + the current message + a
        ``From`` line carrying the Slack user id (authoritative identity for auth/trust).
        The node treats this injected thread as the source of truth, not its own memory."""
        board = self.human_gate.board
        history = self.store.list_master_chat_messages(
            board=board, conversation_id=conversation_id, limit=_NODE_CHAT_HISTORY_LIMIT
        )
        lines = [
            f"{message.role}: {redact_secret_text(message.text)}"
            for message in history[-_NODE_CHAT_HISTORY_LIMIT:]
            if message.text.strip()
        ]
        member = self._assistant_member(item.user_id)
        display = member.name if member is not None else (item.user_id or "user")
        role_suffix = f", {member.role}" if member is not None else ""
        return "\n".join(
            [
                "[GROVE CHAT — THREAD CONTEXT]",
                f"Thread: {conversation_id}",
                f"Project: {self._project_directory().display_name(board)}",
                f"From: {display} ({item.user_id}{role_suffix})",
                "Conversation so far (THIS thread only, oldest→newest):",
                "\n".join(lines) if lines else "(none)",
                "Current message:",
                redact_secret_text(item.text),
            ]
        )

    def _persist_node_chat_turn(
        self, item: SlackChatQueueItem, *, conversation_id: str, response_text: str
    ) -> None:
        """Persist the user message + chat-master response to the per-thread durable
        history (idempotent on board/conversation/request_id/role — a retried turn never
        duplicates). Non-fatal: a history-write failure must not block delivery."""
        board = self.human_gate.board
        try:
            self.store.append_master_chat_message(
                board=board,
                conversation_id=conversation_id,
                role="user",
                text=redact_secret_text(item.text),
                request_id=item.message_ts,
                origin_surface="slack",
            )
            self.store.append_master_chat_message(
                board=board,
                conversation_id=conversation_id,
                role="assistant",
                text=redact_secret_text(response_text),
                request_id=f"{item.message_ts}:response",
                origin_surface="slack",
            )
        except Exception as exc:  # non-fatal: delivery proceeds even if history write fails
            LOGGER.warning("Slack node chat history persist failed: %s", _safe_log_error(exc))

    def _process_node_chat_queue_item(self, item: SlackChatQueueItem, *, now: int) -> None:
        # node-direct (the persistent chat-master node) is the only chat path.
        item = self.store.mark_slack_chat_message_running(item.id, now=now)
        session_id = _slack_chat_queue_conversation_id(item)
        response_text = item.response_text
        if response_text is None:
            try:
                item = self._ensure_node_chat_placeholder(item, now=now)
            except Exception as exc:
                LOGGER.warning(
                    "Slack node chat placeholder delivery deferred: %s",
                    _safe_log_error(exc),
                )
                self.store.defer_slack_chat_message(
                    item.id,
                    error=_safe_log_error(exc),
                    next_attempt_at=now + self.node_chat_retry_delay_seconds,
                    now=now,
                )
                return
            wait_updates = self._start_node_chat_wait_updates(item)
            try:
                response_text = self.chat_facade.send(
                    session_id=session_id,
                    node=item.node,
                    text=self._node_chat_context_pack(item, conversation_id=session_id),
                )
            except Exception as exc:
                self._stop_node_chat_wait_updates(wait_updates)
                if _slack_node_chat_input_busy(exc):
                    LOGGER.info("Slack node chat deferred by input guard: %s", _safe_log_error(exc))
                    self.store.defer_slack_chat_message(
                        item.id,
                        error=_safe_log_error(exc),
                        next_attempt_at=now + self.node_chat_retry_delay_seconds,
                        now=now,
                    )
                    return
                if _slack_node_chat_timed_out(exc):
                    LOGGER.info("Slack node chat deferred by timeout: %s", _safe_log_error(exc))
                    self.store.defer_slack_chat_message(
                        item.id,
                        error=_safe_log_error(exc),
                        next_attempt_at=now + self.node_chat_retry_delay_seconds,
                        now=now,
                    )
                    return
                LOGGER.warning("Slack node chat failed: %s", _safe_log_error(exc))
                self.store.fail_slack_chat_message(item.id, error=_safe_log_error(exc), now=now)
                return
            else:
                self._stop_node_chat_wait_updates(wait_updates)
                self._persist_node_chat_turn(
                    item, conversation_id=session_id, response_text=response_text
                )
                item = self.store.store_slack_chat_message_response(
                    item.id,
                    response_text=response_text,
                    now=now,
                )
                response_text = item.response_text or ""
        try:
            self._deliver_node_chat_response(item, response_text=response_text)
        except Exception as exc:
            LOGGER.warning(
                "Slack node chat response delivery deferred: %s",
                _safe_log_error(exc),
            )
            self.store.defer_slack_chat_message(
                item.id,
                error=_safe_log_error(exc),
                next_attempt_at=now + self.node_chat_retry_delay_seconds,
                now=now,
            )
            return
        self.store.complete_slack_chat_message(item.id, now=now)

    def _ensure_node_chat_placeholder(
        self, item: SlackChatQueueItem, *, now: int
    ) -> SlackChatQueueItem:
        if item.placeholder_ts:
            return item
        ts = self.slack_client.post_message(
            channel=item.channel_id,
            text=SLACK_NODE_CHAT_WAIT_TEXT,
            thread_ts=item.thread_ts,
        )
        return self.store.store_slack_chat_message_placeholder_ts(
            item.id,
            placeholder_ts=ts,
            now=now,
        )

    def _start_node_chat_wait_updates(
        self, item: SlackChatQueueItem
    ) -> tuple[threading.Event, threading.Thread] | None:
        update_message = getattr(self.slack_client, "update_message", None)
        if not item.placeholder_ts or not callable(update_message):
            return None
        stop = threading.Event()
        started = time.monotonic()

        def update_loop() -> None:
            while not stop.wait(SLACK_NODE_CHAT_WAIT_UPDATE_SECONDS):
                elapsed = int(time.monotonic() - started)
                try:
                    self._update_slack_message(
                        channel=item.channel_id,
                        ts=item.placeholder_ts or "",
                        text=_node_chat_wait_text(elapsed),
                    )
                except Exception as exc:
                    LOGGER.info("Slack node chat wait update skipped: %s", _safe_log_error(exc))

        thread = threading.Thread(target=update_loop, daemon=True)
        thread.start()
        return stop, thread

    def _stop_node_chat_wait_updates(
        self, wait_updates: tuple[threading.Event, threading.Thread] | None
    ) -> None:
        if wait_updates is None:
            return
        stop, thread = wait_updates
        stop.set()
        thread.join(timeout=1.0)

    def _deliver_node_chat_response(self, item: SlackChatQueueItem, *, response_text: str) -> None:
        chunks = _slack_assistant_response_chunks(response_text)
        if item.placeholder_ts and self._update_slack_message(
            channel=item.channel_id,
            ts=item.placeholder_ts,
            text=chunks[0],
        ):
            for response_chunk in chunks[1:]:
                self.slack_client.post_message(
                    channel=item.channel_id,
                    text=response_chunk,
                    thread_ts=item.thread_ts,
                )
            return
        for response_chunk in chunks:
            self.slack_client.post_message(
                channel=item.channel_id,
                text=response_chunk,
                thread_ts=item.thread_ts,
            )

    def _update_slack_message(
        self,
        *,
        channel: str,
        ts: str,
        text: str,
    ) -> bool:
        update_message = getattr(self.slack_client, "update_message", None)
        if not callable(update_message):
            return False
        update_message(channel=channel, ts=ts, text=text)
        return True

    def _project_directory(self) -> ProjectDirectory:
        """Project display/identity directory (single source: ~/.grove registries).
        Resolves display names <-> internal boards so the chat layer never exposes
        the internal board/session id (e.g. 'dev10') to the model."""
        return ProjectDirectory(
            Path("~/.grove").expanduser(), default_session=self.human_gate.board
        )


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


def config_status(
    config_path: Path = SLACK_CONFIG_PATH,
    *,
    intake_enabled: bool = False,
    runtime_status_path: Path | None = None,
) -> dict[str, object]:
    runtime_status = _fresh_slack_runtime_status(runtime_status_path)
    return FakeStatusProbe(
        config_path=config_path,
        socket_connected=bool(runtime_status.get("socket_connected")),
        last_event_at=cast(int | None, runtime_status.get("last_event_at")),
        last_error=cast(str | None, runtime_status.get("last_error")),
        intake_enabled=intake_enabled,
    ).status()


def slack_runtime_status_path(grove_home: Path, session: str) -> Path:
    return grove_home.expanduser() / session / SLACK_RUNTIME_STATUS_FILENAME


def _fresh_slack_runtime_status(path: Path | None) -> dict[str, object]:
    if path is None:
        return {}
    try:
        loaded = json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return {}
    if not isinstance(loaded, Mapping):
        return {}
    updated_at = loaded.get("updated_at")
    if not isinstance(updated_at, (int, float)) or isinstance(updated_at, bool):
        return {}
    if time.time() - float(updated_at) > SLACK_RUNTIME_STATUS_TTL_SECONDS:
        return {}
    runtime: dict[str, object] = {}
    if loaded.get("socket_connected") is True:
        runtime["socket_connected"] = True
    last_event_at = loaded.get("last_event_at")
    if isinstance(last_event_at, int) and not isinstance(last_event_at, bool):
        runtime["last_event_at"] = last_event_at
    last_error = loaded.get("last_error")
    if isinstance(last_error, str) and last_error:
        runtime["last_error"] = redact_secret_text(last_error)
    return runtime


def _write_slack_runtime_status(
    path: Path,
    *,
    socket_connected: bool,
    last_event_at: int | None = None,
    last_error: str | None = None,
    node_chat_queue: Mapping[str, int | None] | None = None,
) -> None:
    payload: dict[str, object] = {
        "socket_connected": socket_connected,
        "updated_at": int(time.time()),
        "pid": os.getpid(),
    }
    if last_event_at is not None:
        payload["last_event_at"] = last_event_at
    if last_error:
        payload["last_error"] = redact_secret_text(last_error)
    if node_chat_queue is not None:
        payload["node_chat_queue"] = dict(node_chat_queue)
    path.parent.mkdir(parents=True, exist_ok=True)
    temp_path = path.with_name(f"{path.name}.{os.getpid()}.tmp")
    temp_path.write_text(f"{json.dumps(payload, sort_keys=True)}\n", encoding="utf-8")
    temp_path.replace(path)


def mask_token(value: str) -> str:
    if len(value) <= 7:
        return value[:4] + "..." + value[-4:]
    if len(value) <= 8:
        return value[:4] + "..." + value[-3:]
    return value[:4] + "..." + value[-4:]


def _parse_command_members(values: Sequence[str]) -> dict[str, SlackCommandMember]:
    members: dict[str, SlackCommandMember] = {}
    for value in values:
        slack_user, member_id, name, role = _parse_command_member(value)
        members[slack_user] = SlackCommandMember(
            member_id=member_id,
            name=name,
            role=role,
        )
    return members


def _parse_command_member(value: str) -> tuple[str, str, str, SlackCommandRole]:
    parts = value.split(":", 3)
    if len(parts) != 4 or any(not part.strip() for part in parts):
        raise ValueError(
            "command member must use SLACK_USER:MEMBER_ID:NAME:ROLE with role admin, "
            "operator, or viewer"
        )
    slack_user, member_id, name, raw_role = (part.strip() for part in parts)
    if raw_role not in {"admin", "operator", "viewer"}:
        raise ValueError("command member role must be admin, operator, or viewer")
    return slack_user, member_id, name, cast(SlackCommandRole, raw_role)


def slack_command_members_path(grove_home: Path, session: str) -> Path:
    return grove_home.expanduser() / session / SLACK_COMMAND_MEMBERS_FILENAME


def load_command_members_file(path: Path) -> dict[str, SlackCommandMember]:
    """Load persisted command members from a 0600 JSON config:
    ``{"members": [{"slack_user","member_id","name","role"}]}`` (role ∈ admin/operator/
    viewer). **Fail-closed:** a missing/unreadable/wrong-shaped file yields ``{}`` (no
    members → read-only). A present-but-INVALID member entry (unknown role / missing
    field) raises ``ValueError`` — invalid persisted members are never silently dropped.
    """
    try:
        raw = path.read_text(encoding="utf-8")
    except (FileNotFoundError, OSError):
        return {}
    try:
        loaded = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise ValueError(f"command members file is not valid JSON: {path}") from exc
    if not isinstance(loaded, Mapping):
        return {}
    entries = loaded.get("members")
    if not isinstance(entries, list):
        return {}
    members: dict[str, SlackCommandMember] = {}
    for entry in entries:
        if not isinstance(entry, Mapping):
            raise ValueError("each command member must be an object")
        slack_user = str(entry.get("slack_user") or "").strip()
        member_id = str(entry.get("member_id") or "").strip()
        name = str(entry.get("name") or "").strip()
        role = str(entry.get("role") or "").strip()
        if not (slack_user and member_id and name and role):
            raise ValueError("command member requires slack_user, member_id, name, role")
        if role not in {"admin", "operator", "viewer"}:
            raise ValueError(f"command member role must be admin, operator, or viewer: {role!r}")
        members[slack_user] = SlackCommandMember(
            member_id=member_id, name=name, role=cast(SlackCommandRole, role)
        )
    return members


def _load_command_node_names(grove_home: Path, session: str) -> frozenset[str]:
    registry_path = grove_home.expanduser() / session / "registry.json"
    try:
        loaded = json.loads(registry_path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return frozenset()
    if not isinstance(loaded, dict):
        return frozenset()
    raw_nodes = loaded.get("nodes")
    if not isinstance(raw_nodes, dict):
        return frozenset()
    nodes: set[str] = set()
    for key, raw_node in raw_nodes.items():
        if not isinstance(key, str) or not isinstance(raw_node, dict):
            continue
        raw_name = raw_node.get("name")
        node_name = raw_name.strip() if isinstance(raw_name, str) and raw_name.strip() else key
        pane = raw_node.get("tmux_pane")
        if not _valid_node_ref(node_name) or not isinstance(pane, str):
            continue
        match = TMUX_TARGET_RE.fullmatch(pane.strip())
        if match is None or match.group("session") != session:
            continue
        if int(match.group("window")) == 0 and int(match.group("pane")) == 0:
            continue
        nodes.add(node_name)
    return frozenset(nodes)


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Run the grove Slack connector.")
    parser.add_argument("--config-path", type=Path, default=SLACK_CONFIG_PATH)
    parser.add_argument("--board", default="default")
    parser.add_argument("--channel")
    parser.add_argument("--default-node")
    parser.add_argument("--board-db-path", type=Path, default=default_board_db_path())
    parser.add_argument("--poll-interval", type=float, default=5.0)
    parser.add_argument("--enable-commands", action="store_true")
    parser.add_argument("--enable-intake", action="store_true")
    parser.add_argument("--enable-digest", action="store_true")
    parser.add_argument("--digest-live", action="store_true")
    parser.add_argument("--digest-interval", type=int, default=300)
    parser.add_argument("--enable-reminders", action="store_true")
    parser.add_argument(
        "--route-chat-to-node",
        action="store_true",
        help="Deprecated compatibility flag; Slack chat is always node-direct.",
    )
    parser.add_argument("--reminder-after-seconds", type=int, default=3600)
    parser.add_argument("--max-reminders", type=int, default=1)
    parser.add_argument("--intake-assignee")
    parser.add_argument(
        "--command-member",
        action="append",
        default=[],
        dest="command_members",
        metavar="SLACK_USER:MEMBER_ID:NAME:ROLE",
    )
    parser.add_argument(
        "--command-members-path",
        type=Path,
        help=(
            "Path to a 0600 JSON config of persisted command members "
            "({members:[{slack_user,member_id,name,role}]}). Defaults to "
            "<grove-home>/<session>/slack-command-members.json. --command-member "
            "(CLI) overrides file entries."
        ),
    )
    parser.add_argument(
        "--grove-home",
        type=Path,
        default=Path(os.environ.get("GROVE_HOME", "~/.grove")).expanduser(),
    )
    parser.add_argument("--session", default=os.environ.get("GROVE_VIEWER_SESSION", "dev10"))
    parser.add_argument("--runtime-status-path", type=Path)
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
    command_config = None
    command_node_names: frozenset[str] = frozenset()
    if args.enable_commands or args.enable_intake or args.enable_digest or args.enable_reminders:
        command_node_names = _load_command_node_names(args.grove_home, args.session)
    if args.enable_commands or args.enable_intake:
        members_path = args.command_members_path or slack_command_members_path(
            args.grove_home, args.session
        )
        try:
            # Persisted file members (auto-loaded from the default path when present),
            # then CLI --command-member as an emergency override (CLI wins).
            file_members = load_command_members_file(members_path)
            cli_members = _parse_command_members(args.command_members)
        except ValueError as exc:
            raise SystemExit(str(exc)) from exc
        members = {**file_members, **cli_members}
        command_config = SlackCommandConfig(
            board=args.board,
            members=members,
            node_names=command_node_names,
            intake_enabled=args.enable_intake,
            intake_assignee=args.intake_assignee,
        )
    digest_config = SlackDigestConfig(
        board=args.board,
        channel=channel,
        enabled=args.enable_digest or args.enable_reminders,
        dry_run=not args.digest_live,
        interval_seconds=args.digest_interval,
        reminder_enabled=args.enable_reminders,
        reminder_after_seconds=args.reminder_after_seconds,
        max_reminders=args.max_reminders,
        node_names=command_node_names,
    )
    slack_client = SlackSdkClient(bot_token=config.bot_token)
    connector = SlackConnector(
        store=SQLiteBoardStore(args.board_db_path),
        slack_client=slack_client,
        chat_facade=GroveServeChatFacade(),
        human_gate=HumanGateConfig(board=args.board, channel=channel),
        chat_route=ChatRouteConfig(default_node=node),
        command_config=command_config,
        digest_config=digest_config,
        bot_user_id=_bot_user_id_from_client(slack_client),
        route_chat_to_node=args.route_chat_to_node,
    )
    socket_client = _build_socket_client(config=config, connector=connector)
    runtime_status_path = args.runtime_status_path or slack_runtime_status_path(
        args.grove_home,
        args.session,
    )
    socket_client.connect()
    stop_node_chat_queue = threading.Event()
    node_chat_queue_thread = threading.Thread(
        target=_run_node_chat_queue_worker,
        kwargs={
            "connector": connector,
            "stop_event": stop_node_chat_queue,
            "poll_interval": args.poll_interval,
        },
        name="grove-slack-node-chat-queue",
        daemon=True,
    )
    node_chat_queue_thread.start()
    socket_disconnected_since: float | None = None
    try:
        while True:
            last_error: str | None = None
            socket_connected = _socket_is_connected(socket_client)
            if socket_connected:
                socket_disconnected_since = None
            else:
                now_monotonic = time.monotonic()
                if socket_disconnected_since is None:
                    socket_disconnected_since = now_monotonic
                disconnected_for = now_monotonic - socket_disconnected_since
                if disconnected_for >= SLACK_SOCKET_DISCONNECTED_RESTART_SECONDS:
                    LOGGER.error(
                        "Slack socket wedged >%.0fs; exiting for fresh restart",
                        SLACK_SOCKET_DISCONNECTED_RESTART_SECONDS,
                    )
                    raise RuntimeError(
                        "Slack socket disconnected for "
                        f"{disconnected_for:.1f}s; exiting for fresh restart"
                    )
                LOGGER.warning("Slack socket disconnected; reconnecting")
                try:
                    socket_client.connect()
                except Exception as exc:
                    last_error = _safe_log_error(exc)
                    LOGGER.warning("Slack socket reconnect failed: %s", last_error)
                socket_connected = _socket_is_connected(socket_client)
                if socket_connected:
                    socket_disconnected_since = None
            _write_slack_runtime_status(
                runtime_status_path,
                socket_connected=socket_connected,
                last_error=last_error,
                node_chat_queue=connector.node_chat_queue_summary(now=int(time.time())),
            )
            connector.poll_human_gates()
            connector.poll_completion_notices()
            try:
                connector.poll_digest()
            except Exception as exc:
                LOGGER.warning("Slack digest poll failed: %s", _safe_log_error(exc))
            time.sleep(args.poll_interval)
    finally:
        stop_node_chat_queue.set()
        if node_chat_queue_thread is not None:
            node_chat_queue_thread.join(timeout=1.0)
        _write_slack_runtime_status(
            runtime_status_path,
            socket_connected=False,
            node_chat_queue=connector.node_chat_queue_summary(now=int(time.time())),
        )
        socket_client.close()


def _run_node_chat_queue_worker(
    *,
    connector: SlackConnector,
    stop_event: threading.Event,
    poll_interval: float,
) -> None:
    while not stop_event.is_set():
        try:
            connector.poll_node_chat_queue()
        except Exception as exc:
            LOGGER.warning("Slack node chat queue poll failed: %s", _safe_log_error(exc))
        stop_event.wait(poll_interval)


def _socket_is_connected(socket_client: SocketClientProtocol) -> bool:
    try:
        return socket_client.is_connected()
    except Exception as exc:
        LOGGER.warning("Slack socket status check failed: %s", _safe_log_error(exc))
        return True


def _bot_user_id_from_client(slack_client: object) -> str | None:
    bot_user_id = getattr(slack_client, "bot_user_id", None)
    if not callable(bot_user_id):
        return None
    try:
        user_id = cast(Callable[[], object], bot_user_id)()
    except Exception as exc:
        LOGGER.warning("Slack auth.test failed: %s", _safe_log_error(exc))
        return None
    return user_id if isinstance(user_id, str) and user_id else None


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
        try:
            client.send_socket_mode_response(response_cls(envelope_id=request.envelope_id))
        except Exception as exc:
            LOGGER.warning("Slack socket ack failed: %s", _safe_log_error(exc))
        try:
            if request.type == "events_api" and isinstance(request.payload, Mapping):
                event = _event_from_socket_payload(
                    cast(Mapping[str, object], request.payload),
                    bot_user_id=connector.bot_user_id,
                )
                if event is not None:
                    connector.handle_event(event)
            elif request.type == "interactive" and isinstance(request.payload, Mapping):
                connector.handle_interaction(cast(Mapping[str, object], request.payload))
        except Exception as exc:
            LOGGER.warning("Slack socket handler failed: %s", _safe_log_error(exc))

    socket_client.socket_mode_request_listeners.append(listener)
    return socket_client


def _event_from_socket_payload(
    payload: Mapping[str, object],
    *,
    bot_user_id: str | None = None,
) -> SlackEvent | None:
    raw_event = payload.get("event")
    if not isinstance(raw_event, dict):
        return None
    event = cast(Mapping[str, object], raw_event)
    bot_id = _mapping_str(event, "bot_id")
    app_id = _mapping_str(event, "app_id")
    subtype = _mapping_str(event, "subtype")
    if bot_id is not None or app_id is not None or subtype is not None:
        return None
    team = payload.get("team_id")
    channel = event.get("channel")
    user = event.get("user")
    text = event.get("text")
    files = _slack_file_attachments(event.get("files"))
    if not isinstance(text, str) and files:
        text = ""
    ts = event.get("ts")
    if not isinstance(ts, str):
        ts = event.get("event_ts")
    if bot_user_id is not None and user == bot_user_id:
        return None
    if not all(isinstance(value, str) for value in (team, channel, user, text, ts)):
        return None
    thread_ts = event.get("thread_ts")
    event_type = event.get("type")
    event_id = payload.get("event_id")
    client_msg_id = event.get("client_msg_id")
    return SlackEvent(
        team=cast(str, team),
        channel=cast(str, channel),
        user=cast(str, user),
        text=cast(str, text),
        ts=cast(str, ts),
        thread_ts=thread_ts if isinstance(thread_ts, str) else None,
        event_type=event_type if isinstance(event_type, str) else "message",
        event_id=event_id if isinstance(event_id, str) else None,
        client_msg_id=client_msg_id if isinstance(client_msg_id, str) else None,
        bot_id=bot_id,
        app_id=app_id,
        subtype=subtype,
        files=files,
    )


def _first_block_action(payload: Mapping[str, object]) -> Mapping[str, object] | None:
    if payload.get("type") != "block_actions":
        return None
    actions = payload.get("actions")
    if not isinstance(actions, list) or not actions:
        return None
    first = actions[0]
    return first if isinstance(first, Mapping) else None


def _event_from_interaction_payload(
    payload: Mapping[str, object],
    *,
    action_id: str,
) -> SlackEvent | None:
    team = _nested_str(payload, "team", "id") or ""
    channel = _nested_str(payload, "channel", "id")
    user = _nested_str(payload, "user", "id")
    message = payload.get("message")
    if not isinstance(message, Mapping):
        return None
    ts = message.get("ts")
    thread_ts = message.get("thread_ts")
    if not isinstance(channel, str) or not isinstance(user, str) or not isinstance(ts, str):
        return None
    return SlackEvent(
        team=team,
        channel=channel,
        user=user,
        text=action_id,
        ts=ts,
        thread_ts=thread_ts if isinstance(thread_ts, str) else ts,
        event_type="block_actions",
    )


def _nested_str(mapping: Mapping[str, object], key: str, nested_key: str) -> str | None:
    value = mapping.get(key)
    if not isinstance(value, Mapping):
        return None
    nested = value.get(nested_key)
    return nested if isinstance(nested, str) else None


def _mapping_str(mapping: Mapping[str, object], key: str) -> str | None:
    value = mapping.get(key)
    return value if isinstance(value, str) and value else None


def _mapping_int(mapping: Mapping[str, object], key: str) -> int | None:
    value = mapping.get(key)
    if isinstance(value, int):
        return value
    if isinstance(value, str) and value.isdigit():
        return int(value)
    return None


def _slack_file_attachments(value: object) -> tuple[SlackFileAttachment, ...]:
    if not isinstance(value, Sequence) or isinstance(value, str | bytes):
        return ()
    attachments: list[SlackFileAttachment] = []
    for raw in value:
        if not isinstance(raw, Mapping):
            continue
        attachment = _slack_file_attachment(raw)
        if attachment is not None:
            attachments.append(attachment)
    return tuple(attachments)


def _slack_file_attachment(raw: Mapping[str, object]) -> SlackFileAttachment | None:
    file_id = _mapping_str(raw, "id") or _mapping_str(raw, "file_id") or ""
    title = _mapping_str(raw, "title") or ""
    name = _mapping_str(raw, "name") or title
    mimetype = _mapping_str(raw, "mimetype") or ""
    filetype = _mapping_str(raw, "filetype") or ""
    pretty_type = _mapping_str(raw, "pretty_type") or ""
    url_private = _mapping_str(raw, "url_private")
    url_private_download = _mapping_str(raw, "url_private_download")
    if not any((file_id, title, name, mimetype, filetype, url_private, url_private_download)):
        return None
    return SlackFileAttachment(
        file_id=file_id,
        title=title,
        name=name,
        mimetype=mimetype,
        filetype=filetype,
        pretty_type=pretty_type,
        size=_mapping_int(raw, "size"),
        url_private=url_private,
        url_private_download=url_private_download,
    )


def _slack_file_is_image(attachment: SlackFileAttachment) -> bool:
    if attachment.mimetype.lower().startswith("image/"):
        return True
    image_types = {"jpg", "jpeg", "png", "gif", "webp", "heic", "heif", "svg"}
    if attachment.filetype.lower() in image_types:
        return True
    suffix = Path(attachment.name or attachment.title).suffix.lower().lstrip(".")
    return suffix in image_types


def _safe_slack_file_name(value: str) -> str:
    cleaned = re.sub(r"[^A-Za-z0-9._-]+", "_", value.strip())
    cleaned = cleaned.strip("._")
    return cleaned[:120] or "file"


def _needs_human(task: Task) -> bool:
    return bool(task.metadata.get("needs_human"))


def _is_task_completion_event(event: BoardEvent) -> bool:
    if event.kind == "task.completed":
        return True
    if event.kind != "audit.task.status":
        return False
    return event.payload.get("to_status") == "done"


def _completion_notice_dedup_key(event: BoardEvent) -> str:
    task_id = event.task_id or "unknown"
    return f"task_completed:{task_id}:{event.cursor}"


def _completion_notice_metadata(task: Task, *, event: BoardEvent) -> dict[str, object]:
    return {
        "event_type": TASK_COMPLETION_METADATA_EVENT_TYPE,
        "event_payload": {
            "dedup_key": _completion_notice_dedup_key(event),
            "board": task.board_id,
            "task_id": task.id,
        },
    }


def _completion_notice_text(task: Task, *, event: BoardEvent) -> str:
    summary = ""
    raw_summary = event.payload.get("summary")
    if isinstance(raw_summary, str):
        summary = raw_summary.strip()
    title = _safe_slack_message_text(task.title)
    assignee = _safe_slack_message_text(task.assignee or "unassigned")
    parts = [f"Task completed: `{task.id}` - {title}", f"assignee: {assignee}"]
    if summary:
        parts.append(f"summary: {_safe_slack_message_text(summary)}")
    return "\n".join(parts)


def _answer_comment_body(text: str) -> str:
    body = text.strip()
    if body.upper().startswith("ANSWER:"):
        return body
    return f"ANSWER: {body}" if body else "ANSWER:"


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


def _human_gate_notice_text(task: Task) -> str:
    question = _safe_slack_message_text(task.metadata.get("question") or task.body or "")
    title = _safe_slack_text(task.title)
    assignee = _safe_slack_text(task.assignee or "unassigned")
    lines = [
        f"Human decision needed for item {task.id}: {title}",
        f"Assignee: {assignee}",
    ]
    if question:
        lines.append(f"Question: {question}")
    lines.append("Reply in this thread to add the answer.")
    return "\n".join(lines)


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


def _normalize_slack_text(text: str) -> str:
    return " ".join(part for part in text.split() if not part.startswith("<@"))


def _normalize_slack_command_text(text: str) -> str:
    normalized = _normalize_slack_text(text)
    if not normalized.startswith("/"):
        return normalized
    command_text = normalized[1:].strip()
    if command_text.lower().startswith("grove "):
        return command_text[6:].strip()
    return command_text


def _assistant_mentioned(event: SlackEvent, *, bot_user_id: str | None) -> bool:
    # ``app_mention`` is delivered by Slack ONLY when the bot itself is mentioned, so
    # it is trusted. For a plain ``message`` event we require the bot's OWN mention.
    if event.event_type == "app_mention":
        return True
    if bot_user_id:
        return f"<@{bot_user_id}>" in event.text
    # Fail closed: without a confirmed bot_user_id we must NOT treat an arbitrary
    # <@U...> as addressing the bot — that reacts to other people's mentions. (See
    # the bot_user_id auth.test resolution; a missing id is the real root cause.)
    return False


def _explicit_reserved_command_text(text: str) -> bool:
    normalized = _normalize_slack_text(text)
    if normalized.startswith("/"):
        return True
    first = normalized.split(maxsplit=1)[0].lower() if normalized.split() else ""
    return first in {"status", "approve", "abort", "killswitch", "confirm", "digest"}


def _slack_assistant_conversation_id(event: SlackEvent, *, thread_ts: str) -> str:
    return (
        f"slack:{_safe_slack_text(event.team)}:"
        f"{_safe_slack_text(event.channel)}:{_safe_slack_text(thread_ts)}"
    )


def _slack_chat_queue_conversation_id(item: SlackChatQueueItem) -> str:
    return (
        f"slack:{_safe_slack_text(item.team_id)}:"
        f"{_safe_slack_text(item.channel_id)}:{_safe_slack_text(item.thread_ts)}"
    )


def _slack_event_from_chat_queue_item(item: SlackChatQueueItem) -> SlackEvent:
    return SlackEvent(
        team=item.team_id,
        channel=item.channel_id,
        user=item.user_id,
        text=item.text,
        ts=item.message_ts,
        thread_ts=item.thread_ts,
        event_type="app_mention",
    )


def _slack_node_chat_input_busy(exc: Exception) -> bool:
    return SLACK_NODE_CHAT_INPUT_BUSY_MARKER in str(exc)


def _slack_node_chat_timed_out(exc: Exception) -> bool:
    return isinstance(exc, subprocess.TimeoutExpired) or "timed out after" in str(exc)


def _slack_assistant_request_id(event: SlackEvent) -> str:
    request_id = event.event_id or event.client_msg_id or event.ts
    return f"slack:{_safe_slack_text(request_id)}"


def _assistant_response_text(response: MasterChatResponse) -> str:
    if response.answer is not None and response.answer.text.strip():
        return _safe_slack_message_text(response.answer.text)
    raise AssistantContentBlocked("assistant response missing answer text")


def _slack_notice_decision_from_result(result: str) -> str:
    lowered = result.lower()
    if (
        lowered.startswith("deny:")
        or lowered.startswith("denied")
        or lowered.startswith("invalid")
        or lowered.startswith("usage:")
    ):
        return "deny"
    if lowered.startswith("preview:"):
        return "preview"
    return "completed"


def _slack_notice_response_type_from_result(result: str) -> MasterChatResponseType:
    return "denied" if _slack_notice_decision_from_result(result) == "deny" else "answer"


def _slack_notice_reason_from_result(result: str) -> str:
    safe = _safe_slack_text(result).strip()
    lowered = safe.lower()
    if lowered.startswith("deny:") or lowered.startswith("denied:"):
        return safe.split(":", 1)[1].strip()
    if lowered.startswith("completed:") or lowered.startswith("preview:"):
        return safe.split(":", 1)[1].strip()
    return safe


def _assistant_workspace_path() -> Path:
    return Path(__file__).resolve().parents[3]


def _select_chat_node(event: SlackEvent, route: ChatRouteConfig) -> str:
    channel_node = route.channel_nodes.get(event.channel)
    if channel_node is not None:
        return channel_node
    text = _normalize_slack_text(event.text)
    for match in NODE_MENTION_RE.finditer(text):
        mentioned = match.group("node")
        return route.mention_nodes.get(mentioned, mentioned)
    return route.default_node


def _strip_intake_prefix(text: str) -> str:
    clean = _normalize_slack_text(text).strip()
    lowered = clean.lower()
    for prefix in ("bug:", "feedback:", "task:", "bug ", "feedback ", "task "):
        if lowered.startswith(prefix):
            return clean[len(prefix) :].strip()
    return clean


def _intent_from_intake_command(command: str) -> SlackIntentName:
    if command == "bug":
        return "bug"
    if command == "feedback":
        return "feedback"
    return "task_request"


def _labels_for_intent(intent: SlackIntentName) -> tuple[str, ...]:
    if intent == "bug":
        return ("slack-intake", "bug")
    if intent == "feedback":
        return ("slack-intake", "feedback")
    if intent == "task_request":
        return ("slack-intake", "task-request")
    return ("slack-intake",)


def _build_intake_task_proposal(
    *,
    event: SlackEvent,
    classification: SlackIntentClassification,
    config: SlackCommandConfig,
) -> SlackIntakeProposal:
    title = _safe_intake_title(classification.title or classification.summary)
    body = _safe_slack_text(classification.summary or title)
    labels = _safe_intake_labels(
        (*classification.labels, *_labels_for_intent(classification.intent))
    )
    assignee = config.intake_assignee
    if assignee is not None and (
        not _valid_node_ref(assignee) or assignee not in config.node_names
    ):
        assignee = None
    return SlackIntakeProposal(
        intent=classification.intent,
        title=title,
        body=body,
        labels=labels,
        priority=1 if classification.intent == "bug" else 0,
        assignee=assignee,
        confidence=_rounded_confidence(classification.confidence),
        reason=_safe_slack_text(classification.reason),
        slack={
            "team": _safe_slack_text(event.team),
            "channel": _safe_slack_text(event.channel),
            "thread_ts": _safe_slack_text(event.thread_ts or event.ts),
            "message_ts": _safe_slack_text(event.ts),
            "user": _safe_slack_text(event.user),
        },
    )


def _slack_task_body_with_grove_context(
    body: str | None,
    *,
    config: SlackCommandConfig,
    target_node: str | None,
) -> str:
    nodes = tuple(
        ContextPackNode(name=node, parent="lead")
        for node in sorted(config.node_names)
        if node.strip()
    )
    return prepend_grove_context_pack(
        body,
        caller_node="slack intake",
        nodes=nodes,
        project=config.board,
        target_node=target_node,
    )


def _digest_reminder_notice_reason(*, task: Task, step: int, max_reminders: int) -> str:
    kind = "ask-human" if _needs_human(task) else "blocked"
    return _safe_slack_text(
        f"digest reminder {step}/{max_reminders}: {kind} task `{task.id}` remains blocked; "
        f"title={task.title}"
    )


def _digest_reminder_pending_key(*, task: Task, step: int) -> str:
    return f"pending:digest_reminder:{task.id}:{step}"


def _task_slack_thread_ts(
    store: SQLiteBoardStore,
    *,
    board: str,
    task: Task,
    channel: str,
) -> str | None:
    for sub in store.list_notify_subs(board=board, task_id=task.id):
        if sub.channel_kind == "slack" and sub.room_id == channel and sub.thread_id:
            return sub.thread_id
    for thread in store.list_slack_threads(task_id=task.id, mode=HUMAN_GATE_MODE):
        if thread.channel_id == channel:
            return thread.thread_ts
    return None


def _digest_config_status_text(config: SlackDigestConfig) -> str:
    return _safe_slack_text(
        f"digest status enabled={config.enabled} dry_run={config.dry_run} "
        f"reminders={config.reminder_enabled} interval={config.interval_seconds}s"
    )


def _decode_intake_proposal(args: tuple[str, ...]) -> SlackIntakeProposal | None:
    if len(args) != 1:
        return None
    try:
        loaded = json.loads(args[0])
    except json.JSONDecodeError:
        return None
    if not isinstance(loaded, dict):
        return None
    intent = loaded.get("intent")
    if intent not in TASK_INTENTS:
        return None
    title = loaded.get("title")
    body = loaded.get("body")
    labels = loaded.get("labels")
    priority = loaded.get("priority")
    assignee = loaded.get("assignee")
    confidence = loaded.get("confidence")
    reason = loaded.get("reason")
    slack = loaded.get("slack")
    if not isinstance(title, str) or not isinstance(body, str):
        return None
    if not isinstance(labels, list) or not all(isinstance(label, str) for label in labels):
        return None
    if not isinstance(priority, int):
        return None
    if assignee is not None and not isinstance(assignee, str):
        return None
    if not isinstance(confidence, int | float):
        return None
    if not isinstance(reason, str) or not isinstance(slack, dict):
        return None
    return SlackIntakeProposal(
        intent=cast(SlackIntentName, intent),
        title=_safe_intake_title(title),
        body=_safe_slack_text(body),
        labels=_safe_intake_labels(tuple(labels)),
        priority=max(0, min(priority, 10)),
        assignee=assignee if assignee is None or _valid_node_ref(assignee) else None,
        confidence=_rounded_confidence(float(confidence)),
        reason=_safe_slack_text(reason),
        slack={str(key): _safe_slack_text(value) for key, value in slack.items()},
    )


def _safe_intake_title(value: str) -> str:
    title = _safe_slack_text(value).strip()
    if not title:
        return "slack-intake"
    return title[:120]


def _safe_intake_labels(labels: Sequence[str]) -> tuple[str, ...]:
    safe: list[str] = []
    for label in labels:
        normalized = label.lower().replace("_", "-").strip()
        if re.fullmatch(r"[a-z0-9-]{1,32}", normalized) and normalized not in safe:
            safe.append(normalized)
    return tuple(safe[:8])


def _rounded_confidence(value: float) -> float:
    return round(max(0.0, min(float(value), 1.0)), 2)


def _parse_mutating_command(
    command: str,
    args: tuple[str, ...],
) -> tuple[SlackCommandName, tuple[str, ...]] | None:
    if command == "approve" and len(args) == 1 and _valid_task_ref(args[0]):
        return "approve", args
    if command == "abort" and len(args) == 1 and _valid_task_ref(args[0]):
        return "abort", args
    if command == "killswitch":
        try:
            _parse_killswitch_args(args)
        except ValueError:
            return None
        return "killswitch", args
    return None


def _parse_killswitch_args(args: tuple[str, ...]) -> tuple[str, str | None, str]:
    if len(args) == 1 and args[0] in {"on", "off"}:
        return "global", None, args[0]
    if len(args) == 2 and args[0] == "board" and args[1] in {"on", "off"}:
        return "board", None, args[1]
    if len(args) == 3 and args[0] == "node" and args[2] in {"on", "off"}:
        if not _valid_node_ref(args[1]):
            raise ValueError("invalid node")
        return "node", args[1], args[2]
    raise ValueError("invalid killswitch command")


def _pending_command_summary(pending: SlackPendingCommand) -> str:
    if pending.command in {"approve", "abort"}:
        return f"{pending.command} item {_safe_slack_text(pending.args[0])}"
    if pending.command == "task_create":
        proposal = _decode_intake_proposal(pending.args)
        if proposal is None:
            return "create slack intake item"
        return f"create {proposal.intent} item {_safe_slack_text(proposal.title)}"
    scope, target, enabled = _parse_killswitch_args(pending.args)
    if scope == "node":
        return f"set node {_safe_slack_text(target or '')} kill-switch {enabled}"
    if scope == "board":
        return f"set board kill-switch {enabled}"
    return f"set global kill-switch {enabled}"


def _execution_node_for_task(task: Task) -> str | None:
    execution = task.metadata.get("execution")
    if isinstance(execution, Mapping):
        node = execution.get("node")
        if isinstance(node, str) and _valid_node_ref(node):
            return node
    if task.assignee is not None and _valid_node_ref(task.assignee):
        return task.assignee
    return None


def _valid_task_ref(value: str) -> bool:
    return bool(SLACK_COMMAND_TASK_RE.fullmatch(value))


def _valid_node_ref(value: str) -> bool:
    return bool(NODE_MENTION_RE.fullmatch("@" + value))


def _slack_actor(user: str, *, role: str) -> dict[str, object]:
    safe_user = _safe_slack_text(user)
    return {"kind": "slack", "id": safe_user, "login": safe_user, "role": role}


def _slack_member_actor(user: str, member: SlackCommandMember) -> dict[str, object]:
    return {
        "kind": "slack",
        "id": _safe_slack_text(user),
        "login": _safe_slack_text(member.name),
        "role": member.role,
        "member_id": _safe_slack_text(member.member_id),
    }


def _safe_slack_text(value: object) -> str:
    without_paths = ABSOLUTE_PATH_RE.sub("[path]", str(value))
    without_secrets = redact_secret_text(without_paths)
    return EMAIL_RE.sub("[pii]", without_secrets)[:500]


def _safe_slack_message_text(value: object) -> str:
    without_paths = ABSOLUTE_PATH_RE.sub("[path]", str(value))
    without_secrets = redact_secret_text(without_paths)
    return EMAIL_RE.sub("[pii]", without_secrets)


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
