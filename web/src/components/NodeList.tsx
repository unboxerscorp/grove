import { useMemo, useState } from "react";

import { agentGlyph, cx } from "../constants";
import { statusLabel, useI18n } from "../i18n";
import { liveNodeCount } from "../nodeLive";
import { buildOrgTree, isBgServiceNode } from "../orgTree";
import type { GroveNode } from "../types";
import { NodeHealthBadge } from "./NodeHealthBadge";

function statusClass(status: string): string {
  switch (status) {
    case "active":
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

  const orgTree = useMemo(() => buildOrgTree(nodes), [nodes]);
  const ordered = useMemo(
    () => [
      ...orgTree.rows.map((row) => ({ ...row, section: "tree" as const })),
      ...orgTree.serviceNodes.map((node) => ({ node, depth: 0, section: "services" as const })),
    ],
    [orgTree],
  );
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return ordered;
    return ordered.filter(({ node }) =>
      `${node.name} ${node.agent} ${node.kind ?? ""} ${node.group ?? ""} ${node.tmux_pane} ${node.session_id} ${node.status}`
        .toLowerCase()
        .includes(q),
    );
  }, [ordered, query]);

  const liveCount = liveNodeCount(nodes);

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
        {filtered.map(({ node: n, depth, section }, i) => (
          <button
            key={n.tmux_pane || n.session_id || n.name}
            type="button"
            data-node={n.name}
            data-depth={depth}
            data-section={section}
            className={cx(
              "dr-node",
              n.tmux_pane === selectedPane && "is-selected",
              n.terminal_allowed === false && "is-locked",
              isBgServiceNode(n) && "is-service",
            )}
            style={
              {
                "--depth": depth,
                "--indent": `${depth * 14}px`,
                "--branch": `${Math.max(0, depth - 1) * 14}px`,
                animationDelay: `${Math.min(i, 14) * 26}ms`,
              } as React.CSSProperties
            }
            disabled={n.terminal_allowed === false}
            title={n.terminal_allowed === false ? t("nodes.notViewable") : undefined}
            onClick={() => onSelect(n.tmux_pane)}
          >
            <span className={cx("dr-node__dot", statusClass(n.status))} />
            <span className="dr-node__body">
              <span className="dr-node__top">
                <span className="dr-node__name">{n.name}</span>
                <NodeHealthBadge health={n.health} compact />
                <span className="dr-node__agent" title={n.agent}>
                  {isBgServiceNode(n) ? t("node.kind.service") : `${agentGlyph(n.agent)} ${n.agent}`}
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
