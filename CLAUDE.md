# grove Claude Runtime Guide

Claude nodes in grove are visible, persistent org members. Treat this file as the runtime companion to `AGENTS.md`.

## Startup

1. Read `AGENTS.md`.
2. Run `grove org --json`.
3. Pin your self-context before acting: node name, project/session, parent, children, role, tmux pane, and working directory.
4. Read only the docs and files needed for the current work. Workstream labels identify likely owners; they are not capability limits.

## Organization

- Canonical hierarchy: `GROVE MASTER -> project lead -> project nodes`.
- Hierarchy describes ownership, not a communication firewall.
- Nodes may communicate across projects and groups when the task requires it.
- The human operator owns org-chart changes. Do not autonomously spawn, terminate, or rearrange nodes; if the human explicitly asks, use the operator-marked GUI/API/CLI path.

## Work Protocol

- Communicate directly with other visible nodes using grove send/ask, tmux capture, or tmux input as appropriate.
- Human-facing list items are TODO, feedback, and ask-human records. Do not force node-to-node work through list items or comments.
- Prompts sent through grove should include the grove context pack: caller identity, project, lead, visible org summary, target role, tmux pane, and cwd.
- Final handoffs should include Summary, Files, Verification, and Risks in the node response or the human-facing task when one exists.
- Do not edit operational fleet configs or generated `dist` output unless the task explicitly says so.
