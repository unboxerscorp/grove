from __future__ import annotations

from grove_bridge.master import (
    FeedbackRouteTarget,
    MasterActor,
    MasterChatRequest,
    MasterChatResponse,
    MasterRequestContext,
    MasterScope,
    MasterTurn,
    classify_master_message,
    draft_feedback_route,
    handle_master_chat,
)


def _context(*, is_operator: bool = True) -> MasterRequestContext:
    return MasterRequestContext(
        conversation_id="conv-1",
        request_id="req-1",
        actor=MasterActor(
            id="member-1",
            role="operator" if is_operator else "viewer",
            is_operator=is_operator,
            display_name="Ada",
        ),
        scope=MasterScope(
            selected_project="example",
            visible_projects=("example", "grove-dev"),
            origin_surface="floating_web_chat",
            origin_page="/projects/example/boards/dev10",
        ),
        metadata={"session": "dev10"},
    )


def _turn(message: str, *, is_operator: bool = True) -> MasterTurn:
    return MasterTurn(
        context=_context(is_operator=is_operator), message=message, redacted_message=message
    )


USER_VISIBLE_INTERNAL_TERMS = (
    "read-only",
    "future web route",
    "operator-gated",
    "grove_bridge.master",
    "supported read-only",
)


def _assert_user_visible_text(text: str) -> None:
    lowered = text.lower()
    for term in USER_VISIBLE_INTERNAL_TERMS:
        assert term not in lowered


def test_classifies_capability_question_as_read_only_question() -> None:
    classification = classify_master_message("MASTER로 뭐 가능?")

    assert classification.kind == "capability_question"
    assert classification.intent == "capability.explain"
    assert classification.response_mode == "answer"
    assert classification.requires_confirmation is False


def test_classifies_project_setup_request_as_preview_only_action() -> None:
    classification = classify_master_message("새 React 프로젝트 만들어줘")

    assert classification.kind == "workflow_setup"
    assert classification.intent == "workflow.setup"
    assert classification.response_mode == "preview"
    assert classification.requires_confirmation is True


def test_handle_master_chat_returns_read_only_answer_for_questions() -> None:
    response = handle_master_chat(
        MasterChatRequest(
            turn=_turn("리뷰어 몇 명인지 알려줘"),
            route_target=FeedbackRouteTarget.grove_dev_default(),
        )
    )

    assert response.response_type == "answer"
    assert response.answer is not None
    assert response.proposal is None
    assert response.requires_confirmation is False
    assert response.audit_events[0].kind == "master.turn.received"
    _assert_user_visible_text(response.answer.text)


def test_master_fallback_answer_copy_avoids_internal_terms() -> None:
    capability = handle_master_chat(
        MasterChatRequest(
            turn=_turn("MASTER로 뭐 가능?"),
            route_target=FeedbackRouteTarget.grove_dev_default(),
        )
    )
    node_query = handle_master_chat(
        MasterChatRequest(
            turn=_turn("노드 상태는 어때?"),
            route_target=FeedbackRouteTarget.grove_dev_default(),
        )
    )
    unsupported = handle_master_chat(
        MasterChatRequest(
            turn=_turn("그냥 애매한 말"),
            route_target=FeedbackRouteTarget.grove_dev_default(),
        )
    )

    for response in (capability, node_query, unsupported):
        assert response.answer is not None
        _assert_user_visible_text(response.answer.text)


def test_handle_master_chat_returns_preview_for_actions_without_executing() -> None:
    response = handle_master_chat(
        MasterChatRequest(
            turn=_turn("example 프로젝트에 reviewer 노드 2명 추가해줘"),
            route_target=FeedbackRouteTarget.grove_dev_default(),
        )
    )

    assert response.response_type == "preview"
    assert response.answer is None
    assert response.proposal is not None
    assert response.proposal.intent == "workflow.setup"
    assert response.proposal.requires_confirmation is True
    assert response.proposal.requires_operator is True
    assert response.proposal.payload["execution"] == "preview_only"


def test_viewer_action_preview_is_denied_before_execution() -> None:
    response = handle_master_chat(
        MasterChatRequest(
            turn=_turn("새 프로젝트 만들어줘", is_operator=False),
            route_target=FeedbackRouteTarget.grove_dev_default(),
        )
    )

    assert response.response_type == "denied"
    assert response.proposal is not None
    assert response.requires_confirmation is False
    assert response.operator_gate is not None
    assert response.operator_gate.allowed is False


def test_feedback_message_drafts_grove_dev_route_without_creating_task() -> None:
    response = handle_master_chat(
        MasterChatRequest(
            turn=_turn("피드백: 보드 검색이 너무 느려서 작업을 찾기 어려워"),
            route_target=FeedbackRouteTarget.grove_dev_default(
                board="dev10", assignee="grove-master"
            ),
        )
    )

    assert response.response_type == "preview"
    assert response.feedback_route is not None
    assert response.feedback_route.route.project == "grove-dev"
    assert response.feedback_route.route.board == "dev10"
    assert response.feedback_route.route.assignee == "grove-master"
    assert response.feedback_route.title == "보드 검색이 너무 느려서 작업을 찾기 어려워"
    gating = response.feedback_route.metadata["gating"]
    assert isinstance(gating, str)
    assert "확인 후에만 생성" in gating
    _assert_user_visible_text(response.feedback_route.body)
    assert response.proposal is not None
    assert response.proposal.intent == "feedback.route"
    _assert_user_visible_text(response.proposal.audit_reason)


def test_draft_feedback_route_builds_title_body_and_assignee_candidates() -> None:
    draft = draft_feedback_route(
        turn=_turn("버그: 터미널 로그가 가끔 끊겨요. 새로고침하면 돌아와요."),
        category="bug",
        severity="medium",
        route=FeedbackRouteTarget.grove_dev_default(board="dev10"),
    )

    assert draft.title == "터미널 로그가 가끔 끊겨요"
    assert "새로고침하면 돌아와요" in draft.body
    assert draft.assignee_candidates == ("grove-master", "grove-py", "grove-qa")
    assert draft.metadata["board_session"] == "dev10"
    assert draft.metadata["execution"] == "not_created"


def test_master_chat_response_documents_post_api_shape() -> None:
    response = handle_master_chat(
        MasterChatRequest(
            turn=_turn("이 제품에서 할 수 있는 일 알려줘"),
            route_target=FeedbackRouteTarget.grove_dev_default(),
        )
    )

    assert isinstance(response, MasterChatResponse)
    assert response.conversation_id == "conv-1"
    assert response.request_id == "req-1"
    assert response.response_type in {"answer", "preview", "denied"}
