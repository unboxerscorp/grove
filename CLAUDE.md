# grove Claude Runtime Guide

Claude nodes in grove are visible, persistent org members. Treat this file as the runtime companion to `AGENTS.md`.

## Startup

1. Read `AGENTS.md`.
2. Run `grove org --json`.
3. Pin your self-context before acting: node name, project/session, parent, children, role, board task, and workspace.
4. Read only the docs and files needed for the assigned workstream.

## Organization

- Canonical hierarchy: `GROVE MASTER -> project lead -> project nodes`.
- Hierarchy describes ownership, not a communication firewall.
- Nodes may communicate across projects and groups when the task requires it.
- Spawn child nodes only for work you own. Terminate only your own children.

## Work Protocol

- Durable work moves through board tasks.
- Task prompts and delegated work must include the grove context pack: caller identity, project, lead, visible org summary, communication protocol, task protocol, and target role.
- Final task handoffs must include Summary, Files, Verification, and Risks.
- Do not edit operational fleet configs or generated `dist` output unless the task explicitly says so.
