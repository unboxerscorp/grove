import { useMemo, useState } from "react";

import { agentGlyph, cx } from "../constants";
import { statusLabel, useI18n } from "../i18n";
import type { GroveNode } from "../types";

function statusClass(status: string): string {
  switch (status) {
    case "running":
      return "is-running";
    case "error":
      return "is-error";
    case "done":
      return "is-done";
    default:
      return "is-idle";
  }
}

export function NodeList(props: {
  nodes: GroveNode[];
  selectedPane: string | null;
  onSelect: (pane: string) => void;
  boardLive: boolean;
}) {
  const { nodes, selectedPane, onSelect, boardLive } = props;
  const { t } = useI18n();
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return nodes;
    return nodes.filter((n) =>
      `${n.name} ${n.agent} ${n.tmux_pane} ${n.session_id} ${n.status}`.toLowerCase().includes(q),
    );
  }, [nodes, query]);

  const liveCount = nodes.filter((n) => n.status === "running").length;

  return (
    <aside className="dr-rail">
      <div className="dr-rail__head">
        <span className="dr-rail__title">{t("nodes.title")}</span>
        <span className="dr-rail__meta">
          <span className={cx("dr-spark", boardLive && "is-on")} />
          {t("nodes.live", { live: liveCount, total: nodes.length })}
        </span>
      </div>

      <input
        className="dr-rail__search"
        type="text"
        placeholder={t("nodes.filter")}
        value={query}
        spellCheck={false}
        onChange={(e) => setQuery(e.target.value)}
      />

      <div className="dr-rail__list">
        {filtered.length === 0 && (
          <div className="dr-rail__empty">{nodes.length ? t("nodes.noMatch") : t("nodes.none")}</div>
        )}
        {filtered.map((n, i) => (
          <button
            key={n.tmux_pane || n.session_id || n.name}
            type="button"
            data-node={n.name}
            className={cx("dr-node", n.tmux_pane === selectedPane && "is-selected", n.terminal_allowed === false && "is-locked")}
            style={{ animationDelay: `${Math.min(i, 14) * 26}ms` }}
            disabled={n.terminal_allowed === false}
            title={n.terminal_allowed === false ? t("nodes.notViewable") : undefined}
            onClick={() => onSelect(n.tmux_pane)}
          >
            <span className={cx("dr-node__dot", statusClass(n.status))} />
            <span className="dr-node__body">
              <span className="dr-node__top">
                <span className="dr-node__name">{n.name}</span>
                <span className="dr-node__agent" title={n.agent}>
                  {agentGlyph(n.agent)} {n.agent}
                </span>
              </span>
              <span className="dr-node__sub">
                <span className="dr-node__pane">{n.tmux_pane}</span>
                <span className={cx("dr-node__status", statusClass(n.status))}>
                  {statusLabel(t, n.status)}
                </span>
              </span>
            </span>
          </button>
        ))}
      </div>
    </aside>
  );
}
