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
                parent="grove-master",
                role="Project lead token=xoxb-secret dev10:1.2",
            ),
            ContextPackNode(
                name="worker",
                agent="codex",
                parent="lead",
                group="product",
                role="Implementation maker",
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
    assert "xoxb-secret" not in pack
    assert "dev10:1.2" not in pack
    assert len(pack.encode("utf-8")) <= 1_200


def test_prepend_grove_context_pack_is_idempotent() -> None:
    message = f"{GROVE_CONTEXT_PACK_HEADER}\n\nOriginal message:\nhello"

    assert prepend_grove_context_pack(message, project="dev10") == message
