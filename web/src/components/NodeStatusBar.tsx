import { useEffect, useState } from "react";

import { api } from "../api";
import type { NodeSummary } from "../api";
import { useI18n } from "../i18n";

/**
 * Sub-header node-liveness heatmap for the active project. Reads the server's
 * authoritative summary from GET /api/status ({nodes:{running,total,stale}}),
 * derives idle = total - running - stale, and renders a proportion bar + chips.
 * Polls and re-runs on liveTick (board events) and projectTick (project switch).
 */
export function NodeStatusBar({ liveTick, projectTick }: { liveTick: number; projectTick: number }) {
  const { t } = useI18n();
  const [summary, setSummary] = useState<NodeSummary | null>(null);

  useEffect(() => {
    let alive = true;
    const load = () =>
      api
        .getStatus()
        .then((s) => {
          if (alive) setSummary(s.nodes ?? null);
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
    </div>
  );
}
