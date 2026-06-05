from __future__ import annotations

import re
from collections.abc import Mapping, Sequence
from dataclasses import dataclass

GROVE_CONTEXT_PACK_HEADER = "GROVE CONTEXT PACK"
DEFAULT_MAX_BYTES = 8_000
MAX_NODE_LINES = 40


@dataclass(frozen=True)
class ContextPackNode:
    name: str
    agent: str = ""
    parent: str = ""
    group: str = ""
    role: str = ""


def redact_grove_context_text(value: str) -> str:
    redacted = re.sub(r"\b[A-Za-z0-9_-]+:\d+\.\d+\b", "[tmux-pane]", value)
    redacted = re.sub(r"\bxox[a-z]?-[^\s,)]+", "[redacted]", redacted, flags=re.IGNORECASE)
    redacted = re.sub(r"\bsk-[A-Za-z0-9_-]{12,}\b", "[redacted]", redacted)
    return re.sub(
        r"\b(token|secret|password|api[_-]?key)\s*[:=]\s*[^\s,)]+",
        lambda match: f"{match.group(1)}=[redacted]",
        redacted,
        flags=re.IGNORECASE,
    )


def _clean(value: str | None, fallback: str = "(unknown)") -> str:
    stripped = re.sub(r"\s+", " ", value or "").strip()
    return stripped or fallback


def _first_line(value: str | None) -> str:
    cleaned = _clean(value, "")
    if not cleaned:
        return ""
    return cleaned.splitlines()[0].strip()


def _truncate_utf8(value: str, max_bytes: int) -> str:
    cap = max(256, max_bytes)
    if len(value.encode("utf-8")) <= cap:
        return value
    suffix = "\n[context pack truncated]"
    out = value
    while out and len((out + suffix).encode("utf-8")) > cap:
        out = out[:-1]
    return out + suffix


def _project_lead(nodes: Sequence[ContextPackNode], explicit: str | None) -> str:
    if explicit is not None and explicit.strip():
        return explicit.strip()
    for node in nodes:
        if node.name == "lead":
            return node.name
    for node in nodes:
        if not node.parent and "lead" in node.name:
            return node.name
    return "lead"


def _node_line(node: ContextPackNode) -> str:
    parent = _clean(node.parent, "root")
    parts = [_clean(node.agent, "unknown")]
    if node.group.strip():
        parts.append(f"group={_clean(node.group)}")
    role = _first_line(node.role)
    if role:
        parts.append(f"role={role}")
    return f"- {parent} -> {_clean(node.name)} ({'; '.join(parts)})"


def build_grove_context_pack(
    *,
    project: str,
    caller_node: str | None = None,
    communication_protocol: str | None = None,
    max_bytes: int = DEFAULT_MAX_BYTES,
    nodes: Sequence[ContextPackNode] = (),
    project_lead: str | None = None,
    target_node: str | None = None,
    target_role: str | None = None,
    task_protocol: str | None = None,
) -> str:
    visible_nodes = tuple(nodes[:MAX_NODE_LINES])
    lead = _project_lead(visible_nodes, project_lead)
    target = target_node.strip() if target_node is not None and target_node.strip() else "(none)"
    role = _first_line(target_role)
    communication = (
        communication_protocol
        or "Nodes may communicate across the org; durable implementation and review work "
        "should be tracked through grove board tasks."
    )
    task = (
        task_protocol
        or "Use board-task-centered handoffs. Final answers should include Summary, Files, "
        "Verification, and Risks."
    )
    org_lines = (
        [_node_line(node) for node in visible_nodes]
        if visible_nodes
        else ["- (visible org summary unavailable in this dispatch context)"]
    )
    lines = [
        GROVE_CONTEXT_PACK_HEADER,
        f"Caller node: {_clean(caller_node, 'operator/CLI')}",
        f"Project: {_clean(project)}",
        f"Project lead: {_clean(lead)}",
        f"Target node: {target}",
        f"Target role: {role or '(not recorded)'}",
        f"Communication protocol: {communication}",
        f"Task protocol: {task}",
        "Visible org summary:",
        *org_lines,
    ]
    return _truncate_utf8(redact_grove_context_text("\n".join(lines)), max_bytes)


def prepend_grove_context_pack(
    message: str | None,
    *,
    project: str,
    caller_node: str | None = None,
    communication_protocol: str | None = None,
    max_bytes: int = DEFAULT_MAX_BYTES,
    nodes: Sequence[ContextPackNode] = (),
    project_lead: str | None = None,
    target_node: str | None = None,
    target_role: str | None = None,
    task_protocol: str | None = None,
) -> str:
    body = message if message is not None and message.strip() else "(no body)"
    if body.lstrip().startswith(GROVE_CONTEXT_PACK_HEADER):
        return body
    pack = build_grove_context_pack(
        caller_node=caller_node,
        communication_protocol=communication_protocol,
        max_bytes=max_bytes,
        nodes=nodes,
        project=project,
        project_lead=project_lead,
        target_node=target_node,
        target_role=target_role,
        task_protocol=task_protocol,
    )
    return f"{pack}\n\nOriginal message:\n{body}"


def context_pack_nodes_from_registry(
    raw_nodes: Mapping[str, object],
) -> tuple[ContextPackNode, ...]:
    nodes: list[ContextPackNode] = []
    for fallback_name, raw_node in raw_nodes.items():
        if not isinstance(raw_node, Mapping):
            continue
        raw_name = raw_node.get("name")
        nodes.append(
            ContextPackNode(
                name=raw_name if isinstance(raw_name, str) and raw_name.strip() else fallback_name,
                agent=str(raw_node.get("agent") or ""),
                parent=str(raw_node.get("parent") or ""),
                group=str(raw_node.get("group") or ""),
                role=str(raw_node.get("role") or ""),
            )
        )
    return tuple(sorted(nodes, key=lambda node: node.name))
