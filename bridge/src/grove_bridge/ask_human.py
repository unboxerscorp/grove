"""Ask-human Slack notification support for blocked grove tasks."""

from __future__ import annotations

import json
import os
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Protocol, cast
from urllib import error, request

from grove_bridge.legacy import KanbanTask

SLACK_POST_MESSAGE_URL = "https://slack.com/api/chat.postMessage"


@dataclass(frozen=True)
class AskHumanConfig:
    """Configuration for Slack-backed human gates."""

    enabled: bool = False
    dry_run: bool = True
    channel: str | None = None

    def __post_init__(self) -> None:
        if self.channel is not None:
            channel = self.channel.strip()
            if not channel:
                raise ValueError("ask_human.channel must be a non-empty string")
            object.__setattr__(self, "channel", channel)
        if self.enabled and not self.dry_run and self.channel is None:
            raise ValueError("ask_human.channel is required when ask-human is live")


class SlackClientProtocol(Protocol):
    """Minimal Slack client seam used by the bridge."""

    def post_message(self, channel: str, text: str, thread_ts: str | None = None) -> str: ...


class AskHumanStartupError(RuntimeError):
    """Raised when ask-human is enabled but cannot start safely."""


class SlackWebClient:
    """Thin Slack Web API client for ``chat.postMessage``."""

    def __init__(
        self,
        *,
        token: str,
        api_url: str = SLACK_POST_MESSAGE_URL,
        timeout_seconds: float = 15.0,
    ) -> None:
        stripped = token.strip()
        if not stripped:
            raise AskHumanStartupError("SLACK_BOT_TOKEN is required when ask_human is enabled")
        self._token = stripped
        self._api_url = api_url
        self._timeout_seconds = timeout_seconds

    def post_message(self, channel: str, text: str, thread_ts: str | None = None) -> str:
        payload: dict[str, object] = {"channel": channel, "text": text}
        if thread_ts is not None:
            payload["thread_ts"] = thread_ts
        body = json.dumps(payload).encode("utf-8")
        req = request.Request(
            self._api_url,
            data=body,
            headers={
                "Authorization": f"Bearer {self._token}",
                "Content-Type": "application/json; charset=utf-8",
            },
            method="POST",
        )
        try:
            with request.urlopen(req, timeout=self._timeout_seconds) as response:
                raw_response = response.read().decode("utf-8")
        except error.URLError as exc:
            raise RuntimeError("Slack chat.postMessage request failed") from exc

        try:
            response_payload = cast(dict[str, object], json.loads(raw_response))
        except json.JSONDecodeError as exc:
            raise RuntimeError("Slack chat.postMessage returned invalid JSON") from exc

        if response_payload.get("ok") is not True:
            slack_error = response_payload.get("error")
            detail = slack_error if isinstance(slack_error, str) else "unknown error"
            raise RuntimeError(f"Slack chat.postMessage failed: {detail}")
        ts = response_payload.get("ts")
        if not isinstance(ts, str) or not ts.strip():
            raise RuntimeError("Slack chat.postMessage response missing ts")
        return ts


class AskHumanKanbanDbProtocol(Protocol):
    def add_notify_sub(
        self,
        conn: object,
        *,
        task_id: str,
        platform: str,
        chat_id: str,
        thread_id: str | None = None,
        user_id: str | None = None,
        notifier_profile: str | None = None,
    ) -> None: ...


class AskHumanNotifierProtocol(Protocol):
    def notify_blocked(
        self,
        *,
        conn: object,
        task: KanbanTask,
        reason: str,
        comment: str,
    ) -> str | None: ...


class AskHumanBridgeConfigProtocol(Protocol):
    @property
    def ask_human(self) -> AskHumanConfig: ...


class AskHumanNotifier:
    """Post Slack root messages for newly blocked tasks and store reply bindings."""

    def __init__(
        self,
        *,
        config: AskHumanConfig,
        slack_client: SlackClientProtocol | None,
        kanban_db: object,
    ) -> None:
        self.config = config
        self.slack_client = slack_client
        self.kanban_db = cast(AskHumanKanbanDbProtocol, kanban_db)

    def notify_blocked(
        self,
        *,
        conn: object,
        task: KanbanTask,
        reason: str,
        comment: str,
    ) -> str | None:
        if (
            not self.config.enabled
            or self.config.dry_run
            or self.config.channel is None
            or self.slack_client is None
        ):
            return None

        ts = self.slack_client.post_message(
            self.config.channel,
            _blocked_task_message(task=task, reason=reason, comment=comment),
            thread_ts=None,
        )
        self.kanban_db.add_notify_sub(
            conn,
            task_id=task.id,
            platform="slack",
            chat_id=self.config.channel,
            thread_id=ts,
        )
        return ts


def build_ask_human_notifier(
    *,
    config: AskHumanBridgeConfigProtocol,
    kanban_db: object,
    env: Mapping[str, str] | None = None,
) -> AskHumanNotifier | None:
    ask_human = config.ask_human
    if not ask_human.enabled:
        return None
    if ask_human.channel is None:
        raise AskHumanStartupError("ask_human.channel is required when ask_human is enabled")

    source_env = os.environ if env is None else env
    token = source_env.get("SLACK_BOT_TOKEN")
    if token is None or not token.strip():
        raise AskHumanStartupError("SLACK_BOT_TOKEN is required when ask_human is enabled")

    return AskHumanNotifier(
        config=ask_human,
        slack_client=SlackWebClient(token=token),
        kanban_db=kanban_db,
    )


def _blocked_task_message(*, task: KanbanTask, reason: str, comment: str) -> str:
    body = task.body.strip() if task.body else "(no body)"
    return (
        "[grove] Human input requested for blocked task\n"
        f"Task: {task.id}\n"
        f"Title: {task.title}\n"
        f"Assignee: {task.assignee or '(unassigned)'}\n"
        f"Reason: {reason}\n\n"
        f"Task body:\n{body}\n\n"
        f"Bridge detail:\n{comment.strip() or '(no detail)'}"
    )
