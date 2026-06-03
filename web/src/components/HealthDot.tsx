import { useEffect, useState } from "react";

import { api } from "../api";
import type { Health } from "../api";
import { cx } from "../constants";
import { useI18n } from "../i18n";

/**
 * Header server-health indicator. Polls the unauthenticated GET /api/health
 * ({ok, board_ok?}) and shows a single LED: teal=ok, amber=board degraded,
 * coral=down, slate=checking.
 */
export function HealthDot() {
  const { t } = useI18n();
  const [health, setHealth] = useState<Health | null>(null);

  useEffect(() => {
    let alive = true;
    const load = () =>
      api
        .getHealth()
        .then((h) => {
          if (alive) setHealth(h);
        })
        .catch(() => {
          if (alive) setHealth({ ok: false });
        });
    void load();
    const id = setInterval(() => void load(), 10000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  const state = !health ? "pending" : !health.ok ? "down" : health.board_ok === false ? "degraded" : "ok";
  const label = t(`health.${state}`);

  return (
    <span className={cx("health-dot", `is-${state}`)} role="status" title={label} aria-label={label}>
      <span className="health-dot__led" />
      <span className="health-dot__txt">{label}</span>
    </span>
  );
}
