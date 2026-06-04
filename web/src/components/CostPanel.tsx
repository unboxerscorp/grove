import { useCallback, useEffect, useRef, useState } from "react";

import { api } from "../api";
import type { CostAgentMetrics, CostMetric, CostSummary, UsageReport } from "../api";
import { agentGlyph, cx } from "../constants";
import { useI18n } from "../i18n";
import type { TFn } from "../i18n";

function CostMark() {
  return (
    <svg className="cost__mark" viewBox="0 0 24 24" width={20} height={20} aria-hidden="true">
      <ellipse cx={12} cy={6} rx={7} ry={3} fill="none" stroke="currentColor" strokeWidth={1.5} />
      <path d="M5 6v6c0 1.66 3.13 3 7 3s7-1.34 7-3V6" fill="none" stroke="currentColor" strokeWidth={1.5} />
      <path d="M5 12v6c0 1.66 3.13 3 7 3s7-1.34 7-3v-6" fill="none" stroke="currentColor" strokeWidth={1.5} />
    </svg>
  );
}

function fmtTokens(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(n);
}

function fmtCost(n: number): string {
  return `$${n.toFixed(2)}`;
}

/** Translate a provenance token, falling back to the raw value if unmapped so an
 *  unexpected backend source/confidence never renders an i18n key. */
function provLabel(t: TFn, kind: "source" | "conf", value: string): string {
  const key = `cost.${kind}.${value}`;
  const s = t(key);
  return s === key ? value : s;
}

/** Estimated values must never read as hard facts: an estimate source or a
 *  non-explicit confidence (partial/inferred) flags the number. */
function isEstimated(m: CostMetric): boolean {
  return m.source === "estimate" || m.confidence === "partial" || m.confidence === "inferred";
}

function isUnknown(m: CostMetric): boolean {
  return m.value === null || m.value === undefined || m.status === "unknown" || m.confidence === "unknown";
}

function MetricView({ m, kind, t }: { m: CostMetric; kind: "tokens" | "cost"; t: TFn }) {
  const unknown = isUnknown(m);
  const est = isEstimated(m);
  return (
    <div className={cx("cost-metric", est && "is-est", unknown && "is-unknown")} data-est={est ? "1" : "0"}>
      <span className="cost-metric__value">
        {unknown ? t("cost.unknown") : kind === "cost" ? fmtCost(m.value as number) : fmtTokens(m.value as number)}
      </span>
      {est && !unknown && (
        <span className="cost-metric__badge" title={t("cost.estimateHint")}>
          ~ {t("cost.estimate")}
        </span>
      )}
      <span className="cost-metric__prov">
        {provLabel(t, "source", m.source)} · {provLabel(t, "conf", m.confidence)}
      </span>
    </div>
  );
}

function CreditView({ credit, warnings, t }: { credit?: CostMetric; warnings?: string[]; t: TFn }) {
  // Backend authority is final: if credit is unknown we say so and never
  // back-fill an estimated remaining balance.
  const unknown = !credit || isUnknown(credit);
  return (
    <div className={cx("cost-credit", unknown && "is-unknown")}>
      <span className="cost-credit__k">{t("cost.credit")}</span>
      {unknown ? (
        <span className="cost-credit__unknown">⚠ {t("cost.creditUnknown")}</span>
      ) : (
        <MetricView m={credit} kind="cost" t={t} />
      )}
      {(warnings ?? []).map((w, i) => (
        <div key={i} className="cost-credit__warn">
          ⚠ {w}
        </div>
      ))}
    </div>
  );
}

function AgentCard({ agent, item, t }: { agent: string; item: CostAgentMetrics; t: TFn }) {
  const hasCredit = item.credit_remaining !== undefined || (item.warnings?.length ?? 0) > 0;
  return (
    <div className="cost-card" data-agent={agent}>
      <div className="cost-card__head">
        <span className="cost-card__glyph">{agentGlyph(agent)}</span>
        <span className="cost-card__name">{agent}</span>
      </div>
      <div className="cost-card__grid">
        <div className="cost-cell">
          <span className="cost-cell__k">{t("cost.tokens")}</span>
          <MetricView m={item.total_tokens} kind="tokens" t={t} />
        </div>
        <div className="cost-cell">
          <span className="cost-cell__k">{t("cost.cost")}</span>
          <MetricView m={item.cost_usd_estimate} kind="cost" t={t} />
        </div>
      </div>
      {hasCredit && <CreditView credit={item.credit_remaining} warnings={item.warnings} t={t} />}
    </div>
  );
}

function UsageCell({ label, m, kind, t }: { label: string; m: CostMetric; kind: "tokens" | "cost"; t: TFn }) {
  return (
    <div className="usage-cell">
      <span className="usage-cell__k">{label}</span>
      <MetricView m={m} kind={kind} t={t} />
    </div>
  );
}

/**
 * Usage rollup (read-only) — node/day breakdown of runs/tokens/cost. agy stays
 * honestly unknown (CreditView "⚠ 알 수 없음 (추정하지 않음)" + warnings) — never
 * fabricated. Consistent with the v1.4 cost panel pattern.
 */
function UsageSection({ projectTick, t }: { projectTick: number; t: TFn }) {
  const [usage, setUsage] = useState<UsageReport | null>(null);
  const [errCode, setErrCode] = useState<"forbidden" | "error" | null>(null);

  useEffect(() => {
    let alive = true;
    api
      .getUsage()
      .then((u) => {
        if (alive) {
          setUsage(u);
          setErrCode(null);
        }
      })
      .catch((e: unknown) => {
        if (!alive) return;
        setUsage(null);
        setErrCode(/\b403\b/.test(e instanceof Error ? e.message : "") ? "forbidden" : "error");
      });
    return () => {
      alive = false;
    };
  }, [projectTick]);

  if (errCode === "forbidden") return <div className="usage__msg is-warn">{t("usage.forbidden")}</div>;
  if (!usage) return null;
  const nodes = usage.nodes ?? [];
  const days = usage.days ?? [];

  return (
    <section className="usage">
      <h3 className="usage__title">{t("usage.title")}</h3>
      <p className="usage__note">{t("usage.note")}</p>

      {usage.totals && (
        <div className="usage-totals" data-usage="totals">
          <UsageCell label={t("usage.runs")} m={usage.totals.runs} kind="tokens" t={t} />
          <UsageCell label={t("cost.tokens")} m={usage.totals.total_tokens} kind="tokens" t={t} />
          <UsageCell label={t("cost.cost")} m={usage.totals.cost_usd_estimate} kind="cost" t={t} />
        </div>
      )}

      <div className="usage-group">
        <div className="usage-group__h">{t("usage.byNode")}</div>
        {nodes.length === 0 && <div className="usage__msg">{t("usage.empty")}</div>}
        {nodes.map((n) => (
          <div key={n.node} className="usage-node" data-node={n.node} data-usage-agent={n.agent}>
            <div className="usage-node__head">
              <span className="usage-node__glyph">{agentGlyph(n.agent)}</span>
              <span className="usage-node__name">{n.node}</span>
              <span className="usage-node__agent">{n.agent}</span>
            </div>
            <div className="usage-row">
              <UsageCell label={t("usage.runs")} m={n.totals.runs} kind="tokens" t={t} />
              <UsageCell label={t("cost.tokens")} m={n.totals.total_tokens} kind="tokens" t={t} />
              <UsageCell label={t("cost.cost")} m={n.totals.cost_usd_estimate} kind="cost" t={t} />
            </div>
            {(n.agent === "agy" || n.credit_remaining || (n.warnings?.length ?? 0) > 0) && (
              <CreditView credit={n.credit_remaining} warnings={n.warnings} t={t} />
            )}
          </div>
        ))}
      </div>

      <div className="usage-group">
        <div className="usage-group__h">{t("usage.byDay")}</div>
        {days.length === 0 && <div className="usage__msg">{t("usage.empty")}</div>}
        {days.map((d) => (
          <div key={d.day} className="usage-day" data-day={d.day}>
            <span className="usage-day__date">{d.day}</span>
            <div className="usage-row">
              <UsageCell label={t("usage.runs")} m={d.totals.runs} kind="tokens" t={t} />
              <UsageCell label={t("cost.tokens")} m={d.totals.total_tokens} kind="tokens" t={t} />
              <UsageCell label={t("cost.cost")} m={d.totals.cost_usd_estimate} kind="cost" t={t} />
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

export function CostPanel({ projectTick = 0 }: { projectTick?: number }) {
  const { t } = useI18n();
  const [data, setData] = useState<CostSummary | null>(null);
  const [loading, setLoading] = useState(true);
  // Error kept as a code, not the raw message, so a backend path/status never
  // leaks into the UI.
  const [errCode, setErrCode] = useState<"forbidden" | "error" | null>(null);

  const tRef = useRef(t);
  tRef.current = t;

  const load = useCallback(() => {
    setLoading(true);
    api
      .getCost()
      .then((c) => {
        setData(c);
        setErrCode(null);
      })
      .catch((e: unknown) => {
        const msg = e instanceof Error ? e.message : "";
        setData(null);
        setErrCode(/\b403\b/.test(msg) ? "forbidden" : "error");
      })
      .finally(() => setLoading(false));
  }, []);

  // Re-scope on project switch.
  useEffect(() => {
    load();
  }, [load, projectTick]);

  const byAgent = data?.by_agent ?? {};
  const agentKeys = Object.keys(byAgent);

  return (
    <section className="cost">
      <div className="cost__scroll">
        <header className="cost__head">
          <div className="cost__title-wrap">
            <CostMark />
            <h2 className="cost__title">{t("cost.title")}</h2>
          </div>
          <button type="button" className="dr-btn dr-btn--ghost cost-refresh" onClick={load} disabled={loading}>
            ↻ {loading ? t("cost.refreshing") : t("cost.refresh")}
          </button>
        </header>

        <p className="cost__note">{t("cost.note")}</p>

        {errCode === "forbidden" && <div className="cost__msg is-warn">{t("cost.forbidden")}</div>}
        {errCode === "error" && <div className="cost__msg is-error">{t("cost.loadError")}</div>}
        {!errCode && !loading && agentKeys.length === 0 && <div className="cost__msg">{t("cost.empty")}</div>}

        {!errCode && agentKeys.length > 0 && (
          <>
            {data?.totals && (
              <div className="cost-card cost-card--total" data-agent="__total">
                <div className="cost-card__head">
                  <span className="cost-card__name">{t("cost.total")}</span>
                </div>
                <div className="cost-card__grid">
                  <div className="cost-cell">
                    <span className="cost-cell__k">{t("cost.tokens")}</span>
                    <MetricView m={data.totals.total_tokens} kind="tokens" t={t} />
                  </div>
                  <div className="cost-cell">
                    <span className="cost-cell__k">{t("cost.cost")}</span>
                    <MetricView m={data.totals.cost_usd_estimate} kind="cost" t={t} />
                  </div>
                </div>
              </div>
            )}

            <div className="cost-grid">
              {agentKeys.map((key) => (
                <AgentCard key={key} agent={key} item={byAgent[key]!} t={t} />
              ))}
            </div>

            <div className="cost-legend" role="note">
              <span className="cost-legend__item">
                <span className="cost-metric__badge">~ {t("cost.estimate")}</span>
                {t("cost.legendEstimate")}
              </span>
            </div>
          </>
        )}

        <UsageSection projectTick={projectTick} t={t} />
      </div>
    </section>
  );
}
