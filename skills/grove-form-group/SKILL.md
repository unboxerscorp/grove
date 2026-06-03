---
name: grove-form-group
description: Use when several peer grove nodes should discuss, compare, review, or converge on a decision.
---

# grove-form-group (alias: grove:form-group)

## Purpose

A group is a fan-out label for discussion, comparison, review, or convergence. Use it when several peer nodes should inspect the same context from different angles.

Choose a moderator. The moderator coordinates prompts, waits for replies, gathers results, and writes the decision or next board tasks.

## Form the group

Inspect existing groups first:

```bash
grove org --json
```

Spawn missing peers with the same group:

```bash
grove spawn --name <name> --agent <agent> --role <role> --parent <moderator> --group <group> --json
```

## Fan out

Send the same context to each peer, but give each peer a distinct viewpoint or acceptance criteria.

```bash
grove send <node-a> "<context and viewpoint A>"
grove send <node-b> "<context and viewpoint B>"
grove send <node-c> "<context and viewpoint C>"
```

For durable implementation, verification, or review, create board tasks instead of relying on discussion messages.

## Fan in

```bash
grove gather --group <group> --json
```

The moderator must turn group output into one of:

- a decision with evidence
- follow-up board tasks
- a block comment with the missing input
