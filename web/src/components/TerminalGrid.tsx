import { useEffect, useMemo, useRef, useState } from "react";

import { cx } from "../constants";
import { useI18n } from "../i18n";
import type { GroveNode } from "../types";
import { TerminalPane } from "./TerminalPane";

const MAX_CELLS = 9;
const MAX_ROWS = 3;
const MAX_COLS = 3;
const MAX_VIEWS = 6;
const STORE_KEY = "grove.termviews";
const STORE_VERSION = 1;

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
function loadStore(defaultName: string, seedNode?: string | null): { store: Store; restored: boolean } {
  try {
    const raw = localStorage.getItem(STORE_KEY);
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
 * localStorage ("grove.termviews"), so it survives navigation, refresh, and the
 * expand→back round-trip — and is per browser, i.e. each admin keeps their own.
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
}: {
  nodes: GroveNode[];
  initialNode?: string | null;
  onExpand: (pane: string) => void;
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
    const boot = loadStore(t("termview.name", { n: 1 }), initialNode);
    seeded.current = boot.restored || Boolean(initialNode);
    return boot.store;
  });
  const [picking, setPicking] = useState<Picking>(null);

  // Persist on every change (per browser; survives remount / revisit / expand-back).
  useEffect(() => {
    try {
      localStorage.setItem(STORE_KEY, serialize(store));
    } catch {
      /* storage unavailable (private mode / quota) — run in-memory */
    }
  }, [store]);

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
  const total = totalCells(rows);
  const canAddRow = rows.length < MAX_ROWS && total < MAX_CELLS;
  const canAddCol = (row: GridRow) => row.cells.length < MAX_COLS && total < MAX_CELLS;

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

  return (
    <section className="dr-termgrid">
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
        <div className="dr-termgrid__empty">
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
          {rows.map((row) => (
            <div className="dr-termgrid__row" key={row.id}>
              {row.cells.map((cell) => {
                const node = nodes.find((n) => n.name === cell.node) ?? null;
                return (
                  <div className="dr-termgrid__cell" key={cell.id}>
                    <div className="dr-termgrid__cellbar">
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
              })}
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
