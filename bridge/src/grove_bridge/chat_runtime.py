"""Bridge-native chatbot runtime — Stage0 scaffolding (flag-gated, inert).

Design: docs/design/CHAT_BRIDGE_CHATBOT_RUNTIME.md.

Stage0 rule: nothing in this module is constructed or wired into the live
Slack/web route unless the operator explicitly enables the runtime feature flag
(default OFF). Importing this module has **zero** effect on existing behavior —
it defines types, a flag gate, a provider-adapter boundary, a no-template guard,
and a bounded worker-pool scaffold. No live publish, no cutover, no intake
changes happen here.

Ownership notes:
- The persona/policy system prompt and the exact structured-turn contract are
  chat-master deliverables (submitted at the Stage0 window). The parser here is
  a minimal scaffold of that boundary with the agreed **safe-fallback** rule.
- The provider backend (official ``anthropic`` SDK vs. the existing raw-HTTP
  ``AnthropicAssistantClient``) is confirmed at implementation; this module only
  defines the boundary + a redacting wrapper.
"""

from __future__ import annotations

import json
import os
import threading
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Literal, Protocol, runtime_checkable

from grove_bridge.assistant import (
    AnthropicAssistantClient,
    AssistantLLMClient,
    AssistantTransportError,
)
from grove_bridge.auth_status import redact_secret_text
from grove_bridge.chat_actions import (
    ChatActionDenied,
    ChatConfirmAction,
    apply_chat_confirm_action,
)
from grove_bridge.store import SQLiteBoardStore

# GUI feature flag name (default OFF). Distinct from the ``intake`` flag, which
# stays FALSE independently — enabling the runtime does NOT enable intake.
CHAT_BRIDGE_RUNTIME_FLAG = "chat_bridge_runtime"
CHAT_PROVIDER_DEFAULT_PROVIDER = "gemini"
CHAT_PROVIDER_DEFAULT_MODEL = "gemini-2.5-flash"

# Upper bound on provider function-calling round-trips per turn. A model that
# never converges to a text answer raises (caller defers) rather than looping.
_GEMINI_MAX_TOOL_ITERATIONS = 5

# Marker prefix for chat-master's structured task-proposal turn. The final
# contract (marker + field schema) is chat-master-owned; this is the Stage0
# scaffold of the boundary.
TASK_PROPOSAL_MARKER = "<<<GROVE_TASK_PROPOSAL>>>"

# SHADOW-only placeholder persona (0 user exposure). The canonical persona/policy
# is chat-master's deliverable, folded in before any canary/live publish.
CHAT_BRIDGE_SHADOW_PERSONA = (
    "You are Grove CHAT MASTER. Answer the user's chat directly when you can. "
    "Use supplied Grove context, but do not invent node names, task ids, or hidden "
    "capabilities. If the user asks for work to be created, explain that task "
    "creation requires an explicit confirmation flow; do not claim a task was "
    "created unless it was actually confirmed. When the user clearly wants a task "
    "created, output exactly one structured task proposal and no extra prose: "
    f"{TASK_PROPOSAL_MARKER}"
    '{"title":"short task title","body":"task details","project":"selected project",'
    '"worktree":null,"card_text":"your user-facing confirmation question"}. '
    "The card_text must be your own natural wording asking whether to create the "
    "task. For ordinary chat, do not use the marker. Write concise Korean by "
    "default unless the user uses another language."
)

ChatSurface = Literal["slack", "web"]
TurnKind = Literal["answer", "task_proposal"]


# --------------------------------------------------------------------------- #
# Flag gate
# --------------------------------------------------------------------------- #
@runtime_checkable
class FlagSource(Protocol):
    def gui_feature_flags(
        self, *, board: str, features: tuple[str, ...]
    ) -> dict[str, dict[str, object]]: ...


def chat_bridge_runtime_enabled(flags: FlagSource, *, board: str) -> bool:
    """True only when the operator has explicitly enabled the runtime flag.

    Default OFF: an unconfigured flag, ``enabled`` other than ``True``, or any
    error reading the flag source all resolve to ``False`` (inert). Keeping the
    failure path OFF guarantees the runtime can never accidentally activate.
    """
    try:
        state = flags.gui_feature_flags(board=board, features=(CHAT_BRIDGE_RUNTIME_FLAG,))[
            CHAT_BRIDGE_RUNTIME_FLAG
        ]
    except Exception:
        return False
    return state.get("enabled") is True


# --------------------------------------------------------------------------- #
# Session + structured-turn types
# --------------------------------------------------------------------------- #
@dataclass(frozen=True)
class ChatSession:
    """A durable per-thread/per-conversation chat session (Slack thread or web
    conversation). Persistence is the additive store's concern (later slice)."""

    conversation_id: str
    surface: ChatSurface
    status: str = "active"


@dataclass(frozen=True)
class TaskProposalFields:
    title: str
    body: str = ""
    project: str = "dev10"
    worktree: str | None = None


@dataclass(frozen=True)
class StructuredTurn:
    """Result of interpreting a chat-master turn: either a free-chat *answer*
    (always an LLM generation) or a *task_proposal* (confirm-before-create)."""

    kind: TurnKind
    answer_text: str | None = None
    proposal: TaskProposalFields | None = None
    card_text: str | None = None


class TurnParseError(Exception):
    """A structured-turn marker was present but its payload was unparseable.

    Per the SAFE-FALLBACK rule (design §4): callers MUST treat this as a
    defer/retry — they must NEVER fabricate a user-facing answer/card from the
    raw text when this is raised.
    """


def parse_structured_turn(raw: str) -> StructuredTurn:
    """Parse a chat-master turn into a :class:`StructuredTurn`.

    Safe fallback: text with no task-proposal marker is treated as a plain
    *answer* (a successful generation). A present-but-malformed marker payload
    raises :class:`TurnParseError` so the caller can defer/retry — it is never
    silently turned into a fabricated answer.
    """
    text = raw if isinstance(raw, str) else ""
    marker = text.find(TASK_PROPOSAL_MARKER)
    if marker == -1:
        return StructuredTurn(kind="answer", answer_text=text)
    payload = text[marker + len(TASK_PROPOSAL_MARKER) :].strip()
    try:
        decoded = json.loads(payload)
    except (json.JSONDecodeError, ValueError) as exc:
        raise TurnParseError("unparseable task-proposal payload") from exc
    if not isinstance(decoded, dict) or not isinstance(decoded.get("title"), str):
        raise TurnParseError("task-proposal payload missing required title")
    proposal = TaskProposalFields(
        title=decoded["title"],
        body=decoded.get("body", "") if isinstance(decoded.get("body"), str) else "",
        project=decoded.get("project", "dev10")
        if isinstance(decoded.get("project"), str)
        else "dev10",
        worktree=decoded.get("worktree") if isinstance(decoded.get("worktree"), str) else None,
    )
    card = decoded.get("card_text")
    return StructuredTurn(
        kind="task_proposal",
        proposal=proposal,
        card_text=card if isinstance(card, str) else None,
    )


# --------------------------------------------------------------------------- #
# Provider-adapter boundary (NO CLI node; NO AssistantBroker node-routed client)
# --------------------------------------------------------------------------- #
@dataclass(frozen=True)
class ProviderRequest:
    system_prompt: str
    user_text: str


@dataclass(frozen=True)
class ChatTool:
    """A READ-ONLY tool the chat runtime exposes to the provider's function-calling.

    ``parameters`` is a JSON Schema (the provider ``functionDeclaration.parameters``).
    ``handler`` runs the tool against real grove state and returns a JSON-able dict
    fed back to the model verbatim — never a fabricated/placeholder value. Tools here
    are read-only; writes (task create/update) stay confirm-gated elsewhere.
    """

    name: str
    description: str
    parameters: dict[str, object]
    handler: Callable[[Mapping[str, object]], Mapping[str, object]]


@runtime_checkable
class ChatProviderAdapter(Protocol):
    """Bridge-native LLM call boundary. Concrete impls call the Claude API
    directly (official ``anthropic`` SDK or the raw-HTTP client) — never a
    persistent CLI node."""

    def generate(self, request: ProviderRequest, *, tools: Sequence[ChatTool] = ()) -> str: ...


@dataclass
class RedactingProviderAdapter:
    """Wraps a provider adapter and redacts secrets/PII from every field before
    the provider sees it ([R] guard): raw secrets never leave the bridge."""

    inner: ChatProviderAdapter
    redact: Callable[[str], str] = redact_secret_text

    def generate(self, request: ProviderRequest, *, tools: Sequence[ChatTool] = ()) -> str:
        safe = ProviderRequest(
            system_prompt=self.redact(request.system_prompt),
            user_text=self.redact(request.user_text),
        )
        safe_tools = [self._redacting_tool(tool) for tool in tools]
        return self.inner.generate(safe, tools=safe_tools)

    def _redacting_tool(self, tool: ChatTool) -> ChatTool:
        # [R]: tool RESULTS (real board data fed back via functionResponse) are
        # redacted before the provider sees them, mirroring request redaction.
        redact = self.redact
        inner_handler = tool.handler

        def handler(args: Mapping[str, object]) -> Mapping[str, object]:
            return _redact_tool_result(inner_handler(args), redact)

        return ChatTool(
            name=tool.name,
            description=tool.description,
            parameters=tool.parameters,
            handler=handler,
        )


def _redact_tool_result(
    result: Mapping[str, object], redact: Callable[[str], str]
) -> dict[str, object]:
    return {key: _redact_value(value, redact) for key, value in result.items()}


def _redact_value(value: object, redact: Callable[[str], str]) -> object:
    if isinstance(value, str):
        return redact(value)
    if isinstance(value, Mapping):
        return {key: _redact_value(val, redact) for key, val in value.items()}
    if isinstance(value, list):
        return [_redact_value(item, redact) for item in value]
    return value


@dataclass
class ClaudeChatProviderAdapter:
    """Concrete bridge-native adapter: generates a turn by calling Claude's
    Messages API directly via the bridge's ``AnthropicAssistantClient`` (raw-HTTP,
    **not** a persistent CLI node and **not** the AssistantBroker node-routed
    client). Wrap in :class:`RedactingProviderAdapter` for the [R] boundary.

    Model / effort / thinking tuning (``claude-opus-4-8`` + adaptive thinking +
    streaming, per the claude-api skill) is the underlying client's config and is
    finalized at canary; the default direct client guarantees no CLI routing.
    """

    llm: AssistantLLMClient = field(default_factory=AnthropicAssistantClient)

    def generate(self, request: ProviderRequest, *, tools: Sequence[ChatTool] = ()) -> str:
        # The direct Claude client path does not (yet) do function-calling; tools
        # are accepted for interface parity and ignored here.
        _ = tools
        return self.llm.complete(
            system_prompt=request.system_prompt,
            user_prompt=request.user_text,
        )


class UrlOpenResponse(Protocol):
    def __enter__(self) -> UrlOpenResponse: ...

    def __exit__(self, exc_type: object, exc: object, tb: object) -> object: ...

    def read(self) -> bytes: ...


UrlOpen = Callable[..., UrlOpenResponse]


@dataclass
class GeminiChatProviderAdapter:
    """Concrete bridge-native adapter for Google Gemini's REST generateContent API.

    It uses the official API-key header (``x-goog-api-key``) and does not route
    through any persistent CLI node. Wrap in :class:`RedactingProviderAdapter`
    before live use so secrets are stripped before the request leaves the bridge.
    """

    api_key: str
    model: str = CHAT_PROVIDER_DEFAULT_MODEL
    timeout_seconds: float = 30.0
    urlopen: UrlOpen = urllib.request.urlopen

    def generate(self, request: ProviderRequest, *, tools: Sequence[ChatTool] = ()) -> str:
        key = self.api_key.strip()
        if not key:
            raise AssistantTransportError("gemini api key is not configured")
        model = self.model.strip() or CHAT_PROVIDER_DEFAULT_MODEL
        clean_model = model.removeprefix("models/")
        encoded_model = urllib.parse.quote(clean_model, safe="")
        url = (
            "https://generativelanguage.googleapis.com/v1beta/models/"
            f"{encoded_model}:generateContent"
        )
        # No tools → single round-trip (backward-compatible with the plain path).
        # With tools → bounded function-calling loop: declare tools, run any
        # functionCall against real state, feed the result back, repeat until the
        # model returns text. The loop never fabricates an answer (no text and no
        # call, an unknown tool, or non-convergence all raise → caller defers).
        contents: list[dict[str, object]] = [
            {"role": "user", "parts": [{"text": request.user_text}]}
        ]
        declarations = [
            {"name": t.name, "description": t.description, "parameters": t.parameters}
            for t in tools
        ]
        by_name = {t.name: t for t in tools}
        for _ in range(_GEMINI_MAX_TOOL_ITERATIONS):
            body: dict[str, object] = {
                "systemInstruction": {"parts": [{"text": request.system_prompt}]},
                "contents": contents,
            }
            if declarations:
                body["tools"] = [{"functionDeclarations": declarations}]
            decoded = self._generate_content(url=url, key=key, body=body)
            call = _gemini_function_call(decoded)
            if call is None:
                text = _gemini_response_text(decoded)
                if not text:
                    raise AssistantTransportError("gemini returned no text")
                return text
            name, fn_args = call
            tool = by_name.get(name)
            if tool is None:
                raise AssistantTransportError(f"gemini called unknown tool: {name}")
            result = tool.handler(fn_args)
            contents.append(
                {
                    "role": "model",
                    "parts": [{"functionCall": {"name": name, "args": dict(fn_args)}}],
                }
            )
            contents.append(
                {
                    "role": "user",
                    "parts": [{"functionResponse": {"name": name, "response": dict(result)}}],
                }
            )
        raise AssistantTransportError("gemini tool loop did not converge")

    def _generate_content(self, *, url: str, key: str, body: dict[str, object]) -> object:
        http_request = urllib.request.Request(
            url,
            data=json.dumps(body).encode("utf-8"),
            headers={
                "Content-Type": "application/json",
                "x-goog-api-key": key,
            },
            method="POST",
        )
        try:
            with self.urlopen(http_request, timeout=self.timeout_seconds) as response:
                raw = response.read()
        except urllib.error.HTTPError as exc:
            raise AssistantTransportError(
                f"gemini generateContent failed: HTTP {exc.code}"
            ) from exc
        except urllib.error.URLError as exc:
            raise AssistantTransportError("gemini generateContent unavailable") from exc
        try:
            return json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise AssistantTransportError("gemini returned invalid JSON") from exc


def _gemini_response_text(payload: object) -> str:
    if not isinstance(payload, dict):
        return ""
    parts: list[str] = []
    candidates = payload.get("candidates")
    if not isinstance(candidates, list):
        return ""
    for candidate in candidates:
        if not isinstance(candidate, dict):
            continue
        content = candidate.get("content")
        if not isinstance(content, dict):
            continue
        raw_parts = content.get("parts")
        if not isinstance(raw_parts, list):
            continue
        for part in raw_parts:
            if isinstance(part, dict) and isinstance(part.get("text"), str):
                parts.append(part["text"])
    return "\n".join(part.strip() for part in parts if part.strip()).strip()


def _gemini_function_call(payload: object) -> tuple[str, dict[str, object]] | None:
    """Extract the first ``functionCall`` (name, args) from a generateContent
    response, or ``None`` when the model returned a normal (text) turn."""
    if not isinstance(payload, dict):
        return None
    candidates = payload.get("candidates")
    if not isinstance(candidates, list):
        return None
    for candidate in candidates:
        if not isinstance(candidate, dict):
            continue
        content = candidate.get("content")
        if not isinstance(content, dict):
            continue
        raw_parts = content.get("parts")
        if not isinstance(raw_parts, list):
            continue
        for part in raw_parts:
            if not isinstance(part, dict):
                continue
            call = part.get("functionCall")
            if isinstance(call, dict) and isinstance(call.get("name"), str):
                args = call.get("args")
                return call["name"], dict(args) if isinstance(args, dict) else {}
    return None


def load_gemini_provider_config(
    path: Path,
    *,
    env: Mapping[str, str] = os.environ,
) -> dict[str, str]:
    try:
        loaded = json.loads(path.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        loaded = {}
    payload = loaded if isinstance(loaded, dict) else {}
    provider = str(payload.get("provider") or CHAT_PROVIDER_DEFAULT_PROVIDER).strip().lower()
    model = str(payload.get("model") or CHAT_PROVIDER_DEFAULT_MODEL).strip()
    api_key = str(payload.get("api_key") or "").strip()
    source = "file" if api_key else "none"
    if not api_key:
        api_key = env.get("GEMINI_API_KEY", "").strip()
        if api_key:
            provider = CHAT_PROVIDER_DEFAULT_PROVIDER
            model = env.get("GEMINI_MODEL", model).strip() or CHAT_PROVIDER_DEFAULT_MODEL
            source = "env"
    clean_provider = (
        provider if provider == CHAT_PROVIDER_DEFAULT_PROVIDER else CHAT_PROVIDER_DEFAULT_PROVIDER
    )
    return {
        "provider": clean_provider,
        "model": model or CHAT_PROVIDER_DEFAULT_MODEL,
        "api_key": api_key,
        "source": source,
    }


def load_chat_bridge_persona(path: Path | None) -> str:
    """Load the chat-master persona/policy system prompt from a runtime source.

    Returns :data:`CHAT_BRIDGE_SHADOW_PERSONA` (placeholder) when the source is
    ``None``, missing, empty, or unreadable — so behavior is unchanged until
    chat-master fills the source. chat-master edits the source file directly
    (no code change, no commit; the file is re-read per turn so edits take effect
    without a restart).
    """
    if path is None:
        return CHAT_BRIDGE_SHADOW_PERSONA
    try:
        text = path.read_text(encoding="utf-8").strip()
    except (FileNotFoundError, OSError):
        return CHAT_BRIDGE_SHADOW_PERSONA
    return text or CHAT_BRIDGE_SHADOW_PERSONA


def build_get_project_tasks_tool(store: SQLiteBoardStore, *, default_board: str) -> ChatTool:
    """READ-ONLY tool: list real tasks on a grove project board (a store query).

    Answers "what work/tasks remain / are running / are assigned" with actual
    board data. Performs no writes — task creation/update stays confirm-gated
    elsewhere. The result is fed back to the model verbatim (no fabrication)."""

    def handler(args: Mapping[str, object]) -> Mapping[str, object]:
        board_arg = args.get("board") or args.get("project")
        board = (
            board_arg.strip() if isinstance(board_arg, str) and board_arg.strip() else default_board
        )
        status_arg = args.get("status")
        status = status_arg.strip() if isinstance(status_arg, str) and status_arg.strip() else None
        tasks = store.list_tasks(board=board, status=status, limit=50)
        return {
            "board": board,
            "status": status or "all",
            "count": len(tasks),
            "tasks": [
                {"id": t.id, "title": t.title, "status": t.status, "assignee": t.assignee}
                for t in tasks
            ],
        }

    return ChatTool(
        name="get_project_tasks",
        description=(
            "List tasks on a grove project board. Use this to answer questions about "
            "what work/tasks remain, are in progress, done, or who they are assigned to. "
            "Returns real board data — do not guess task state."
        ),
        parameters={
            "type": "object",
            "properties": {
                "board": {
                    "type": "string",
                    "description": (
                        "Project/board id, e.g. 'dev10'. Defaults to the current project."
                    ),
                },
                "status": {
                    "type": "string",
                    "description": (
                        "Optional status filter (e.g. 'ready','running','done','ask-human'). "
                        "Omit for all."
                    ),
                },
            },
        },
        handler=handler,
    )


# --------------------------------------------------------------------------- #
# V2: role-gated WRITE tools (LLM-first agent) — routed through the dispatcher
# --------------------------------------------------------------------------- #
# Each write tool maps the model's function-call args -> a ChatConfirmAction and
# applies it via apply_chat_confirm_action: the tool boundary enforcing the six
# guards (role-gate operator/admin, board-ownership IDOR, scope, CAS, audit, [R]),
# and accepting ONLY the action schema (no unvalidated text reaches the DB). A
# denial is returned as a tool RESULT (so the LLM can tell the user) — never raised
# (which would break the function-calling loop). Per the operator/lead V2 decision:
# an explicit operator request authorizes execution; ambiguous/risky ops are handled
# by the chat-master persona via the PROPOSAL + CONFIRM/CANCEL path, not here.
_WRITE_TOOL_SPECS: tuple[tuple[str, str, dict[str, object]], ...] = (
    (
        "create",
        "create_task",
        {
            "title": {"type": "string", "description": "Short task title (required)."},
            "body": {"type": "string", "description": "Task details."},
            "assignee": {"type": "string", "description": "Optional executor node."},
            "status": {"type": "string", "description": "Optional initial status."},
        },
    ),
    (
        "comment",
        "add_task_comment",
        {
            "task_id": {"type": "string", "description": "Target task id (required)."},
            "comment": {"type": "string", "description": "Comment body."},
        },
    ),
    (
        "transition",
        "set_task_status",
        {
            "task_id": {"type": "string", "description": "Target task id (required)."},
            "to_status": {"type": "string", "description": "New status."},
            "from_status": {"type": "string", "description": "Expected current status (CAS)."},
        },
    ),
    (
        "dispatch",
        "dispatch_task",
        {
            "task_id": {"type": "string", "description": "Staged task id (required)."},
            "assignee": {"type": "string", "description": "Executor node to assign."},
            "comment": {"type": "string", "description": "Optional dispatch note."},
        },
    ),
)


def build_chat_write_tools(
    store: SQLiteBoardStore,
    *,
    board: str,
    actor: Mapping[str, object],
) -> list[ChatTool]:
    """Role-gated write tools for the V2 LLM-first agent (operator/admin only —
    enforced in the dispatcher). The LLM calls these on an explicit operator
    request; the dispatcher applies the stored action schema with the six guards."""

    def _make_handler(kind: str) -> Callable[[Mapping[str, object]], Mapping[str, object]]:
        def handler(args: Mapping[str, object]) -> Mapping[str, object]:
            target = args.get("task_id")
            target_id = target.strip() if isinstance(target, str) and target.strip() else None
            fields = args
            if kind == "create":
                # Decision ①: chat-created tasks land in 'staged' (stack-then-gate)
                # unless the operator explicitly named a status. An explicit,
                # non-blank status is honored verbatim.
                status_val = args.get("status")
                if not (isinstance(status_val, str) and status_val.strip()):
                    fields = {**args, "status": "staged"}
            try:
                result = apply_chat_confirm_action(
                    store,
                    ChatConfirmAction(
                        kind=kind,  # type: ignore[arg-type]
                        board=board,
                        target_task_id=target_id,
                        fields=fields,
                    ),
                    actor=actor,
                )
            except ChatActionDenied as exc:
                return {"ok": False, "error": str(exc)}
            return {"ok": True, **result}

        return handler

    return [
        ChatTool(
            name=name,
            description=(
                f"Write tool ({kind}). Use ONLY for an explicit operator request. "
                "Operator/admin only; denials are returned as a result."
            ),
            parameters={"type": "object", "properties": props},
            handler=_make_handler(kind),
        )
        for kind, name, props in _WRITE_TOOL_SPECS
    ]


# --------------------------------------------------------------------------- #
# No-template guard (free-chat ANSWER channel only; confirm-flow copy exempt)
# --------------------------------------------------------------------------- #
class NoTemplateViolation(Exception):
    """A fixed bridge template (or empty text) was about to be posted as a
    free-chat answer. Confirm-flow §7 copy is chat-master-authored and is NOT
    checked here."""


def guard_answer_channel(answer: str, *, forbidden: frozenset[str]) -> str:
    """Return ``answer`` if it is a genuine generation; raise
    :class:`NoTemplateViolation` if it is empty/whitespace or matches a known
    fixed bridge template. Applies to the free-chat answer channel only."""
    norm = (answer or "").strip()
    if not norm:
        raise NoTemplateViolation("empty answer is not a valid generation")
    if norm in forbidden:
        raise NoTemplateViolation("fixed bridge template must not be posted as a chat answer")
    return answer


# --------------------------------------------------------------------------- #
# Kill-switch + metrics
# --------------------------------------------------------------------------- #
@dataclass
class KillSwitch:
    """Emergency stop, distinct from the rollout flag. When tripped, the pool
    refuses to acquire sessions; a circuit-breaker on error rate can trip it."""

    _tripped: bool = False
    _lock: threading.Lock = field(default_factory=threading.Lock)

    def trip(self) -> None:
        with self._lock:
            self._tripped = True

    def reset(self) -> None:
        with self._lock:
            self._tripped = False

    @property
    def tripped(self) -> bool:
        with self._lock:
            return self._tripped


@dataclass
class RuntimeMetrics:
    enqueued: int = 0
    processed: int = 0
    deferred: int = 0
    errors: int = 0
    active_sessions: int = 0


# --------------------------------------------------------------------------- #
# Bounded worker-pool scaffold (per-session lease; NOT wired to the live route)
# --------------------------------------------------------------------------- #
class ChatWorkerPool:
    """Bounded concurrency + per-session FIFO lease.

    Scaffold only: this enforces the concurrency/ordering invariants
    (≤ ``max_workers`` concurrent sessions, one in-flight worker per session) and
    honors the kill-switch. Wiring it to the durable queue / provider adapter is
    a later flag-gated slice — nothing here runs unless explicitly driven.
    """

    def __init__(
        self,
        *,
        max_workers: int = 4,
        kill_switch: KillSwitch | None = None,
        metrics: RuntimeMetrics | None = None,
    ) -> None:
        self.max_workers = max(1, max_workers)
        self.kill_switch = kill_switch or KillSwitch()
        self.metrics = metrics or RuntimeMetrics()
        self._sessions_in_flight: set[str] = set()
        self._lock = threading.Lock()

    def try_acquire_session(self, conversation_id: str) -> bool:
        """Acquire an exclusive in-flight lease for ``conversation_id``.

        Returns ``False`` (and acquires nothing) if the kill-switch is tripped,
        the session is already in flight (preserves per-session FIFO), or the
        pool is at its concurrency cap.
        """
        with self._lock:
            if self.kill_switch.tripped:
                return False
            if conversation_id in self._sessions_in_flight:
                return False
            if len(self._sessions_in_flight) >= self.max_workers:
                return False
            self._sessions_in_flight.add(conversation_id)
            self.metrics.active_sessions = len(self._sessions_in_flight)
            return True

    def release_session(self, conversation_id: str) -> None:
        with self._lock:
            self._sessions_in_flight.discard(conversation_id)
            self.metrics.active_sessions = len(self._sessions_in_flight)
