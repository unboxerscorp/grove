"""Slack connector for grove board and chat workflows."""

from __future__ import annotations

import argparse
import hashlib
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
from typing import Literal, Protocol, cast

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
TRIAGE_ANNOUNCEMENT_MODE = "triage_announcement"
INTAKE_CONFIRM_ACTION_ID = "grove_intake_confirm"
INTAKE_ANSWER_ONLY_ACTION_ID = "grove_intake_answer_only"
SLACK_SCOPES = (
    "app_mentions:read",
    "channels:history",
    "chat:write",
    "groups:history",
    "im:history",
    "mpim:history",
)
NODE_MENTION_RE = re.compile(r"(?<![A-Za-z0-9_-])@(?P<node>[A-Za-z0-9_-]+)")
SLACK_COMMAND_TASK_RE = re.compile(r"^[A-Za-z0-9_.:-]+$")
ABSOLUTE_PATH_RE = re.compile(r"(?<![A-Za-z0-9_./-])/(?!/)[^\s'\"()<>]+")
TMUX_TARGET_RE = re.compile(r"^(?P<session>[A-Za-z0-9_-]+):(?P<window>\d+)\.(?P<pane>\d+)$")
EMAIL_RE = re.compile(r"\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b")
COMMAND_CONFIRM_TTL_SECONDS = 300
INTAKE_CONFIDENCE_THRESHOLD = 0.8
SlackCommandRole = Literal["admin", "operator", "viewer"]
SlackCommandName = Literal["approve", "abort", "killswitch", "task_create"]
SlackIntentName = Literal["bug", "feedback", "task_request", "question", "command"]
TASK_INTENTS = frozenset({"bug", "feedback", "task_request"})


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

    def update_message(
        self,
        *,
        channel: str,
        ts: str,
        text: str,
        blocks: Sequence[Mapping[str, object]] | None = None,
    ) -> None: ...

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
        blocks: Sequence[Mapping[str, object]] | None = None,
    ) -> Mapping[str, object]: ...

    def chat_update(
        self,
        *,
        channel: str,
        ts: str,
        text: str,
        blocks: Sequence[Mapping[str, object]] | None = None,
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


class SlackIntentClassifier(Protocol):
    def classify(self, text: str) -> SlackIntentClassification: ...


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


class BoundedSlackIntentClassifier:
    """Small deterministic classifier; it proposes, never mutates."""

    def classify(self, text: str) -> SlackIntentClassification:
        normalized = _normalize_slack_text(text)
        lowered = normalized.lower()
        if not normalized:
            return SlackIntentClassification(
                intent="question",
                confidence=0.0,
                title="",
                summary="",
                reason="empty",
            )
        if _looks_like_control_command(lowered):
            return SlackIntentClassification(
                intent="command",
                confidence=1.0,
                title=normalized,
                summary=normalized,
                reason="control_command",
            )
        if _contains_prompt_injection(lowered):
            return SlackIntentClassification(
                intent="question",
                confidence=0.2,
                title=normalized,
                summary=normalized,
                reason="unsafe_or_ambiguous",
            )
        if _contains_any(
            lowered, ("bug", "crash", "broken", "fails", "failure", "error", "버그", "오류", "고장")
        ):
            return SlackIntentClassification(
                intent="bug",
                confidence=0.92,
                title=_strip_intake_prefix(normalized),
                summary=normalized,
                labels=("bug",),
                reason="bug_terms",
            )
        if _contains_any(lowered, ("feedback", "suggest", "suggestion", "피드백", "제안", "개선")):
            return SlackIntentClassification(
                intent="feedback",
                confidence=0.9,
                title=_strip_intake_prefix(normalized),
                summary=normalized,
                labels=("feedback",),
                reason="feedback_terms",
            )
        if _contains_any(
            lowered,
            (
                "task",
                "todo",
                "please implement",
                "implement",
                "add ",
                "create ",
                "작업",
                "만들",
                "해줘",
            ),
        ):
            return SlackIntentClassification(
                intent="task_request",
                confidence=0.86,
                title=_strip_intake_prefix(normalized),
                summary=normalized,
                labels=("task-request",),
                reason="task_terms",
            )
        if "?" in normalized or _contains_any(
            lowered, ("how", "what", "why", "질문", "어떻게", "무엇")
        ):
            return SlackIntentClassification(
                intent="question",
                confidence=0.8,
                title=normalized,
                summary=normalized,
                reason="question_terms",
            )
        return SlackIntentClassification(
            intent="question",
            confidence=0.35,
            title=normalized,
            summary=normalized,
            reason="low_confidence",
        )


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
        blocks: Sequence[Mapping[str, object]] | None = None,
    ) -> str:
        response = self._client.chat_postMessage(
            channel=channel,
            text=text,
            thread_ts=thread_ts,
            metadata=metadata,
            blocks=blocks,
        )
        ts = response.get("ts") if isinstance(response, dict) else None
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
                return None, "confirmation id is unknown or already used"
            if pending.expires_at <= now:
                return None, "confirmation id expired"
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
                return None, "confirmation id is unknown or already used"
            if pending.expires_at <= now:
                self._pending.pop(confirmation_id, None)
                self._cleanup(now=now)
                return None, "confirmation id expired"
            if pending.actor.member_id != member_id:
                self._cleanup(now=now)
                return None, "confirmation owner mismatch"
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
        confirmation_store: SlackConfirmationStore | None = None,
        intent_classifier: SlackIntentClassifier | None = None,
    ) -> None:
        self.store = store
        self.slack_client = slack_client
        self.chat_facade = chat_facade
        self.human_gate = human_gate
        self.chat_route = chat_route
        self.command_config = command_config
        self.intent_classifier = intent_classifier or BoundedSlackIntentClassifier()
        self.confirmations = confirmation_store or (
            SlackConfirmationStore(
                ttl_seconds=command_config.confirmation_ttl_seconds,
                clock=command_config.clock,
            )
            if command_config is not None
            else None
        )
        self._locks: dict[str, threading.Lock] = {}
        self._triage_announcement_dirty = True

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
        if self._handle_command(event, thread_ts=thread_ts):
            return True
        if self._handle_intake(event, thread_ts=thread_ts):
            return True
        return self._handle_chat(event, thread_ts=thread_ts)

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
            self.slack_client.post_message(
                channel=event.channel,
                text="Slack control commands are not enabled for this project.",
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
            self.slack_client.post_message(
                channel=event.channel,
                text="Denied: this Slack identity is not mapped to a grove member.",
                thread_ts=thread_ts,
            )
            return True
        if self.confirmations is None:
            self.slack_client.post_message(
                channel=event.channel,
                text="No pending confirmations are available.",
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
            self.slack_client.post_message(
                channel=event.channel,
                text=f"Denied: {_safe_slack_text(error or 'confirmation failed')}.",
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
            self.slack_client.post_message(
                channel=event.channel,
                text="No task was created. I will treat this as answer-only.",
                thread_ts=thread_ts,
            )
            return True
        result = self._execute_pending_command(pending)
        self.slack_client.post_message(channel=event.channel, text=result, thread_ts=thread_ts)
        return True

    def upsert_triage_announcement(self, *, channel: str | None = None) -> str | None:
        config = self.command_config
        target_channel = channel or self.human_gate.channel
        if config is None or not config.intake_enabled or target_channel is None:
            return None
        existing = self._existing_triage_announcement(channel=target_channel)
        if existing is not None and not self._triage_announcement_dirty:
            return existing.thread_ts
        message = _build_triage_announcement_message(
            board=config.board,
            tasks=self.store.list_tasks(board=config.board, limit=50),
        )
        content_hash = _block_message_hash(message)
        if existing is not None:
            if existing.node == content_hash:
                self._triage_announcement_dirty = False
                return existing.thread_ts
            try:
                self.slack_client.update_message(
                    channel=target_channel,
                    ts=existing.thread_ts,
                    text=message.text,
                    blocks=message.blocks,
                )
            except Exception:
                self._triage_announcement_dirty = True
                raise
            self.store.upsert_slack_thread(
                board=config.board,
                task_id=None,
                team_id="",
                channel_id=target_channel,
                thread_ts=existing.thread_ts,
                mode=TRIAGE_ANNOUNCEMENT_MODE,
                node=content_hash,
            )
            self._triage_announcement_dirty = False
            return existing.thread_ts
        try:
            ts = self.slack_client.post_message(
                channel=target_channel,
                text=message.text,
                blocks=message.blocks,
            )
        except Exception:
            self._triage_announcement_dirty = True
            raise
        self.store.upsert_slack_thread(
            board=config.board,
            task_id=None,
            team_id="",
            channel_id=target_channel,
            thread_ts=ts,
            mode=TRIAGE_ANNOUNCEMENT_MODE,
            node=content_hash,
        )
        self._triage_announcement_dirty = False
        return ts

    def _existing_triage_announcement(self, *, channel: str) -> SlackThread | None:
        for thread in self.store.list_slack_threads(mode=TRIAGE_ANNOUNCEMENT_MODE):
            if thread.task_id is None and thread.channel_id == channel:
                return thread
        return None

    def _handle_command(self, event: SlackEvent, *, thread_ts: str) -> bool:
        command_text = _normalize_slack_text(event.text)
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
        }:
            return False
        config = self.command_config
        if config is None:
            self.slack_client.post_message(
                channel=event.channel,
                text="Slack control commands are not enabled for this project.",
                thread_ts=thread_ts,
            )
            return True
        actor = config.members.get(event.user)
        if actor is None:
            self._audit_slack_command(
                command=command,
                event=event,
                actor=_slack_actor(event.user, role="none"),
                status="denied",
                summary="unmapped slack identity",
            )
            self.slack_client.post_message(
                channel=event.channel,
                text="Denied: this Slack identity is not mapped to a grove member.",
                thread_ts=thread_ts,
            )
            return True
        if command == "status":
            self._audit_slack_command(
                command="status",
                event=event,
                actor=_slack_member_actor(event.user, actor),
                status="ok",
                summary="status",
            )
            self.slack_client.post_message(
                channel=event.channel,
                text=self._command_status_text(config.board),
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
        if actor.role not in {"admin", "operator"}:
            self._audit_slack_command(
                command=command,
                event=event,
                actor=_slack_member_actor(event.user, actor),
                status="denied",
                summary="insufficient role",
            )
            self.slack_client.post_message(
                channel=event.channel,
                text="Denied: operator or admin role is required for this command.",
                thread_ts=thread_ts,
            )
            return True
        preview = self._preview_command(
            command=command,
            args=tuple(parts[1:]),
            event=event,
            actor=actor,
        )
        self.slack_client.post_message(channel=event.channel, text=preview, thread_ts=thread_ts)
        return True

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
        if config is None or not config.intake_enabled:
            self.slack_client.post_message(
                channel=event.channel,
                text="Slack intake is not enabled for this project.",
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
            self.slack_client.post_message(
                channel=event.channel,
                text="Denied: operator or admin role is required to create tasks.",
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
        self.slack_client.post_message(
            channel=event.channel,
            text=preview.text,
            blocks=preview.blocks,
            thread_ts=thread_ts,
        )

    def _handle_intake(self, event: SlackEvent, *, thread_ts: str) -> bool:
        config = self.command_config
        if config is None or not config.intake_enabled:
            return False
        classification = self.intent_classifier.classify(event.text)
        if classification.intent == "command":
            return False
        if (
            classification.intent not in TASK_INTENTS
            or classification.confidence < INTAKE_CONFIDENCE_THRESHOLD
        ):
            self._audit_slack_command(
                command="intake",
                event=event,
                actor=_slack_actor(event.user, role="read-only"),
                status="ok",
                summary="read-only answer path",
                payload={
                    "intent": classification.intent,
                    "confidence": _rounded_confidence(classification.confidence),
                    "reason": _safe_slack_text(classification.reason),
                },
            )
            self.slack_client.post_message(
                channel=event.channel,
                text=(
                    "I treated this as a question or clarification; no task was created. "
                    "Use `bug`, `feedback`, or `task` for an explicit intake preview."
                ),
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
                payload={"intent": classification.intent},
            )
            self.slack_client.post_message(
                channel=event.channel,
                text="Denied: this Slack identity is not mapped to a grove member.",
                thread_ts=thread_ts,
            )
            return True
        if actor.role not in {"admin", "operator"}:
            self._audit_slack_command(
                command="intake",
                event=event,
                actor=_slack_member_actor(event.user, actor),
                status="denied",
                summary="insufficient role",
                payload={"intent": classification.intent},
            )
            self.slack_client.post_message(
                channel=event.channel,
                text="Denied: operator or admin role is required to create tasks.",
                thread_ts=thread_ts,
            )
            return True
        preview = self._preview_intake_task(
            event=event,
            actor=actor,
            classification=classification,
        )
        self.slack_client.post_message(
            channel=event.channel, text=preview.text, blocks=preview.blocks, thread_ts=thread_ts
        )
        return True

    def _preview_intake_task(
        self,
        *,
        event: SlackEvent,
        actor: SlackCommandMember,
        classification: SlackIntentClassification,
    ) -> SlackBlockMessage:
        if self.command_config is None or self.confirmations is None:
            return SlackBlockMessage(
                text="Slack intake is not enabled for this project.",
                blocks=(),
            )
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
            "Preview: create "
            f"{_safe_slack_text(proposal.intent)} task "
            f"`{_safe_slack_text(proposal.title)}`.\n"
            f"Confirm with `confirm {pending.confirmation_id}` within "
            f"{self.command_config.confirmation_ttl_seconds}s."
        )
        return SlackBlockMessage(
            text=text,
            blocks=_build_intake_preview_blocks(
                proposal=proposal,
                confirmation_id=pending.confirmation_id,
                ttl_seconds=self.command_config.confirmation_ttl_seconds,
            ),
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
            self.slack_client.post_message(
                channel=event.channel,
                text="Usage: confirm <confirmation-id>",
                thread_ts=thread_ts,
            )
            return
        if self.confirmations is None:
            self.slack_client.post_message(
                channel=event.channel,
                text="No pending confirmations are available.",
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
            response = (
                "Denied: only the member who created the preview can confirm it."
                if error == "confirmation owner mismatch"
                else f"Denied: {_safe_slack_text(error or 'confirmation failed')}."
            )
            self.slack_client.post_message(
                channel=event.channel,
                text=response,
                thread_ts=thread_ts,
            )
            return
        result = self._execute_pending_command(pending)
        self.slack_client.post_message(channel=event.channel, text=result, thread_ts=thread_ts)

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
            return "Invalid command. Use: approve <task>, abort <task>, killswitch <on|off>."
        if self.command_config is None or self.confirmations is None:
            return "Slack control commands are not enabled for this project."
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
            f"Preview: {_pending_command_summary(pending)}.\n"
            f"Confirm with `confirm {pending.confirmation_id}` within "
            f"{self.command_config.confirmation_ttl_seconds}s."
        )

    def _execute_pending_command(self, pending: SlackPendingCommand) -> str:
        if self.command_config is None:
            return "Denied: Slack control commands are not enabled."
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
            return "Denied: task is not in this project scope."

    def _execute_task_create(
        self,
        pending: SlackPendingCommand,
        *,
        actor: Mapping[str, object],
    ) -> str:
        config = self.command_config
        if config is None or not config.intake_enabled:
            return "Denied: Slack intake is not enabled."
        if pending.actor.role not in {"admin", "operator"}:
            self._audit_slack_command(
                command="intake",
                event=pending.event,
                actor=actor,
                status="denied",
                summary="insufficient role",
            )
            return "Denied: operator or admin role is required to create tasks."
        proposal = _decode_intake_proposal(pending.args)
        if proposal is None:
            self._audit_slack_command(
                command="intake",
                event=pending.event,
                actor=actor,
                status="denied",
                summary="invalid intake proposal",
            )
            return "Denied: intake proposal is invalid."
        assignee = proposal.assignee
        if assignee is not None and not self._command_node_exists(assignee):
            assignee = None
        task = self.store.create_task(
            board=config.board,
            title=proposal.title,
            body=proposal.body,
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
        self._triage_announcement_dirty = True
        self.store.add_audit_event(
            board=config.board,
            kind="audit.task.create",
            actor=actor,
            action="slack_intake_create",
            target={"type": "task", "id": task.id},
            task_id=task.id,
            status="ok",
            summary=f"created {proposal.intent} task",
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
            summary="created task",
            target={"type": "task", "id": task.id},
            task_id=task.id,
            payload={"intent": proposal.intent},
        )
        return f"Created task `{_safe_slack_text(task.id)}`: {_safe_slack_text(task.title)}."

    def _execute_approve(
        self,
        pending: SlackPendingCommand,
        *,
        actor: Mapping[str, object],
    ) -> str:
        assert self.command_config is not None
        task_id = pending.args[0]
        if not _valid_task_ref(task_id):
            return "Denied: invalid task id."
        task = self.store.get_task(board=self.command_config.board, task_id=task_id)
        node = _execution_node_for_task(task)
        if node is None:
            return "Denied: task has no execution node."
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
            return "Denied: execution gate is blocked."
        if not self.store.approve_execution(
            board=self.command_config.board,
            task_id=task.id,
            actor=actor,
        ):
            return "Denied: task is not awaiting approval."
        self._audit_slack_command(
            command="approve",
            event=pending.event,
            actor=actor,
            status="ok",
            summary="approved",
            task_id=task.id,
            run_id=task.current_run_id,
        )
        return f"Approved task `{_safe_slack_text(task.id)}`."

    def _execute_abort(
        self,
        pending: SlackPendingCommand,
        *,
        actor: Mapping[str, object],
    ) -> str:
        assert self.command_config is not None
        task_id = pending.args[0]
        if not _valid_task_ref(task_id):
            return "Denied: invalid task id."
        task = self.store.get_task(board=self.command_config.board, task_id=task_id)
        reason = "slack command abort"
        if not self.store.abort_execution(
            board=self.command_config.board,
            task_id=task.id,
            actor=actor,
            reason=reason,
        ):
            return "Denied: task execution is already terminal."
        self._audit_slack_command(
            command="abort",
            event=pending.event,
            actor=actor,
            status="ok",
            summary=reason,
            task_id=task.id,
            run_id=task.current_run_id,
        )
        return f"Aborted task `{_safe_slack_text(task.id)}`."

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
                return "Denied: node is not in this project."
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
        return _safe_slack_text(summary.capitalize()) + "."

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
            return "Denied: node is not in this project."
        return None

    def _command_node_exists(self, node: str) -> bool:
        return self.command_config is not None and node in self.command_config.node_names

    def _command_status_text(self, board: str) -> str:
        ready = len(self.store.list_tasks(board=board, status="ready"))
        running = len(self.store.list_tasks(board=board, status="running"))
        blocked = len(self.store.list_tasks(board=board, status="blocked"))
        gate = self.store.execution_global_state(board=board)
        return _safe_slack_text(
            "Status: "
            f"board={board} ready={ready} running={running} blocked={blocked} "
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
    parser.add_argument("--intake-assignee")
    parser.add_argument(
        "--command-member",
        action="append",
        default=[],
        dest="command_members",
        metavar="SLACK_USER:MEMBER_ID:NAME:ROLE",
    )
    parser.add_argument(
        "--grove-home",
        type=Path,
        default=Path(os.environ.get("GROVE_HOME", "~/.grove")).expanduser(),
    )
    parser.add_argument("--session", default=os.environ.get("GROVE_VIEWER_SESSION", "dev10"))
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
    if args.enable_commands or args.enable_intake:
        try:
            members = _parse_command_members(args.command_members)
        except ValueError as exc:
            raise SystemExit(str(exc)) from exc
        command_config = SlackCommandConfig(
            board=args.board,
            members=members,
            node_names=_load_command_node_names(args.grove_home, args.session),
            intake_enabled=args.enable_intake,
            intake_assignee=args.intake_assignee,
        )
    connector = SlackConnector(
        store=SQLiteBoardStore(args.board_db_path),
        slack_client=SlackSdkClient(bot_token=config.bot_token),
        chat_facade=GroveServeChatFacade(),
        human_gate=HumanGateConfig(board=args.board, channel=channel),
        chat_route=ChatRouteConfig(default_node=node),
        command_config=command_config,
    )
    socket_client = _build_socket_client(config=config, connector=connector)
    socket_client.connect()
    try:
        while True:
            connector.poll_human_gates()
            try:
                connector.upsert_triage_announcement()
            except Exception as exc:
                LOGGER.warning("Slack triage announcement update failed: %s", _safe_log_error(exc))
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
        elif request.type == "interactive" and isinstance(request.payload, Mapping):
            connector.handle_interaction(cast(Mapping[str, object], request.payload))
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


def _looks_like_control_command(lowered_text: str) -> bool:
    first = lowered_text.split(maxsplit=1)[0] if lowered_text.split() else ""
    return first in {"status", "approve", "abort", "killswitch", "confirm"}


def _contains_prompt_injection(lowered_text: str) -> bool:
    suspicious = (
        "ignore previous",
        "ignore all previous",
        "bypass",
        "without confirmation",
        "no confirmation",
        "silently create",
        "force create",
        "무시하고",
        "확인 없이",
    )
    return _contains_any(lowered_text, suspicious)


def _contains_any(text: str, needles: Sequence[str]) -> bool:
    return any(needle in text for needle in needles)


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


def _build_intake_preview_blocks(
    *,
    proposal: SlackIntakeProposal,
    confirmation_id: str,
    ttl_seconds: int,
) -> tuple[Mapping[str, object], ...]:
    summary = (
        "*Slack intake preview*\n"
        f"Intent: `{_safe_slack_text(proposal.intent)}`  "
        f"Confidence: `{proposal.confidence:.2f}`\n"
        f"*Title*: {_safe_slack_text(proposal.title)}\n"
        f"*Body*: {_safe_slack_text(proposal.body)}\n"
        f"*Labels*: {', '.join(_safe_slack_text(label) for label in proposal.labels) or 'none'}\n"
        f"*Assignee*: {_safe_slack_text(proposal.assignee or 'unassigned')}\n"
        f"Expires in {ttl_seconds}s."
    )
    blocks = list(_mrkdwn_section_blocks(summary))
    blocks.append(
        {
            "type": "actions",
            "block_id": "grove_intake_actions",
            "elements": [
                {
                    "type": "button",
                    "text": {"type": "plain_text", "text": "task로 등록"},
                    "style": "primary",
                    "action_id": INTAKE_CONFIRM_ACTION_ID,
                    "value": confirmation_id,
                    "confirm": {
                        "title": {"type": "plain_text", "text": "task 등록"},
                        "text": {
                            "type": "mrkdwn",
                            "text": "이 preview를 현재 grove board task로 등록할까요?",
                        },
                        "confirm": {"type": "plain_text", "text": "등록"},
                        "deny": {"type": "plain_text", "text": "취소"},
                    },
                },
                {
                    "type": "button",
                    "text": {"type": "plain_text", "text": "답만"},
                    "action_id": INTAKE_ANSWER_ONLY_ACTION_ID,
                    "value": confirmation_id,
                    "confirm": {
                        "title": {"type": "plain_text", "text": "task 생성 안 함"},
                        "text": {
                            "type": "mrkdwn",
                            "text": "이 preview를 폐기하고 답변만 하도록 처리할까요?",
                        },
                        "confirm": {"type": "plain_text", "text": "답만"},
                        "deny": {"type": "plain_text", "text": "취소"},
                    },
                },
            ],
        }
    )
    return tuple(blocks)


def _build_triage_announcement_message(*, board: str, tasks: Sequence[Task]) -> SlackBlockMessage:
    intake_tasks = [task for task in tasks if isinstance(task.metadata.get("intake"), Mapping)]
    by_status = {"ready": 0, "running": 0, "blocked": 0, "done": 0, "other": 0}
    for task in intake_tasks:
        if task.status in by_status:
            by_status[task.status] += 1
        else:
            by_status["other"] += 1
    open_count = (
        by_status["ready"] + by_status["running"] + by_status["blocked"] + by_status["other"]
    )
    header = f"grove triage queue: {board}"
    progress = _ascii_progress_bar(done=by_status["done"], total=max(1, len(intake_tasks)))
    recent = "\n".join(
        f"- `{_safe_slack_text(task.status)}` {_safe_slack_text(task.title)}"
        for task in intake_tasks[:10]
    )
    if not recent:
        recent = "No Slack intake tasks yet."
    text = (
        f"{header}\n"
        f"open={open_count} ready={by_status['ready']} running={by_status['running']} "
        f"blocked={by_status['blocked']} done={by_status['done']}\n"
        f"{recent}"
    )
    blocks: list[Mapping[str, object]] = [
        {"type": "header", "text": {"type": "plain_text", "text": header[:150]}},
        {
            "type": "section",
            "text": {
                "type": "mrkdwn",
                "text": (
                    f"*Open*: {open_count}  *Ready*: {by_status['ready']}  "
                    f"*Running*: {by_status['running']}  *Blocked*: {by_status['blocked']}  "
                    f"*Done*: {by_status['done']}\n`{progress}`"
                ),
            },
        },
    ]
    blocks.extend(_mrkdwn_section_blocks(recent))
    blocks.append(
        {
            "type": "actions",
            "elements": [
                {
                    "type": "button",
                    "text": {"type": "plain_text", "text": "새로고침"},
                    "action_id": "grove_triage_refresh",
                    "value": board,
                }
            ],
        }
    )
    return SlackBlockMessage(text=text, blocks=tuple(blocks))


def _block_message_hash(message: SlackBlockMessage) -> str:
    payload = {
        "text": message.text,
        "blocks": list(message.blocks),
    }
    encoded = json.dumps(
        payload,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def _mrkdwn_section_blocks(text: str) -> tuple[Mapping[str, object], ...]:
    remaining = text.strip()
    blocks: list[Mapping[str, object]] = []
    while remaining and len(blocks) < 4:
        if len(remaining) <= 3000:
            blocks.append({"type": "section", "text": {"type": "mrkdwn", "text": remaining}})
            return tuple(blocks)
        split = remaining.rfind("\n\n", 0, 3000)
        if split <= 0:
            split = remaining.rfind("\n", 0, 3000)
        if split <= 0:
            split = 3000
        blocks.append({"type": "section", "text": {"type": "mrkdwn", "text": remaining[:split]}})
        remaining = remaining[split:].lstrip()
    if remaining:
        blocks.append(
            {
                "type": "context",
                "elements": [{"type": "mrkdwn", "text": "Content was collapsed for Slack limits."}],
            }
        )
    return tuple(blocks)


def _ascii_progress_bar(*, done: int, total: int) -> str:
    filled = round((max(0, done) / max(1, total)) * 10)
    return "#" * filled + "-" * (10 - filled)


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
        return "Slack intake"
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
        return f"{pending.command} task {_safe_slack_text(pending.args[0])}"
    if pending.command == "task_create":
        proposal = _decode_intake_proposal(pending.args)
        if proposal is None:
            return "create slack intake task"
        return f"create {proposal.intent} task {_safe_slack_text(proposal.title)}"
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
