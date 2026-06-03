import { useEffect, useRef, useState } from "react";

import { api } from "../api";
import type { AuditEvent } from "../api";
import { fmtAgo } from "../constants";
import { useI18n } from "../i18n";
import { useFocusTrap } from "../useFocusTrap";

const PAGE = 4;

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
  const [cursor, setCursor] = useState<string | number | null>(null);
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
        setEvents(Array.isArray(page.events) ? page.events : []);
        setCursor(page.next_cursor ?? null);
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
    if (cursor === null || loading) return;
    setLoading(true);
    api
      .getAudit({ cursor, limit: PAGE, action: action || undefined, node: node || undefined })
      .then((page) => {
        setEvents((prev) => [...prev, ...(Array.isArray(page.events) ? page.events : [])]);
        setCursor(page.next_cursor ?? null);
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
            <div key={`${ev.ts}-${i}`} className="audit-event">
              <span className="audit-event__actor">{ev.actor}</span>
              <span className="audit-event__action">{ev.action}</span>
              <span className="audit-event__target">{ev.target}</span>
              <span className="audit-event__ts">{fmtAgo(ev.ts)}</span>
            </div>
          ))}
          {cursor !== null && (
            <button type="button" className="dr-btn dr-btn--ghost audit-more" onClick={loadMore} disabled={loading}>
              {loading ? t("audit.loading") : t("audit.more")}
            </button>
          )}
        </div>
      </aside>
    </div>
  );
}
