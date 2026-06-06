# Shared Context

grove is a terminal cockpit for running a tree of Claude Code and Codex agents in tmux. The product direction is a complete cockpit experience, not only a thin CLI wrapper.

## Current Repo Shape

- TypeScript core lives in `src/`.
- Python bridge work starts in `bridge/`.
- Generated build output lives in `dist/` and must not be edited directly.
- Operational fleet config files are local runtime inputs and are not part of harness work unless the lead assigns that specifically.

## Product Invariants

- A node is one agent session running in tmux.
- `send`, `wait`, `ask`, `watch`, `gather`, and fan-in behavior form the core control plane.
- Durable turn events must remain idempotent and resume-safe.
- CLI behavior should remain scriptable and predictable.

## Collaboration Invariants

- Prefer small, reviewable changes.
- Keep behavior changes backed by tests.
- Report blockers with the exact command or file that exposed them.
- Never claim a gate is green without running the gate.
- Use `grove org --all --json` for startup and routing context so every node sees the full multi-project tree. Use project-scoped org views only after deliberately narrowing the task.
