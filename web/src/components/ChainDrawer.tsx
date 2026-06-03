import { useEffect, useMemo, useRef, useState } from "react";

import { actorId, api, targetNode } from "../api";
import type { AuditEvent } from "../api";
import { cx } from "../constants";
import { useI18n } from "../i18n";
import { useFocusTrap } from "../useFocusTrap";

const FETCH_LIMIT = 100;

/**
 * Build a delegation graph (actor -> target.node) from assign/delegate audit
 * events and enumerate maximal chains: every path from a delegation root (no
 * incoming delegation) to a leaf. Duplicate edges are merged; a per-walk `seen`
 * set makes cycles graceful (a path stops at the first repeat, never loops).
 */
function buildChains(events: AuditEvent[]): string[][] {
  const adj = new Map<string, Set<string>>();
  const indeg = new Map<string, number>();
  const nodes = new Set<string>();
  for (const ev of events) {
    if (ev.action !== "assign" && ev.action !== "delegate") continue;
    const from = actorId(ev.actor);
    const to = targetNode(ev.target);
    if (!from || !to || from === to) continue;
    nodes.add(from);
    nodes.add(to);
    if (!adj.has(from)) adj.set(from, new Set());
    if (!indeg.has(from)) indeg.set(from, indeg.get(from) ?? 0);
    if (adj.get(from)!.has(to)) continue; // merge duplicate edges
    adj.get(from)!.add(to);
    indeg.set(to, (indeg.get(to) ?? 0) + 1);
  }

  const paths: string[][] = [];
  const walk = (n: string, trail: string[], seen: Set<string>) => {
    const next = adj.get(n);
    const children = next ? [...next].filter((c) => !seen.has(c)) : [];
    if (children.length === 0) {
      if (trail.length >= 2) paths.push(trail); // a chain has >=1 hop
      return;
    }
    for (const c of children) {
      const ns = new Set(seen);
      ns.add(c);
      walk(c, [...trail, c], ns);
    }
  };

  const roots = [...nodes].filter((n) => (indeg.get(n) ?? 0) === 0);
  for (const r of roots) walk(r, [r], new Set([r]));
  // Pure-cycle fallback (no roots): start from every node so chains still show.
  if (paths.length === 0 && nodes.size > 0) {
    for (const n of nodes) walk(n, [n], new Set([n]));
  }

  // Longest (most multi-hop) chains first; dedupe identical node sequences.
  const seenKeys = new Set<string>();
  return paths
    .sort((a, b) => b.length - a.length)
    .filter((p) => {
      const key = p.join(">");
      if (seenKeys.has(key)) return false;
      seenKeys.add(key);
      return true;
    });
}

/**
 * Delegation-chain explorer. Reads /api/audit (project-scoped via the shared
 * client headers), reconstructs multi-hop delegation paths, and lists them as
 * actor -> ... -> leaf chains. A node filter focuses chains through that node
 * (upstream = chips left of the focus, downstream = chips right of it).
 */
export function ChainDrawer(props: { open: boolean; projectTick: number; onClose: () => void }) {
  const { open, projectTick, onClose } = props;
  const { t } = useI18n();
  const panelRef = useRef<HTMLElement | null>(null);
  useFocusTrap(open, panelRef);

  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [node, setNode] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    setLoading(true);
    setError(null);
    api
      .getAudit({ limit: FETCH_LIMIT })
      .then((page) => {
        if (!alive) return;
        setEvents(Array.isArray(page.items) ? page.items : []);
      })
      .catch((e: unknown) => {
        if (alive) setError(e instanceof Error ? e.message : t("chain.loadError"));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, projectTick]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const chains = useMemo(() => buildChains(events), [events]);
  const focus = node.trim();
  const shown = useMemo(
    () => (focus ? chains.filter((c) => c.includes(focus)) : chains),
    [chains, focus],
  );

  if (!open) return null;

  return (
    <div className="dr-drawer chain-drawer">
      <div className="dr-drawer__scrim" onClick={onClose} />
      <aside
        className="dr-drawer__panel chain-panel"
        role="dialog"
        aria-modal="true"
        aria-label={t("chain.title")}
        tabIndex={-1}
        ref={panelRef}
      >
        <header className="dr-drawer__head">
          <div className="dr-drawer__id">
            <span className="dr-drawer__ticket">⛓ {t("chain.title")}</span>
          </div>
          <button type="button" className="dr-drawer__close" onClick={onClose} aria-label={t("drawer.close")}>
            ✕
          </button>
        </header>

        <div className="chain-filter">
          <input
            className="dr-input"
            name="node"
            type="text"
            placeholder={t("chain.filterNode")}
            value={node}
            spellCheck={false}
            onChange={(e) => setNode(e.target.value)}
          />
          <span className="chain-filter__hint">{t("chain.flowHint")}</span>
        </div>

        <div className="dr-drawer__scroll chain-list">
          {error && <div className="chain-msg is-error">{error}</div>}
          {!error && loading && chains.length === 0 && <div className="chain-msg">{t("chain.loading")}</div>}
          {!error && !loading && shown.length === 0 && <div className="chain-msg">{t("chain.empty")}</div>}
          {shown.map((chain, ci) => {
            const hops = chain.length - 1;
            return (
              <div key={`${chain.join(">")}-${ci}`} className={cx("chain-row", hops >= 2 && "is-multihop")}>
                <div className="chain-row__path">
                  {chain.map((n, i) => (
                    <span key={`${n}-${i}`} className="chain-seg">
                      {i > 0 && <span className="chain-arrow" aria-hidden="true">→</span>}
                      <span className={cx("chain-node", focus && n === focus && "is-focus")} data-node={n}>
                        {n}
                      </span>
                    </span>
                  ))}
                </div>
                <span className="chain-row__hops">{t("chain.hops", { n: hops })}</span>
              </div>
            );
          })}
        </div>
      </aside>
    </div>
  );
}
