# grove Agent Working Agreement

This repo is growing into a cockpit product with multiple makers working at once. Treat this file as the startup contract for grove-core, bridge, ui, reviewer, and qa agents.

## Startup Order

1. Read `AGENTS.md`.
2. Run `grove org --json` and pin a short self-context block before acting: current node name, project/session, parent, children, role, tmux pane, and working directory.
3. Check current operator-visible work assigned to you when a human-facing item may exist:
   `grove task list --session <project> --board <project> --assignee <node>`.
4. Read `docs/agents/shared-context.md`.
5. Read `docs/agents/workstream-registry.md` to understand ownership labels and likely experts. Streams are coordination metadata, not a hard permission boundary.
6. Read `docs/engineering/coding-rules.md`.
7. For handoffs, use `docs/agents/handoff-template.md`; for cross-stream coordination, use `docs/agents/coordination.md`.

## Working Agreement

- The human operator owns the organization chart: project creation, node creation, parent/group changes, and node termination. A node may perform these actions only when the human explicitly instructs it to do so.
- The lead/orchestrator owns prioritization and integration decisions inside the organization the human has configured.
- Any node may inspect, communicate, and work across projects and streams when the human request or practical task requires it. Prefer the local owner style and avoid unrelated refactors.
- Reviewer and QA roles describe default focus, not capability limits. They may still communicate directly, run checks, and make changes when explicitly asked or when it is the practical route.
- Nodes may communicate across the visible org regardless of hierarchy or project. Use direct node messaging, tmux capture, or tmux input as appropriate.
- Human-facing list items are operator TODO, feedback, and ask-human records. Do not use list items as the required node-to-node communication protocol.
- Human-facing list items should still stay visible to the responsible node; use `grove task list` or the web board to inspect assigned ready/running/ask-human work before acting on operator-visible work.
- Nodes must not autonomously spawn, terminate, or rearrange nodes. When the human explicitly asks for an org change, use the operator-marked GUI/API/CLI path and report what changed.
- Before routing work or contacting another node, inspect the org so the target role, tmux pane, and cwd are known.
- `agy`/`antigravity` nodes follow the same org-awareness and direct-communication model as `codex` and `claude`; `.agents/AGENTS.md` carries runtime-specific parity notes.
- Do not modify operational fleet configs such as `fleet.yaml`, `grove.yaml`, or `cockpit.grove.yaml` unless the lead asks directly.
- Preserve current P1/P2 behavior for event logs, watch, fan-in, and wait unless the task is explicitly about those behaviors.
- Every handoff must state changed files, verification commands, and remaining risks.

## Verification Gate

The single gate is:

```bash
pnpm check
```

It runs Prettier, ESLint, TypeScript, Vitest, Ruff, Ruff format, mypy strict, and pytest. Install hooks with:

```bash
pnpm hooks:install
```

Python checks run through `uv`. If `uv` is missing, install it before running the gate:

```bash
brew install uv
```

or use the installer documented at `https://docs.astral.sh/uv/getting-started/installation/`.
