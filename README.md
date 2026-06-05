# grove

**A standalone, self-contained dev-room / team-OS for real CLI agents.**

grove runs a visible org of `codex`, `claude`, and `agy` CLI sessions in tmux, then
gives the operator one web cockpit: human-facing lists, live terminals, org
inspection, Slack/web chat to the GROVE MASTER, audit, setup, and remote access. Every
agent you see is a real, viewable, talk-to-able terminal session, not an invisible
runtime.

```bash
grove up                         # start the org chart in tmux
grove org --json                  # inspect nodes, roles, panes, cwd, and hierarchy
grove-web --port 8765            # open the dev-room web SPA + dashboard APIs
grove-web --enable-node-input     # optional: operator-gated web input to node panes
grove serve --port 8787          # optional local OpenAI-compatible chat facade
grove send maker-1 "Please inspect the auth retry path and report risks."
grove ask reviewer "Review the current diff"
grove task ask-human task_123 --comment "Which branch should this use?"
grove watchdog --json            # dry-run node health and recovery plan
grove repair --all
```

## What ships today

- **Real tmux agent tree** - bring up an org chart of `codex`, `claude`, and `agy`
  nodes; each node is a live tmux pane with adapter-specific turn detection.
- **Web dev-room SPA** - `grove-web` serves human-facing lists, org chart, live
  terminal viewer, project switcher, login/setup panels, Slack configuration UX, audit
  drawer, setup/connect surfaces, tutorial, and the floating MasterChat widget.
- **Grouped sidebar navigation** - v1.24 moved the crowded top nav into a grouped,
  collapsible left sidebar from user UI feedback. It keeps every panel reachable and
  collapses into a responsive drawer on narrow screens; it is a layout change, not a
  new backend or safety surface.
- **Command palette** - v1.25 adds Cmd-K quick navigation across all shipped views
  and drawers, with fuzzy filtering, keyboard navigation, focus/ARIA handling, and
  responsive behavior. It is navigation-only: commands open views/drawers and do not
  create tasks, change config, or perform hidden mutations.
- **GUI-for-all polish** - v1.30 moves more operator workflows into the dashboard:
  Setup can toggle flag-gated features such as intake, quotas, and node input; batch
  UI polish adds node-list indentation, org task-count badges, per-column "+" add
  buttons, a tutorial refresh, and the GroveMark tree/wordmark logo.
- **Chat-completions facade** - `grove serve` is a local OpenAI-compatible
  `/v1/chat/completions` SSE facade backed by selected grove nodes. It is not the
  dashboard server.
- **Org-chart spawn/up** - create nodes from the CLI or dashboard with role, parent,
  group, agent type, workspace, and model metadata.
- **Direct node communication** - use `grove send`, `grove ask`, tmux capture, or tmux
  input to talk to any visible node across the org. The hierarchy records ownership and
  reporting; it is not a communication firewall.
- **Human-facing lists** - board/task records are for operator TODOs, feedback, and
  human decisions. They are not the required protocol for node-to-node implementation,
  review, or blocker traffic.
- **Task self-status CLI** - v1.31 adds `grove task start|review|done|block|ask-human`
  for updating an existing human-facing item when durable operator-visible state is
  useful.
- **Project room model** - v1.27 makes the dashboard use one active project, one tmux
  session, and one project board. The old board selector is gone; the `"default"` board
  alias resolves to the active project's board. New projects get a `project-master`
  node, and new human-facing item creation uses a required assignee dropdown that
  defaults to it.
  v1.30 adds dashboard project creation, GitHub import through `new-project --clone`,
  and display names such as showing project `dev10` as `grove-dev`.
- **Board query and saved views** - v1.26 adds status/assignee/label filters,
  full-text search over task title/body, pagination, and live board results.
  Operators can save named board views; results are project-scoped, role-aware, and
  redacted.
- **Immortal task board** - v1.29 makes the board render every registered task:
  canonical workflow columns `ready`, `running`, `review`, `blocked`, `ask_human`, and
  `done` are always visible, unknown statuses fall into a catch-all
  column, and completed work remains on the board instead of vanishing.
- **Human item status discipline** - human-facing items can move through ready/start,
  running, review, and done, with blocked/ask-human as explicit side states. v1.31
  standardizes the stored running status as `running` while keeping `in_progress`,
  `claimed`, and `executing` as aliases for old data.
- **GROVE MASTER chat and org** - v1.30 makes `POST /api/master/chat` produce real
  answers from scoped project, org, board, and runtime facts. The org view adds a
  cross-project GROVE MASTER root that opens chat, project lead nodes that switch
  projects, and human-as-node assignment for human-owned work.
- **Web-to-node input** - v1.27 can send a prompt or command from a node's terminal
  panel to that node's tmux pane when `grove-web --enable-node-input` is set. It is
  operator-gated, project/pane allowlisted, rate-limited, sent as literal tmux input,
  and audited with redaction. Backend node flags decide whether a pane is viewable or
  input-capable.
- **Node connect copy** - each terminal panel can fetch `GET /api/nodes/{node}/connect`
  and copy tmux attach/select-pane commands for that node. It exposes connection
  strings only for nodes in the current project scope.
- **Perfect node sync** - v1.28 makes `/api/nodes` and the org chart surface every
  registry/meta node, including `lead` and `project-master`. Nodes without a usable
  pane are shown as unavailable with a reason instead of silently disappearing. v1.29
  adds a tmux/registry reconciler so orphan panes are adopted and dead panes are marked
  rather than hidden.
- **Lead as a real node** - the project lead is a project-scoped real node, such as
  `dev10:0.0`, not a synthetic placeholder. Its terminal can be viewed and, when
  node input is enabled for the operator, addressed like any other live pane.
- **Board card clarity** - board cards show task titles as primary text with long
  titles/summaries wrapping instead of widening columns.
- **Channels and ask-human** - Slack and web chat route to the GROVE MASTER. Human
  decisions can be recorded as ask-human items, but ordinary node communication stays
  direct.
- **Slack bot human channel** - v1.30 improves the Slack panel with usage guidance,
  available commands, intake flow, and Block Kit previews/buttons. Humans can file
  bugs, feedback, ask-human items, or questions from Slack; human-facing item
  registration stays gated/audited, and answer-only replies flow back through Slack
  threads and item comments. `/api/slack/test` is still being upgraded from a stub to
  a real send.
- **Event-driven wait and durable submit** - transcript/event watchers wake waits
  promptly, with deadline-bounded fallbacks so waits do not hang forever. v1.31
  hardens send-to-wait correlation so submitted turns survive crashes and can still be
  matched to durable terminal events.
- **Repair and lifecycle tools** - `repair`, `rebind`, and `despawn` recover stale
  pane bindings, reattach broken transcripts, and tear down nodes safely.
- **Node failure resilience** - v1.31 adds `grove watchdog` for external pane and
  transcript health: rate-limit, usage-limit, login-required, crash/shell-fallback, and
  hung detection. The recovery scheduler is dry-run by default, uses backoff, timer
  re-wake, a staggered one-at-a-time wake queue, and circuit breakers; quorum decisions
  use a decision-ledger with 2/3 approval and idempotent dispatch.
- **Project portability** - `new-project`, `load-project`, `export-project`, and
  `import-project` support local project rooms and portable bundles with machine-local
  paths, sessions, transcripts, and secrets stripped.
- **Dashboard login, setup, and team auth** - onboarding wizard, stable local tokens,
  dashboard login, optional real team auth with server-side sessions, CSRF, member
  roles, logout, display names, and role-gated UI/API.
- **Audit, inbox, presence, notifications** - actor-aware audit events, decision inbox,
  board cursor replay, presence, notification rules, and deduped ask-human/blocked alerts.
- **Notification routing v2** - v1.24 adds conditional routing and escalation for
  blocked, ask-human, and anomaly notifications. New routing is default OFF and dry-run
  by default; configuration is operator-gated, audited, and redacted to avoid surprise
  outbound sends or secret/PII leaks.
- **Routing planner** - `/api/plan` recommends candidate nodes using role, capability,
  load, and cost signals. It never claims, assigns, or spawns by itself.
- **Guarded autonomy** - autonomous pickup and the guarded execution loop are shipped
  but default OFF. Execution requires both gates, an approval step, concurrency 1,
  multi-level kill-switch checks, and prepared dispatch lease validation. v1.29
  supports enabling autopickup across nodes through the global and per-node controls
  when the operator opts in.
- **Slack safety commands** - Slack `status`, `approve`, `abort`, and `killswitch`
  are default OFF, role-gated, preview-then-confirm, one-shot, audited, and redacted.
- **Slack intelligent intake** - v1.20 `--enable-intake` is default OFF. A deterministic,
  no-LLM classifier triages Slack messages into bug, feedback, human-list request,
  question, or command. Bug/feedback/list-item messages produce Block Kit previews and
  only create human-facing items after same-member confirm through the role-gated,
  audited create path; questions route to the GROVE MASTER. Injection-like text falls
  back to question/no task, and the live triage announcement is upserted in place with
  `chat.update`.
- **Slack assistant routing** - v1.21 keeps bounded thread context and answers
  natural-language status questions with Block Kit messages. It can summarize the
  board, blocked items, running items, node status, and usage from project data. Usage
  and ledger answers require operator/admin role; viewer scope is denied instead of
  leaked. Thread follow-ups cannot smuggle task, comment, or unblock mutations.
- **Slack digest and reminders** - v1.25 `--enable-digest` and `--enable-reminders`
  are default OFF. The connector can publish a scheduled board/status digest by
  reusing persisted message timestamps with `chat.update`, and can remind on stale
  blocked or ask-human work. Digest/reminder is notify-only, dry-run by default unless
  `--digest-live` is set, operator-gated, audited, and redacted.
- **Retro analytics insights** - v1.22 `--enable-retro-analytics` is default OFF. The
  self-retro lane and completed task/run history feed advisory cards for throughput,
  allowlisted retro themes, blocked/slow patterns, and neutral node/role outcomes. It
  creates zero actions, tasks, or config changes; operator-only access, project scope,
  redaction, low-confidence labels for small samples, and agy cost unknown are part of
  the contract.
- **Usage trend and anomaly signals** - v1.23 `--enable-usage-trend` is default OFF.
  It rolls measured usage/cost over 7d/14d/30d windows, shows node/day trends,
  deterministic anomaly flags, and a forecast labeled "not a prediction". Signals are
  advisory-only: they never throttle, abort, kill, change quota, or couple to execution
  enforcement. Access is operator-only and project-scoped; thin data is low-confidence,
  and agy cost stays unknown across day totals, trend, forecast, and cost anomalies.
- **Usage and timeline** - `/api/usage` reports run usage by node/day with source and
  warnings; agy cost/credit is reported as unknown when no local source exists, never
  fabricated. Execution timeline shows step and Gantt-style durations from audit data.
- **Signed aggregation** - default OFF multi-machine summaries use HMAC signatures,
  trusted `key_id`s, freshness checks, count allowlists, and no raw task bodies,
  comments, transcripts, paths, tokens, or member PII.
- **Signed cross-room handoff** - default OFF handoff exports signed, privacy-allowlisted
  task packages. The receiver verifies and explicitly accepts locally; the sender never
  creates or executes work remotely.
- **Tailnet shared access** - v1.18 shared access is default OFF and tailnet-scoped:
  peers join with per-user identity, roles, CSRF-protected sessions, and audit. Work
  uses the host machine's local CLI credentials and capacity; it is not public internet
  access and not per-user sandboxing.
- **Per-user ledger and soft quotas** - v1.19 shared-host fairness is default OFF:
  per-member usage rolls up measured runs/tokens/cost, operator-set soft quotas warn
  and queue/throttle instead of hard-killing running work, and host-pressure signals
  show when local capacity is saturated. agy cost stays unknown when no local source exists.
- **Stable Loop release hardening** - v1.31 adds a 2-tier exhaustive verification
  harness: inventory plus oracle registry, isolated seed checks, and thin live
  non-mutating smoke. The stabilization pass fixed 14 safety/runtime bugs across
  path-traversal and flag-injection guards, CSRF, WebSocket scope/lifecycle,
  registry clobbering, viewer permissions, Tier-2 live guards, and board status drift.

## Concepts

```text
grove.yaml / project scaffold
  |
  +-- node: one tmux pane running one agent CLI (codex | claude | agy)
  +-- human node: an assignable person/inbox endpoint for human-owned decisions
  +-- human-facing item: operator TODO, feedback, or ask-human record
  +-- run: execution evidence when an item is deliberately run through an executor
  +-- comment: human answers and durable notes on a human-facing item
  +-- audit event: actor + action + target + timestamp for important mutations
```

The org chart and live panes are the source for who exists, where each node runs, and
how to talk to it. Nodes communicate directly with `grove send`, `grove ask`, tmux
capture, or tmux input. Human-facing list items are durable operator records for TODOs,
feedback, and decisions; a human may reference an item number when instructing the
MASTER or a project lead. Old task statuses still normalize for display so historical
data remains readable.

## Quick start

From the repository:

```bash
pnpm install
pnpm build
node dist/cli.js init
node dist/cli.js up
uv run --project bridge grove-web --port 8765
```

If grove is installed globally or linked, use `grove` in place of `node dist/cli.js`.
The dashboard/API server is the Python bridge console script `grove-web`, declared in
`bridge/pyproject.toml` and backed by `grove_bridge.web_app`.

`grove-web` shows one board per active project. The `"default"` board alias resolves
to that project's board; switching projects switches the board, nodes, and terminal
scope together.

To enable the web terminal's operator-only send box:

```bash
uv run --project bridge grove-web --port 8765 --enable-node-input
```

To expose a local chat facade for tools that speak OpenAI-compatible chat completions:

```bash
node dist/cli.js serve --port 8787
```

For local development, run the full gate before handing off:

```bash
pnpm check
```

`pnpm check` runs Prettier, ESLint, TypeScript typecheck, Vitest, Ruff, Ruff format,
mypy strict, and pytest. Python checks use `uv`.

## Common commands

| command                                  | purpose                                        |
| ---------------------------------------- | ---------------------------------------------- |
| `grove-web [--port 8765]`                | run the dev-room web SPA and dashboard APIs    |
| `grove init`                             | scaffold a starter org chart and protocol docs |
| `grove new-project <name> [--clone url]` | create or clone/import a local project room    |
| `grove load-project <path>`              | load an existing project room                  |
| `grove up [--config f]`                  | start or adopt the tmux org chart              |
| `grove serve [--port 8787]`              | run a local OpenAI-compatible chat facade      |
| `grove status`                           | show node state, liveness, and recent activity |
| `grove watchdog [--execute]`             | inspect health and optionally run one recovery |
| `grove spawn <node>`                     | create a persistent node                       |
| `grove delegate <node> "<title>"`        | legacy alias: create a human-facing item       |
| `grove task start/review/done ...`       | update an existing human-facing item           |
| `grove send <node> "<msg>"`              | send a non-blocking message to a node          |
| `grove wait <node>`                      | wait for the node's current turn to finish     |
| `grove ask <node> "<msg>"`               | send and wait in one command                   |
| `grove tail <node>`                      | follow a node transcript live                  |
| `grove session <node>`                   | print resolved session and transcript metadata |
| `grove repair [--all]`                   | recover stale pane/session bindings            |
| `grove rebind <node>`                    | re-resolve a node's pane/session binding       |
| `grove despawn <node>`                   | safely remove a node pane and registry entry   |
| `grove export-project`                   | write a portable, redacted project bundle      |
| `grove import-project <bundle>`          | recreate a project from a portable bundle      |

## Safety defaults

grove is built for local-first operation. The sharp edges are deliberately opt-in:

- Team auth is optional; loopback use stays frictionless, non-loopback access requires
  explicit auth/bind choices.
- Shared access is default OFF, tailnet-scoped, per-user, role-gated, CSRF-protected,
  and audited.
- Autonomous pickup and guarded execution are default OFF and require explicit gates,
  approval, concurrency 1, kill-switch checks, and prepared dispatch validation.
- Watchdog recovery is not an always-on restart loop. `grove watchdog` observes pane
  and transcript health and plans recovery in dry-run mode by default; `--execute`
  performs at most one due action under backoff, timer re-wake, global staggering,
  CAS locks, and circuit breakers. Login-required states stay manual.
- Triumvirate decisions use the board decision-ledger with 2/3 quorum, authenticated
  voter identity, idempotency keys, and dispatch locks so a repeated request cannot
  impersonate a voter or double-dispatch.
- Stable Loop live checks are guarded and non-mutating where they touch a real room.
  The v1.31 two-tier harness keeps isolated seed tests separate from thin live smoke so
  exhaustive verification does not mutate an operator's active project by accident.
- The v1.24 left sidebar is a layout-only navigation change; the responsive drawer does
  not add a backend mutation or safety surface.
- The v1.25 command palette is navigation-only. Cmd-K opens views/drawers or routes to
  existing gated UI; it does not create tasks, update config, send Slack messages, or
  bypass confirmations.
- GUI feature toggles in Setup are operator-gated, persisted controls for existing
  flag-gated features. They do not bypass the underlying backend gates, make
  default-off integrations live without explicit enablement, or grant viewer users
  operator powers.
- GROVE MASTER chat is project-scoped, role-aware, and audited with message hashes and
  redacted metadata. It can answer from scoped project/org/board/runtime facts and can
  act when the operator explicitly instructs it through the appropriate path.
- Board query/search is deterministic, paginated, project-scoped, role-aware, and
  redacted. Missing boards or saved views return clear 404s; dev-room board access
  stays inside the owning project and rejects cross-project board IDs. Saving or
  deleting named views is the audited exception.
- The v1.29 board model is "registered tasks do not disappear." Every status renders
  into a canonical column or catch-all, `done` stays visible, and terminal task buckets
  are limited to done/deleted/cancelled/deferred in the product model. Deletion is
  admin-only soft-delete when exposed; no hard-delete path is part of normal task flow.
- The canonical in-progress task status is `running`, labeled "In Progress" in the UI.
  Legacy `in_progress`, `claimed`, and `executing` values normalize to `running` at the
  store/API/UI boundary so old tasks remain visible and movable.
- Manual task status and reviewer changes are board mutations. They require the same
  operator/admin state-change gate, project scope, CSRF/Origin protections, and audit
  trail as other dashboard mutations; virtual states such as `ask_human` are display
  states, not hidden alternate stores.
- `grove task` status updates use the local `grove-web` board API and should be treated
  as durable human-facing item mutations. Use `--from-status` and `--idempotency-key`
  for stale or repeated updates; non-loopback dashboard URLs require explicit remote
  opt-in.
- The dashboard follows a 1:1:1 project model: one project, one tmux session, one
  board. The `"default"` alias resolves to the active project board, not a global
  board picker. New task forms require choosing an assignee from project candidates;
  unknown assignees are omitted rather than accepted as free text.
- Dashboard login uses server-side sessions when team auth is enabled. Project
  creation, GitHub import, and display-name changes are project lifecycle operations
  that remain role-gated and audited; display names are labels, not authority or
  project identity.
- Web-to-node input is default OFF (`--enable-node-input`). When enabled, sends require
  operator/admin role, project-scoped pane allowlisting, rate limiting, literal tmux
  input (`send-keys -l`), and audit/redaction; viewers can still watch terminals but
  cannot send. MASTER/lead panes are live panes and can be addressed when input is
  enabled and authorized.
- Node connect commands are project-scoped. `GET /api/nodes/{node}/connect` returns
  attach/select-pane strings for an authorized node; it does not expose tokens or grant
  extra tmux privileges.
- Node lists do not hide failures. `/api/nodes` and the org chart include unexposed
  nodes with `exposed=false` and an unavailable reason, while omitting token, key, and
  raw path fields.
- Notification routing v2 is default OFF and dry-run by default. Operator-gated config
  and audit are required before routing/escalation can move beyond simulation, and
  payloads stay redacted.
- Slack safety commands are default OFF and require role-gated preview/confirm.
- Slack bot UX improvements are communication surface, not a new mutation bypass.
  Block Kit intake/item previews, ask-human replies, and thread answers reuse the
  same role, project-scope, confirmation, audit, and redaction rules as the existing
  Slack connector. `/api/slack/test` should still be treated as incomplete until the
  real-send upgrade lands.
- Slack intelligent intake is default OFF (`--enable-intake`) and no-LLM. It can propose
  bug/feedback/ask-human item previews, but confirmed item registration is role-gated
  and audited; viewer or unmapped users cannot create items. Questions route to the
  GROVE MASTER, and injection-like text falls back to plain chat/no item.
- Slack assistant routing also requires `--enable-intake`. Natural-language answers are
  project-scoped and redacted; usage/ledger detail is denied unless the Slack member is
  operator/admin, and bounded thread context cannot create hidden mutations.
- Slack digest/reminder is default OFF (`--enable-digest` / `--enable-reminders`) and
  dry-run by default. Live posting requires explicit `--digest-live`; config is
  operator-gated, audited, redacted, and notify-only.
- Retro analytics is default OFF (`--enable-retro-analytics`), operator-only,
  project-scoped, redacted, and advisory-only. It reads retros and completed work but
  performs no action, task creation, or config change; small samples are low-confidence
  and agy cost remains unknown unless locally sourced.
- Usage trend/anomaly is default OFF (`--enable-usage-trend`), operator-only,
  project-scoped, redacted, and advisory-only. Anomaly and forecast signals never
  throttle, abort, kill, change quota, or call execution enforcement; the forecast is
  labeled not a prediction, thin data is low-confidence, and agy cost stays unknown
  instead of becoming a cost anomaly.
- Multi-machine aggregation is non-mutating and default OFF.
- Cross-room handoff is data transfer only and default OFF; receiver-local accept is
  required before any task is created.
- Cost numbers are source-tagged. agy credit/cost is unknown unless locally available;
  grove does not invent estimates.
- Per-user resource ledgers and quotas are default OFF, project-scoped, role-gated,
  and audited. Operators/admins configure quotas; viewers are observer-only. Quota
  pressure is soft by default: warn, queue, or slow new work, but do not kill running tasks.
- The dashboard and APIs are served by `grove-web`, not `grove serve`. Tailnet
  shared-access belongs to `grove-web --shared-access --allow-host <host>`.

## Security notes

- Tokens, member registries, project state, stable dashboard tokens, and signing keys
  live outside git under local state directories.
- Sensitive files are written with restrictive permissions; signing keys are created
  race-safely and stored `0600`.
- Signed summaries and handoffs expose `key_id`, never the secret key.
- API responses and task metadata redact tokens, common secret formats, absolute paths,
  email PII where relevant, and raw execution details on safety surfaces.
- Non-loopback bearer-token egress is guarded; remote URLs require explicit opt-in where
  supported.

## License

MIT
