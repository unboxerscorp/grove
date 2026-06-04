# MASTER Node

## Phase-1 Scope

This document defines the MASTER node concept and the first bridge boundary for
natural-language project control and grove product feedback intake. Phase 1 is
design and new-module scaffolding only:

- no `web_app.py` route registration;
- no frontend core wiring in `app.tsx`;
- no direct state mutation from natural language;
- all future mutations are operator-gated and audit-first.

## Concept

MASTER is the single natural-language CLI authority for governing a user's
`~/dev` workspace. It is the entry point for questions such as "what can grove
do?", "create a project", "how many reviewers are on this project?", or "set up
the workflow for this node group."

The MASTER is intentionally replaceable. The product contract is not "Codex is
hard-coded as MASTER"; the contract is:

1. grove owns the governance broker, authorization checks, confirmation state,
   and audit trail.
2. a swappable CLI adapter receives bounded context and user turns.
3. the adapter returns answers or typed proposals.
4. grove validates, previews, confirms, executes through existing safe paths,
   and audits every outcome.

Codex CLI can be the first adapter because grove already models real agent
sessions as tmux-backed nodes. A later adapter can replace Codex without
changing the broker contract, chat UI, audit model, or routing semantics.

## Responsibilities

MASTER has two duties:

1. **Workspace governance for `~/dev`**
   - answer capability, project, node, board, and workflow questions;
   - draft project, node, workflow, and task setup proposals;
   - never execute shell commands or mutate grove state directly;
   - hand state changes back to grove as typed proposals that require broker
     validation and operator confirmation.

2. **grove-feedback chief**
   - receive product bugs, feedback, feature requests, and confusion reports
     about grove itself;
   - normalize them into feedback-route proposals;
   - route accepted feedback to the `grove-dev-team` board lane selected by
     the product governance configuration;
   - preserve source context, actor, project, page, and redacted transcript
     metadata for follow-up.

MASTER is therefore both the general `~/dev` governance assistant and the
orchestrator for grove's own feedback intake.

## Relationship To Floating Web Chat

The floating web chat is a presentation surface for MASTER, not the authority
that performs governance.

The chat owns:

- compact message input/output;
- current project/page context hints;
- preview cards for proposed changes;
- confirm/cancel controls;
- links to the live MASTER terminal or transcript when available.

The bridge broker owns:

- actor identity and role resolution;
- context-pack construction and redaction;
- adapter calls into the MASTER CLI;
- proposal parsing and schema validation;
- pending-action storage;
- operator-gated confirmation;
- audit event emission.

The MASTER adapter owns:

- natural-language interpretation;
- response drafting;
- typed proposal drafting.

This separation keeps the web chat small and replaceable. A mobile sheet,
desktop floating widget, CLI command, or Slack intake path can all use the same
broker contract if they supply the same actor and context metadata.

## Natural-Language Classes

Phase-1 interfaces recognize these request classes:

- `capability_question`: what MASTER/grove can do;
- `project_question`: project inventory, status, or lifecycle questions;
- `node_question`: node count, role, group, health, or assignment questions;
- `workflow_setup`: proposed project/node/task/workflow setup;
- `feedback_route`: grove product bug, feedback, feature request, or confusion
  report;
- `unsupported`: destructive, unscoped, unsafe, or ambiguous requests.

Only read-only answers and proposal drafts belong in the first adapter
contract. Router registration, execution, and UI preview rendering are follow-up
work.

## Feedback Routing

Feedback routing is a mutation even when the user simply says "this is broken."
The broker must produce a preview before creating any task.

Default normalized route:

- target project: `grove-dev-team`;
- target board/lane: configured dev-team feedback board;
- default label: `grove-feedback`;
- category labels: `bug`, `feedback`, `feature-request`, `question`, or
  `unsafe`;
- assignee: configured grove dev-team orchestrator, not an inferred local node.

Feedback payloads should include:

- concise title;
- category and severity;
- user-facing summary;
- reproduction notes when present;
- origin project/page;
- source surface such as `floating-web-chat`;
- conversation id;
- actor id;
- redacted transcript excerpt;
- proposed routing target.

Secret-looking content must be redacted before the preview and before any task
body is created.

## Authority Model

MASTER is advisory. The authenticated actor is the only source of authority for
state changes.

Read-only requests require normal authenticated read access to the selected
project or visible workspace summary. Mutating proposals require:

- an authenticated actor;
- operator/admin role for the target scope;
- Host/Origin/CSRF checks on the eventual route;
- a pending action created by the broker;
- explicit confirmation by the same actor;
- payload-hash revalidation at confirmation time;
- fresh scope checks immediately before execution.

The MASTER adapter must never receive dashboard tokens, member secrets, signing
keys, raw environment dumps, or unrestricted filesystem context.

## Audit Model

Every material broker step must write an audit event with redacted payloads:

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

Audit records should identify:

- actor id and role;
- source surface;
- conversation id;
- request class;
- target project/board/node when applicable;
- proposal id and pending id;
- payload hash;
- redaction status;
- execution result or denial reason.

Audit records must not store raw secrets or unredacted transcript bodies.

## Bridge Boundary

The first bridge module, `grove_bridge.master`, defines typed interfaces only.
It should model:

- actor and request context;
- NL request classification;
- read-only answer drafts;
- typed action proposals;
- feedback route drafts;
- audit sinks;
- operator-gated policy checks;
- adapter and broker protocols.

The module must not register FastAPI routes, call `web_app.py`, write board
tasks, spawn nodes, or execute project setup. Those actions belong to later
router and executor layers after the phase-1 contract is reviewed.

## Non-Goals

- arbitrary command execution;
- destructive operations such as delete/despawn/reset;
- hidden task creation without preview;
- direct edits to `web_app.py` or `app.tsx` in this phase;
- making MASTER a privileged service account;
- storing raw prompt transcripts or secrets.
