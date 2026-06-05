---
name: grove-delegate
description: Use when handing context or requests to another grove node without forcing task-based communication.
---

# grove-delegate (alias: grove:delegate)

## Direct first

Use `ask` for a direct question:

```bash
grove ask <node> "<question>"
grove ask <project:node> "<question>"
```

Use `send` plus `wait` for an asynchronous direct exchange:

```bash
grove send <node> "<message>"
grove wait <node>
```

The org tree records ownership and reporting structure. It is not a communication boundary. Nodes may talk across siblings or projects using `project:node` or `--project`.

Do not force node-to-node implementation, review, or blocker traffic through board tasks. Board tasks are for human TODOs, human feedback, and ask-human records.

Do not autonomously create or delete nodes. If the human explicitly asks for an org change, use the operator-marked GUI/API/CLI path and report the result.

## Message Spec

A useful direct handoff should include:

- goal and expected output
- scope and files that may be touched
- files or areas that must not be touched
- workspace metadata: kind, path, branch, or session if relevant
- verification command
- reporting format
- blocking criteria

If a needed node does not exist, ask the human operator or project lead to request an org change.

## Human Tasks

Use human-facing tasks only for operator TODOs, feedback, and "human judgment needed" items. A human may reference a task number when instructing master or a project lead.
