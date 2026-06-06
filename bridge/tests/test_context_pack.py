from __future__ import annotations

from grove_bridge.context_pack import (
    GROVE_CONTEXT_PACK_HEADER,
    ContextPackNode,
    build_grove_context_pack,
    prepend_grove_context_pack,
)


def test_build_grove_context_pack_redacts_and_bounds_visible_context() -> None:
    pack = build_grove_context_pack(
        caller_node="orch-master",
        max_bytes=1_200,
        nodes=(
            ContextPackNode(
                name="lead",
                agent="codex",
                cwd="/repo/dev10",
                parent="grove-master",
                role="Project lead token=xoxb-secret dev10:1.2",
                tmux_pane="dev10:1.2",
            ),
            ContextPackNode(
                name="worker",
                agent="codex",
                cwd="/repo/dev10",
                parent="lead",
                group="product",
                role="Implementation maker",
                tmux_pane="dev10:1.3",
            ),
        ),
        project="dev10",
        project_lead="lead",
        target_node="worker",
        target_role="Implementation maker",
    )

    assert GROVE_CONTEXT_PACK_HEADER in pack
    assert "Caller node: orch-master" in pack
    assert "Project: dev10" in pack
    assert "Project lead: lead" in pack
    assert "Target node: worker" in pack
    assert "Target role: Implementation maker" in pack
    assert "lead -> worker" in pack
    assert "pane=dev10:1.3" in pack
    assert "cwd=/repo/dev10" in pack
    assert "Human-facing list items are for human TODO" in pack
    assert "Board tasks are" not in pack
    assert "xoxb-secret" not in pack
    assert "dev10:1.2" in pack
    assert len(pack.encode("utf-8")) <= 1_200


def test_prepend_grove_context_pack_is_idempotent() -> None:
    message = f"{GROVE_CONTEXT_PACK_HEADER}\n\nOriginal message:\nhello"

    assert prepend_grove_context_pack(message, project="dev10") == message


# Advisory work-instructions (작업지침). PARITY_* fixtures are duplicated verbatim
# in src/context-pack.test.ts; both renderers MUST emit identical bytes for
# identical input, or a node would get a different prompt depending on whether
# it was dispatched through the TypeScript or Python path.
PARITY_WORK_INSTRUCTIONS = "PR 머지 전 reviewer 승인 필수\n  여러 줄 가능"
PARITY_PACK = "\n".join(
    [
        "GROVE CONTEXT PACK",
        "Caller node: lead",
        "Project: dev10",
        "Project lead: lead",
        "Target node: maker",
        "Target role: Builder",
        "Target work instructions (advisory): PR 머지 전 reviewer 승인 필수 여러 줄 가능",
        "Communication protocol: direct comms",
        "Visible org summary:",
        "- lead -> maker (codex; group=product; pane=dev10:1.3; cwd=/repo; "
        "role=Builder; work_instructions=PR 머지 전 reviewer 승인 필수)",
    ]
)


def _maker(work_instructions: str = "") -> ContextPackNode:
    return ContextPackNode(
        name="maker",
        agent="codex",
        cwd="/repo",
        parent="lead",
        group="product",
        role="Builder",
        work_instructions=work_instructions,
        tmux_pane="dev10:1.3",
    )


def test_work_instructions_render_is_byte_identical_to_the_typescript_renderer() -> None:
    pack = build_grove_context_pack(
        caller_node="lead",
        communication_protocol="direct comms",
        nodes=(_maker(PARITY_WORK_INSTRUCTIONS),),
        project="dev10",
        project_lead="lead",
        target_node="maker",
        target_role="Builder",
        target_work_instructions=PARITY_WORK_INSTRUCTIONS,
    )

    assert pack == PARITY_PACK


def test_work_instructions_unset_is_byte_identical_to_un_instructed_pack() -> None:
    pack = build_grove_context_pack(
        caller_node="lead",
        communication_protocol="direct comms",
        nodes=(_maker(),),
        project="dev10",
        project_lead="lead",
        target_node="maker",
        target_role="Builder",
    )

    assert "work_instructions" not in pack
    assert "(advisory)" not in pack
    assert pack == "\n".join(
        [
            "GROVE CONTEXT PACK",
            "Caller node: lead",
            "Project: dev10",
            "Project lead: lead",
            "Target node: maker",
            "Target role: Builder",
            "Communication protocol: direct comms",
            "Visible org summary:",
            "- lead -> maker (codex; group=product; pane=dev10:1.3; cwd=/repo; role=Builder)",
        ]
    )


def test_work_instructions_redacts_secrets() -> None:
    pack = build_grove_context_pack(
        project="dev10",
        target_node="maker",
        target_work_instructions="deploy with token=xoxb-deadbeef now",
    )

    assert "xoxb-deadbeef" not in pack
    assert "token=[redacted]" in pack


def test_work_instructions_caps_pathologically_long_text() -> None:
    pack = build_grove_context_pack(
        project="dev10",
        target_node="maker",
        target_work_instructions="a" * 600,
    )

    assert f"Target work instructions (advisory): {'a' * 500}…" in pack
    assert "a" * 501 not in pack
