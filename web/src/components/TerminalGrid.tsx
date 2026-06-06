import { useEffect, useMemo, useRef, useState } from "react";

import { cx } from "../constants";
import { useI18n } from "../i18n";
import type { GroveNode } from "../types";
import { TerminalPane } from "./TerminalPane";

const MAX_CELLS = 9;
const MAX_ROWS = 3;
const MAX_COLS = 3;

let _cid = 0;
const nextCellId = () => `tc-${++_cid}`;
let _rid = 0;
const nextRowId = () => `tr-${++_rid}`;

interface GridCell {
  id: string;
  node: string;
}
interface GridRow {
  id: string;
  cells: GridCell[];
}

type Picking = null | { type: "col"; rowId: string } | { type: "row" };

/**
 * Dynamic read-only terminal grid, RAGGED: each row owns its own list of cells,
 * so rows can hold different numbers of columns. Each row has its own right "+"
 * (add a column to THAT row); one bottom "+" adds a new row. Each "+" opens a
 * node-pick modal (duplicates allowed). Cells are compact TerminalPanes
 * (capture-only) with a per-cell composer; the same pane in multiple cells shares
 * ONE backend pipe (fanout). "×" closes a cell (an emptied row is dropped); "⤢"
 * expands a cell to the full single view. No input/resize flows from the grid ->
 * zero operator-tmux impact. Caps: 9 cells total / 3 rows / 3 columns per row.
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
  const [rows, setRows] = useState<GridRow[]>(() =>
    initialNode ? [{ id: nextRowId(), cells: [{ id: nextCellId(), node: initialNode }] }] : [],
  );
  const [picking, setPicking] = useState<Picking>(null);

  // Seed the first cell once the selected node resolves (mount race: the default
  // terminal node can arrive after this component mounts). Seeds once, so closing
  // the last cell stays at the empty "+" state.
  const seeded = useRef(Boolean(initialNode));
  useEffect(() => {
    if (seeded.current || !initialNode) return;
    seeded.current = true;
    setRows((prev) =>
      prev.length === 0
        ? [{ id: nextRowId(), cells: [{ id: nextCellId(), node: initialNode }] }]
        : prev,
    );
  }, [initialNode]);

  const total = rows.reduce((sum, r) => sum + r.cells.length, 0);
  const canAddRow = rows.length < MAX_ROWS && total < MAX_CELLS;
  const canAddCol = (row: GridRow) => row.cells.length < MAX_COLS && total < MAX_CELLS;

  const addCell = (node: string) => {
    if (!picking) return;
    if (picking.type === "row") {
      setRows((prev) =>
        prev.length >= MAX_ROWS || prev.reduce((s, r) => s + r.cells.length, 0) >= MAX_CELLS
          ? prev
          : [...prev, { id: nextRowId(), cells: [{ id: nextCellId(), node }] }],
      );
    } else {
      const { rowId } = picking;
      setRows((prev) => {
        if (prev.reduce((s, r) => s + r.cells.length, 0) >= MAX_CELLS) return prev;
        return prev.map((r) =>
          r.id === rowId && r.cells.length < MAX_COLS
            ? { ...r, cells: [...r.cells, { id: nextCellId(), node }] }
            : r,
        );
      });
    }
    setPicking(null);
  };

  // Drop the cell; an emptied row is removed so no blank row lingers.
  const closeCell = (rowId: string, cellId: string) =>
    setRows((prev) =>
      prev
        .map((r) => (r.id === rowId ? { ...r, cells: r.cells.filter((c) => c.id !== cellId) } : r))
        .filter((r) => r.cells.length > 0),
    );

  return (
    <section className="dr-termgrid">
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
