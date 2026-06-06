from __future__ import annotations

import re
from collections.abc import Mapping, Sequence
from dataclasses import dataclass

GROVE_CONTEXT_PACK_HEADER = "GROVE CONTEXT PACK"
DEFAULT_MAX_BYTES = 8_000
MAX_NODE_LINES = 40
# Caps for the advisory work-instructions field so a pathologically long value
# cannot bloat every dispatch. Mirror of the TypeScript renderer (context-pack.ts).
WORK_INSTRUCTIONS_FULL_MAX_CHARS = 500
WORK_INSTRUCTIONS_SUMMARY_MAX_CHARS = 120


@dataclass(frozen=True)
class ContextPackNode:
    name: str
    agent: str = ""
    cwd: str = ""
    parent: str = ""
    group: str = ""
    role: str = ""
    work_instructions: str = ""
    tmux_pane: str = ""
    # Owning project (registry session). Used ONLY by collapse_foreign_projects
    # to decide visibility — never rendered, so it does not affect pack bytes.
    # Empty means "treat as home project" (legacy single-project packs).
    project: str = ""


def redact_grove_context_text(value: str) -> str:
    redacted = re.sub(r"\bxox[a-z]?-[^\s,)]+", "[redacted]", value, flags=re.IGNORECASE)
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


def _cap_code_points(value: str, max_chars: int) -> str:
    """Cap by Unicode code points (mirror of the TypeScript renderer) so both
    renderers emit byte-for-byte identical output for the same input."""
    if len(value) <= max_chars:
        return value
    return value[:max_chars] + "…"


def _work_instructions_full(value: str | None) -> str:
    return _cap_code_points(_clean(value, ""), WORK_INSTRUCTIONS_FULL_MAX_CHARS)


def _work_instructions_summary(value: str | None) -> str:
    first_raw_line = re.split(r"\r?\n", value or "", maxsplit=1)[0]
    return _cap_code_points(_clean(first_raw_line, ""), WORK_INSTRUCTIONS_SUMMARY_MAX_CHARS)


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
    if node.tmux_pane.strip():
        parts.append(f"pane={_clean(node.tmux_pane)}")
    if node.cwd.strip():
        parts.append(f"cwd={_clean(node.cwd)}")
    role = _first_line(node.role)
    if role:
        parts.append(f"role={role}")
    work_instructions = _work_instructions_summary(node.work_instructions)
    if work_instructions:
        parts.append(f"work_instructions={work_instructions}")
    return f"- {parent} -> {_clean(node.name)} ({'; '.join(parts)})"


_INFRA_GROUPS = frozenset({"master", "services"})


def _is_infra_node(node: ContextPackNode) -> bool:
    """Shared control-plane nodes — master/services groups, plus the advisor —
    are always shown regardless of project. Mirror of context-pack.ts
    isInfraNode."""
    group = node.group.strip()
    return (group != "" and group in _INFRA_GROUPS) or node.name == "advisor"


def _foreign_project_lead_name(nodes: Sequence[ContextPackNode]) -> str | None:
    """Lead of a foreign project among its own nodes — mirrors _project_lead
    (a node named "lead", else a root node whose name contains "lead")."""
    for node in nodes:
        if node.name == "lead":
            return node.name
    for node in nodes:
        if not node.parent and "lead" in node.name:
            return node.name
    return None


def collapse_foreign_projects(
    nodes: Sequence[ContextPackNode], home_project: str
) -> list[ContextPackNode]:
    """Collapse the visible org so OTHER projects surface only their lead node
    (task_dd4). Home-project nodes — and nodes with no project, i.e. legacy
    single-project packs — are kept in full; shared control-plane nodes are
    exempt; each foreign project keeps only its lead (dropped entirely if it has
    none). Node SELECTION only: input order is preserved and the renderer is
    untouched, so the byte-parity fixtures are unaffected. A single-project pack
    is an inert no-op. Mirror of context-pack.ts:collapseForeignProjects."""
    home = home_project.strip()
    foreign_by_project: dict[str, list[ContextPackNode]] = {}
    for node in nodes:
        project = node.project.strip()
        if project != "" and project != home and not _is_infra_node(node):
            foreign_by_project.setdefault(project, []).append(node)
    kept_foreign_leads: set[str] = set()
    for project, group in foreign_by_project.items():
        lead_name = _foreign_project_lead_name(group)
        if lead_name is not None:
            kept_foreign_leads.add(f"{project} {lead_name}")
    result: list[ContextPackNode] = []
    for node in nodes:
        project = node.project.strip()
        if project in ("", home):
            result.append(node)
        elif _is_infra_node(node):
            result.append(node)
        elif f"{project} {node.name}" in kept_foreign_leads:
            result.append(node)
    return result


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
    target_work_instructions: str | None = None,
) -> str:
    visible_nodes = tuple(collapse_foreign_projects(nodes, project)[:MAX_NODE_LINES])
    lead = _project_lead(visible_nodes, project_lead)
    target = target_node.strip() if target_node is not None and target_node.strip() else "(none)"
    role = _first_line(target_role)
    work_instructions = _work_instructions_full(target_work_instructions)
    communication = (
        communication_protocol
        or "Nodes may communicate directly across projects and hierarchy. "
        "Human-facing list items are for "
        "human TODO, feedback, and ask-human records, not a required node-to-node protocol."
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
        *(
            [f"Target work instructions (advisory): {work_instructions}"]
            if work_instructions
            else []
        ),
        f"Communication protocol: {communication}",
        "Visible org summary:",
        *org_lines,
    ]
    return _truncate_utf8(redact_grove_context_text("\n".join(lines)), max_bytes)


def build_compact_grove_context_pack(
    *,
    project: str,
    caller_node: str | None = None,
    max_bytes: int = DEFAULT_MAX_BYTES,
    nodes: Sequence[ContextPackNode] = (),
    target_node: str | None = None,
    target_role: str | None = None,
    target_work_instructions: str | None = None,
) -> str:
    """Compact node-to-node pack: the token-saving default for live `grove send`
    / `grove ask` between running nodes. Carries identity plus the target's role
    and work-instructions summary, and an org digest (node count) with a one-line
    reminder pointing at `grove org --all --json` / `grove task mine` for a full
    refresh. Keeps the `GROVE CONTEXT PACK` header prefix so the
    no-duplicate-prepend guard still fires. Mirror of
    context-pack.ts:buildCompactGroveContextPack."""
    target = target_node.strip() if target_node is not None and target_node.strip() else "(none)"
    role = _first_line(target_role)
    work_instructions = _work_instructions_summary(target_work_instructions)
    node_count = len(tuple(nodes))
    noun = "node" if node_count == 1 else "nodes"
    lines = [
        f"{GROVE_CONTEXT_PACK_HEADER} (compact)",
        f"Caller node: {_clean(caller_node, 'operator/CLI')}",
        f"Project: {_clean(project)}",
        f"Target node: {target}",
        *([f"Target role: {role}"] if role else []),
        *(
            [f"Target work instructions (advisory): {work_instructions}"]
            if work_instructions
            else []
        ),
        f"Visible org: {node_count} {noun} — run `grove org --all --json` for the "
        f"full multi-project tree; `grove task mine` for your tasks.",
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
    target_work_instructions: str | None = None,
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
        target_work_instructions=target_work_instructions,
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
                cwd=str(raw_node.get("cwd") or ""),
                parent=str(raw_node.get("parent") or ""),
                group=str(raw_node.get("group") or ""),
                role=str(raw_node.get("role") or ""),
                work_instructions=str(raw_node.get("work_instructions") or ""),
                tmux_pane=str(raw_node.get("tmux_pane") or ""),
            )
        )
    return tuple(sorted(nodes, key=lambda node: node.name))
