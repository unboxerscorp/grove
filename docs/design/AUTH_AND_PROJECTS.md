# Auth And Project Lifecycle

Status: current v2 live auth and project lifecycle model.

This document describes the live dashboard auth, shared access, and project
lifecycle contract. It supersedes the earlier scaffold note.

Team-auth mode is implemented in the bridge and web UI.
Shared access is implemented as default-off one-time join codes.
Project lifecycle mutations are routed through operator-checked bridge/API
paths.

## Goals

The auth model keeps the dashboard usable on loopback while allowing a safer
tailnet or trusted-LAN room when the operator explicitly enables it.

The live contract is:

- loopback/local mode may use the injected session token bootstrap;
- team-auth mode uses account-backed sessions, HttpOnly cookies, and CSRF for
  state-changing requests;
- shared access is default OFF and must be explicitly enabled;
- project, node, human-facing list item, terminal input, quota, and sharing
  mutations require operator authority;
- viewer sessions may inspect visible project, list item, node, terminal, and
  connect metadata but cannot send pane input or mutate state;
- project creation creates or verifies a concrete project lead node with an
  explicit cwd and tmux placement;
- the current model does not synthesize `project-master` identities.

An `admin` role may exist for account/session administration. Normal project,
node, list item, and terminal control should only need operator authority.

## Project Invariants

Each project is a first-class lifecycle unit:

```text
project name == human-facing list backing slug
project workspace/cwd is explicit
tmux host session may be shared, e.g. dev10
```

The project/list mapping keeps audit, list filtering, and project switching
predictable. The tmux session is operational placement metadata; on the current
Mac mini deployment multiple projects may place panes in the single `dev10`
session while still preserving per-project cwd and registry ownership.

Project creation is an operator-only mutation. It should create or verify these
resources as one idempotent unit:

1. `grove new-project <name> --json` creates or verifies the workspace and
   project registry.
2. The list store creates or adopts the backing slug `<name>`.
3. The project registry contains one concrete lead node, normally named `lead`,
   with `cwd` set to the project workspace and panes placed in the configured
   host tmux session.
4. Dashboard project metadata reports project, workspace, list slug, tmux host
   session, and lead node identity.

The project must not be shown as a normal ready project until the lifecycle
result can report these resources. If tmux pane creation succeeds but
list/registry creation fails, the response should surface a repairable degraded
state and include the exact missing resource. Follow-up repair must be explicit
and audited.

Current live `dev10` uses `grove-master` as the global master and project-level
direct operator. New project scaffolds create a concrete `lead` node rather than
a synthetic `project-master`.

## Auth Modes

### Local Token Mode

The injected-token model is local-machine bootstrap behavior. It remains useful
for loopback and operator-owned local development, but it is not the preferred
model for shared tailnet rooms because a static token can leak through page
source, logs, browser extensions, or copied URLs.

Local mode should stay explicit and visibly marked as local in the UI.

### Team-Auth Mode

Team-auth mode uses account-backed sessions:

- **account**: durable dashboard identity with display name, role, and enabled
  state;
- **session**: opaque browser session bound to one account and expiry time;
- **actor**: request-time identity derived from a valid session;
- **role**: `viewer`, `operator`, or `admin`;
- **csrf**: per-session token required for state-changing dashboard requests.

The bridge exposes and tests the live auth endpoints:

- `POST /api/login`;
- `POST /api/logout`;
- `GET /api/me`;
- `GET /api/csrf`;
- `POST /api/share` when shared access is enabled;
- `POST /api/join` when shared access is enabled.

The frontend consumes `/api/me`, stores the returned CSRF token in memory, sends
the CSRF header for mutating requests, gates operator-only controls, and strips
one-time join codes from URLs after reading them.

Sessions are opaque to the browser. The frontend must not receive password
hashes, raw passwords, cookie values, session signing secrets, or unredacted
join secrets. Cookie defaults should be:

- `HttpOnly`;
- `SameSite=Lax`;
- path scoped to the dashboard;
- `Secure` when served over HTTPS;
- finite TTL with server-side revocation.

## Permissions

The bridge normalizes authorization to permissions rather than route-local ad
hoc role checks.

Initial permission buckets:

- viewer: project/list item/node/terminal/connect read;
- operator: viewer reads plus project/list item/node mutation, node input, audit
  read, cost read, quota mutation, project lifecycle, and share-code issuance;
- admin: operator permissions plus account/session management.

Mutating routes must check the authenticated actor and CSRF. Factual
master-chat turns may be allowed without CSRF after authentication, but
action-confirming master-chat turns require the same CSRF boundary as other
state changes.

Viewer sessions must not:

- create projects;
- create, approve, abort, or mutate human-facing list items;
- send terminal input;
- mint share codes;
- mutate GUI features, quota, routing, or other operator-only settings.

## Shared Access

Shared access is default OFF. When enabled, `POST /api/share` mints a one-time
join code and share URL for an authenticated operator. `POST /api/join`
exchanges a valid code plus display name for a member session.

Shared access rules:

- remote non-loopback bind requires explicit trusted `--allow-host`;
- `GET /api/share` does not mint codes;
- share issuance requires operator role and CSRF;
- join codes are one-time and expiring;
- join-code default role is operator only when the operator explicitly chooses
  that mode; viewer is safer for broad sharing;
- `admin` join role should be treated as a high-risk explicit configuration;
- share URLs must not expose secret material after the UI captures the code;
- joined members use the same project, node, terminal, and list authorization
  policy as other sessions.

Presence should derive from active sessions, not anonymous browser tabs.

## Dashboard Tmux Connect Surface

The dashboard exposes tmux connection metadata at two levels:

- **project/session level**: tmux session name, list backing slug, workspace path
  when safe to expose, tmux attach command, and SSH attach command;
- **node/pane level**: `/api/nodes/{node}/connect` returns pane-specific
  attach/select commands.

Project-level and node-level commands are generated server-side from trusted
configuration and shell-escaped inputs. The bridge should not guess public host
names. Operators configure a host alias for SSH/tailnet sharing; when a node
does not have `connect_host`, the bridge may fall back to the first trusted
non-loopback web `allowed_hosts` entry.

Recommended command payload shape:

```json
{
  "project": "alpha",
  "session": "dev10",
  "list_slug": "alpha",
  "workspace": "/repo/alpha",
  "commands": {
    "tmux_attach": "tmux attach -t dev10",
    "tmux_list_windows": "tmux list-windows -t dev10",
    "ssh_attach": "ssh dev-host -t 'tmux attach -t dev10'",
    "iterm_attach": "osascript -e 'tell application \"iTerm\" to create window with default profile command \"tmux attach -t dev10\"'"
  }
}
```

Viewers may copy connect commands, but only operators may use web controls that
send text into a pane.

## Bridge Boundary

The bridge owns:

- account/session primitives and redaction boundaries in `grove_bridge.auth`;
- route-level auth and CSRF enforcement in the web app;
- shared access join-code issuance and exchange;
- project lifecycle authorization;
- node connect metadata generation;
- audit actor attribution for authenticated actions;
- secret-free payloads for browser and Slack surfaces.

The frontend owns:

- displaying whether the dashboard is local or secured;
- loading `/api/me` and remembering CSRF in memory;
- hiding or disabling operator-only controls for viewers;
- join-code capture and URL scrubbing;
- presenting connect/share/join flows without treating secrets as durable UI
  state.

The CLI and project registry own concrete project creation, workspace/cwd, and
node placement. The auth layer authorizes lifecycle mutations; it does not
invent hidden projects, synthesize `project-master`, or bypass operator-owned
org changes.

## Audit

Project lifecycle and auth-sensitive audit events should include:

- actor id, login, and role;
- requested project name;
- resulting project/workspace/list slug and tmux host session;
- lifecycle step outcomes;
- default assignee or lead node;
- degraded or repair-needed reason when applicable;
- share/join actor metadata without raw join secrets.

Audit payloads must not include dashboard cookies, CSRF values, join codes,
password hashes, raw credentials, session signing secrets, or unredacted
transcripts.

## Non-Goals

- public internet exposure without a separate security review;
- hard per-user OS sandboxing;
- allowing viewers to mutate projects, human-facing list items, nodes, or
  terminal input;
- storing raw credentials, session cookies, CSRF tokens, or join codes in audit
  events;
- synthetic `project-master` defaults in the current model;
- autonomous org creation/deletion without explicit operator instruction.
