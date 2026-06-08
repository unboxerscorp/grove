import { Fragment, useEffect, useMemo, useRef, useState } from "react";

import { cx } from "../constants";
import { useI18n } from "../i18n";
import type { GroveNode } from "../types";
import { TerminalPane } from "./TerminalPane";
import { termDnd, useTermDnd } from "../termViewsStore";

const MAX_CELLS = 9;
const MAX_ROWS = 3;
const MAX_COLS = 3;
const MAX_VIEWS = 6;
const LEGACY_STORE_KEY = "grove.termviews";
const STORE_VERSION = 1;
// Terminal views persist PER PROJECT (still per browser, no server) so each
// project keeps its own tabs/layout. Key: "grove.termviews.<project>".
const storeKey = (project: string | null): string =>
  project ? `${LEGACY_STORE_KEY}.${project}` : LEGACY_STORE_KEY;

let _cid = 0;
const nextCellId = () => `tc-${++_cid}`;
let _rid = 0;
const nextRowId = () => `tr-${++_rid}`;
let _vid = 0;
const nextViewId = () => `tv-${++_vid}`;

interface GridCell {
  id: string;
  node: string;
}
interface GridRow {
  id: string;
  cells: GridCell[];
}
interface TermView {
  id: string;
  name: string;
  rows: GridRow[];
}
interface Store {
  views: TermView[];
  activeId: string;
}

type Picking = null | { type: "col"; rowId: string } | { type: "row" };

const makeRow = (node: string): GridRow => ({ id: nextRowId(), cells: [{ id: nextCellId(), node }] });
const makeView = (name: string, seedNode?: string | null): TermView => ({
  id: nextViewId(),
  name,
  rows: seedNode ? [makeRow(seedNode)] : [],
});
const totalCells = (rows: GridRow[]) => rows.reduce((sum, r) => sum + r.cells.length, 0);

// Persisted shape is intentionally compact + id-free:
//   { version, activeIndex, views: [{ name, rows: string[][] }] }
// IDs are React keys only and are regenerated on load, so stored data can never
// collide with the live counters. Only node names + structure are persisted.
function serialize(store: Store): string {
  const activeIndex = Math.max(
    0,
    store.views.findIndex((v) => v.id === store.activeId),
  );
  return JSON.stringify({
    version: STORE_VERSION,
    activeIndex,
    views: store.views.map((v) => ({ name: v.name, rows: v.rows.map((r) => r.cells.map((c) => c.node)) })),
  });
}

// Hydrate from localStorage with a strict version gate + shape validation; any
// corruption/old version falls back to a single fresh (optionally seeded) view.
// `restored` tells the caller whether a stored layout was applied (so the mount
// seed-once does not overwrite it).
function loadStore(
  project: string | null,
  defaultName: string,
  seedNode?: string | null,
): { store: Store; restored: boolean } {
  const key = storeKey(project);
  try {
    let raw = localStorage.getItem(key);
    // One-time migration: a project with no saved layout yet inherits the legacy
    // project-agnostic key (pre-per-project data), then that legacy key is removed
    // so other projects start fresh — keeps the user's current view in this project.
    if (raw === null && project) {
      const legacy = localStorage.getItem(LEGACY_STORE_KEY);
      if (legacy !== null) {
        raw = legacy;
        try {
          localStorage.setItem(key, legacy);
          localStorage.removeItem(LEGACY_STORE_KEY);
        } catch {
          /* ignore */
        }
      }
    }
    if (raw) {
      const parsed: unknown = JSON.parse(raw);
      const p = parsed as { version?: unknown; activeIndex?: unknown; views?: unknown };
      if (p && p.version === STORE_VERSION && Array.isArray(p.views)) {
        const views: TermView[] = (p.views as unknown[])
          .filter((v): v is { name?: unknown; rows?: unknown } => Boolean(v) && Array.isArray((v as { rows?: unknown }).rows))
          .slice(0, MAX_VIEWS)
          .map((v) => ({
            id: nextViewId(),
            name: typeof v.name === "string" && v.name.trim() ? v.name : defaultName,
            rows: (v.rows as unknown[])
              .filter((r): r is unknown[] => Array.isArray(r))
              .map((cells) => ({
                id: nextRowId(),
                cells: cells
                  .filter((n): n is string => typeof n === "string")
                  .slice(0, MAX_COLS)
                  .map((node) => ({ id: nextCellId(), node })),
              }))
              .filter((r) => r.cells.length > 0)
              .slice(0, MAX_ROWS),
          }));
        if (views.length > 0) {
          const idx =
            typeof p.activeIndex === "number" && p.activeIndex >= 0 && p.activeIndex < views.length
              ? p.activeIndex
              : 0;
          return { store: { views, activeId: (views[idx] ?? views[0]!).id }, restored: true };
        }
      }
    }
  } catch {
    /* corrupt/unavailable storage -> fresh default view below */
  }
  const v = makeView(defaultName, seedNode);
  return { store: { views: [v], activeId: v.id }, restored: false };
}

/**
 * Dynamic read-only terminal grid with named VIEWS (tabs) and per-client
 * persistence. Each view is an independent RAGGED grid: rows stack vertically and
 * each row owns its own list of cells, so rows can hold different column counts.
 * Each row has its own right "+" (add a column to THAT row); one bottom "+" adds
 * a new row. Tabs across the top switch / add / close views. The whole layout
 * (views + active tab + each view's ragged structure of node names) is saved to
 * localStorage per project ("grove.termviews.<project>"), so it survives
 * navigation, refresh, and the expand→back round-trip; is per browser (each admin
 * keeps their own); and each project keeps its own separate views.
 *
 * Cells are compact TerminalPanes (capture-only) with a per-cell composer; the
 * same pane in multiple cells shares ONE backend pipe. "×" closes a cell (an
 * emptied row is dropped); "⤢" expands a cell to the full single view. No
 * input/resize flows from the grid -> zero operator-tmux impact. Caps: 6 views;
 * per view 9 cells / 3 rows / 3 columns per row.
 */
export function TerminalGrid({
  nodes,
  initialNode,
  onExpand,
  project,
}: {
  nodes: GroveNode[];
  initialNode?: string | null;
  onExpand: (pane: string) => void;
  project: string | null;
}) {
  const { t } = useI18n();
  const viewable = useMemo(
    () => nodes.filter((n) => n.terminal_allowed !== false && Boolean(n.tmux_pane)),
    [nodes],
  );

  // Seed-once guard: true if a stored layout was restored OR the default view was
  // already seeded with initialNode — either way the mount effect must not re-seed.
  const seeded = useRef(false);
  const [store, setStore] = useState<Store>(() => {
    const boot = loadStore(project, t("termview.name", { n: 1 }), initialNode);
    seeded.current = boot.restored || Boolean(initialNode);
    return boot.store;
  });
  const [picking, setPicking] = useState<Picking>(null);
  const dnd = useTermDnd();

  // Persist on every change (per browser; survives remount / revisit / expand-back).
  useEffect(() => {
    try {
      localStorage.setItem(storeKey(project), serialize(store));
    } catch {
      /* storage unavailable (private mode / quota) — run in-memory */
    }
  }, [store, project]);

  const setActiveRows = (updater: (rows: GridRow[]) => GridRow[]) =>
    setStore((prev) => ({
      ...prev,
      views: prev.views.map((v) => (v.id === prev.activeId ? { ...v, rows: updater(v.rows) } : v)),
    }));

  // Seed the first cell once the selected node resolves (mount race: the default
  // terminal node can arrive after this component mounts). Only when starting from
  // a fresh, empty default view — never overwrites a restored layout.
  useEffect(() => {
    if (seeded.current || !initialNode) return;
    seeded.current = true;
    setActiveRows((rows) => (rows.length === 0 ? [makeRow(initialNode)] : rows));
  }, [initialNode]);

  // store.views always holds >= 1 view (seeded at init; closeView never empties it).
  const activeView = store.views.find((v) => v.id === store.activeId) ?? store.views[0]!;
  const rows = activeView.rows;

  // Publish the cross-component DnD slice for NodeList (the drag source): mount
  // state gates the drag affordance; the active view's node set drives in-view
  // dimming so a node already here can't be dragged in again. (D1: publish only —
  // NodeList consumes in D2, drop zones in D3.)
  useEffect(() => {
    termDnd.setGridMounted(true);
    return () => termDnd.setGridMounted(false);
  }, []);
  const activeNodeNames = useMemo(() => rows.flatMap((r) => r.cells.map((c) => c.node)), [rows]);
  useEffect(() => {
    termDnd.setActiveNodes(activeNodeNames);
  }, [activeNodeNames]);

  const total = totalCells(rows);
  const canAddRow = rows.length < MAX_ROWS && total < MAX_CELLS;
  const canAddCol = (row: GridRow) => row.cells.length < MAX_COLS && total < MAX_CELLS;
  // Move-aware drop-zone validity: a reorder (dnd.moving) is net-zero, so it may
  // also target the origin's own (possibly full) row, and a solo cell may move to
  // a new row even at the row cap.
  const moving = dnd.moving;
  const moveOriginSolo = moving ? rows.find((r) => r.id === moving.rowId)?.cells.length === 1 : false;
  const colSlotOk = (row: GridRow) =>
    moving ? row.id === moving.rowId || row.cells.length < MAX_COLS : canAddCol(row);
  const rowSlotOk = moving ? moveOriginSolo || rows.length < MAX_ROWS : canAddRow;

  const addCell = (node: string) => {
    if (!picking) return;
    if (picking.type === "row") {
      setActiveRows((rs) =>
        rs.length >= MAX_ROWS || totalCells(rs) >= MAX_CELLS ? rs : [...rs, makeRow(node)],
      );
    } else {
      const { rowId } = picking;
      setActiveRows((rs) =>
        totalCells(rs) >= MAX_CELLS
          ? rs
          : rs.map((r) =>
              r.id === rowId && r.cells.length < MAX_COLS
                ? { ...r, cells: [...r.cells, { id: nextCellId(), node }] }
                : r,
            ),
      );
    }
    setPicking(null);
  };

  // Drop the cell; an emptied row is removed so no blank row lingers.
  const closeCell = (rowId: string, cellId: string) =>
    setActiveRows((rs) =>
      rs
        .map((r) => (r.id === rowId ? { ...r, cells: r.cells.filter((c) => c.id !== cellId) } : r))
        .filter((r) => r.cells.length > 0),
    );

  const selectView = (id: string) => setStore((prev) => ({ ...prev, activeId: id }));
  const addView = () =>
    setStore((prev) => {
      if (prev.views.length >= MAX_VIEWS) return prev;
      const seed = initialNode ?? viewable[0]?.name ?? null;
      const v = makeView(t("termview.name", { n: prev.views.length + 1 }), seed);
      return { views: [...prev.views, v], activeId: v.id };
    });
  const closeView = (id: string) =>
    setStore((prev) => {
      if (prev.views.length <= 1) return prev; // always keep at least one view
      const idx = prev.views.findIndex((v) => v.id === id);
      const views = prev.views.filter((v) => v.id !== id);
      const activeId =
        prev.activeId === id ? (views[idx] ?? views[idx - 1] ?? views[0]!).id : prev.activeId;
      return { views, activeId };
    });

  // --- node→grid drop (Pointer Events) -------------------------------------
  // Insert a cell at `index` within a row (no-dup: a node already in the active
  // view is rejected — the source also blocks dragging in-view nodes).
  const insertCellAt = (rowId: string, index: number, node: string) =>
    setActiveRows((rs) => {
      if (totalCells(rs) >= MAX_CELLS || rs.some((r) => r.cells.some((c) => c.node === node))) return rs;
      return rs.map((r) =>
        r.id === rowId && r.cells.length < MAX_COLS
          ? { ...r, cells: [...r.cells.slice(0, index), { id: nextCellId(), node }, ...r.cells.slice(index)] }
          : r,
      );
    });
  const insertRowAt = (index: number, node: string) =>
    setActiveRows((rs) => {
      if (
        rs.length >= MAX_ROWS ||
        totalCells(rs) >= MAX_CELLS ||
        rs.some((r) => r.cells.some((c) => c.node === node))
      )
        return rs;
      return [...rs.slice(0, index), makeRow(node), ...rs.slice(index)];
    });
  // Reorder an existing cell (cellbar drag): relocate the SAME cell object so its
  // terminal pane is not torn down. Net-zero cell count, so the caps hold; no-dup
  // is intentionally bypassed (we're moving the node, not adding a duplicate).
  const moveCell = (dropKey: string, move: { rowId: string; cellId: string }) =>
    setActiveRows((rs) => {
      const origRowIdx = rs.findIndex((r) => r.id === move.rowId);
      if (origRowIdx < 0) return rs;
      const origRow = rs[origRowIdx]!;
      const origIdx = origRow.cells.findIndex((c) => c.id === move.cellId);
      if (origIdx < 0) return rs;
      const cell = origRow.cells[origIdx]!;
      const [kind, a, b] = dropKey.split(":");
      // No-op: dropped onto the cell's own current slot (idx or idx+1 in its row).
      if (kind === "col" && a === move.rowId && (Number(b) === origIdx || Number(b) === origIdx + 1)) {
        return rs;
      }
      const origSolo = origRow.cells.length === 1;
      // 1. remove the origin occurrence; drop the row if it empties.
      const removed = rs
        .map((r) => (r.id === move.rowId ? { ...r, cells: r.cells.filter((c) => c.id !== move.cellId) } : r))
        .filter((r) => r.cells.length > 0);
      // 2. re-insert the same cell at the target, adjusting for the removal shift.
      if (kind === "row" && a !== undefined) {
        let i = Number(a);
        if (origSolo && origRowIdx < i) i -= 1; // origin row vanished above the target
        i = Math.max(0, Math.min(i, removed.length));
        return [...removed.slice(0, i), { id: nextRowId(), cells: [cell] }, ...removed.slice(i)];
      }
      if (kind === "col" && a !== undefined && b !== undefined) {
        let idx = Number(b);
        if (a === move.rowId && idx > origIdx) idx -= 1; // same-row shift after removal
        return removed.map((r) =>
          r.id === a ? { ...r, cells: [...r.cells.slice(0, idx), cell, ...r.cells.slice(idx)] } : r,
        );
      }
      return rs;
    });
  const dragging = dnd.draggingNode !== null;
  // Each drop zone is a thin strip tagged with a data-dropkey. The pointer drag
  // controller (termViewsStore) hit-tests these, toggles `.is-over` imperatively
  // (teal insert line + glow — pure DOM, no React re-render), and on drop calls
  // the commit handler below with the zone's key.
  const dropSlot = (key: string, orient: "col" | "row") => (
    <div key={key} data-dropkey={key} className={cx("dr-termgrid__drop", `dr-termgrid__drop--${orient}`)} />
  );
  // Commit handler: parse a data-dropkey ("empty" | "row:i" | "col:rowId:i") and
  // insert. Held in a ref so the controller registration stays stable while the
  // closures still see current state.
  const commitRef = useRef<
    (dropKey: string, node: string, move: { rowId: string; cellId: string } | null) => void
  >(() => {});
  commitRef.current = (dropKey, node, move) => {
    if (move) return moveCell(dropKey, move); // cellbar reorder
    if (dropKey === "empty") return insertRowAt(0, node);
    const parts = dropKey.split(":");
    if (parts[0] === "row" && parts[1] !== undefined) insertRowAt(Number(parts[1]), node);
    else if (parts[0] === "col" && parts[1] !== undefined && parts[2] !== undefined)
      insertCellAt(parts[1], Number(parts[2]), node);
  };
  useEffect(() => {
    termDnd.registerCommit((k, n, m) => commitRef.current(k, n, m));
    return () => termDnd.registerCommit(null);
  }, []);
  const renderCell = (row: GridRow, cell: GridCell) => {
    const node = nodes.find((n) => n.name === cell.node) ?? null;
    return (
      <div className={cx("dr-termgrid__cell", dnd.moving?.cellId === cell.id && "is-moving")} key={cell.id}>
        <div
          className="dr-termgrid__cellbar"
          onPointerDown={(e) => {
            if ((e.target as HTMLElement).closest("button")) return; // let ⤢/× taps through
            termDnd.startPointerDrag(cell.node, e.clientX, e.clientY, e.pointerId, {
              rowId: row.id,
              cellId: cell.id,
            });
          }}
        >
          <span className="dr-termgrid__cellname" title={cell.node}>
            {cell.node}
          </span>
          <button
            type="button"
            className="dr-termgrid__icon"
            data-act="full"
            title={t("termgrid.fullview")}
            aria-label={t("termgrid.fullview")}
            disabled={!node}
            onClick={() => node && onExpand(node.tmux_pane)}
          >
            ⤢
          </button>
          <button
            type="button"
            className="dr-termgrid__icon"
            data-act="close"
            title={t("termgrid.close")}
            aria-label={t("termgrid.close")}
            onClick={() => closeCell(row.id, cell.id)}
          >
            ×
          </button>
        </div>
        <div className="dr-termgrid__screen">
          <TerminalPane node={node} compact />
        </div>
      </div>
    );
  };

  return (
    <section className={cx("dr-termgrid", dragging && "is-dnd")}>
      <div className="dr-termtabs" role="tablist" aria-label={t("tab.terminal")}>
        {store.views.map((v) => (
          <span key={v.id} className={cx("dr-termtabs__tab", v.id === store.activeId && "is-active")}>
            <button
              type="button"
              role="tab"
              aria-selected={v.id === store.activeId}
              className="dr-termtabs__name"
              title={v.name}
              onClick={() => selectView(v.id)}
            >
              {v.name}
            </button>
            {store.views.length > 1 && (
              <button
                type="button"
                className="dr-termtabs__close"
                title={t("termview.close")}
                aria-label={t("termview.close")}
                onClick={() => closeView(v.id)}
              >
                ×
              </button>
            )}
          </span>
        ))}
        <button
          type="button"
          className="dr-termtabs__new"
          disabled={store.views.length >= MAX_VIEWS}
          onClick={addView}
        >
          + {t("termview.new")}
        </button>
      </div>

      {total === 0 ? (
        <div className={cx("dr-termgrid__empty", dragging && "is-droptarget")} data-dropkey="empty">
          <p className="dr-termgrid__empty-msg">{t("termgrid.empty")}</p>
          <button
            type="button"
            className="dr-btn dr-btn--primary"
            disabled={viewable.length === 0}
            onClick={() => setPicking({ type: "row" })}
          >
            {t("termgrid.add")}
          </button>
        </div>
      ) : (
        <div className="dr-termgrid__rows">
          {dragging && rowSlotOk && dropSlot("row:0", "row")}
          {rows.map((row, ri) => (
            <Fragment key={row.id}>
              <div className="dr-termgrid__row">
                {dragging && colSlotOk(row) && dropSlot(`col:${row.id}:0`, "col")}
                {row.cells.map((cell, ci) => (
                  <Fragment key={cell.id}>
                    {renderCell(row, cell)}
                    {dragging && colSlotOk(row) && dropSlot(`col:${row.id}:${ci + 1}`, "col")}
                  </Fragment>
                ))}
                <button
                  type="button"
                  className="dr-termgrid__addcol"
                  title={t("termgrid.addCol")}
                  aria-label={t("termgrid.addCol")}
                  disabled={!canAddCol(row)}
                  onClick={() => setPicking({ type: "col", rowId: row.id })}
                >
                  +
                </button>
              </div>
              {dragging && rowSlotOk && dropSlot(`row:${ri + 1}`, "row")}
            </Fragment>
          ))}
          <button
            type="button"
            className="dr-termgrid__addrow"
            title={t("termgrid.addRow")}
            aria-label={t("termgrid.addRow")}
            disabled={!canAddRow}
            onClick={() => setPicking({ type: "row" })}
          >
            +
          </button>
        </div>
      )}

      {picking && (
        <div
          className="dr-termgrid__modal"
          role="dialog"
          aria-modal="true"
          aria-label={t("termgrid.pickTitle")}
        >
          <div className="dr-termgrid__modal-scrim" onClick={() => setPicking(null)} />
          <div className="dr-termgrid__modal-box">
            <div className="dr-termgrid__modal-head">{t("termgrid.pickTitle")}</div>
            <div className="dr-termgrid__modal-list">
              {viewable.length === 0 && (
                <div className="dr-termgrid__modal-empty">{t("termgrid.none")}</div>
              )}
              {viewable.map((n) => (
                <button
                  type="button"
                  key={n.name}
                  className={cx("dr-termgrid__modal-item", `is-${n.status}`)}
                  onClick={() => addCell(n.name)}
                >
                  <span className="dr-termgrid__modal-name">{n.name}</span>
                  <span className="dr-termgrid__modal-pane">{n.tmux_pane}</span>
                </button>
              ))}
            </div>
            <div className="dr-termgrid__modal-foot">
              <button type="button" className="dr-btn dr-btn--ghost" onClick={() => setPicking(null)}>
                {t("termgrid.cancel")}
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
