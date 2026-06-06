# Node Addressing & Namespace Cleanup (design)

Status: DESIGN (design-only). No code. Requested by the operator via grove-master,
under grove-dev lead. Owner: org-worker. Reports to lead. Implementation waits
for lead approval of the Open Decisions below.

## Problem

Multiple projects now run at once (`grove org --all`). Every project reuses the
same **local** names (`lead`, `fe-master`, `worker`), and one string carries too
many meanings:

- **`--project dev10` is overloaded.** It selects the **registry/session**
  (`~/.grove/dev10`, `config.session`), defaults the **tmux session**
  (`Registry.tmuxSession ?? session`), AND becomes the web **`X-Grove-Project`
  header** (`delegate.ts:251`, `task.ts:267/322`; server `PROJECT_HEADER`,
  `web_app.py:130`) used for web URL / token path / API routing. One flag, four
  jobs.
- **Address vs display mismatch.** CLI addresses with `project:node`
  (`parseProjectNodeAddress`, colon, project-first) but the org _displays_
  `node@project` (`org.ts:displayNameForProjectNode` → `lead@dev10`). You see
  `lead@dev10`, you type `dev10:lead`. `:` also reads as the tmux pane separator
  (`dev10:2.3`).
- **No root scope.** `grove-master` lives in the `.master` registry
  (`MASTER_REGISTRY_SESSION`, dot-excluded from project discovery), is the org
  root, and belongs to no project — but there is no addressing rule for "global,
  no project".

Current resolution evidence: `src/project-address.ts` (parse/resolve),
`src/commands/org.ts` (multi-project display + `.master` root),
`src/util/paths.ts` (`MASTER_REGISTRY_SESSION`, `sessionDir`),
`src/registry.ts` (`session` vs `tmuxSession`), `web_app.py` (`PROJECT_HEADER`,
`resolve_project`, `_project_qualified_node_ref`).

## Goal 1 — Root/global vs project-local namespace

- **Root/global plane** = nodes in the `.master` registry: `grove-master`,
  `chat-master`, `task-master`, and `services` (`web`/`slack`). Globally unique,
  no project, addressed without a project scope.
- **Project-local plane** = per-project registry nodes (`lead`, `fe-master`,
  workers), unique only within their project.
- The two planes are addressed by distinct scopes (Goal 3).

## Goal 2 — Same local name across projects

Allowed and expected. Bare `lead` is ambiguous across projects; it resolves in
the **home** project (caller's), and any cross-project reference MUST carry a
scope. Collisions never silently pick a project — they require explicit scope
(Goal 3).

## Goal 3 — CLI address syntax (+ explicit scope on conflict)

Two scope kinds: **project scope** and the **root scope**. The central decision
is the separator, because two conventions already exist:

- **Option A — scope-first colon** (today's CLI + the operator's examples):
  `base-web-admin:lead`, `root:grove-master`. Minimal CLI churn; but contradicts
  the `@project` display and overloads `:` vs tmux panes.
- **Option B — node@scope, matches display** (recommended): `lead@base-web-admin`,
  `grove-master` (root nodes bare, or `grove-master@root` when disambiguation is
  wanted). Unifies what you see with what you type; `@` never collides with pane
  ids. Requires a backcompat alias for `project:node`.

Recommendation: **Option B** (`node@project`, root nodes bare / `@root`), since
the org already displays `@project` everywhere — changing the parser is smaller
than re-teaching every display. Either way:

- **Bare `node`** → home project, else a reserved root name.
- **Conflict / ambiguity** (bare name exists in several visible projects, or a
  project node shadows a root name) → error demanding an explicit scope.
- Node names already forbid `:`/`@`/`/` (`validateGroveName`), so the grammar is
  unambiguous whichever separator wins.

## Goal 4 — Disentangle `--project`

Split the one overloaded flag into named axes; keep `--project` as a
**deprecated alias** that maps to all of them (so today's `--project dev10` and
bare `send` keep working):

- `--project <name>` — logical project identity (deprecated alias → the others).
- `--registry`/`--session <name>` — on-disk registry + event/session store
  (`~/.grove/<name>`). For v1 still 1:1 with project.
- tmux session stays a **runtime binding** (`Registry.tmuxSession`), never an
  address.
- `X-Grove-Project` (web routing key) = the project identity; keep the header
  name, source it from the resolved project, not from a CLI flag's raw value.

Backcompat: `--project` alias preserved with a one-line deprecation note; bare
send/ask unchanged; remove the alias two minors after the warning.

## Goal 5 — Context pack: split Registry/session vs Project

Today the pack emits one `Project: dev10` line. Split into:

- `Project: <logical project>` (identity)
- `Registry/session: <session>` (storage/runtime), shown only when it differs
  from the project (so single-binding packs stay compact).

⚠ **Parity:** this is a renderer change → BOTH `src/context-pack.ts` and
`bridge/src/grove_bridge/context_pack.py` must change together and the
byte-identical PARITY fixtures (full + compact, in both test files) must be
updated in lockstep. Highest parity-risk item; treat as its own implementation
sub-step with the parity fixtures as the gate.

## Goal 6 — Web org tree / selection / route / `X-Grove-Project`

- `/api/org` already returns a `project` field + `@project` display names, so the
  org chart / node list need no data change; only **node-ref input fields**
  (assignee, address) must accept the new syntax.
- Project **selection/route** (the project switcher, board route) and the
  `X-Grove-Project` header should key off the **logical project**; document that
  the header is the routing identity, decoupled from registry/session naming.
- `_project_qualified_node_ref` (`web_app.py`) parses `:` only → must accept the
  chosen canonical separator (+ legacy). Coordinate the parser change with
  board-worker (assignee refs) and chat (intake addressing) so it lands once.

## Goal 7 — Migration / backcompat / test scope

- Parser: new canonical + legacy `project:node` both resolve; deprecation path
  exercised; bare → home; root names → global; conflict → error.
- `--project` alias maps to the new flags; bare send/ask preserved.
- Display↔address round-trip (org display name parses back to the same target).
- Python `_project_qualified_node_ref` accepts new + legacy.
- Context-pack PARITY fixtures (full + compact) updated byte-identically TS↔Py.
- Targeted unit tests + parity fixtures only — no broad gate.

## Existing-compat guarantees (must hold)

- `--project <name>` keeps working (deprecated alias).
- Bare `grove send <node>` / `grove ask <node>` in a single-project context
  keeps working unchanged.
- No registry/on-disk format change in slice 1 (addressing/parse + display +
  context-pack wording + web parser only).

## Parity impact summary

- Goal 5 (Project vs Registry/session split) is the only change that touches the
  locked renderer → full + compact PARITY fixtures change in both languages,
  byte-identical, as the gate. Goals 3/4/6 are parse/flag/web changes that do not
  alter rendered pack bytes (so existing PARITY stays green until Goal 5).

## Open Decisions (need lead before implementing)

1. **Separator (the big one):** Option B `node@project` (match display,
   recommended) vs Option A `project:node` (operator's examples, current CLI)?
   Root nodes bare vs `@root/grove-master` / `root:grove-master`?
2. **Flag naming:** `--registry` vs `--session` vs `--project-name` for the
   storage axis; `--project` stays the deprecated alias?
3. **Context-pack split shape:** always emit `Registry/session:` or only when it
   differs from Project? (Recommend: only when differs, to keep packs compact.)
4. **Slice boundary:** slice 1 = parser + display + flags + context-pack split
   (TS+Py+parity); web parser (`_project_qualified_node_ref`, X-Grove-Project
   docs) as a coordinated slice 2 with board-worker/chat — or all at once?
5. **Root membership:** confirm root set = grove-master / chat-master /
   task-master / services (is `task-master` live yet?).
