# grove Agent Working Agreement

This repo is growing into a cockpit product with multiple makers working at once. Treat this file as the startup contract for grove-core, bridge, ui, reviewer, and qa agents.

## Startup Order

1. Read `AGENTS.md`.
2. Run `grove org --json` and pin a short self-context block before acting: current node name, project/session, parent, children, role, assigned board task, and target workspace.
3. Read `docs/agents/shared-context.md`.
4. Read `docs/agents/workstream-registry.md` and keep code edits inside the assigned stream unless the task explicitly crosses streams.
5. Read `docs/engineering/coding-rules.md`.
6. For handoffs, use `docs/agents/handoff-template.md`; for cross-stream coordination, use `docs/agents/coordination.md`.

## Working Agreement

- The lead/orchestrator owns prioritization and integration decisions.
- Makers keep code edits scoped to their stream and avoid unrelated refactors.
- Reviewers and QA are read-only for code changes unless explicitly reassigned, but they may communicate, inspect, and report through board tasks.
- Nodes may communicate across the visible org regardless of hierarchy. Durable implementation, review, verification, and blocker traffic should be captured in board tasks and comments.
- Nodes may spawn child nodes for owned work and terminate only their own children, using the grove skill and board protocol.
- Before any delegation, node creation, group formation, org inspection, board task action, or work routing, agents must invoke the matching grove skill first, starting with `grove:harness`.
- `agy`/`antigravity` nodes follow the same grove skills and board delegation protocol as `codex` and `claude`; `.agents/AGENTS.md` carries runtime-specific parity notes.
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
