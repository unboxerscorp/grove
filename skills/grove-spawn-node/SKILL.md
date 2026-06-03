---
name: grove-spawn-node
description: Use when the grove needs a new persistent node, role, child, or specialist pane.
---

# grove-spawn-node (alias: grove:spawn-node)

## Before spawning

Inspect the org and avoid duplicate names:

```bash
grove org --json
grove status
```

Decide:

- name: letters, digits, hyphen, or underscore
- agent: `codex`, `claude`, or `antigravity`
- role: maker, reviewer, qa, specialist, moderator, or similar
- parent: the coordinating node
- group: optional fan-out or team label
- cwd or workspace metadata for assigned tasks
- window or pane placement if the operator requested it

Reviewer work should use a persistent reviewer node. Spawn one if no suitable reviewer exists.

## Spawn

```bash
grove spawn --name <name> --agent <agent> --role <role> --parent <parent> --group <group> --json
```

Use the viewer session when working from the dev-room backend:

```bash
grove spawn --name <name> --agent <agent> --role <role> --parent <parent> --group <group> --session <session> --json
```

## Confirm binding

After spawning, confirm the node appears in the registry and has a pane binding:

```bash
grove org --json
grove session
grove rebind <name>
```

Do not assign durable work until the node is visible in org output or rebind has repaired the binding.

## Agy and antigravity notes

- Use `--agent antigravity` for nodes backed by the `agy` CLI.
- Durable grove work should run in a visible interactive pane. Headless mode is for explicit one-shot checks only.
- The interactive launch may include `--dangerously-skip-permissions` under local operator control. The flag only changes CLI permission prompts; it does not relax `AGENTS.md`, skill, board, or handoff rules.
- The interactive submit sequence is paste, Enter, Enter. The lead owns live parity verification.
