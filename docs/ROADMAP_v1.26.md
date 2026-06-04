# grove v1.26 — Roadmap

> Status: **autonomous build in progress** (auto-started 2026-06-04 after v1.25.0).
> Design: `docs/V1_26_BRAINSTORM.md`. v1.26 = **find anything on the board** — filter + full-text
> search + saved views over the (now busy) kanban board. Read-only query; default-friendly.

## Theme

The dev-room board has many tasks (the dogfood backlog + grove-dev work). v1.26 adds a **filter
builder** (status / assignee / label), **full-text search** over task title/body, and **saved
views** (named filter presets) — all read-only queries over the existing board. No new mutation;
scoped + redacted; project-scoped.

## Workstreams

- **V26-W1 board query backend** (bridge) — a read-only board query endpoint: filter (status/
  assignee/label) + full-text (title/body) + pagination; project-scoped, role-aware (a viewer
  sees what they could see), redacted (no secret/path leak in results); deterministic. Saved
  views persisted (operator-set) in board settings. Board task on dev-room → grove-py.
- **V26-W2 board filter/search/saved-views FE** (web) — a filter bar + search box on the board
  view, results update live; saved-view chips (create/select); reachable via the v1.25 command
  palette. Read-only. verify `boardQueryOk`; no regression (sidebar/palette flags). → grove-fe.
- **V26-W3 brainstorm → v1.27** (grove-arch) — theming (dark/light/high-contrast), onboarding v3,
  optional per-user sandbox v0; + keep README current.
- **Wave-2** — real-server e2e for the board query endpoint + FE polish.

## Exit criteria

1. Board query: read-only filter + full-text + saved views, project-scoped, role-aware, redacted,
   deterministic, paginated.
2. FE: filter bar + search + saved-view chips on the board, live results, palette-reachable, no
   regression.
3. Zero open P0/P1 (query scope/role leak, injection in search, any mutation from query); coverage
   ≥80%; full check + web e2e green (new endpoint covered by real-server api.mjs); CHANGELOG +
   README + 0.27.0.

## Conventions

Unchanged + safety-first: board query is read-only (no mutation); scoped + role-aware + redacted;
deterministic; track work on the dev-room board (dogfood); push origin main + tags at release;
docs lane keeps README current; refresh the :9131 dashboard at release; pnpm check + reviewer GO;
mock mirrors real backend + real-server e2e for the new endpoint; one node per window; one writer
per area per wave; agy headless; no questions until told to stop.
