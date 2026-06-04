# grove

**A standalone, self-contained dev-room / team-OS for real CLI agents.**

grove runs a tree of `codex`, `claude`, and `agy` CLI sessions in tmux, then gives the
team one web cockpit: a kanban board, channels, live terminal panes, decision inbox,
audit lane, usage reporting, and safety controls. Every agent you see is a real,
viewable, talk-to-able terminal session, not an invisible runtime.

```bash
grove up                         # start the org chart in tmux
grove-web --port 8765            # open the dev-room web SPA + dashboard APIs
grove serve --port 8787          # optional local OpenAI-compatible chat facade
grove delegate maker-1 "Fix auth retry handling" --body "Add tests and report risks."
grove ask reviewer "Review the current diff"
grove repair --all
```

## What ships today

- **Real tmux agent tree** - bring up an org chart of `codex`, `claude`, and `agy`
  nodes; each node is a live tmux pane with adapter-specific turn detection.
- **Web dev-room SPA** - `grove-web` serves the board, org chart, live terminal
  viewer, project switcher, auth/status panels, audit drawer, cost/usage views,
  execution timeline, aggregation, and handoff surfaces.
- **Grouped sidebar navigation** - v1.24 moved the crowded top nav into a grouped,
  collapsible left sidebar from user UI feedback. It keeps every panel reachable and
  collapses into a responsive drawer on narrow screens; it is a layout change, not a
  new backend or safety surface.
- **Chat-completions facade** - `grove serve` is a local OpenAI-compatible
  `/v1/chat/completions` SSE facade backed by selected grove nodes. It is not the
  dashboard server.
- **Org-chart spawn/up** - create nodes from the CLI or dashboard with role, parent,
  group, agent type, workspace, and model metadata.
- **Board-based delegation** - `grove delegate <node> "<title>"` creates an assigned
  board task; the pull executor claims it and runs it in the target real session.
- **Channels and ask-human** - Slack integration and web/chat paths route work and
  human decisions through grove tasks, comments, and unblock flows.
- **Event-driven turn detection** - transcript/event watchers wake waits promptly,
  with deadline-bounded fallbacks so waits do not hang forever.
- **Repair and lifecycle tools** - `repair`, `rebind`, and `despawn` recover stale
  pane bindings, reattach broken transcripts, and tear down nodes safely.
- **Project portability** - `new-project`, `load-project`, `export-project`, and
  `import-project` support local project rooms and portable bundles with machine-local
  paths, sessions, transcripts, and secrets stripped.
- **Onboarding and team auth** - onboarding wizard, stable local tokens, optional real
  team auth with server-side sessions, CSRF, member roles, logout, and role-gated UI/API.
- **Audit, inbox, presence, notifications** - actor-aware audit events, decision inbox,
  board cursor replay, presence, notification rules, and deduped ask-human/blocked alerts.
- **Notification routing v2** - v1.24 adds conditional routing and escalation for
  blocked, ask-human, and anomaly notifications. New routing is default OFF and dry-run
  by default; configuration is operator-gated, audited, and redacted to avoid surprise
  outbound sends or secret/PII leaks.
- **Routing planner** - read-only `/api/plan` recommends candidate nodes using role,
  capability, load, and cost signals. It never claims, delegates, or spawns by itself.
- **Guarded autonomy** - autonomous pickup and the guarded execution loop are shipped
  but default OFF. Execution requires both gates, an approval step, concurrency 1,
  multi-level kill-switch checks, and prepared dispatch lease validation.
- **Slack safety commands** - Slack `status`, `approve`, `abort`, and `killswitch`
  are default OFF, role-gated, preview-then-confirm, one-shot, audited, and redacted.
- **Slack intelligent intake** - v1.20 `--enable-intake` is default OFF. A deterministic,
  no-LLM classifier triages Slack messages into bug, feedback, task request, question,
  or command. Bug/feedback/task messages produce Block Kit previews and only create
  board tasks after same-member confirm through the role-gated, audited task-create
  path; questions stay on the read-only answer path. Injection-like text falls back to
  question/no task, and the live triage announcement is upserted in place with
  `chat.update`.
- **Slack read-only assistant** - v1.21 keeps bounded thread context and answers
  deterministic, no-LLM natural-language status questions with Block Kit messages.
  It can summarize the board, blocked tasks, running tasks, node status, and usage
  from read-only board/run data. Usage and ledger answers require operator/admin role;
  viewer scope is denied instead of leaked. Thread follow-ups cannot smuggle task,
  comment, or unblock mutations.
- **Retro analytics insights** - v1.22 `--enable-retro-analytics` is default OFF. The
  self-retro lane and completed task/run history feed read-only advisory cards for
  throughput, allowlisted retro themes, blocked/slow patterns, and neutral node/role
  outcomes. It creates zero actions, tasks, or config changes; operator-only access,
  project scope, redaction, low-confidence labels for small samples, and agy cost
  unknown are part of the contract.
- **Usage trend and anomaly signals** - v1.23 `--enable-usage-trend` is default OFF.
  It rolls measured usage/cost over 7d/14d/30d windows, shows node/day trends,
  deterministic anomaly flags, and a forecast labeled "not a prediction". Signals are
  advisory-only: they never throttle, abort, kill, change quota, or couple to execution
  enforcement. Access is operator-only and project-scoped; thin data is low-confidence,
  and agy cost stays unknown across day totals, trend, forecast, and cost anomalies.
- **Usage and timeline** - `/api/usage` reports run usage by node/day with source and
  warnings; agy cost/credit is reported as unknown when no local source exists, never
  fabricated. Execution timeline shows step and Gantt-style durations from audit data.
- **Signed read-only aggregation** - default OFF multi-machine summaries use HMAC
  signatures, trusted `key_id`s, freshness checks, count allowlists, and no raw task
  bodies, comments, transcripts, paths, tokens, or member PII.
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

## Concepts

```text
grove.yaml / project scaffold
  |
  +-- node: one tmux pane running one agent CLI (codex | claude | agy)
  +-- board task: the delegation protocol between humans, leads, and nodes
  +-- run: a claimed task executed in a real session
  +-- comment: task discussion, human answers, and execution notes
  +-- audit event: actor + action + target + timestamp for important mutations
```

The board is the source of truth for delegated work. Orchestrators assign by creating
tasks; executors claim, heartbeat, complete, block, unblock, and comment. The dashboard
is a cockpit over that same state, plus live terminals for the actual sessions.

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

| command                           | purpose                                        |
| --------------------------------- | ---------------------------------------------- |
| `grove-web [--port 8765]`         | run the dev-room web SPA and dashboard APIs    |
| `grove init`                      | scaffold a starter org chart and protocol docs |
| `grove new-project <name>`        | create a local project room                    |
| `grove load-project <path>`       | load an existing project room                  |
| `grove up [--config f]`           | start or adopt the tmux org chart              |
| `grove serve [--port 8787]`       | run a local OpenAI-compatible chat facade      |
| `grove status`                    | show node state, liveness, and recent activity |
| `grove spawn <node>`              | create a persistent node                       |
| `grove delegate <node> "<title>"` | create an assigned board task                  |
| `grove send <node> "<msg>"`       | send a non-blocking message to a node          |
| `grove wait <node>`               | wait for the node's current turn to finish     |
| `grove ask <node> "<msg>"`        | send and wait in one command                   |
| `grove tail <node>`               | follow a node transcript live                  |
| `grove session <node>`            | print resolved session and transcript metadata |
| `grove repair [--all]`            | recover stale pane/session bindings            |
| `grove rebind <node>`             | re-resolve a node's pane/session binding       |
| `grove despawn <node>`            | safely remove a node pane and registry entry   |
| `grove export-project`            | write a portable, redacted project bundle      |
| `grove import-project <bundle>`   | recreate a project from a portable bundle      |

## Safety defaults

grove is built for local-first operation. The sharp edges are deliberately opt-in:

- Team auth is optional; loopback use stays frictionless, non-loopback access requires
  explicit auth/bind choices.
- Shared access is default OFF, tailnet-scoped, per-user, role-gated, CSRF-protected,
  and audited.
- Autonomous pickup and guarded execution are default OFF and require explicit gates,
  approval, concurrency 1, kill-switch checks, and prepared dispatch validation.
- The v1.24 left sidebar is a layout-only navigation change; the responsive drawer does
  not add a backend mutation or safety surface.
- Notification routing v2 is default OFF and dry-run by default. Operator-gated config
  and audit are required before routing/escalation can move beyond simulation, and
  payloads stay redacted.
- Slack safety commands are default OFF and require role-gated preview/confirm.
- Slack intelligent intake is default OFF (`--enable-intake`) and no-LLM. It can propose
  bug/feedback/task previews, but confirmed task creation is role-gated and audited;
  viewer or unmapped users cannot create tasks. Question handling is read-only, and
  injection-like text falls back to no task.
- Slack read-only assistant also requires `--enable-intake`. Natural-language answers are
  deterministic, project-scoped, redacted, and read-only; usage/ledger detail is denied
  unless the Slack member is operator/admin, and bounded thread context cannot create
  hidden mutations.
- Retro analytics is default OFF (`--enable-retro-analytics`), operator-only,
  project-scoped, redacted, and advisory-only. It reads retros and completed work but
  performs no action, task creation, or config change; small samples are low-confidence
  and agy cost remains unknown unless locally sourced.
- Usage trend/anomaly is default OFF (`--enable-usage-trend`), operator-only,
  project-scoped, redacted, read-only, and advisory-only. Anomaly and forecast signals
  never throttle, abort, kill, change quota, or call execution enforcement; the forecast
  is labeled not a prediction, thin data is low-confidence, and agy cost stays unknown
  instead of becoming a cost anomaly.
- Multi-machine aggregation is read-only and default OFF.
- Cross-room handoff is data transfer only and default OFF; receiver-local accept is
  required before any task is created.
- Cost numbers are source-tagged. agy credit/cost is unknown unless locally available;
  grove does not invent estimates.
- Per-user resource ledgers and quotas are default OFF, project-scoped, role-gated,
  and audited. Operators/admins configure quotas; viewers remain read-only. Quota
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
