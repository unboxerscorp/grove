import { useEffect, useMemo, useRef, useState } from "react";

import { cx } from "../constants";
import { useI18n } from "../i18n";
import type { GroveNode } from "../types";
import { TerminalPane } from "./TerminalPane";

const MAX_CELLS = 9;
const MAX_COLS = 3;

let _cid = 0;
const nextCellId = () => `tc-${++_cid}`;

interface GridCell {
  id: string;
  node: string;
}

/**
 * Dynamic read-only terminal grid. Starts as one cell (the selected node) and
 * grows via the right "+" (add column → widens) / bottom "+" (add row → wraps
 * taller); each "+" opens a node-pick modal (duplicates allowed). Cells are
 * compact TerminalPanes (capture OR pipe-pane stream, transparently); the same
 * pane in multiple cells shares ONE backend pipe (fanout). "×" closes a cell;
 * "⤢" expands it to the full single view (full TerminalPane + send box). No
 * input/resize flows from the grid -> zero operator-tmux impact. Cap: 9 cells /
 * 3 columns.
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
  const [cells, setCells] = useState<GridCell[]>(() =>
    initialNode ? [{ id: nextCellId(), node: initialNode }] : [],
  );
  const [cols, setCols] = useState(1);
  const [picking, setPicking] = useState<null | "col" | "row">(null);

  // Seed the first cell once the selected node resolves (handles the mount race
  // where the default terminal node arrives after this component mounts). Only
  // seeds once, so closing the last cell stays at the empty "+" state.
  const seeded = useRef(Boolean(initialNode));
  useEffect(() => {
    if (seeded.current || !initialNode) return;
    seeded.current = true;
    setCells((prev) => (prev.length === 0 ? [{ id: nextCellId(), node: initialNode }] : prev));
  }, [initialNode]);

  const atCellCap = cells.length >= MAX_CELLS;
  const canAddCol = !atCellCap && cols < MAX_COLS;
  const canAddRow = !atCellCap;

  const addCell = (node: string, mode: "col" | "row") => {
    setCells((prev) => (prev.length >= MAX_CELLS ? prev : [...prev, { id: nextCellId(), node }]));
    if (mode === "col") setCols((c) => Math.min(MAX_COLS, c + 1));
    setPicking(null);
  };
  const closeCell = (id: string) => setCells((prev) => prev.filter((c) => c.id !== id));

  const gridCols = Math.max(1, Math.min(cols, cells.length));

  return (
    <section className="dr-termgrid">
      {cells.length === 0 ? (
        <div className="dr-termgrid__empty">
          <p className="dr-termgrid__empty-msg">{t("termgrid.empty")}</p>
          <button
            type="button"
            className="dr-btn dr-btn--primary"
            disabled={viewable.length === 0}
            onClick={() => setPicking("row")}
          >
            {t("termgrid.add")}
          </button>
        </div>
      ) : (
        <>
          <div className="dr-termgrid__main">
            <div
              className="dr-termgrid__grid"
              style={{ gridTemplateColumns: `repeat(${gridCols}, minmax(0, 1fr))` }}
            >
              {cells.map((cell) => {
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
                        onClick={() => closeCell(cell.id)}
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
            </div>
            <button
              type="button"
              className="dr-termgrid__addcol"
              title={t("termgrid.addCol")}
              aria-label={t("termgrid.addCol")}
              disabled={!canAddCol}
              onClick={() => setPicking("col")}
            >
              +
            </button>
          </div>
          <button
            type="button"
            className="dr-termgrid__addrow"
            title={t("termgrid.addRow")}
            aria-label={t("termgrid.addRow")}
            disabled={!canAddRow}
            onClick={() => setPicking("row")}
          >
            +
          </button>
        </>
      )}

      {picking && (
        <div className="dr-termgrid__modal" role="dialog" aria-modal="true" aria-label={t("termgrid.pickTitle")}>
          <div className="dr-termgrid__modal-scrim" onClick={() => setPicking(null)} />
          <div className="dr-termgrid__modal-box">
            <div className="dr-termgrid__modal-head">{t("termgrid.pickTitle")}</div>
            <div className="dr-termgrid__modal-list">
              {viewable.length === 0 && <div className="dr-termgrid__modal-empty">{t("termgrid.none")}</div>}
              {viewable.map((n) => (
                <button
                  type="button"
                  key={n.name}
                  className={cx("dr-termgrid__modal-item", `is-${n.status}`)}
                  onClick={() => addCell(n.name, picking)}
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
