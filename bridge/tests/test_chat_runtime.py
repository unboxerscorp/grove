from __future__ import annotations

import pytest

from grove_bridge.assistant import AssistantTransportError
from grove_bridge.chat_runtime import (
    CHAT_BRIDGE_RUNTIME_FLAG,
    ChatProviderAdapter,
    ChatWorkerPool,
    ClaudeChatProviderAdapter,
    GeminiChatProviderAdapter,
    KillSwitch,
    NoTemplateViolation,
    ProviderRequest,
    RedactingProviderAdapter,
    RuntimeMetrics,
    TurnParseError,
    chat_bridge_runtime_enabled,
    guard_answer_channel,
    parse_structured_turn,
)


class _FakeFlags:
    def __init__(self, state: dict[str, object]) -> None:
        self._state = state

    def gui_feature_flags(
        self, *, board: str, features: tuple[str, ...]
    ) -> dict[str, dict[str, object]]:
        _ = board
        return {f: dict(self._state) for f in features}


def test_runtime_flag_default_off_is_inert() -> None:
    # Unconfigured / not-enabled flag → runtime disabled (inert). Default OFF.
    assert (
        chat_bridge_runtime_enabled(
            _FakeFlags({"enabled": False, "configured": False}), board="dev10"
        )
        is False
    )
    assert chat_bridge_runtime_enabled(_FakeFlags({}), board="dev10") is False
    # Only an explicit enabled=True flips it on.
    assert (
        chat_bridge_runtime_enabled(
            _FakeFlags({"enabled": True, "configured": True}), board="dev10"
        )
        is True
    )


def test_runtime_flag_swallows_flag_source_errors_to_off() -> None:
    class _Boom:
        def gui_feature_flags(
            self, *, board: str, features: tuple[str, ...]
        ) -> dict[str, dict[str, object]]:
            raise RuntimeError("flag store down")

    # A failing flag source must never enable the runtime — defaults to OFF.
    assert chat_bridge_runtime_enabled(_Boom(), board="dev10") is False
    assert CHAT_BRIDGE_RUNTIME_FLAG == "chat_bridge_runtime"


class _RecordingAdapter:
    def __init__(self) -> None:
        self.seen: ProviderRequest | None = None

    def generate(self, request: ProviderRequest) -> str:
        self.seen = request
        return "generated answer"


def test_redacting_provider_adapter_redacts_before_provider_sees_it() -> None:
    secret = "xoxb-" + ("m" * 44)
    inner = _RecordingAdapter()
    adapter: ChatProviderAdapter = RedactingProviderAdapter(inner=inner)

    adapter.generate(
        ProviderRequest(
            system_prompt=f"persona token {secret}",
            user_text=f"please use {secret} at /Users/chopin/private",
        )
    )

    assert inner.seen is not None
    assert secret not in inner.seen.system_prompt
    assert secret not in inner.seen.user_text


def test_parse_structured_turn_plain_text_is_answer() -> None:
    turn = parse_structured_turn("Here is a normal answer.")
    assert turn.kind == "answer"
    assert turn.answer_text == "Here is a normal answer."
    assert turn.proposal is None


def test_parse_structured_turn_marker_yields_task_proposal() -> None:
    raw = '<<<GROVE_TASK_PROPOSAL>>>{"title": "board export", "body": "add it", "project": "dev10"}'
    turn = parse_structured_turn(raw)
    assert turn.kind == "task_proposal"
    assert turn.proposal is not None
    assert turn.proposal.title == "board export"


def test_parse_structured_turn_bad_marker_payload_raises_for_defer() -> None:
    # SAFE FALLBACK: a present-but-unparseable marker must raise (caller defers/retries),
    # NEVER fabricate a raw-text answer/card.
    with pytest.raises(TurnParseError):
        parse_structured_turn("<<<GROVE_TASK_PROPOSAL>>>{not valid json")


def test_guard_answer_channel_rejects_fixed_bridge_templates() -> None:
    forbidden = frozenset({"처리 중이에요", "전달 실패"})
    # A genuine generation passes through unchanged.
    assert (
        guard_answer_channel("실제 생성된 답변입니다", forbidden=forbidden)
        == "실제 생성된 답변입니다"
    )
    # A fixed bridge template on the answer channel is a violation.
    with pytest.raises(NoTemplateViolation):
        guard_answer_channel("처리 중이에요", forbidden=forbidden)
    # Empty / whitespace is not a valid generated answer.
    with pytest.raises(NoTemplateViolation):
        guard_answer_channel("   ", forbidden=forbidden)


def test_worker_pool_per_session_lease_and_bounded_concurrency() -> None:
    pool = ChatWorkerPool(max_workers=2)

    assert pool.try_acquire_session("conv-A") is True
    # Same session cannot be acquired twice (intra-session FIFO / ordering).
    assert pool.try_acquire_session("conv-A") is False
    assert pool.try_acquire_session("conv-B") is True
    # Pool is at capacity (2) → a third distinct session is refused.
    assert pool.try_acquire_session("conv-C") is False

    pool.release_session("conv-A")
    assert pool.try_acquire_session("conv-C") is True


def test_worker_pool_kill_switch_blocks_acquire() -> None:
    ks = KillSwitch()
    metrics = RuntimeMetrics()
    pool = ChatWorkerPool(max_workers=4, kill_switch=ks, metrics=metrics)

    ks.trip()
    assert pool.try_acquire_session("conv-A") is False
    ks.reset()
    assert pool.try_acquire_session("conv-A") is True


class _RecordingLLM:
    def __init__(self) -> None:
        self.calls: list[tuple[str, str]] = []

    def complete(self, *, system_prompt: str, user_prompt: str) -> str:
        self.calls.append((system_prompt, user_prompt))
        return "claude says hi"


def test_claude_provider_adapter_delegates_to_direct_llm_client() -> None:
    llm = _RecordingLLM()
    adapter = ClaudeChatProviderAdapter(llm=llm)
    out = adapter.generate(ProviderRequest(system_prompt="persona", user_text="hello"))
    assert out == "claude says hi"
    assert llm.calls == [("persona", "hello")]


def test_claude_provider_adapter_redaction_composes() -> None:
    secret = "xoxb-" + ("m" * 44)
    llm = _RecordingLLM()
    adapter = RedactingProviderAdapter(inner=ClaudeChatProviderAdapter(llm=llm))
    adapter.generate(ProviderRequest(system_prompt=f"p {secret}", user_text=f"u {secret}"))
    assert llm.calls
    sent_system, sent_user = llm.calls[0]
    assert secret not in sent_system
    assert secret not in sent_user


class _FakeGeminiResponse:
    def __init__(self, payload: dict[str, object]) -> None:
        self.payload = payload

    def __enter__(self) -> _FakeGeminiResponse:
        return self

    def __exit__(self, exc_type: object, exc: object, tb: object) -> object:
        return False

    def read(self) -> bytes:
        import json

        return json.dumps(self.payload).encode("utf-8")


def test_gemini_provider_adapter_posts_and_parses_text() -> None:
    seen: list[object] = []

    def fake_urlopen(request: object, *, timeout: float) -> _FakeGeminiResponse:
        seen.append((request, timeout))
        return _FakeGeminiResponse(
            {"candidates": [{"content": {"parts": [{"text": "Gemini answer"}]}}]}
        )

    adapter = GeminiChatProviderAdapter(api_key="test-key", urlopen=fake_urlopen)

    out = adapter.generate(ProviderRequest(system_prompt="persona", user_text="hello"))

    assert out == "Gemini answer"
    assert seen


def test_gemini_provider_adapter_requires_text() -> None:
    def fake_urlopen(request: object, *, timeout: float) -> _FakeGeminiResponse:
        _ = (request, timeout)
        return _FakeGeminiResponse({"candidates": []})

    adapter = GeminiChatProviderAdapter(api_key="test-key", urlopen=fake_urlopen)

    with pytest.raises(AssistantTransportError):
        adapter.generate(ProviderRequest(system_prompt="persona", user_text="hello"))
