---
name: grove-spawn-node
description: Use only to understand or request human-operator node creation.
---

# grove-spawn-node (alias: grove:spawn-node)

## Rule

Nodes do not autonomously create, terminate, or rearrange other nodes. Organization changes require explicit human instruction through the GUI/API or an operator-marked command.

If you think a new persistent node, role, child, or specialist pane is needed, inspect the org and ask the human operator or project lead. If the human explicitly asks you to create it, use the operator-marked command.

```bash
grove org --all --json
grove status
```

Decide:

- name: letters, digits, hyphen, or underscore
- agent: `codex`, `claude`, or `antigravity`
- role: maker, reviewer, qa, specialist, moderator, or similar
- parent: the coordinating node
- group: optional fan-out or team label
- cwd or workspace metadata for assigned work or human-facing items
- window or pane placement if the human operator requested it

Reviewer work should use an existing persistent reviewer node. If no suitable reviewer exists, request one from the human operator.

## Human Operator Command

```bash
grove spawn --name <name> --agent <agent> --role <role> --parent <parent> --group <group> --json
grove spawn --operator --name <name> --agent <agent> --role <role> --parent <parent> --group <group> --json
```

The dashboard node creation flow supplies the project cwd. Project nodes should start in the project's configured working directory.

## Confirm binding

After spawning, confirm the node appears in the registry and has a pane binding:

```bash
grove org --all --json
grove session
grove rebind <name>
```

Do not route work to the node until it is visible in org output and has a pane and cwd binding.

## Agy and antigravity notes

- Use `--agent antigravity` for nodes backed by the `agy` CLI.
- Grove work should run in a visible interactive pane. Headless mode is for explicit one-shot checks only.
- The interactive launch may include `--dangerously-skip-permissions` under local operator control. The flag only changes CLI permission prompts; it does not relax `AGENTS.md`, skill, human-facing list, or handoff rules.
- The interactive submit sequence is paste, Enter, Enter. The lead owns live parity verification.
