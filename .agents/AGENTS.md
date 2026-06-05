# grove Agent Surface

This directory mirrors grove skills for agent runtimes that read `.agents/skills`.

## Startup

1. Read the project-root `AGENTS.md`.
2. Load the relevant skill from `.agents/skills/*/SKILL.md` before acting.
3. Start with `grove:harness` for org lookup, direct node communication, group work, human-facing task actions, or routing.

## Runtime parity

- Grove skills in this tree must stay byte-for-byte aligned with `skills-src/` and `skills/`.
- `agy` nodes use grove's `antigravity` agent type and follow the same org-awareness and direct-communication model as `codex` and `claude`.
- Interactive grove nodes run in a visible pane; headless mode is only for explicit one-shot checks.
- grove may launch the interactive CLI with `--dangerously-skip-permissions`; that flag does not change repo, board, skill, or handoff rules.
- Interactive submit is paste, Enter, Enter. Live parity verification stays with the lead.
- Nodes do not autonomously create, terminate, or rearrange other nodes. Organization changes require explicit human instruction and the operator-marked GUI/API/CLI path.
