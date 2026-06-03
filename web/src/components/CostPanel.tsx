import { useCallback, useEffect, useRef, useState } from "react";

import { api } from "../api";
import type { CostAgent, CostMetric, CostSummary } from "../api";
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

function fmtCost(n: number, cur: string): string {
  return cur === "USD" ? `$${n.toFixed(2)}` : `${n.toFixed(2)} ${cur}`;
}

/** A value is estimated (must not read as a hard fact) when it comes from an
 *  estimate source or was inferred rather than explicitly reported. */
function isEstimated(m: CostMetric): boolean {
  return m.source === "estimate" || m.confidence === "inferred";
}

function isUnknown(m: CostMetric): boolean {
  return m.value === null || m.value === undefined || m.status === "unknown";
}

function MetricView({ m, kind, currency, t }: { m: CostMetric; kind: "tokens" | "cost"; currency: string; t: TFn }) {
  const unknown = isUnknown(m);
  const est = isEstimated(m);
  return (
    <div className={cx("cost-metric", est && "is-est", unknown && "is-unknown")} data-est={est ? "1" : "0"}>
      <span className="cost-metric__value">
        {unknown
          ? t("cost.unknown")
          : kind === "cost"
            ? fmtCost(m.value as number, currency)
            : fmtTokens(m.value as number)}
      </span>
      {est && !unknown && (
        <span className="cost-metric__badge" title={t("cost.estimateHint")}>
          ~ {t("cost.estimate")}
        </span>
      )}
      <span className="cost-metric__prov">
        {t(`cost.source.${m.source}`)} · {t(`cost.conf.${m.confidence}`)}
      </span>
    </div>
  );
}

function CreditView({ credit, currency, t }: { credit: CostMetric; currency: string; t: TFn }) {
  // Backend authority is final: if credit is unknown we say so and never
  // back-fill an estimated remaining balance.
  const unknown = isUnknown(credit);
  return (
    <div className={cx("cost-credit", unknown && "is-unknown")}>
      <span className="cost-credit__k">{t("cost.credit")}</span>
      {unknown ? (
        <span className="cost-credit__unknown">⚠ {t("cost.creditUnknown")}</span>
      ) : (
        <MetricView m={credit} kind="cost" currency={currency} t={t} />
      )}
      {credit.warning && <div className="cost-credit__warn">⚠ {credit.warning}</div>}
    </div>
  );
}

function AgentCard({ a, currency, t }: { a: CostAgent; currency: string; t: TFn }) {
  return (
    <div className="cost-card" data-agent={a.agent}>
      <div className="cost-card__head">
        <span className="cost-card__glyph">{agentGlyph(a.agent)}</span>
        <span className="cost-card__name">{a.agent}</span>
      </div>
      <div className="cost-card__grid">
        <div className="cost-cell">
          <span className="cost-cell__k">{t("cost.tokens")}</span>
          <MetricView m={a.tokens} kind="tokens" currency={currency} t={t} />
        </div>
        <div className="cost-cell">
          <span className="cost-cell__k">{t("cost.cost")}</span>
          <MetricView m={a.cost} kind="cost" currency={currency} t={t} />
        </div>
      </div>
      {a.credit && <CreditView credit={a.credit} currency={currency} t={t} />}
    </div>
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

  const currency = data?.currency ?? "USD";
  const agents = data?.agents ?? [];

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
        {!errCode && !loading && agents.length === 0 && <div className="cost__msg">{t("cost.empty")}</div>}

        {!errCode && agents.length > 0 && (
          <>
            {data?.totals && (
              <div className="cost-card cost-card--total" data-agent="__total">
                <div className="cost-card__head">
                  <span className="cost-card__name">{t("cost.total")}</span>
                </div>
                <div className="cost-card__grid">
                  <div className="cost-cell">
                    <span className="cost-cell__k">{t("cost.tokens")}</span>
                    <MetricView m={data.totals.tokens} kind="tokens" currency={currency} t={t} />
                  </div>
                  <div className="cost-cell">
                    <span className="cost-cell__k">{t("cost.cost")}</span>
                    <MetricView m={data.totals.cost} kind="cost" currency={currency} t={t} />
                  </div>
                </div>
              </div>
            )}

            <div className="cost-grid">
              {agents.map((a) => (
                <AgentCard key={a.agent} a={a} currency={currency} t={t} />
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
      </div>
    </section>
  );
}
