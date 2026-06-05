---
name: grove-task-only-comms
description: Use when handing work, answers, reviews, verification, or blockers between grove nodes through durable board-task-centered communication.
---

# grove-task-only-comms

Use this skill whenever work state must survive beyond a quick chat turn.

## Rule

Durable grove work belongs in board tasks and task comments. Direct conversation may point someone to the task, but implementation instructions, blockers, review findings, verification results, and final answers should be recorded on the task.

## Required Context

Every task dispatch should include:

- caller node identity
- project/session and project lead
- visible org summary
- communication protocol
- task protocol
- target node role
- requested work and acceptance criteria

## ANSWER Format

When finishing or answering a task, leave an `ANSWER:` comment or body update with:

- Summary
- Files
- Verification
- Risks

## Safety

- Use `grove:harness` before board actions or routing.
- Use `grove:org` before asking, assigning, spawning, or routing.
- Keep code edits scoped to the assigned workstream.
- Do not edit operational fleet configs or generated `dist` output unless explicitly assigned.
