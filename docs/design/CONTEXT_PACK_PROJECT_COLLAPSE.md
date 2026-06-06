# Context-Pack Foreign-Project Collapse (task_dd4)

Status: IMPLEMENTED (Phase 1 committed d4833a2; Phase 2 deferred). The lead
agreed every Open Decision below on 2026-06-06. Phase 1 shipped the collapse
filter + render-inert `project` field in `src/context-pack.ts` and
`bridge/src/grove_bridge/context_pack.py`, with byte-parity re-verified by the
lead (TS 13/13, Py 11/11, PARITY_PACK byte-identical). It is an inert no-op
until a second project exists (Phase 2). Owner: org-worker. Reports to
grove-dev lead.

This proposes how the context-pack "Visible org summary" should, once multiple
projects exist, show **other** projects collapsed to their **lead node only**,
keeping each dispatch's org summary compact and relevant. Source request
(task_dd4, grove-master): as more projects are created and grow, other projects
need only surface their lead in the visible org.

## Key Finding: the feature is forward-looking

There is **no code path today that puts more than one project's nodes into a
context pack**, so right now there is nothing to collapse. Grounding:

- **Renderers are single-project.** `buildGroveContextPack` (`src/context-pack.ts:144`)
  and `build_grove_context_pack` (`bridge/src/grove_bridge/context_pack.py:109`)
  render a flat `nodes` list under one `project` string, one line per node via
  `nodeLine` / `_node_line`. Output is locked byte-for-byte by `PARITY_PACK`
  (`src/context-pack.test.ts`, `bridge/tests/test_context_pack.py`).
- **Node sourcing is single-project.** TS `contextPackNodesFromContext` /
  `contextPackNodesFromRegistry` (`src/context-pack.ts:108,123`) read one
  session's registry. Web: `_context_pack_nodes_for_project(project.config)`
  (`bridge/src/grove_bridge/web_app.py:7081`) maps `_org_node_records(config)`
  for one project, passed with `project=project.name` (`web_app.py:7070`).
- **The only cross-project touch is role resolution, not visibility.**
  `_context_pack_target_role_for_assignee` (`web_app.py:7108-7122`) loads another
  project's config **only** to resolve a project-qualified assignee's `role` for
  the `Target role:` line. It does **not** add foreign nodes to the visible org.
- **`ContextPackNode` has no `project` field** (TS interface `context-pack.ts:13`;
  Python dataclass `context_pack.py:16`). A node currently cannot say which
  project it belongs to.

Implication: collapse cannot be observed until a future change aggregates
multiple projects into one pack. This design defines the behavior and the
parity-safe shape so it is ready when that aggregation lands — and can be
introduced now as an inert no-op for the single-project case.

## Design Principle: collapse is node-selection, not rendering

Collapse decides **which** nodes appear, not **how** a node line is formatted.
So it belongs in an **upstream pure filter** applied to the `nodes` list
_before_ the renderer:

```
sourced nodes  ->  collapseForeignProjects(nodes, homeProject, opts)  ->  buildGroveContextPack(nodes=...)
```

Consequences:

- `nodeLine` / `_node_line` and `buildGroveContextPack` / `build_grove_context_pack`
  stay **byte-for-byte unchanged** → the existing `PARITY_PACK` fixtures remain
  valid and untouched. **Zero parity-surface risk.**
- The filter is _new, additive_ code (a TS function + a mirrored Python
  function). Parity discipline extends to it as _node-selection_ parity (same
  input → same selected set/order), verified by its own tests — separate from
  the locked render fixture.

## Data model

Add an **optional** `project` field to `ContextPackNode` (TS interface + Python
dataclass). It is populated at node-sourcing and read **only** by the filter;
`nodeLine` / `_node_line` never reference it, so rendered output is unchanged.

Parity guard: add a test asserting `PARITY_PACK` is still byte-identical with
`project` set on the input node — proving the field is render-inert in both
languages. (Adding a per-node field is otherwise a known multi-site threading
exercise; here the scope is bounded because only the filter consumes it.)

## Collapse semantics (proposed)

`collapseForeignProjects(nodes, homeProject, opts)`:

1. Keep every node whose `project === homeProject` (or whose `project` is unset —
   treated as home for backward-compat / single-project packs).
2. For each **foreign** project, keep **only that project's lead node**; drop its
   other nodes.
3. Preserve current ordering (sort by `name`, as today) after selection.
4. Single-project input → returns the list unchanged (inert no-op).

## Open Decisions (RESOLVED — lead adopted every recommendation, 2026-06-06)

1. **Foreign-project lead identification.** Reuse the existing `_project_lead`
   heuristic (node named `lead`, else a root node whose name contains `lead`)?
   Or key off `group === "lead"`, or "the child of grove-master for that
   project" per canonical `GROVE MASTER -> project lead`? (Recommend: reuse
   `_project_lead` for consistency with the existing renderer helper.)
2. **Shared infra exemption.** `grove-master` and `services`/`advisor` sit under
   the master, not under a project tree. Are they always shown (recommended —
   they are shared control plane), or also collapsed?
3. **Foreign project with no resolvable lead.** Drop it entirely, or emit one
   placeholder line? (Recommend: drop; log nothing in the pack.)
4. **Scope of "project".** Is a project the registry session, or a grove-master
   sub-tree? This sets where the `project` field is sourced from.
5. **Land now vs defer.** Introduce the filter + field now as a parity-proven
   single-project no-op (ready for future aggregation), or defer entirely until
   a multi-project visible-org is actually built? (Recommend: land the inert
   no-op once decisions 1–4 are fixed, so the seam exists when needed.)

## Parity & test plan

- Re-run existing `PARITY_PACK` (TS + Python) after the additive field → prove
  no render drift (byte-identical).
- New filter: paired TS + Python unit tests for each semantic rule above, plus a
  cross-language selection-parity test (same multi-project input → same selected
  node set + order in both implementations).
- No change to the locked render fixtures unless the lead later approves a
  rendering change (not part of this design).

## Phased rollout

- **Phase 0 — DONE:** design agreement on Open Decisions.
- **Phase 1 — DONE (committed d4833a2):** additive `project` field
  (render-inert, parity-proven) + pure `collapseForeignProjects` filter
  (TS + mirrored Python) + selection-parity tests. Inert for single-project;
  no behavior change to current dispatches.
- **Phase 2 (future):** wire the filter into node-sourcing wherever multi-project
  aggregation is introduced — sourcing must set `node.project` to the registry
  session and pass the same string as the pack's home `project`. Out of scope
  until a second project exists.

## Constraint (Phase 1 — satisfied)

Phase 1 touched `src/context-pack.ts` and `bridge/src/grove_bridge/context_pack.py`
only by adding the render-inert `project` field and the upstream filter; the
locked renderer + PARITY fixtures were unchanged and re-verified byte-identical.
Any future rendering change to the parity surface still requires explicit lead
agreement before edits.
