import { useMemo, useState } from "react";

import { agentGlyph, cx } from "../constants";
import { statusLabel, useI18n } from "../i18n";
import { liveNodeCount } from "../nodeLive";
import { buildNodeListRows, isBgServiceNode } from "../orgTree";
import type { GroveNode } from "../types";
import { NodeHealthBadge } from "./NodeHealthBadge";
import { termDnd, useTermDnd } from "../termViewsStore";

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
  // Server-authoritative tree shape from /api/org — the same childrenMap/roots
  // the OrgChart feeds buildOrgTree. Threaded in so the list's indentation
  // stays in lockstep with the org chart instead of diverging on raw parent
  // pointers (task_2149). Optional: absent → parent-pointer fallback.
  childrenMap?: Record<string, string[]>;
  roots?: string[];
}) {
  const { nodes, selectedPane, onSelect, boardLive, childrenMap, roots } = props;
  const { t } = useI18n();
  const [query, setQuery] = useState("");
  // Terminal node→grid drag-and-drop: this list is the drag SOURCE. Affordance is
  // live only while the terminal grid is mounted; a node already in the active
  // view is dimmed + non-draggable (you can't drag the same node in twice).
  const dnd = useTermDnd();
  const activeSet = useMemo(() => new Set(dnd.activeNodes), [dnd.activeNodes]);

  const ordered = useMemo(() => buildNodeListRows(nodes, childrenMap, roots), [nodes, childrenMap, roots]);
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
        {filtered.map(({ node: n, depth, section }, i) => {
          const locked = n.terminal_allowed === false;
          const inView = dnd.gridMounted && activeSet.has(n.name);
          const canDrag = dnd.gridMounted && !inView && !locked;
          const dragging = dnd.draggingNode === n.name;
          return (
            <button
              key={n.tmux_pane || n.session_id || n.name}
              type="button"
              data-node={n.name}
              data-depth={depth}
              data-section={section}
              className={cx(
                "dr-node",
                n.tmux_pane === selectedPane && "is-selected",
                locked && "is-locked",
                isBgServiceNode(n) && "is-service",
                inView && "is-inview",
                canDrag && "is-draggable",
                dragging && "is-dragging",
              )}
              style={
                {
                  "--depth": depth,
                  "--indent": `${depth * 18}px`,
                  "--branch": `${Math.max(0, depth - 1) * 18}px`,
                  animationDelay: `${Math.min(i, 14) * 26}ms`,
                } as React.CSSProperties
              }
              disabled={locked}
              title={locked ? t("nodes.notViewable") : canDrag ? t("nodes.dragHint") : undefined}
              onClick={() => onSelect(n.tmux_pane)}
              onPointerDown={
                canDrag
                  ? (e) => termDnd.startPointerDrag(n.name, e.clientX, e.clientY, e.pointerId)
                  : undefined
              }
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
              {inView && <span className="dr-node__inview">{t("nodes.inThisView")}</span>}
            </button>
          );
        })}
      </div>
    </aside>
  );
}
