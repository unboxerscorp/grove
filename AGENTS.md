# grove Agent Working Agreement

This repo is growing into a cockpit product with multiple makers working at once. Treat this file as the startup contract for grove-core, bridge, ui, reviewer, and qa agents.

## Startup Order

1. Read `AGENTS.md`.
2. Read `docs/agents/shared-context.md`.
3. Read `docs/agents/workstream-registry.md` and only operate inside your assigned stream.
4. Read `docs/engineering/coding-rules.md`.
5. For handoffs, use `docs/agents/handoff-template.md`; for cross-stream coordination, use `docs/agents/coordination.md`.

## Working Agreement

- The lead/orchestrator owns prioritization and integration decisions.
- Makers keep edits scoped to their stream and avoid unrelated refactors.
- Reviewers and QA are read-only unless explicitly reassigned by the lead.
- Before any delegation, node creation, group formation, org inspection, board task action, or work routing, agents must invoke the matching grove skill first, starting with `grove:harness`.
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
