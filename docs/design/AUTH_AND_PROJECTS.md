# Auth And Project Lifecycle

Status: phase 1 draft. This document defines the v1.28 dashboard login and
project lifecycle track. Phase 1 is design and new-module scaffolding only:

- no `web_app.py` route registration;
- no `app.tsx` or frontend core wiring;
- no replacement of the current v1.27 `/api/nodes/{node}/connect` behavior;
- no mutation outside the requested bridge auth interface scaffold.

## Goals

v1.28 replaces injected dashboard tokens with account-backed sessions, keeps the
dashboard access model centered on `operator` and `viewer`, and makes the
dashboard safe to share on a tailnet or trusted LAN. An `admin` role may exist
for account/session administration, but normal project, node, board, and task
mutation should only need operator authority. It also makes projects a
first-class lifecycle unit: one project owns one tmux session and one board, and
project creation always gives that project a `project-master` entry.

The intended product invariant is:

```text
project name == tmux session name == board slug
```

That 1:1:1 mapping keeps routing, audit, board filtering, project switching, and
tmux connect affordances predictable.

## Auth Model

The injected-token model is local-machine bootstrap behavior. It is convenient
for loopback use, but it is a poor fit for shared tailnet rooms because a static
token can leak through page source, logs, browser extensions, or copied URLs.
The replacement model is account login plus server-issued sessions.

Phase 1 auth terms:

- **account**: a durable dashboard identity with display name, role, and enabled
  state;
- **session**: an opaque server-issued browser session bound to one account and
  expiry time;
- **actor**: the request-time identity derived from a valid session;
- **role**: `viewer`, `operator`, or `admin` for dashboard authorization.

The bridge should normalize request authorization to permissions instead of
route-local role checks. Existing lower-level primitives may keep compatibility
fields while migration is in progress, but dashboard policy should ask whether
the actor has a named permission. Viewers may read visible project, board, task,
node, terminal, and connect metadata. Operators may mutate projects, boards,
tasks, nodes, node input, quota, and operator-only reporting after Origin, Host,
and CSRF checks pass. Admins inherit operator authority and add account/session
management.

Initial permission buckets:

- viewer: project/board/task/node/terminal/connect read;
- operator: viewer reads plus project/board/task/node mutation, node input,
  audit read, cost read, and quota mutation;
- admin: operator permissions plus account/session management.

### Session Contract

The future router layer should expose these logical operations:

- login with account credentials or a one-time join code;
- issue an HttpOnly session cookie plus CSRF token;
- verify session cookies on API and websocket upgrade paths;
- return `/me` account and role metadata;
- revoke a session on logout;
- expire sessions automatically and deny disabled accounts.

Sessions should be opaque to the browser. The frontend must not receive a
dashboard bearer token in HTML, JavaScript globals, query strings, or local
storage. Non-mutating requests authenticate with the session cookie. Mutating
requests also send the CSRF token header.

Password and session secrets stay behind interfaces. Account payloads must not
carry password hashes, raw passwords, cookie values, CSRF values, or session
signing secrets. Password hashes are modeled as redacted metadata only, with
hashing and verification delegated to a `PasswordHasher`/credential verifier
boundary. Session cookie encoding/decoding is delegated to a session manager or
token codec boundary; the route layer writes cookies later.

Cookie defaults:

- `HttpOnly`;
- `SameSite=Lax`;
- path scoped to the dashboard;
- `Secure` when served over HTTPS;
- finite TTL with server-side revocation.

### Tailnet Multiuser Compatibility

Shared dashboard serving is allowed only when host binding is explicit and the
operator configures trusted hosts. A tailnet room should therefore use:

- explicit bind host or wildcard bind with `--allow-host`;
- no HTML token bootstrap on non-loopback hosts;
- account sessions and CSRF for all users;
- per-user audit actors rather than a shared `lead` identity;
- presence derived from active sessions, not from anonymous browser tabs.

Join links or one-time codes may be used for onboarding, but the resulting
identity is still an account/session pair. Join-code default role should remain
operator only when the operator explicitly chooses that behavior; viewer is the
safer default for broad sharing.

## Project Lifecycle

Project creation is an operator-only mutation. The future lifecycle service
should validate the requested project name once, then create or verify these
resources as one idempotent unit:

1. `grove new-project <name> --json` creates the workspace and tmux session.
2. The board store creates or adopts board slug `<name>`.
3. The project registry contains a `project-master` node.
4. Dashboard project metadata reports the same project/session/board identity.

The project must not be partially visible as a normal ready project until the
lifecycle result can report all three resources. If tmux creation succeeds but
board creation fails, the response should surface a repairable degraded state
and include the exact missing resource. Follow-up repair should be explicit and
audited.

The auth-side lifecycle contract is represented as a `ProjectIdentity` decision:
`project`, `session`, and `board` must be non-empty and equal before a lifecycle
mutation is authorized. A valid identity is still necessary but not sufficient:
the actor must also have project mutation permission. The auth module does not
create projects, boards, sessions, panes, or registry entries.

### Project-Master

Each project has one default orchestrator target named `project-master`. It is
the default assignee for newly created project tasks and the stable place for
project-level questions, setup work, and coordination.

Phase 1 does not decide whether `project-master` is created as a live spawned
tmux pane immediately or as an external registry entry that can be materialized
later. The lifecycle contract requires the dashboard and board APIs to see
exactly one `project-master` identity for the project.

### Audit

Project lifecycle audit events should include:

- actor id and role;
- requested project name;
- resulting project/session/board slug;
- lifecycle step outcomes;
- default assignee;
- degraded or repair-needed reason when applicable.

The audit payload must not include dashboard cookies, CSRF values, join codes,
or account secrets.

## Dashboard Tmux Connect Surface

The project dashboard should show tmux connection metadata at two levels:

- **project/session level**: tmux session name, board slug, workspace path when
  safe to expose, tmux attach command, and SSH attach command;
- **node/pane level**: reuse v1.27 `/api/nodes/{node}/connect` for pane-specific
  attach/select commands.

Project-level copy commands should be generated server-side from trusted
configuration and shell-escaped inputs. The bridge should not guess public host
names. Operators configure a host alias for SSH/tailnet sharing, and the UI only
copies commands returned by the bridge.

Recommended command payload shape:

```json
{
  "project": "alpha",
  "session": "alpha",
  "board": "alpha",
  "commands": {
    "tmux_attach": "tmux attach -t alpha",
    "tmux_list_windows": "tmux list-windows -t alpha",
    "ssh_attach": "ssh dev-host -t 'tmux attach -t alpha'",
    "iterm_attach": "osascript -e 'tell application \"iTerm\" to create window with default profile command \"tmux attach -t alpha\"'"
  }
}
```

Viewers may copy read-only connect commands, but only operators may use web
input controls that send text into a pane. Node-level connect controls should
continue to call `/api/nodes/{node}/connect`; v1.28 should not fork that route.

## Bridge Boundary

The phase-1 bridge module, `grove_bridge.auth`, defines typed auth interfaces
and pure authorization helpers only. It should model:

- account identity and dashboard role;
- login credentials and login result;
- non-exception login outcomes for unknown account, disabled account, and invalid
  credentials;
- password hash redaction and password/session secret boundaries;
- session issuance, verification, and revocation;
- request actor context;
- protocol boundaries for account and session stores;
- permission decisions for role-gated access;
- project lifecycle authorization for the 1:1:1 project/session/board identity.

The module must not register FastAPI routes, write cookies, read account files,
mutate the existing team-auth store, create projects, create boards, spawn
nodes, or call tmux. Those actions belong to later router/service layers after
this contract is reviewed.

## Non-Goals

- public internet exposure without a separate security review;
- replacing v1.27 node connect routes;
- changing `web_app.py` or `app.tsx` in this phase;
- hard per-user OS sandboxing;
- storing raw credentials or session secrets in audit events;
- allowing viewers to mutate projects, boards, nodes, or terminal input.
