import { cx } from "../constants";
import { useI18n } from "../i18n";
import type { NodeHealth, NodeHealthStatus } from "../types";

const KNOWN: NodeHealthStatus[] = ["healthy", "rate_limited", "login_required", "crashed", "cooldown", "hung"];

/**
 * PR1 watchdog node-health badge - display-only (no recovery actions/buttons).
 * Renders a compact LED + status label for a node's process health. A missing
 * entry or unrecognised status degrades to a neutral "unknown" badge. `compact`
 * drops the visible text (LED only; the label stays in the tooltip).
 */
export function NodeHealthBadge({ health, compact }: { health?: NodeHealth | null; compact?: boolean }) {
  const { t } = useI18n();
  const status: NodeHealthStatus = health?.status && KNOWN.includes(health.status) ? health.status : "unknown";
  const label = t(`nodehealth.${status}`);
  const reason = health?.reason || health?.message;
  return (
    <span
      className={cx("nodehealth", `is-${status}`, compact && "is-compact")}
      data-health={status}
      data-node-health={health?.node}
      role="status"
      title={reason ? `${label} - ${reason}` : label}
      aria-label={label}
    >
      <span className="nodehealth__led" aria-hidden="true" />
      {!compact && <span className="nodehealth__txt">{label}</span>}
    </span>
  );
}
