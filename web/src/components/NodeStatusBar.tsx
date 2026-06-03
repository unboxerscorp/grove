import { useEffect, useRef, useState } from "react";

import { api } from "../api";
import type { NodeDetail, NodeSummary } from "../api";
import { cx, fmtAgo } from "../constants";
import { statusLabel, useI18n } from "../i18n";

function detailClass(s: string): string {
  switch (s) {
    case "running":
      return "is-running";
    case "error":
      return "is-error";
    case "blocked":
      return "is-blocked";
    case "dead":
      return "is-dead";
    default:
      return "is-idle";
  }
}

/**
 * Sub-header node-liveness heatmap for the active project. Reads the server's
 * authoritative summary from GET /api/status ({nodes:{running,total,stale}}),
 * derives idle = total - running - stale, and renders a proportion bar + chips.
 * The "Detail" toggle fetches GET /api/status?detail=1 for a per-node breakdown
 * (status, last-seen, and an "inferred" badge when source !== heartbeat).
 * Polls and re-runs on liveTick (board events) and projectTick (project switch).
 */
export function NodeStatusBar({ liveTick, projectTick }: { liveTick: number; projectTick: number }) {
  const { t } = useI18n();
  const [summary, setSummary] = useState<NodeSummary | null>(null);
  const [detail, setDetail] = useState<NodeDetail[] | null>(null);
  const [open, setOpen] = useState(false);
  const openRef = useRef(open);
  openRef.current = open;

  useEffect(() => {
    let alive = true;
    const load = () =>
      api
        .getStatus(openRef.current)
        .then((s) => {
          if (!alive) return;
          setSummary(s.nodes ?? null);
          if (openRef.current) setDetail(s.node_details ?? []);
        })
        .catch(() => {
          /* keep last */
        });
    void load();
    const id = setInterval(() => void load(), 5000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [liveTick, projectTick]);

  // Fetch the per-node detail as soon as the panel is opened.
  useEffect(() => {
    if (!open) return;
    let alive = true;
    api
      .getStatus(true)
      .then((s) => {
        if (alive) setDetail(s.node_details ?? []);
      })
      .catch(() => {
        /* keep last */
      });
    return () => {
      alive = false;
    };
  }, [open, liveTick, projectTick]);

  const running = summary?.running ?? 0;
  const total = summary?.total ?? 0;
  const stale = summary?.stale ?? 0;
  const idle = Math.max(0, total - running - stale);

  return (
    <div className="nodestat" role="status" aria-label={t("status.nodes")}>
      <span className="nodestat__label">{t("status.nodes")}</span>
      <div className="nodestat__bar" aria-hidden="true">
        <span className="nodestat__seg is-running" style={{ flexGrow: running }} />
        <span className="nodestat__seg is-idle" style={{ flexGrow: idle }} />
        <span className="nodestat__seg is-stale" style={{ flexGrow: stale }} />
      </div>
      <span className="nodestat__chip is-running">
        <span className="nodestat__led" />
        {running} {t("status.running")}
      </span>
      <span className="nodestat__chip is-idle">
        <span className="nodestat__led" />
        {idle} {t("status.idle")}
      </span>
      <span className="nodestat__chip is-stale">
        <span className="nodestat__led" />
        {stale} {t("status.stale")}
      </span>
      <span className="nodestat__total">
        {total} {t("status.total")}
      </span>
      <button
        type="button"
        className={cx("nodestat__more", open && "is-open")}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        {t("status.detail")} ▾
      </button>

      {open && (
        <div className="nodestat-detail" role="region" aria-label={t("status.detail")}>
          {(detail ?? []).map((d) => (
            <div key={d.name} className="nodestat-row">
              <span className={cx("nodestat__led", detailClass(d.status))} />
              <span className="nodestat-row__name">{d.name}</span>
              <span className={cx("nodestat-row__status", detailClass(d.status))}>{statusLabel(t, d.status)}</span>
              {d.confidence === "inferred" && (
                <span className="nodestat-row__inferred" title={d.status_reason ?? ""}>
                  {t("status.inferred")}
                </span>
              )}
              <span className="nodestat-row__seen">
                {t("status.lastSeen")} {fmtAgo(d.last_seen)}
              </span>
            </div>
          ))}
          {detail && detail.length === 0 && <div className="nodestat-row nodestat-row--empty">—</div>}
        </div>
      )}
    </div>
  );
}
