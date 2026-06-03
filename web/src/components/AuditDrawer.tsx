import { useEffect, useRef, useState } from "react";

import { actorLabel, api, targetLabel } from "../api";
import type { AuditEvent } from "../api";
import { cx, fmtAgo } from "../constants";
import { useI18n } from "../i18n";
import { useFocusTrap } from "../useFocusTrap";

const PAGE = 4;

// Autonomy actions (v1.10 backend): node self-claim + retrospective. Surfaced
// with distinct chips/icons and exposed as quick filters.
const ACTION_FILTERS = ["", "autopickup", "retro"] as const;

function actionClass(action: string): string {
  if (action === "autopickup") return "is-autopickup";
  if (action === "retro") return "is-retro";
  return "";
}
function actionGlyph(action: string): string {
  if (action === "autopickup") return "⚡";
  if (action === "retro") return "↺";
  return "";
}

/**
 * Read-only audit lane (drawer). Consumes GET /api/audit (cursor-paged) with
 * action + node filters, rendering each event as actor · action · target · time.
 */
export function AuditDrawer(props: { open: boolean; projectTick: number; onClose: () => void }) {
  const { open, projectTick, onClose } = props;
  const { t } = useI18n();
  const panelRef = useRef<HTMLElement | null>(null);
  useFocusTrap(open, panelRef);

  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [cursor, setCursor] = useState(0);
  // next_cursor is always returned, so end-of-list = a short page, not a null
  // cursor (mirrors web_app.py audit_endpoint).
  const [hasMore, setHasMore] = useState(false);
  const [action, setAction] = useState("");
  const [node, setNode] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // (Re)load page 1 on open / filter change / project switch.
  useEffect(() => {
    if (!open) return;
    let alive = true;
    setLoading(true);
    setError(null);
    api
      .getAudit({ limit: PAGE, action: action || undefined, node: node || undefined })
      .then((page) => {
        if (!alive) return;
        const items = Array.isArray(page.items) ? page.items : [];
        setEvents(items);
        setCursor(page.next_cursor ?? 0);
        setHasMore(items.length === PAGE);
      })
      .catch((e: unknown) => {
        if (alive) setError(e instanceof Error ? e.message : t("audit.loadError"));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, action, node, projectTick]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const loadMore = () => {
    if (!hasMore || loading) return;
    setLoading(true);
    api
      .getAudit({ cursor, limit: PAGE, action: action || undefined, node: node || undefined })
      .then((page) => {
        const items = Array.isArray(page.items) ? page.items : [];
        setEvents((prev) => [...prev, ...items]);
        setCursor(page.next_cursor ?? cursor);
        setHasMore(items.length === PAGE);
      })
      .catch(() => {
        /* keep what we have */
      })
      .finally(() => setLoading(false));
  };

  if (!open) return null;

  return (
    <div className="dr-drawer audit-drawer">
      <div className="dr-drawer__scrim" onClick={onClose} />
      <aside
        className="dr-drawer__panel audit-panel"
        role="dialog"
        aria-modal="true"
        aria-label={t("audit.title")}
        tabIndex={-1}
        ref={panelRef}
      >
        <header className="dr-drawer__head">
          <div className="dr-drawer__id">
            <span className="dr-drawer__ticket">⌗ {t("audit.title")}</span>
          </div>
          <button type="button" className="dr-drawer__close" onClick={onClose} aria-label={t("drawer.close")}>
            ✕
          </button>
        </header>

        <div className="audit-quickfilter" role="group" aria-label={t("audit.filterAction")}>
          {ACTION_FILTERS.map((a) => (
            <button
              key={a || "all"}
              type="button"
              data-action={a || "all"}
              className={cx("audit-qf", actionClass(a), action === a && "is-on")}
              aria-pressed={action === a}
              onClick={() => setAction(a)}
            >
              {a ? `${actionGlyph(a)} ${t(`audit.action.${a}`)}` : t("audit.action.all")}
            </button>
          ))}
        </div>

        <div className="audit-filter">
          <input
            className="dr-input"
            name="action"
            type="text"
            placeholder={t("audit.filterAction")}
            value={action}
            spellCheck={false}
            onChange={(e) => setAction(e.target.value)}
          />
          <input
            className="dr-input"
            name="node"
            type="text"
            placeholder={t("audit.filterNode")}
            value={node}
            spellCheck={false}
            onChange={(e) => setNode(e.target.value)}
          />
        </div>

        <div className="dr-drawer__scroll audit-list">
          {error && <div className="audit-msg is-error">{error}</div>}
          {!error && events.length === 0 && !loading && <div className="audit-msg">{t("audit.empty")}</div>}
          {events.map((ev, i) => (
            <div key={ev.cursor ?? `${ev.ts}-${i}`} className={cx("audit-event", actionClass(ev.action))}>
              <span className="audit-event__actor">{actorLabel(ev.actor)}</span>
              <span className={cx("audit-event__action", actionClass(ev.action))} data-action={ev.action}>
                {actionGlyph(ev.action) && <span className="audit-event__glyph" aria-hidden="true">{actionGlyph(ev.action)}</span>}
                {ev.action}
              </span>
              <span className="audit-event__target">{targetLabel(ev.target)}</span>
              <span className="audit-event__ts">{fmtAgo(ev.ts)}</span>
            </div>
          ))}
          {hasMore && (
            <button type="button" className="dr-btn dr-btn--ghost audit-more" onClick={loadMore} disabled={loading}>
              {loading ? t("audit.loading") : t("audit.more")}
            </button>
          )}
        </div>
      </aside>
    </div>
  );
}
