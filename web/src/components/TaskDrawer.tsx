import { useEffect, useRef, useState } from "react";

import { api } from "../api";
import type { PlanCandidate, PlanResult } from "../api";
import { cx, initials, statusColor } from "../constants";
import { statusLabel, useI18n } from "../i18n";
import type { TFn } from "../i18n";
import type { Comment, Run, Task } from "../types";
import { useFocusTrap } from "../useFocusTrap";

function fmtScore(v: number | null | undefined): string {
  return typeof v === "number" ? v.toFixed(2) : "—";
}

/**
 * Read-only planner recommendations: ranked candidate nodes for a task+role.
 * The endpoint never claims/assigns — this surfaces the ranking for MANUAL
 * assignment only, mirroring `read_only:true` in the backend response.
 */
function PlannerPanel({ taskId, defaultRole, t }: { taskId: string; defaultRole: string; t: TFn }) {
  const [role, setRole] = useState(defaultRole);
  const [plan, setPlan] = useState<PlanResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const recommend = () => {
    const r = role.trim();
    if (!r || loading) return;
    setLoading(true);
    setError(null);
    api
      .getPlan({ role: r, task_id: taskId })
      .then((p) => setPlan(p))
      .catch(() => {
        // Fixed message only — never surface e.message: the raw cause can carry
        // the request path + the role input (potential secret/path) into the UI.
        setPlan(null);
        setError(t("plan.error"));
      })
      .finally(() => setLoading(false));
  };

  const candidates = plan?.candidates ?? [];

  return (
    <section className="dr-drawer__section plan-panel">
      <h3 className="dr-drawer__h">{t("plan.title")}</h3>
      <div className="plan-controls">
        <input
          className="dr-input plan-role"
          name="planRole"
          type="text"
          placeholder={t("plan.rolePh")}
          value={role}
          spellCheck={false}
          onChange={(e) => setRole(e.target.value)}
        />
        <button
          type="button"
          className="dr-btn dr-btn--primary plan-run"
          disabled={loading || !role.trim()}
          onClick={recommend}
        >
          {loading ? t("plan.running") : t("plan.recommend")}
        </button>
      </div>

      {error && <div className="plan-msg is-error">{error}</div>}

      {plan && (
        <>
          {/* read_only:true must read as a recommendation, never an action. */}
          <div className="plan-readonly" role="note">
            🛈 {t("plan.readonly")}
          </div>
          {candidates.length === 0 && <div className="plan-msg">{t("plan.empty")}</div>}
          <ol className="plan-list">
            {candidates.map((c) => (
              <PlanRow key={c.node} c={c} t={t} />
            ))}
          </ol>
        </>
      )}
    </section>
  );
}

function PlanRow({ c, t }: { c: PlanCandidate; t: TFn }) {
  const score = c.score;
  const breakdown = c.score_breakdown ?? {};
  // Top score factors (read-only reasons), each with its confidence.
  const factors = Object.entries(breakdown).slice(0, 4);
  return (
    <li className="plan-cand" data-node={c.node}>
      <div className="plan-cand__head">
        <span className="plan-cand__rank">#{typeof c.rank?.value === "number" ? c.rank.value : "?"}</span>
        <span className="plan-cand__node">{c.node}</span>
        {c.role && <span className="plan-cand__role">{c.role}</span>}
        <span className="plan-cand__score">
          {fmtScore(score?.value)}
          {score?.confidence && <span className={cx("plan-conf", `is-${score.confidence}`)}>{t(`cost.conf.${score.confidence}`)}</span>}
        </span>
      </div>
      <div className="plan-cand__factors">
        {factors.map(([key, m]) => (
          <span key={key} className="plan-factor" title={`${m.source} · ${m.confidence}`}>
            <span className="plan-factor__k">{t(`plan.factor.${key}`)}</span>
            <span className="plan-factor__v">{fmtScore(m.value)}</span>
            <span className={cx("plan-conf", `is-${m.confidence}`)}>{t(`cost.conf.${m.confidence}`)}</span>
          </span>
        ))}
      </div>
    </li>
  );
}

export function TaskDrawer(props: { taskId: string | null; onClose: () => void }) {
  const { taskId, onClose } = props;
  const { t } = useI18n();
  const panelRef = useRef<HTMLElement | null>(null);
  useFocusTrap(!!taskId, panelRef);
  const [task, setTask] = useState<Task | null>(null);
  const [comments, setComments] = useState<Comment[]>([]);
  const [runs, setRuns] = useState<Run[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!taskId) {
      setTask(null);
      setComments([]);
      setRuns([]);
      setError(null);
      return;
    }
    let alive = true;
    setLoading(true);
    setError(null);
    Promise.all([
      api.getTask(taskId),
      api.getComments(taskId).catch(() => [] as Comment[]),
      api.getRuns(taskId).catch(() => [] as Run[]),
    ])
      .then(([t, c, r]) => {
        if (!alive) return;
        setTask(t);
        setComments(Array.isArray(c) ? c : []);
        setRuns(Array.isArray(r) ? r : []);
      })
      .catch((e: unknown) => {
        if (alive) setError(e instanceof Error ? e.message : t("drawer.loadError"));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [taskId]);

  // Close on Escape while open.
  useEffect(() => {
    if (!taskId) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [taskId, onClose]);

  if (!taskId) return null;

  return (
    <div className="dr-drawer">
      <div className="dr-drawer__scrim" onClick={onClose} />
      <aside className="dr-drawer__panel" role="dialog" aria-modal="true" aria-label="task detail" tabIndex={-1} ref={panelRef}>
        <header className="dr-drawer__head">
          <div className="dr-drawer__id">
            <span className="dr-drawer__ticket" style={{ color: statusColor(task?.status ?? "") }}>
              {task?.id ?? taskId}
            </span>
            {task?.status && (
              <span className="dr-pill" style={{ "--accent": statusColor(task.status) } as React.CSSProperties}>
                {statusLabel(t, task.status)}
              </span>
            )}
          </div>
          <button type="button" className="dr-drawer__close" onClick={onClose} aria-label={t("drawer.close")}>
            ✕
          </button>
        </header>

        {loading && <div className="dr-drawer__msg">{t("drawer.loading")}</div>}
        {error && <div className="dr-drawer__msg is-error">{error}</div>}

        {task && (
          <div className="dr-drawer__scroll">
            <h2 className="dr-drawer__title">{task.title}</h2>
            <div className="dr-drawer__facts">
              {task.assignee && (
                <span className="dr-fact">
                  <span className="dr-fact__k">{t("fact.assignee")}</span>
                  <span className="dr-fact__v">
                    <span className="dr-card__who">{initials(task.assignee)}</span> {task.assignee}
                  </span>
                </span>
              )}
              {task.tenant && (
                <span className="dr-fact">
                  <span className="dr-fact__k">{t("fact.tenant")}</span>
                  <span className="dr-fact__v">{task.tenant}</span>
                </span>
              )}
            </div>
            {task.body && <p className="dr-drawer__body">{task.body}</p>}

            <section className="dr-drawer__section dr-drawer__runs">
              <h3 className="dr-drawer__h">
                {t("drawer.runs")} <span className="dr-drawer__hn">{runs.length}</span>
              </h3>
              {runs.length === 0 && <div className="dr-drawer__empty">{t("drawer.noRuns")}</div>}
              {runs.map((r) => (
                <div key={r.id} className="dr-run">
                  <span className="dr-run__dot" style={{ background: statusColor(r.status ?? "") }} />
                  <span className="dr-run__body">
                    <span className="dr-run__top">
                      <span className="dr-run__id">{r.id}</span>
                      {r.node && <span className="dr-run__node">{r.node}</span>}
                    </span>
                    {r.summary && <span className="dr-run__sum">{r.summary}</span>}
                  </span>
                  {r.status && <span className="dr-run__status">{statusLabel(t, r.status)}</span>}
                </div>
              ))}
            </section>

            <section className="dr-drawer__section dr-drawer__comments">
              <h3 className="dr-drawer__h">
                {t("drawer.comments")} <span className="dr-drawer__hn">{comments.length}</span>
              </h3>
              {comments.length === 0 && <div className="dr-drawer__empty">{t("drawer.noComments")}</div>}
              {comments.map((c) => (
                <div key={c.id} className="dr-comment">
                  <span className="dr-comment__who">{c.author ?? "—"}</span>
                  <p className="dr-comment__body">{c.body}</p>
                </div>
              ))}
            </section>

            <PlannerPanel taskId={task.id} defaultRole={task.assignee ?? ""} t={t} />
          </div>
        )}
      </aside>
    </div>
  );
}
