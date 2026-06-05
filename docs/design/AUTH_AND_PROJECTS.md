# Auth And Project Lifecycle

Status: phase 1 draft, updated for the current v2 direct-org model. This
document defines the dashboard login and project lifecycle track. Phase 1 is
design and new-module scaffolding only:

- no `web_app.py` route registration;
- no `app.tsx` or frontend core wiring;
- no replacement of the current v1.27 `/api/nodes/{node}/connect` behavior;
- no mutation outside the requested bridge auth interface scaffold.

## Goals

The auth track replaces injected dashboard tokens with account-backed sessions, keeps the
dashboard access model centered on `operator` and `viewer`, and makes the
dashboard safe to share on a tailnet or trusted LAN. An `admin` role may exist
for account/session administration, but normal project, node, human-facing list,
and node mutation should only need operator authority. It also makes projects a
first-class lifecycle unit: one project owns one workspace/cwd and one
human-facing list backing slug, and project creation creates a concrete project
lead node in that workspace. There is no synthetic `project-master` identity in
the current model.

The intended product invariant is:

```text
project name == human-facing list backing slug
project workspace/cwd is explicit
tmux host session may be shared, e.g. dev10
```

The project/list mapping keeps audit, list filtering, and project switching
predictable. The tmux session is operational placement metadata; on the current
Mac mini deployment multiple projects may place panes in the single `dev10`
session while still preserving per-project cwd and registry ownership.

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
the actor has a named permission. Viewers may read visible project, list item,
node, terminal, and connect metadata. Operators may mutate projects, list items,
nodes, node input, quota, and operator-only reporting after Origin, Host, and
CSRF checks pass. Admins inherit operator authority and add account/session
management.

Initial permission buckets:

- viewer: project/list item/node/terminal/connect read;
- operator: viewer reads plus project/list item/node mutation, node input,
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
should validate the requested project name and workspace once, then create or
verify these resources as one idempotent unit:

1. `grove new-project <name> --json` creates or verifies the workspace and
   project registry.
2. The list store creates or adopts the backing slug `<name>`.
3. The project registry contains one concrete lead node, normally named `lead`,
   with `cwd` set to the project workspace and panes placed in the configured
   host tmux session.
4. Dashboard project metadata reports project, workspace, list slug, tmux host
   session, and lead node identity.

The project must not be partially visible as a normal ready project until the
lifecycle result can report these resources. If tmux pane creation succeeds but
list/registry creation fails, the response should surface a repairable degraded
state and include the exact missing resource. Follow-up repair should be
explicit and audited.

The auth-side lifecycle contract is represented as a `ProjectIdentity` decision:
`project`, `workspace`, `list_slug`, and `tmux_session` must be non-empty and
internally consistent before a lifecycle mutation is authorized. A valid
identity is still necessary but not sufficient: the actor must also have project
mutation permission. The auth module does not create projects, list items,
sessions, panes, or registry entries.

### Project Lead

Each project has one default lead node. It is the default direct-contact target
for project-level questions, setup work, and coordination, and it may also be
the default assignee for newly created human-facing list items when the operator
chooses that project.

The lifecycle contract requires dashboard and list APIs to see exactly one
default project lead identity for the project. Current live dev10 uses
`grove-master` as the global master and project-level direct operator, while new
project scaffolds create a concrete `lead` node rather than a synthetic
`project-master`.

### Audit

Project lifecycle audit events should include:

- actor id and role;
- requested project name;
- resulting project/workspace/list slug and tmux host session;
- lifecycle step outcomes;
- default assignee;
- degraded or repair-needed reason when applicable.

The audit payload must not include dashboard cookies, CSRF values, join codes,
or account secrets.

## Dashboard Tmux Connect Surface

The project dashboard should show tmux connection metadata at two levels:

- **project/session level**: tmux session name, list backing slug, workspace path
  when safe to expose, tmux attach command, and SSH attach command;
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
- project lifecycle authorization for the project/workspace/list/tmux identity.

The module must not register FastAPI routes, write cookies, read account files,
mutate the existing team-auth store, create projects, create list backing
records, spawn nodes, or call tmux. Those actions belong to later router/service
layers after this contract is reviewed.

## Non-Goals

- public internet exposure without a separate security review;
- replacing v1.27 node connect routes;
- changing `web_app.py` or `app.tsx` in this phase;
- hard per-user OS sandboxing;
- storing raw credentials or session secrets in audit events;
- allowing viewers to mutate projects, human-facing list items, nodes, or
  terminal input.
