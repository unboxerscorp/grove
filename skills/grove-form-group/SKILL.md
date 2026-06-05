---
name: grove-form-group
description: Use when several peer grove nodes should discuss, compare, review, or converge on a decision.
---

# grove-form-group (alias: grove:form-group)

## Purpose

A group is a fan-out label for discussion, comparison, review, or convergence. Use it when several peer nodes should inspect the same context from different angles.

Choose a moderator. The moderator coordinates direct prompts, waits for replies, gathers results, and writes the decision for the requester.

## Use Existing Nodes

Inspect existing groups first:

```bash
grove org --json
```

Do not autonomously spawn missing peers. If the org is missing a role, ask the human operator or project lead; if the human explicitly asks you to create it, use the operator-marked GUI/API/CLI path.

## Fan out

Send the same context to each peer, but give each peer a distinct viewpoint or acceptance criteria.

```bash
grove send <node-a> "<context and viewpoint A>"
grove send <node-b> "<context and viewpoint B>"
grove send <node-c> "<context and viewpoint C>"
```

For implementation, verification, or review, keep the peer discussion direct unless a human-facing TODO, feedback item, or ask-human record is needed.

## Fan in

```bash
grove gather --group <group> --json
```

The moderator must turn group output into one of:

- a decision with evidence
- direct follow-up messages to the relevant nodes
- a human-facing TODO or ask-human item when human judgment is needed
