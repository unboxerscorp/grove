import { useCallback, useEffect, useState } from "react";

import { api } from "../api";
import type { CostMetric, LedgerMemberRollup, LedgerReport } from "../api";
import { cx } from "../constants";
import { useI18n } from "../i18n";
import type { TFn } from "../i18n";

function LedgerMark() {
  return (
    <svg className="ledger__mark" viewBox="0 0 24 24" width={20} height={20} aria-hidden="true">
      <rect x={4} y={3} width={16} height={18} rx={2} fill="none" stroke="currentColor" strokeWidth={1.5} />
      <path d="M8 8h8M8 12h8M8 16h5" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" />
    </svg>
  );
}

function fmtTokens(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(n);
}

function isUnknown(m?: CostMetric): boolean {
  return !m || m.value === null || m.value === undefined || m.status === "unknown" || m.confidence === "unknown";
}

/** A metric cell that NEVER invents a value: null / unknown reads "알 수 없음". */
function Metric({ m, kind, t }: { m: CostMetric; kind: "count" | "tokens" | "cost"; t: TFn }) {
  const unknown = isUnknown(m);
  const text = unknown
    ? t("cost.unknown")
    : kind === "cost"
      ? `$${(m.value as number).toFixed(2)}`
      : kind === "tokens"
        ? fmtTokens(m.value as number)
        : String(m.value);
  return (
    <span className={cx("ledger-metric", unknown && "is-unknown")} data-unknown={unknown ? "1" : "0"}>
      {text}
    </span>
  );
}

function roleClass(role?: string): string {
  switch ((role ?? "").toLowerCase()) {
    case "admin":
      return "is-admin";
    case "operator":
      return "is-operator";
    case "viewer":
      return "is-viewer";
    default:
      return "is-member";
  }
}

/** Operator-only inline budget editor: edit → save → CONFIRM → POST. Hidden for
 *  viewers/members. Disabled (404) degrades to a graceful notice upstream. */
function QuotaControl({ row, onChanged, t }: { row: LedgerMemberRollup; onChanged: () => void; t: TFn }) {
  const q = row.quota;
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [runLimit, setRunLimit] = useState(q.soft_run_limit != null ? String(q.soft_run_limit) : "");
  const [tokenLimit, setTokenLimit] = useState(q.soft_token_limit != null ? String(q.soft_token_limit) : "");
  const [costLimit, setCostLimit] = useState(q.soft_cost_usd != null ? String(q.soft_cost_usd) : "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<"disabled" | "forbidden" | "error" | null>(null);

  const num = (s: string): number | null => {
    const v = s.trim();
    if (!v) return null;
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? n : null;
  };

  const submit = () => {
    setBusy(true);
    setErr(null);
    api
      .setQuota({
        member_id: row.member.id,
        enabled: true,
        soft_run_limit: num(runLimit),
        soft_token_limit: num(tokenLimit),
        soft_cost_usd: num(costLimit),
      })
      .then(() => {
        setBusy(false);
        setConfirming(false);
        setEditing(false);
        onChanged();
      })
      .catch((e: unknown) => {
        setBusy(false);
        setConfirming(false);
        const m = e instanceof Error ? e.message : "";
        setErr(/\b404\b/.test(m) ? "disabled" : /\b403\b/.test(m) ? "forbidden" : "error");
      });
  };

  if (!editing) {
    return (
      <button type="button" className="dr-btn dr-btn--ghost ledger-quota__edit" onClick={() => setEditing(true)}>
        {q.configured ? t("ledger.quota.editExisting") : t("ledger.quota.set")}
      </button>
    );
  }

  return (
    <div className="ledger-quota__form" data-quota-edit={row.member.id}>
      <div className="ledger-quota__fields">
        <label className="ledger-quota__field">
          <span className="ledger-quota__k">{t("ledger.quota.runs")}</span>
          <input className="dr-input ledger-quota__run" name="softRun" type="number" min={0} value={runLimit} onChange={(e) => setRunLimit(e.target.value)} />
        </label>
        <label className="ledger-quota__field">
          <span className="ledger-quota__k">{t("ledger.quota.tokens")}</span>
          <input className="dr-input ledger-quota__token" name="softToken" type="number" min={0} value={tokenLimit} onChange={(e) => setTokenLimit(e.target.value)} />
        </label>
        <label className="ledger-quota__field">
          <span className="ledger-quota__k">{t("ledger.quota.cost")}</span>
          <input className="dr-input ledger-quota__cost" name="softCost" type="number" min={0} step="0.01" value={costLimit} onChange={(e) => setCostLimit(e.target.value)} />
        </label>
      </div>
      {err && <div className="ledger-msg is-error" data-quota-err={err}>{t(`ledger.quota.err.${err}`)}</div>}
      {confirming ? (
        <div className="ledger-quota__confirm">
          <span className="ledger-quota__q">{t("ledger.quota.confirm")}</span>
          <button type="button" className="dr-btn dr-btn--primary ledger-quota__yes" disabled={busy} onClick={submit}>
            {busy ? t("ledger.quota.saving") : t("ledger.quota.yes")}
          </button>
          <button type="button" className="dr-btn dr-btn--ghost ledger-quota__no" onClick={() => setConfirming(false)}>
            {t("ledger.quota.no")}
          </button>
        </div>
      ) : (
        <div className="ledger-quota__actions">
          <button type="button" className="dr-btn dr-btn--primary ledger-quota__save" onClick={() => setConfirming(true)}>
            {t("ledger.quota.save")}
          </button>
          <button type="button" className="dr-btn dr-btn--ghost ledger-quota__cancel" onClick={() => setEditing(false)}>
            {t("ledger.quota.cancel")}
          </button>
        </div>
      )}
    </div>
  );
}

function MemberRow({ row, quotaEnabled, isViewer, onChanged, t }: { row: LedgerMemberRollup; quotaEnabled: boolean; isViewer: boolean; onChanged: () => void; t: TFn }) {
  const q = row.quota;
  const throttled = q.soft_throttle?.active === true;
  const limitText = [
    q.soft_run_limit != null ? `${t("ledger.quota.runs")} ${q.soft_run_limit}` : null,
    q.soft_token_limit != null ? `${t("ledger.quota.tokens")} ${fmtTokens(q.soft_token_limit)}` : null,
    q.soft_cost_usd != null ? `${t("ledger.quota.cost")} $${q.soft_cost_usd}` : null,
  ].filter(Boolean).join(" · ");

  return (
    <div className="ledger-member" data-member={row.member.id} data-role={row.member.role}>
      <div className="ledger-member__head">
        <span className={cx("ledger-chip", roleClass(row.member.role))}>
          <span className="ledger-chip__dot" aria-hidden="true" />
          {row.member.name ?? row.member.id}
        </span>
        <span className="ledger-member__role">{row.member.role}</span>
      </div>

      <div className="ledger-member__grid">
        <div className="ledger-cell">
          <span className="ledger-cell__k">{t("ledger.runs")}</span>
          <Metric m={row.totals.runs} kind="count" t={t} />
        </div>
        <div className="ledger-cell">
          <span className="ledger-cell__k">{t("ledger.tokens")}</span>
          <Metric m={row.totals.total_tokens} kind="tokens" t={t} />
        </div>
        <div className="ledger-cell">
          <span className="ledger-cell__k">{t("ledger.cost")}</span>
          <Metric m={row.totals.cost_usd_estimate} kind="cost" t={t} />
        </div>
      </div>

      {/* my-budget vs soft budget + soft-throttle (warning only, never a kill) */}
      {quotaEnabled && q.enabled ? (
        <div className={cx("ledger-budget", throttled && "is-throttled")} data-budget-status={q.status}>
          <span className="ledger-budget__k">{t("ledger.budget")}</span>
          {limitText && <span className="ledger-budget__limit">{limitText}</span>}
          {throttled ? (
            <span className="ledger-throttle is-active" data-throttle="active">
              ⚠ {t("ledger.throttle")}
              <span className="ledger-throttle__note">{t("ledger.throttleNote")}</span>
            </span>
          ) : (
            <span className="ledger-budget__ok">✓ {t("ledger.budgetOk")}</span>
          )}
        </div>
      ) : (
        <div className="ledger-budget is-none">{t("ledger.budgetNone")}</div>
      )}

      {(row.warnings ?? []).map((w, i) => (
        <div key={i} className="ledger-warn" data-warn="1">
          ⚠ {w}
        </div>
      ))}

      {/* operator-only quota control; viewers/members see a read-only note */}
      {quotaEnabled &&
        (isViewer ? (
          <div className="ledger-quota__readonly">{t("ledger.quota.readonly")}</div>
        ) : (
          <QuotaControl row={row} onChanged={onChanged} t={t} />
        ))}
    </div>
  );
}

function HostPressure({ host, t }: { host: LedgerReport["host_pressure"]; t: TFn }) {
  const saturated = host.status === "saturated";
  return (
    <div className={cx("ledger-host", saturated ? "is-saturated" : "is-nominal")} data-status={host.status}>
      <div className="ledger-host__head">
        <span className="ledger-host__title">{t("ledger.host.title")}</span>
        <span className={cx("ledger-host__badge", saturated && "is-warn")} data-host={host.status}>
          {saturated ? `⚠ ${t("ledger.host.saturated")}` : t("ledger.host.nominal")}
        </span>
      </div>
      <div className="ledger-host__grid">
        <div className="ledger-cell">
          <span className="ledger-cell__k">{t("ledger.host.running")}</span>
          <Metric m={host.running} kind="count" t={t} />
        </div>
        <div className="ledger-cell">
          <span className="ledger-cell__k">{t("ledger.host.capacity")}</span>
          <Metric m={host.capacity} kind="count" t={t} />
        </div>
        <div className="ledger-cell">
          <span className="ledger-cell__k">{t("ledger.host.ratio")}</span>
          <span className={cx("ledger-host__ratio", saturated && "is-warn")} data-ratio={host.ratio?.value ?? ""}>
            {host.ratio?.value != null ? `${Math.round((host.ratio.value as number) * 100)}%` : t("cost.unknown")}
          </span>
        </div>
        {host.blocked_tasks && (
          <div className="ledger-cell">
            <span className="ledger-cell__k">{t("ledger.host.blocked")}</span>
            <Metric m={host.blocked_tasks} kind="count" t={t} />
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Per-member ledger + soft quota + host pressure (v1.19). All READ-ONLY except
 * the operator-only quota control (explicit confirm + role-gated). Cost and agy
 * credit stay honestly unknown ("알 수 없음", never invented). A soft quota only
 * warns (soft-throttle) — it NEVER hard-kills running work (hard_kill:false).
 */
export function LedgerPanel({ projectTick, onChanged }: { projectTick: number; onChanged: () => void }) {
  const { t } = useI18n();
  const [report, setReport] = useState<LedgerReport | null>(null);
  const [isViewer, setIsViewer] = useState(false);
  const [errCode, setErrCode] = useState<"forbidden" | "error" | null>(null);
  const [tick, setTick] = useState(0);

  const refresh = useCallback(() => {
    setTick((x) => x + 1);
    onChanged();
  }, [onChanged]);

  useEffect(() => {
    let alive = true;
    api
      .getMe()
      .then((me) => alive && setIsViewer(me?.member?.role === "viewer"))
      .catch(() => alive && setIsViewer(false));
    return () => {
      alive = false;
    };
  }, [projectTick, tick]);

  useEffect(() => {
    let alive = true;
    api
      .getLedger()
      .then((r) => {
        if (!alive) return;
        setReport(r);
        setErrCode(null);
      })
      .catch((e: unknown) => {
        if (!alive) return;
        const m = e instanceof Error ? e.message : "";
        setErrCode(/\b403\b/.test(m) ? "forbidden" : "error");
      });
    return () => {
      alive = false;
    };
  }, [projectTick, tick]);

  return (
    <section className="ledger">
      <div className="ledger__scroll">
        <header className="ledger__head">
          <div className="ledger__title-wrap">
            <LedgerMark />
            <h2 className="ledger__title">{t("ledger.title")}</h2>
          </div>
          {report && (
            <span className="ledger__scope" data-scope={report.scope}>
              {report.scope === "self" ? t("ledger.scopeSelf") : t("ledger.scopeAll")}
            </span>
          )}
        </header>
        <p className="ledger__note">{t("ledger.note")}</p>

        {errCode === "forbidden" && <div className="ledger-msg is-warn">{t("ledger.forbidden")}</div>}
        {errCode === "error" && <div className="ledger-msg is-error">{t("ledger.error")}</div>}

        {report && (
          <>
            <HostPressure host={report.host_pressure} t={t} />

            {!report.quota_enabled && <div className="ledger-quota__disabled">{t("ledger.quota.disabled")}</div>}

            <div className="ledger-members">
              {report.members.map((row) => (
                <MemberRow
                  key={row.member.id}
                  row={row}
                  quotaEnabled={report.quota_enabled}
                  isViewer={isViewer}
                  onChanged={refresh}
                  t={t}
                />
              ))}
            </div>
          </>
        )}
      </div>
    </section>
  );
}
