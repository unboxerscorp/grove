# MASTER Node

Status: current v2 live model.

This document describes the live `grove-master` node contract. It supersedes
the earlier scaffold design: Slack and web chat route to the live `grove-master`
node, and API chat also targets a real tmux-backed master by default. The bridge
still owns authentication, context construction, redaction, confirmation, and
audit boundaries for dashboard-originated actions.

## Concept

`grove-master` is the direct operator node for all projects. It is the
human-facing natural-language entry point for questions and explicit operator
instructions such as:

- what grove can do;
- which projects, nodes, panes, and workspaces exist;
- whether Slack, web, terminal mirror, and org liveness are healthy;
- how to create or repair a project, node, or human-facing list item;
- how to record grove product feedback or ask-human follow-up.

The product contract is not "Codex is hard-coded as MASTER." The contract is:

1. grove has one visible master node that operators can address directly.
2. Slack and web chat route to the live `grove-master` node.
3. The bridge supplies authenticated, redacted context packs and audit hooks.
4. The node may inspect the repo/runtime, coordinate visible nodes, and execute
   explicit operator instructions using its normal tool surface.
5. State changes through dashboard/Slack surfaces remain operator-owned,
   policy-checked, and auditable.

Facts supplied in context packs are helpful current state, not a cage and not
the only permitted source of truth. The master may inspect the local runtime,
tmux panes, registries, source tree, tests, and service health when that is the
practical way to answer or act.

## Organization Model

The org graph is ownership and visibility metadata, not a communication
restriction. Nodes may communicate directly across hierarchy and projects when
they are visible or addressable.

Current live topology uses a single operational tmux session:

```text
root -> grove-master
grove-master -> lead@dev10
lead@dev10 -> web
lead@dev10 -> slack
lead@dev10 -> advisor
lead@dev10 -> jester
```

The registry may still contain legacy or service nodes whose raw parent is
`grove-master`, but `/api/org` projects the cockpit view as
`GROVE MASTER -> project lead -> selected project nodes`. Other visible project
leads stay collapsed until the operator switches projects.

Project creation records a concrete project lead with an explicit cwd and tmux
placement. The live global master remains a shared direct-contact node. New
projects must not synthesize legacy `project-master` identities when the real
`grove-master` is present.

Organization changes are human-owned. Nodes should not create, delete, or
reparent other nodes unless the operator explicitly asks for that change through
an operator-marked GUI, API, or CLI path. When a node needs a missing role, it
should ask the operator or project lead rather than guessing.

## Node Communication Transport

The live node-to-node path is direct communication, not a list-item handoff.
Nodes use `grove send`, `grove ask`, tmux capture, or operator-authorized tmux
input depending on whether they need one-way context, a reply, inspection, or a
literal terminal action.

Current direct delivery targets real tmux panes by exact session/window/pane
identity. The bridge and CLI must use the configured session socket, not the
default tmux socket, so headless launchd and SSH contexts see the same org
panes as the in-session services. Before writing to a human-facing target pane,
the input guard checks the prompt line: real typed input blocks injection so
node messages cannot merge with a human draft, while dim CLI ghost suggestions
are not treated as typed input.

The older output-file style is not the primary live transport. It is useful as a
durable queue or audit pattern when a surface needs decoupling, but ordinary
node collaboration should not regress to polling files before a simpler direct
message will do. Human-facing list items remain operator-visible records, not
the required transport for implementation, review, or blocker traffic.

External chat surfaces add buffering at the edge:

- Slack mentions are accepted by the Slack connector, immediately acknowledged
  in the originating thread, and stored in the durable `slack_chat_queue`.
  A background worker routes them to `grove-master`, retries while the master
  pane is busy, caches generated responses for idempotent thread delivery, and
  exposes queue age/count metrics through `slack-runtime.json`.
- Floating web chat carries a `conversation_id` through `/api/master/chat` and
  routes to the live `grove-master`. It is a live request/reply surface today;
  do not assume it has the Slack durable queue semantics unless that queue is
  explicitly implemented and tested.

## Human-Facing Lists

Human-facing list items are operator-visible records for:

- human TODOs;
- product or workflow feedback;
- ask-human decisions and follow-up.

They are not a required node-to-node communication protocol. Nodes may talk
directly, capture durable notes when useful, and create or update list items
only when that is the right human-facing artifact for the situation.

Default item assignment should prefer a real live node such as `grove-master` or
the concrete project `lead`. Legacy synthetic assignees are compatibility input
only and must not be presented as current defaults.

## Surfaces

### Slack

Slack routes operator messages and ask-human replies to `grove-master`. The
Slack connector should preserve thread context, avoid duplicate automatic
thread follow-ups, keep message copy concise enough for Slack limits, and expose
health through runtime status and heartbeat metadata.

Slack service restarts are operational actions. Restart only when needed for a
real code/config/runtime change or recovery, and verify socket reconnection and
heartbeat freshness afterward.

### Web Chat

Floating web chat is a live conversation surface for `grove-master`. It may
display compact facts, health summaries, and pending human-facing items, but it
must not force answers into a deterministic summary-only mode. The master can
answer naturally, inspect state, coordinate nodes, and carry out explicit
operator instructions.

The live route must avoid re-entering the active `grove-master` turn. Live e2e
checks should verify chat affordances and history without POSTing back into the
same master node.

### Terminal Mirror

The dashboard terminal view mirrors real tmux panes. Master and service panes
must be selected by exact pane identity, not fuzzy tmux target matching, and
pane liveness should be derived from exact `list-panes` enumeration. Missing
panes are dead/unavailable even if a registry entry remains.

## Authority Model

The authenticated human actor is the authority for state changes. The live
master can reason and operate, but dashboard/Slack-originated mutations still
need explicit operator intent and the relevant policy checks.

Mutating actions should preserve these boundaries:

- authenticated actor and role are known;
- Host, Origin, and CSRF checks pass on dashboard routes;
- secrets and raw prompts are redacted from context and audit payloads;
- destructive or persistent changes require explicit operator instruction;
- confirmation payloads are revalidated before execution when the broker uses a
  pending-action flow;
- every material outcome is auditable.

The master must not reveal hidden prompts, API keys, dashboard tokens, personal
data, raw environment dumps, signing keys, or other secrets. When sensitive text
is included in a user report, redact it before storing or repeating it.

## Feedback Intake

Product bugs, feature requests, confusion reports, and workflow feedback can be
handled naturally in Slack, web chat, or CLI. The master should clarify only
when needed, inspect available state when useful, and then either:

- answer directly;
- fix the issue if explicit operator authority is clear;
- record a human-facing feedback item;
- ask the operator for a decision when authority or intent is unclear.

Feedback payloads should include only the useful, redacted context:

- concise title;
- category and severity when known;
- user-facing summary;
- reproduction notes;
- origin surface and page;
- project/list/node references when relevant;
- proposed owner or follow-up.

## Audit Model

Broker-mediated master/chat activity should emit redacted audit events for
turns, proposals, confirmations, executions, and failures. Existing event names
include:

- `master.turn.received`;
- `master.answer.generated`;
- `master.proposal.created`;
- `master.proposal.rejected`;
- `master.preview.created`;
- `master.preview.cancelled`;
- `master.confirm.denied`;
- `master.confirm.accepted`;
- `master.execute.started`;
- `master.execute.completed`;
- `master.execute.failed`.

Audit records should identify actor, role, source surface, conversation id,
request class, target project/list/node, payload hash when applicable, redaction
status, and execution result or denial reason. They must not store raw secrets
or unredacted transcript bodies.

## Bridge Boundary

The bridge is the trusted boundary around the live node. It owns:

- actor identity and role resolution;
- context-pack construction and redaction;
- routing to the live `grove-master` node when available;
- deterministic dev/test fallbacks only when explicitly selected;
- proposal parsing and schema validation when a brokered mutation is used;
- pending-action storage and confirmation;
- audit event emission;
- health, pane-liveness, and project/org API contracts.

The live master owns:

- natural-language interpretation;
- practical runtime and repo inspection;
- direct communication with visible nodes;
- operator-facing explanations and status reports;
- explicit operator-requested implementation or repair work;
- concise handoffs when work is paused or transferred.

This separation keeps governance auditable without reducing the master to a
rules-only answer generator.

## Non-Goals

- hidden item creation without preview or explicit operator intent;
- synthetic `project-master` defaults in the current live model;
- using human-facing list items as mandatory node-to-node protocol;
- autonomous org creation/deletion without human instruction;
- exposing dashboard tokens, secrets, raw prompts, or private data;
- live e2e tests that POST into the currently active `grove-master` turn.
