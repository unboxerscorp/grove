"""MASTER node interfaces for NL governance and grove feedback routing."""

from __future__ import annotations

import hashlib
import json
import re
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Literal, Protocol

from grove_bridge.auth_status import redact_secret_text

MasterSurface = Literal["floating_web_chat", "cli", "slack", "api"]
MasterRequestKind = Literal[
    "capability_question",
    "project_question",
    "node_question",
    "workflow_setup",
    "feedback_route",
    "unsupported",
]
MasterIntent = Literal[
    "capability.explain",
    "project.query",
    "node.query",
    "workflow.setup",
    "feedback.route",
    "unsupported",
]
MasterResponseMode = Literal["answer", "preview"]
MasterChatResponseType = Literal["answer", "preview", "denied"]
FeedbackCategory = Literal["bug", "feedback", "feature_request", "question", "unsafe"]
FeedbackSeverity = Literal["low", "medium", "high", "critical"]
AuditEventKind = Literal[
    "master.turn.received",
    "master.answer.generated",
    "master.proposal.created",
    "master.proposal.rejected",
    "master.preview.created",
    "master.preview.cancelled",
    "master.confirm.denied",
    "master.confirm.accepted",
    "master.execute.started",
    "master.execute.completed",
    "master.execute.failed",
]
DEFAULT_FEEDBACK_PROJECT = "grove-dev"
DEFAULT_FEEDBACK_BOARD = "dev10"
DEFAULT_FEEDBACK_LABEL = "grove-feedback"
DEFAULT_FEEDBACK_ASSIGNEE_CANDIDATES = ("grove-master", "grove-py", "grove-qa")
ACTION_KEYWORDS = (
    "만들",
    "생성",
    "추가",
    "붙여",
    "셋업",
    "세팅",
    "설정",
    "라우팅",
    "위임",
    "맡겨",
    "create",
    "spawn",
    "add",
    "setup",
    "route",
    "assign",
)
DESTRUCTIVE_KEYWORDS = (
    "삭제",
    "지워",
    "없애",
    "초기화",
    "reset",
    "delete",
    "remove",
    "despawn",
)
FEEDBACK_KEYWORDS = (
    "피드백",
    "버그",
    "오류",
    "문제",
    "불편",
    "느려",
    "깨져",
    "안 돼",
    "안되",
    "개선",
    "제안",
    "feedback",
    "bug",
    "broken",
    "slow",
)
CAPABILITY_KEYWORDS = ("뭐 가능", "무엇 가능", "할 수 있", "기능", "도와", "capability", "help")
NODE_KEYWORDS = ("노드", "node", "reviewer", "리뷰어", "maker", "qa", "agent", "에이전트")
PROJECT_KEYWORDS = ("프로젝트", "project", "보드", "board", "task", "태스크", "작업")
QUESTION_KEYWORDS = ("?", "알려", "몇", "상태", "목록", "리스트", "보여", "있어", "가능")
PREFIX_RE = re.compile(r"^\s*(?:피드백|버그|오류|문제|제안|feedback|bug)\s*[:：-]\s*", re.I)


@dataclass(frozen=True)
class MasterActor:
    """Authenticated actor context supplied by the web/API layer."""

    id: str
    role: str
    is_operator: bool
    display_name: str | None


@dataclass(frozen=True)
class MasterScope:
    """Workspace scope visible to a MASTER turn."""

    selected_project: str | None
    visible_projects: tuple[str, ...]
    origin_surface: MasterSurface
    origin_page: str | None


@dataclass(frozen=True)
class MasterRequestContext:
    """Bounded, redacted context for one natural-language request."""

    conversation_id: str
    request_id: str
    actor: MasterActor
    scope: MasterScope
    metadata: Mapping[str, object]


@dataclass(frozen=True)
class MasterTurn:
    """User turn handed to the MASTER broker or adapter."""

    context: MasterRequestContext
    message: str
    redacted_message: str


@dataclass(frozen=True)
class MasterClassification:
    """NL classification result for routing a MASTER turn."""

    kind: MasterRequestKind
    intent: MasterIntent
    response_mode: MasterResponseMode
    requires_confirmation: bool
    confidence: float
    reason: str
    needs_clarification: bool


@dataclass(frozen=True)
class MasterAnswer:
    """Read-only answer produced for a MASTER request."""

    text: str
    citations: tuple[str, ...]
    metadata: Mapping[str, object]


@dataclass(frozen=True)
class MasterActionProposal:
    """Typed proposal that must be broker-validated before preview or execution."""

    proposal_id: str
    intent: MasterIntent
    summary: str
    payload: Mapping[str, object]
    target_project: str | None
    requires_confirmation: bool
    requires_operator: bool
    audit_reason: str


@dataclass(frozen=True)
class FeedbackRouteTarget:
    """Destination for grove product feedback after operator confirmation."""

    project: str
    board: str
    assignee: str | None
    labels: tuple[str, ...]

    @classmethod
    def grove_dev_default(
        cls,
        *,
        board: str = DEFAULT_FEEDBACK_BOARD,
        assignee: str | None = None,
    ) -> FeedbackRouteTarget:
        return cls(
            project=DEFAULT_FEEDBACK_PROJECT,
            board=board,
            assignee=assignee,
            labels=(DEFAULT_FEEDBACK_LABEL,),
        )


@dataclass(frozen=True)
class FeedbackRouteDraft:
    """Draft task payload for routing grove feedback to the dev-team board."""

    category: FeedbackCategory
    severity: FeedbackSeverity
    title: str
    body: str
    summary: str
    reproduction: str | None
    route: FeedbackRouteTarget
    assignee_candidates: tuple[str, ...]
    source_conversation_id: str
    source_actor_id: str
    source_surface: MasterSurface
    origin_project: str | None
    redacted_excerpt: str
    metadata: Mapping[str, object]


@dataclass(frozen=True)
class OperatorGateDecision:
    """Result of checking whether an actor may preview or confirm an action."""

    allowed: bool
    reason: str
    actor_id: str
    target_project: str | None
    audit_metadata: Mapping[str, object]


@dataclass(frozen=True)
class MasterAuditEvent:
    """Redacted audit event emitted by MASTER broker steps."""

    kind: AuditEventKind
    actor_id: str
    conversation_id: str
    request_id: str
    target_project: str | None
    payload_hash: str | None
    metadata: Mapping[str, object]


@dataclass(frozen=True)
class MasterTurnResult:
    """Unified result returned to a future router layer."""

    classification: MasterClassification
    answer: MasterAnswer | None
    proposal: MasterActionProposal | None
    feedback_route: FeedbackRouteDraft | None
    audit_events: tuple[MasterAuditEvent, ...]


@dataclass(frozen=True)
class MasterChatRequest:
    """Request shape intended for a future ``POST /api/master/chat`` route."""

    turn: MasterTurn
    route_target: FeedbackRouteTarget


@dataclass(frozen=True)
class MasterChatResponse:
    """Side-effect-free response shape for a future ``POST /api/master/chat`` route."""

    conversation_id: str
    request_id: str
    response_type: MasterChatResponseType
    classification: MasterClassification
    answer: MasterAnswer | None
    proposal: MasterActionProposal | None
    feedback_route: FeedbackRouteDraft | None
    operator_gate: OperatorGateDecision | None
    requires_confirmation: bool
    audit_events: tuple[MasterAuditEvent, ...]


class MasterAgentAdapter(Protocol):
    """Replaceable CLI adapter for the real MASTER session."""

    async def send_turn(self, turn: MasterTurn) -> MasterTurnResult:
        """Send a bounded turn to the underlying MASTER CLI."""
        ...

    async def transcript_ref(self, conversation_id: str) -> str | None:
        """Return a transcript or live-terminal reference for a conversation."""
        ...


class MasterAuditSink(Protocol):
    """Audit sink owned by the bridge/web layer."""

    def record_master_event(self, event: MasterAuditEvent) -> None:
        """Persist a redacted MASTER audit event."""
        ...


class MasterOperatorGate(Protocol):
    """Policy gate for previewing or confirming MASTER proposals."""

    def evaluate_proposal(
        self,
        *,
        actor: MasterActor,
        proposal: MasterActionProposal,
    ) -> OperatorGateDecision:
        """Check whether the proposal may advance to preview/confirmation."""
        ...


class MasterBroker(Protocol):
    """Broker contract for NL handling and feedback routing."""

    async def handle_natural_language_request(self, turn: MasterTurn) -> MasterTurnResult:
        """Classify and answer or propose a typed action for a natural-language turn."""
        ...

    async def draft_feedback_route(
        self,
        *,
        turn: MasterTurn,
        category: FeedbackCategory,
        severity: FeedbackSeverity,
        route: FeedbackRouteTarget,
    ) -> FeedbackRouteDraft:
        """Draft a grove-feedback task route without creating the task."""
        ...


def classify_master_message(message: str) -> MasterClassification:
    """Deterministically classify a MASTER message without calling an LLM."""
    normalized = _normalize(message)
    if _contains_any(normalized, DESTRUCTIVE_KEYWORDS):
        return MasterClassification(
            kind="unsupported",
            intent="unsupported",
            response_mode="answer",
            requires_confirmation=False,
            confidence=0.9,
            reason="destructive keyword matched",
            needs_clarification=False,
        )
    if _contains_any(normalized, FEEDBACK_KEYWORDS):
        return MasterClassification(
            kind="feedback_route",
            intent="feedback.route",
            response_mode="preview",
            requires_confirmation=True,
            confidence=0.82,
            reason="grove feedback keyword matched",
            needs_clarification=False,
        )
    if _contains_any(normalized, ACTION_KEYWORDS):
        return MasterClassification(
            kind="workflow_setup",
            intent="workflow.setup",
            response_mode="preview",
            requires_confirmation=True,
            confidence=0.78,
            reason="action keyword matched",
            needs_clarification=False,
        )
    if _contains_any(normalized, CAPABILITY_KEYWORDS):
        return MasterClassification(
            kind="capability_question",
            intent="capability.explain",
            response_mode="answer",
            requires_confirmation=False,
            confidence=0.86,
            reason="capability question keyword matched",
            needs_clarification=False,
        )
    if _contains_any(normalized, NODE_KEYWORDS) and _is_question(normalized):
        return MasterClassification(
            kind="node_question",
            intent="node.query",
            response_mode="answer",
            requires_confirmation=False,
            confidence=0.74,
            reason="node question keyword matched",
            needs_clarification=False,
        )
    if _contains_any(normalized, PROJECT_KEYWORDS) and _is_question(normalized):
        return MasterClassification(
            kind="project_question",
            intent="project.query",
            response_mode="answer",
            requires_confirmation=False,
            confidence=0.72,
            reason="project question keyword matched",
            needs_clarification=False,
        )
    return MasterClassification(
        kind="unsupported",
        intent="unsupported",
        response_mode="answer",
        requires_confirmation=False,
        confidence=0.45,
        reason="no deterministic rule matched",
        needs_clarification=True,
    )


def handle_master_chat(request: MasterChatRequest) -> MasterChatResponse:
    """Classify a chat turn and return an answer or preview without executing mutations."""
    turn = request.turn
    classification = classify_master_message(turn.redacted_message or turn.message)
    audit_events = [_audit_event(turn, "master.turn.received", None, None)]
    if classification.response_mode == "answer":
        answer = _answer_for_classification(turn, classification)
        audit_events.append(_audit_event(turn, "master.answer.generated", None, None))
        return MasterChatResponse(
            conversation_id=turn.context.conversation_id,
            request_id=turn.context.request_id,
            response_type="answer",
            classification=classification,
            answer=answer,
            proposal=None,
            feedback_route=None,
            operator_gate=None,
            requires_confirmation=False,
            audit_events=tuple(audit_events),
        )

    feedback_route = None
    if classification.kind == "feedback_route":
        feedback_route = draft_feedback_route(
            turn=turn,
            category=_feedback_category(turn.redacted_message),
            severity=_feedback_severity(turn.redacted_message),
            route=request.route_target,
        )
    proposal = _proposal_for_preview(turn, classification, feedback_route)
    gate = _operator_gate_for_preview(turn.context.actor, proposal)
    if not gate.allowed:
        audit_events.append(
            _audit_event(turn, "master.proposal.rejected", proposal.target_project, gate.reason)
        )
        return MasterChatResponse(
            conversation_id=turn.context.conversation_id,
            request_id=turn.context.request_id,
            response_type="denied",
            classification=classification,
            answer=None,
            proposal=proposal,
            feedback_route=feedback_route,
            operator_gate=gate,
            requires_confirmation=False,
            audit_events=tuple(audit_events),
        )

    audit_events.append(
        _audit_event(turn, "master.proposal.created", proposal.target_project, proposal.summary)
    )
    audit_events.append(
        _audit_event(turn, "master.preview.created", proposal.target_project, proposal.summary)
    )
    return MasterChatResponse(
        conversation_id=turn.context.conversation_id,
        request_id=turn.context.request_id,
        response_type="preview",
        classification=classification,
        answer=None,
        proposal=proposal,
        feedback_route=feedback_route,
        operator_gate=gate,
        requires_confirmation=True,
        audit_events=tuple(audit_events),
    )


def handle_natural_language_request(
    *,
    turn: MasterTurn,
    adapter: MasterAgentAdapter,
    gate: MasterOperatorGate,
    audit: MasterAuditSink,
) -> MasterTurnResult:
    """Handle an NL turn through the deterministic preview-first contract."""
    response = handle_master_chat(
        MasterChatRequest(turn=turn, route_target=FeedbackRouteTarget.grove_dev_default())
    )
    for event in response.audit_events:
        audit.record_master_event(event)
    return MasterTurnResult(
        classification=response.classification,
        answer=response.answer,
        proposal=response.proposal,
        feedback_route=response.feedback_route,
        audit_events=response.audit_events,
    )


def draft_feedback_route(
    *,
    turn: MasterTurn,
    category: FeedbackCategory,
    severity: FeedbackSeverity,
    route: FeedbackRouteTarget,
) -> FeedbackRouteDraft:
    """Draft a grove-feedback task payload without creating a board task."""
    redacted = redact_secret_text(turn.redacted_message or turn.message)
    summary = _feedback_summary(redacted)
    title = _feedback_title(summary)
    candidates = _assignee_candidates(route)
    body = _feedback_body(
        summary=summary,
        category=category,
        severity=severity,
        turn=turn,
        route=route,
    )
    return FeedbackRouteDraft(
        category=category,
        severity=severity,
        title=title,
        body=body,
        summary=summary,
        reproduction=_feedback_reproduction(summary),
        route=route,
        assignee_candidates=candidates,
        source_conversation_id=turn.context.conversation_id,
        source_actor_id=turn.context.actor.id,
        source_surface=turn.context.scope.origin_surface,
        origin_project=turn.context.scope.selected_project,
        redacted_excerpt=summary,
        metadata={
            "source": "master.chat",
            "board_session": route.board,
            "execution": "not_created",
            "gating": "실제 task 생성은 operator confirm 이후 별도 라우터가 수행",
            "origin_page": turn.context.scope.origin_page or "",
        },
    )


def validate_operator_gated_proposal(
    *,
    actor: MasterActor,
    proposal: MasterActionProposal,
    gate: MasterOperatorGate,
    audit: MasterAuditSink,
) -> OperatorGateDecision:
    """Interface for future operator-gated proposal validation."""
    decision = gate.evaluate_proposal(actor=actor, proposal=proposal)
    return decision


def record_master_audit_events(
    *,
    audit: MasterAuditSink,
    events: Sequence[MasterAuditEvent],
) -> None:
    """Interface for future audit fan-out for MASTER broker events."""
    for event in events:
        audit.record_master_event(event)


def _proposal_for_preview(
    turn: MasterTurn,
    classification: MasterClassification,
    feedback_route: FeedbackRouteDraft | None,
) -> MasterActionProposal:
    target_project = (
        feedback_route.route.project if feedback_route else turn.context.scope.selected_project
    )
    payload: dict[str, object] = {
        "message": redact_secret_text(turn.redacted_message or turn.message),
        "classification": classification.kind,
        "origin_surface": turn.context.scope.origin_surface,
        "origin_page": turn.context.scope.origin_page,
        "execution": "preview_only",
        "operator_confirmation": "required",
    }
    if feedback_route is not None:
        payload.update(
            {
                "route_project": feedback_route.route.project,
                "route_board": feedback_route.route.board,
                "route_assignee": feedback_route.route.assignee,
                "assignee_candidates": feedback_route.assignee_candidates,
                "title": feedback_route.title,
                "body": feedback_route.body,
            }
        )
    proposal_id = _proposal_id(turn, classification.intent, payload)
    return MasterActionProposal(
        proposal_id=proposal_id,
        intent=classification.intent,
        summary=_proposal_summary(classification, feedback_route),
        payload=payload,
        target_project=target_project,
        requires_confirmation=True,
        requires_operator=True,
        audit_reason="preview only; execution requires a later operator-gated confirm route",
    )


def _operator_gate_for_preview(
    actor: MasterActor,
    proposal: MasterActionProposal,
) -> OperatorGateDecision:
    allowed = actor.is_operator if proposal.requires_operator else True
    reason = "operator preview allowed" if allowed else "operator role required for action preview"
    return OperatorGateDecision(
        allowed=allowed,
        reason=reason,
        actor_id=actor.id,
        target_project=proposal.target_project,
        audit_metadata={
            "intent": proposal.intent,
            "proposal_id": proposal.proposal_id,
            "requires_confirmation": proposal.requires_confirmation,
        },
    )


def _answer_for_classification(
    turn: MasterTurn,
    classification: MasterClassification,
) -> MasterAnswer:
    if classification.intent == "capability.explain":
        text = (
            "MASTER can answer read-only questions about visible projects, nodes, boards, "
            "and workflows. Action requests are returned as previews only and require a "
            "separate operator confirmation before execution."
        )
    elif classification.intent in {"project.query", "node.query"}:
        project = turn.context.scope.selected_project or "the selected project"
        text = (
            f"Read-only {classification.kind} request for {project}. "
            "The future web route should attach scoped project/org/board facts before "
            "rendering the final answer."
        )
    else:
        text = (
            "I could not map this to a supported read-only question or previewable action. "
            "Destructive or ambiguous requests need a narrower prompt."
        )
    return MasterAnswer(
        text=text,
        citations=(),
        metadata={
            "intent": classification.intent,
            "response_mode": classification.response_mode,
            "deterministic": True,
        },
    )


def _audit_event(
    turn: MasterTurn,
    kind: AuditEventKind,
    target_project: str | None,
    summary: str | None,
) -> MasterAuditEvent:
    payload_hash = _payload_hash(
        {
            "message": redact_secret_text(turn.redacted_message or turn.message),
            "summary": summary,
            "target_project": target_project,
        }
    )
    return MasterAuditEvent(
        kind=kind,
        actor_id=turn.context.actor.id,
        conversation_id=turn.context.conversation_id,
        request_id=turn.context.request_id,
        target_project=target_project,
        payload_hash=payload_hash,
        metadata={
            "source_surface": turn.context.scope.origin_surface,
            "origin_page": turn.context.scope.origin_page or "",
            "redacted": True,
        },
    )


def _proposal_id(
    turn: MasterTurn,
    intent: MasterIntent,
    payload: Mapping[str, object],
) -> str:
    digest = _payload_hash(
        {
            "conversation_id": turn.context.conversation_id,
            "request_id": turn.context.request_id,
            "intent": intent,
            "payload": payload,
        }
    )
    return f"proposal_{digest[:16]}"


def _payload_hash(payload: Mapping[str, object]) -> str:
    encoded = json.dumps(payload, sort_keys=True, ensure_ascii=True, default=str)
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()


def _proposal_summary(
    classification: MasterClassification,
    feedback_route: FeedbackRouteDraft | None,
) -> str:
    if feedback_route is not None:
        return (
            f"Route grove feedback to {feedback_route.route.project}/"
            f"{feedback_route.route.board}: {feedback_route.title}"
        )
    if classification.intent == "workflow.setup":
        return "Preview workflow/project/node setup request; no execution performed"
    return "Preview unsupported action; no execution performed"


def _feedback_summary(message: str) -> str:
    stripped = PREFIX_RE.sub("", message.strip())
    return " ".join(stripped.split())


def _feedback_title(summary: str) -> str:
    first_sentence = re.split(r"[.!?。]\s+", summary, maxsplit=1)[0].strip()
    if not first_sentence:
        return "grove feedback"
    return first_sentence[:80].rstrip()


def _feedback_reproduction(summary: str) -> str | None:
    parts = re.split(r"[.!?。]\s+", summary, maxsplit=1)
    if len(parts) < 2:
        return None
    detail = parts[1].strip()
    return detail or None


def _feedback_body(
    *,
    summary: str,
    category: FeedbackCategory,
    severity: FeedbackSeverity,
    turn: MasterTurn,
    route: FeedbackRouteTarget,
) -> str:
    lines = [
        f"Category: {category}",
        f"Severity: {severity}",
        f"Summary: {summary}",
        f"Origin project: {turn.context.scope.selected_project or 'none'}",
        f"Origin page: {turn.context.scope.origin_page or 'none'}",
        f"Source conversation: {turn.context.conversation_id}",
        f"Target route: {route.project}/{route.board}",
        "Execution: preview only; board task not created by grove_bridge.master.",
    ]
    return "\n".join(lines)


def _assignee_candidates(route: FeedbackRouteTarget) -> tuple[str, ...]:
    candidates = list(DEFAULT_FEEDBACK_ASSIGNEE_CANDIDATES)
    if route.assignee is not None and route.assignee not in candidates:
        candidates.insert(0, route.assignee)
    return tuple(candidates)


def _feedback_category(message: str) -> FeedbackCategory:
    normalized = _normalize(message)
    if any(keyword in normalized for keyword in ("보안", "secret", "token", "unsafe")):
        return "unsafe"
    if any(keyword in normalized for keyword in ("버그", "오류", "bug", "broken", "안 돼", "안되")):
        return "bug"
    if any(keyword in normalized for keyword in ("기능", "제안", "feature", "request")):
        return "feature_request"
    if _is_question(normalized):
        return "question"
    return "feedback"


def _feedback_severity(message: str) -> FeedbackSeverity:
    normalized = _normalize(message)
    if any(keyword in normalized for keyword in ("critical", "치명", "데이터 손실", "보안")):
        return "critical"
    if any(keyword in normalized for keyword in ("crash", "죽", "먹통", "안 돼", "안되")):
        return "high"
    if any(keyword in normalized for keyword in ("느려", "slow", "불편", "오류", "버그")):
        return "medium"
    return "low"


def _normalize(message: str) -> str:
    return " ".join(message.casefold().split())


def _contains_any(message: str, keywords: Sequence[str]) -> bool:
    return any(keyword.casefold() in message for keyword in keywords)


def _is_question(message: str) -> bool:
    return _contains_any(message, QUESTION_KEYWORDS)


__all__ = [
    "AuditEventKind",
    "FeedbackCategory",
    "FeedbackRouteDraft",
    "FeedbackRouteTarget",
    "FeedbackSeverity",
    "MasterActionProposal",
    "MasterActor",
    "MasterAgentAdapter",
    "MasterAnswer",
    "MasterAuditEvent",
    "MasterAuditSink",
    "MasterBroker",
    "MasterChatRequest",
    "MasterChatResponse",
    "MasterChatResponseType",
    "MasterClassification",
    "MasterIntent",
    "MasterOperatorGate",
    "MasterRequestContext",
    "MasterRequestKind",
    "MasterResponseMode",
    "MasterScope",
    "MasterSurface",
    "MasterTurn",
    "MasterTurnResult",
    "OperatorGateDecision",
    "classify_master_message",
    "draft_feedback_route",
    "handle_master_chat",
    "handle_natural_language_request",
    "record_master_audit_events",
    "validate_operator_gated_proposal",
]
