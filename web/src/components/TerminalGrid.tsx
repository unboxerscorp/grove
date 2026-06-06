import { useEffect, useMemo, useState } from "react";

import { useI18n } from "../i18n";
import type { GroveNode } from "../types";
import { TerminalPane } from "./TerminalPane";

const DIMS = [1, 2, 3] as const;

/**
 * Read-only multi-window grid (max 3x3). Each cell streams one node's pane via a
 * compact TerminalPane — transparently capture mirror OR pipe-pane stream, per the
 * backend. Per-cell node picker + a full-view (⤢) action that hands the pane back
 * to the single terminal. The same pane in multiple cells shares ONE backend pipe
 * (fanout). No input/resize flows -> zero operator-tmux impact (read-only).
 */
export function TerminalGrid({
  nodes,
  onFullView,
}: {
  nodes: GroveNode[];
  onFullView: (pane: string) => void;
}) {
  const { t } = useI18n();
  const viewable = useMemo(
    () => nodes.filter((n) => n.terminal_allowed !== false && Boolean(n.tmux_pane)),
    [nodes],
  );
  const [rows, setRows] = useState(2);
  const [cols, setCols] = useState(2);
  const count = rows * cols;

  // Per-cell selected node name; defaults to the first viewable nodes and is
  // preserved across row/col changes (slice keeps existing picks; pad fills new
  // cells). Keyed on count + viewable.length so node polls don't clobber picks.
  const [cells, setCells] = useState<string[]>([]);
  useEffect(() => {
    setCells((prev) => {
      const next = prev.slice(0, count);
      for (let i = next.length; i < count; i++) {
        next[i] = viewable.length ? (viewable[i % viewable.length]?.name ?? "") : "";
      }
      return next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [count, viewable.length]);

  const setCell = (i: number, name: string) =>
    setCells((prev) => {
      const next = prev.slice();
      next[i] = name;
      return next;
    });

  return (
    <section className="dr-termgrid">
      <div className="dr-termgrid__toolbar">
        <label className="dr-termgrid__dim">
          <span>{t("termgrid.rows")}</span>
          <select className="dr-select" value={rows} onChange={(e) => setRows(Number(e.target.value))}>
            {DIMS.map((d) => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
          </select>
        </label>
        <label className="dr-termgrid__dim">
          <span>{t("termgrid.cols")}</span>
          <select className="dr-select" value={cols} onChange={(e) => setCols(Number(e.target.value))}>
            {DIMS.map((d) => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
          </select>
        </label>
        <span className="dr-termgrid__count">{t("termgrid.cells", { n: count })}</span>
      </div>

      <div
        className="dr-termgrid__grid"
        style={{
          gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
          gridTemplateRows: `repeat(${rows}, minmax(0, 1fr))`,
        }}
      >
        {Array.from({ length: count }, (_, i) => {
          const name = cells[i] ?? "";
          const node = nodes.find((n) => n.name === name) ?? null;
          return (
            <div className="dr-termgrid__cell" key={i}>
              <div className="dr-termgrid__cellbar">
                <select
                  className="dr-select dr-termgrid__pick"
                  value={name}
                  aria-label={t("termgrid.pick")}
                  onChange={(e) => setCell(i, e.target.value)}
                >
                  {viewable.length === 0 && <option value="">{t("termgrid.none")}</option>}
                  {viewable.map((n) => (
                    <option key={n.name} value={n.name}>
                      {n.name}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  className="dr-termgrid__full"
                  aria-label={t("termgrid.fullview")}
                  title={t("termgrid.fullview")}
                  disabled={!node}
                  onClick={() => node && onFullView(node.tmux_pane)}
                >
                  ⤢
                </button>
              </div>
              <div className="dr-termgrid__screen">
                <TerminalPane node={node} compact />
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
