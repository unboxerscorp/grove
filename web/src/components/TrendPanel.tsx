import { useEffect, useState } from "react";

import { api } from "../api";
import type { AnomalySignal, CostMetric, TrendNode, TrendSignal, UsageTrend } from "../api";
import { agentGlyph, cx } from "../constants";
import { useI18n } from "../i18n";
import type { TFn } from "../i18n";

const WINDOWS = ["7d", "14d", "30d"] as const;

function TrendMark() {
  return (
    <svg className="trend__mark" viewBox="0 0 24 24" width={20} height={20} aria-hidden="true">
      <path d="M3 17l5-5 3 3 4-6 3 4" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" />
      <circle cx={16} cy={9} r={1.6} fill="currentColor" />
    </svg>
  );
}

function isUnknown(m?: CostMetric): boolean {
  return !m || m.value === null || m.value === undefined || m.status === "unknown" || m.confidence === "unknown";
}

function fmtTokens(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(Math.round(n));
}

function tokenVal(m?: CostMetric): number {
  return isUnknown(m) ? 0 : (m!.value as number);
}

/** A trend signal is either {latest,baseline,delta,ratio} (≥2 days) or a bare
 *  unknown CostMetric (thin data / agy). Returns a compact human summary. */
function trendSummary(sig: TrendSignal | undefined, t: TFn): { text: string; dir: "up" | "down" | "flat" | "unknown" } {
  if (!sig || sig.delta === undefined) return { text: t("cost.unknown"), dir: "unknown" };
  const delta = isUnknown(sig.delta) ? null : (sig.delta.value as number);
  const ratio = isUnknown(sig.ratio) ? null : (sig.ratio!.value as number);
  if (delta === null) return { text: t("cost.unknown"), dir: "unknown" };
  const dir = delta > 0 ? "up" : delta < 0 ? "down" : "flat";
  const arrow = dir === "up" ? "▲" : dir === "down" ? "▼" : "▶";
  const ratioTxt = ratio != null ? ` ×${ratio.toFixed(2)}` : "";
  return { text: `${arrow} ${delta > 0 ? "+" : ""}${fmtTokens(delta)}${ratioTxt}`, dir };
}

function Spark({ values, spike }: { values: number[]; spike: boolean }) {
  if (values.length === 0) return null;
  const max = Math.max(1, ...values);
  const W = 150;
  const H = 36;
  const gap = 3;
  const bw = (W - gap * (values.length - 1)) / values.length;
  return (
    <svg className="trend-spark" viewBox={`0 0 ${W} ${H}`} width={W} height={H} role="img" aria-hidden="true">
      {values.map((v, i) => {
        const h = Math.max(2, (v / max) * (H - 4));
        const isLast = i === values.length - 1;
        return (
          <rect
            key={i}
            className={cx("trend-spark__bar", spike && isLast && "is-spike")}
            x={i * (bw + gap)}
            y={H - h}
            width={bw}
            height={h}
            rx={1}
          />
        );
      })}
    </svg>
  );
}

function AnomalyView({ a, kind, t }: { a: AnomalySignal; kind: "tokens" | "cost"; t: TFn }) {
  const excluded = /excluded/i.test(a.reason); // agy cost excluded — unknown, never a spike
  const thin = /insufficient/i.test(a.reason);
  const flagged = a.flagged === true;
  return (
    <div className={cx("trend-anomaly", flagged && "is-flagged", excluded && "is-excluded", thin && "is-thin")} data-anomaly={flagged ? "flagged" : "ok"} data-kind={kind}>
      <span className="trend-anomaly__k">{kind === "tokens" ? t("trend.tokens") : t("trend.cost")}</span>
      {flagged ? (
        <span className="trend-anomaly__flag">⚠ {t("trend.anomalyFlag")}</span>
      ) : excluded ? (
        <span className="trend-anomaly__muted">{t("trend.agyExcluded")}</span>
      ) : thin ? (
        <span className="trend-anomaly__muted">{t("trend.thin")}</span>
      ) : (
        <span className="trend-anomaly__ok">✓ {t("trend.withinBaseline")}</span>
      )}
    </div>
  );
}

function NodeCard({ n, t }: { n: TrendNode; t: TFn }) {
  const tokenDays = n.days.map((d) => tokenVal(d.totals.total_tokens));
  const tokSpike = n.anomaly.total_tokens.flagged === true;
  const tokTrend = trendSummary(n.trend.total_tokens, t);
  const lowConf = n.confidence === "low";
  const costUnknown = isUnknown(n.forecast.cost_usd_next_day) || n.agent === "agy";
  return (
    <div className={cx("trend-node", tokSpike && "has-spike")} data-node={n.node} data-agent={n.agent}>
      <div className="trend-node__head">
        <span className="trend-node__glyph">{agentGlyph(n.agent)}</span>
        <span className="trend-node__name">{n.node}</span>
        <span className="trend-node__agent">{n.agent}</span>
        {lowConf && <span className="trend-node__lowconf" data-confidence="low">⚠ {t("trend.lowConfidence")}</span>}
      </div>

      <Spark values={tokenDays} spike={tokSpike} />

      <div className="trend-node__row">
        <span className="trend-node__k">{t("trend.tokensTrend")}</span>
        <span className={cx("trend-node__delta", `is-${tokTrend.dir}`)}>{tokTrend.text}</span>
      </div>

      {/* anomaly = advisory signals only (no enforcement) */}
      <div className="trend-anomalies">
        <AnomalyView a={n.anomaly.total_tokens} kind="tokens" t={t} />
        <AnomalyView a={n.anomaly.cost_usd_estimate} kind="cost" t={t} />
      </div>

      {/* forecast — explicitly NOT a prediction */}
      <div className="trend-forecast">
        <span className="trend-forecast__label" data-forecast="label">🔮 {t("trend.forecastLabel")}</span>
        <span className="trend-forecast__val">
          {t("trend.tokens")}:{" "}
          {isUnknown(n.forecast.total_tokens_next_day) ? t("cost.unknown") : fmtTokens(n.forecast.total_tokens_next_day.value as number)}
        </span>
        <span className="trend-forecast__val">
          {t("trend.cost")}: {costUnknown ? <span className="trend-unknown" data-agy="unknown">⚠ {t("cost.unknown")}</span> : `$${(n.forecast.cost_usd_next_day.value as number).toFixed(2)}`}
        </span>
      </div>

      {(n.warnings ?? []).map((w, i) => (
        <div key={i} className="trend-warn">⚠ {w}</div>
      ))}
    </div>
  );
}

/**
 * Usage trend + anomaly insights (v1.23) — ADVISORY, READ-ONLY. Per-node daily
 * token sparkline + trend delta/ratio, deterministic anomaly flags shown as
 * SIGNALS only ("이상 신호 — 참고용, 자동 조치 없음"; spike day highlighted), a
 * labelled forecast ("예측 아님·참고"), and agy cost kept honestly "알 수 없음"
 * (never mistaken for a spike). There are NO throttle/abort controls (enforcement
 * is never called). Operator-only: viewer (403) / disabled (404) degrade to a
 * fixed graceful notice.
 */
export function TrendPanel({ projectTick }: { projectTick: number }) {
  const { t } = useI18n();
  const [windowSel, setWindowSel] = useState<string>("14d");
  const [report, setReport] = useState<UsageTrend | null>(null);
  const [errCode, setErrCode] = useState<"forbidden" | "disabled" | "error" | null>(null);

  useEffect(() => {
    let alive = true;
    setReport(null);
    setErrCode(null);
    api
      .getUsageTrend(windowSel)
      .then((r) => alive && setReport(r))
      .catch((e: unknown) => {
        if (!alive) return;
        const m = e instanceof Error ? e.message : "";
        setErrCode(/\b403\b/.test(m) ? "forbidden" : /\b404\b/.test(m) ? "disabled" : "error");
      });
    return () => {
      alive = false;
    };
  }, [projectTick, windowSel]);

  const anyFlagged = (report?.nodes ?? []).some((n) => n.anomaly.total_tokens.flagged === true);

  return (
    <section className="trend">
      <div className="trend__scroll">
        <header className="trend__head">
          <div className="trend__title-wrap">
            <TrendMark />
            <h2 className="trend__title">{t("trend.title")}</h2>
          </div>
          <div className="trend-window" role="group" aria-label={t("trend.window")}>
            {WINDOWS.map((w) => (
              <button
                key={w}
                type="button"
                className={cx("trend-window__btn", windowSel === w && "is-on")}
                data-window={w}
                aria-pressed={windowSel === w}
                onClick={() => setWindowSel(w)}
              >
                {w}
              </button>
            ))}
          </div>
        </header>

        {/* advisory banner — signals only, no enforcement ever */}
        {report && (
          <div className="trend-advisory" data-mode={report.mode} data-actions={report.actions.length} data-enforced={report.enforcement?.called ? "1" : "0"}>
            🛈 {anyFlagged ? t("trend.advisoryFlagged") : t("trend.advisory")}
          </div>
        )}

        {errCode === "forbidden" && <div className="trend-msg is-warn" data-err="forbidden">{t("trend.forbidden")}</div>}
        {errCode === "disabled" && <div className="trend-msg is-warn" data-err="disabled">{t("trend.disabled")}</div>}
        {errCode === "error" && <div className="trend-msg is-error" data-err="error">{t("trend.error")}</div>}

        {report &&
          (report.nodes.length > 0 ? (
            <div className="trend-nodes">
              {report.nodes.map((n) => (
                <NodeCard key={n.node} n={n} t={t} />
              ))}
            </div>
          ) : (
            <div className="trend-empty">{t("trend.empty")}</div>
          ))}
      </div>
    </section>
  );
}
