import { useEffect, useState } from "react";

import { api } from "../api";
import type { CostMetric, RetroAnalytics, RetroOutcomeItem } from "../api";
import { cx } from "../constants";
import { useI18n } from "../i18n";
import type { TFn } from "../i18n";

function InsightsMark() {
  return (
    <svg className="insights__mark" viewBox="0 0 24 24" width={20} height={20} aria-hidden="true">
      <path d="M4 19V5M4 19h16" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" />
      <path d="M7 15l4-5 3 3 4-6" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function isUnknown(m?: CostMetric): boolean {
  return !m || m.value === null || m.value === undefined || m.status === "unknown" || m.confidence === "unknown";
}

function num(m?: CostMetric): number {
  return isUnknown(m) ? 0 : (m!.value as number);
}

/** Honest metric: null/unknown reads "알 수 없음"; otherwise the count. */
function Count({ m, t }: { m?: CostMetric; t: TFn }) {
  return isUnknown(m) ? (
    <span className="insights-metric is-unknown">{t("cost.unknown")}</span>
  ) : (
    <span className="insights-metric">{m!.value}</span>
  );
}

function fmtDur(seconds: number): string {
  if (seconds >= 3600) return `${(seconds / 3600).toFixed(1)}h`;
  if (seconds >= 60) return `${Math.round(seconds / 60)}m`;
  return `${seconds}s`;
}

/** Tiny throughput sparkline (completed runs per day) — purely illustrative. */
function Sparkline({ values }: { values: number[] }) {
  if (values.length === 0) return null;
  const max = Math.max(1, ...values);
  const W = 132;
  const H = 34;
  const gap = 3;
  const bw = values.length > 0 ? (W - gap * (values.length - 1)) / values.length : W;
  return (
    <svg className="insights-spark" viewBox={`0 0 ${W} ${H}`} width={W} height={H} role="img" aria-hidden="true">
      {values.map((v, i) => {
        const h = Math.max(2, (v / max) * (H - 4));
        return <rect key={i} className="insights-spark__bar" x={i * (bw + gap)} y={H - h} width={bw} height={h} rx={1} />;
      })}
    </svg>
  );
}

function OutcomeRow({ item, label, t }: { item: RetroOutcomeItem; label: string; t: TFn }) {
  // Neutral counts only — no judgement, no ranking, no action.
  const cells: [string, CostMetric][] = [
    ["completed", item.completed],
    ["blocked", item.blocked],
    ["failed", item.failed],
    ["running", item.running],
    ["other", item.other],
  ];
  return (
    <div className="insights-outcome" data-outcome={label}>
      <span className="insights-outcome__key">
        {label}
        {item.role && item.node && <span className="insights-outcome__role"> · {item.role}</span>}
        {item.agent && <span className="insights-outcome__agent"> · {item.agent}</span>}
      </span>
      <span className="insights-outcome__cells">
        {cells.map(([k, m]) => (
          <span key={k} className={cx("insights-outcome__cell", `is-${k}`)} data-k={k}>
            <span className="insights-outcome__cellk">{t(`insights.outcome.${k}`)}</span>
            <Count m={m} t={t} />
          </span>
        ))}
      </span>
    </div>
  );
}

/**
 * Retro analytics insights (v1.22) — ADVISORY, READ-ONLY. Throughput trend, retro
 * theme frequencies, blocked/slow patterns and neutral node/role outcomes. It
 * never proposes actions (mode "advisory", actions []); small samples are flagged
 * "low confidence"; agy cost stays "알 수 없음". Operator-only: a viewer (403) or
 * a disabled backend (404) degrades to a fixed graceful notice. The backend
 * already redacts — the FE only displays.
 */
export function InsightsPanel({ projectTick }: { projectTick: number }) {
  const { t } = useI18n();
  const [report, setReport] = useState<RetroAnalytics | null>(null);
  const [errCode, setErrCode] = useState<"forbidden" | "disabled" | "error" | null>(null);

  useEffect(() => {
    let alive = true;
    setReport(null);
    setErrCode(null);
    api
      .getRetroAnalytics()
      .then((r) => alive && setReport(r))
      .catch((e: unknown) => {
        if (!alive) return;
        const m = e instanceof Error ? e.message : "";
        setErrCode(/\b403\b/.test(m) ? "forbidden" : /\b404\b/.test(m) ? "disabled" : "error");
      });
    return () => {
      alive = false;
    };
  }, [projectTick]);

  const lowConfidence = report?.confidence === "low";

  return (
    <section className="insights">
      <div className="insights__scroll">
        <header className="insights__head">
          <div className="insights__title-wrap">
            <InsightsMark />
            <h2 className="insights__title">{t("insights.title")}</h2>
          </div>
          {report && lowConfidence && (
            <span className="insights-badge is-lowconf" data-confidence="low">
              ⚠ {t("insights.lowConfidence")}
            </span>
          )}
        </header>

        {/* advisory banner — ALWAYS shown when data renders: no auto-action. */}
        {report && (
          <div className="insights-advisory" data-mode={report.mode} data-actions={report.actions.length}>
            🛈 {t("insights.advisory")}
          </div>
        )}

        {errCode === "forbidden" && <div className="insights-msg is-warn" data-err="forbidden">{t("insights.forbidden")}</div>}
        {errCode === "disabled" && <div className="insights-msg is-warn" data-err="disabled">{t("insights.disabled")}</div>}
        {errCode === "error" && <div className="insights-msg is-error" data-err="error">{t("insights.error")}</div>}

        {report && (
          <div className="insights-grid">
            {/* throughput trend */}
            <div className="insights-card insights-throughput" data-card="throughput">
              <div className="insights-card__h">{t("insights.throughput")}</div>
              <Sparkline values={report.throughput.map((b) => num(b.completed))} />
              <div className="insights-card__sub">
                {t("insights.throughputSub", { n: report.throughput.reduce((s, b) => s + num(b.completed), 0) })}
              </div>
            </div>

            {/* retro themes — allowlist category frequency chips */}
            <div className="insights-card insights-themes" data-card="themes">
              <div className="insights-card__h">{t("insights.themes")}</div>
              {report.themes.length > 0 ? (
                <div className="insights-themes__list">
                  {report.themes.map((th) => (
                    <span key={th.theme} className="insights-theme" data-theme={th.theme}>
                      {t(`insights.theme.${th.theme}`) /* allowlist; falls back to raw */ === `insights.theme.${th.theme}`
                        ? th.theme
                        : t(`insights.theme.${th.theme}`)}
                      <span className="insights-theme__n">{num(th.count)}</span>
                    </span>
                  ))}
                </div>
              ) : (
                <div className="insights-card__empty">{t("insights.empty")}</div>
              )}
            </div>

            {/* blocked / slow patterns */}
            <div className="insights-card insights-patterns" data-card="patterns">
              <div className="insights-card__h">{t("insights.patterns")}</div>
              <div className="insights-pat__row">
                <span className="insights-pat__k">{t("insights.blocked")}</span>
                <Count m={report.patterns.blocked.current} t={t} />
                <span className="insights-pat__sub">
                  {t("insights.blockedRuns")} <Count m={report.patterns.blocked.blocked_runs} t={t} />
                </span>
              </div>
              <div className="insights-pat__row">
                <span className="insights-pat__k">{t("insights.slow")}</span>
                <Count m={report.patterns.slow.count} t={t} />
                <span className="insights-pat__sub">
                  {t("insights.slowAvg")}:{" "}
                  {isUnknown(report.patterns.slow.average_duration_seconds)
                    ? t("cost.unknown")
                    : fmtDur(num(report.patterns.slow.average_duration_seconds))}
                </span>
              </div>
              {report.patterns.blocked.by_assignee.length > 0 && (
                <div className="insights-pat__assignees">
                  {report.patterns.blocked.by_assignee.map((a) => (
                    <span key={a.assignee} className="insights-pat__chip">
                      {a.assignee} <span className="insights-pat__chipn">{num(a.count)}</span>
                    </span>
                  ))}
                </div>
              )}
            </div>

            {/* node / role outcomes — neutral counts */}
            <div className="insights-card insights-outcomes" data-card="outcomes">
              <div className="insights-card__h">{t("insights.outcomes")}</div>
              <div className="insights-outcomes__group">
                <div className="insights-outcomes__label">{t("insights.byNode")}</div>
                {report.outcomes.by_node.map((it) => (
                  <OutcomeRow key={it.node} item={it} label={it.node ?? "?"} t={t} />
                ))}
              </div>
              <div className="insights-outcomes__group">
                <div className="insights-outcomes__label">{t("insights.byRole")}</div>
                {report.outcomes.by_role.map((it) => (
                  <OutcomeRow key={it.role} item={it} label={it.role ?? "?"} t={t} />
                ))}
              </div>
            </div>

            {/* agy cost stays honestly unknown */}
            <div className="insights-card insights-cost" data-card="cost">
              <div className="insights-card__h">{t("insights.cost")}</div>
              <div className="insights-cost__row">
                <span className="insights-cost__k">{t("insights.agyCredit")}</span>
                {isUnknown(report.cost_signals.agy_credit) ? (
                  <span className="insights-metric is-unknown" data-agy="unknown">⚠ {t("cost.unknown")}</span>
                ) : (
                  <span className="insights-metric">{report.cost_signals.agy_credit.value}</span>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
