import { useMemo, useState } from "react";

import { agentGlyph, cx } from "../constants";
import { statusLabel, useI18n } from "../i18n";
import type { GroveNode } from "../types";
import { NodeHealthBadge } from "./NodeHealthBadge";

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

function hierarchicalNodes(nodes: GroveNode[]): { node: GroveNode; depth: number }[] {
  const byName = new Map(nodes.map((node) => [node.name, node]));
  const children = new Map<string, GroveNode[]>();
  const roots: GroveNode[] = [];
  for (const node of nodes) {
    const parent = node.parent ?? null;
    if (parent && byName.has(parent)) {
      const list = children.get(parent) ?? [];
      list.push(node);
      children.set(parent, list);
    } else {
      roots.push(node);
    }
  }
  const ordered: { node: GroveNode; depth: number }[] = [];
  const seen = new Set<string>();
  const visit = (node: GroveNode, depth: number) => {
    if (seen.has(node.name)) return;
    seen.add(node.name);
    ordered.push({ node, depth });
    for (const child of children.get(node.name) ?? []) visit(child, depth + 1);
  };
  for (const root of roots) visit(root, 0);
  for (const node of nodes) visit(node, 0);
  return ordered;
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

  const ordered = useMemo(() => hierarchicalNodes(nodes), [nodes]);
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return ordered;
    return ordered.filter(({ node }) =>
      `${node.name} ${node.agent} ${node.tmux_pane} ${node.session_id} ${node.status}`.toLowerCase().includes(q),
    );
  }, [ordered, query]);

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
        {filtered.map(({ node: n, depth }, i) => (
          <button
            key={n.tmux_pane || n.session_id || n.name}
            type="button"
            data-node={n.name}
            data-depth={depth}
            className={cx("dr-node", n.tmux_pane === selectedPane && "is-selected", n.terminal_allowed === false && "is-locked")}
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
