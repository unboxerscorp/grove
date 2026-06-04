import { useEffect, useRef, useState } from "react";

import { actorLabel, api, canonicalStatus } from "../api";
import type { AuditEvent, HandoffPackage, PlanCandidate, PlanResult } from "../api";
import { cx, fmtAgo, initials, MANUAL_STATUS_COLUMNS, statusColor } from "../constants";
import { statusLabel, useI18n } from "../i18n";
import type { TFn } from "../i18n";
import type { AssigneeCandidate, Comment, Run, Task } from "../types";
import { useFocusTrap } from "../useFocusTrap";

/** v1.29 workflow controls: status transition + reviewer (operator only). Both
 *  PATCH the board store and bubble the updated task up to refresh the board. */
function TaskWorkflow({ task, onUpdated, t }: { task: Task; onUpdated: (task: Task) => void; t: TFn }) {
  const [reviewerCands, setReviewerCands] = useState<AssigneeCandidate[]>([]);
  const [isViewer, setIsViewer] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    api
      .getOrg()
      .then((o) => alive && setReviewerCands(o.reviewer_candidates ?? o.assignee_candidates ?? []))
      .catch(() => {});
    api
      .getMe()
      .then((me) => alive && setIsViewer(me?.member?.role === "viewer"))
      .catch(() => alive && setIsViewer(false));
    return () => {
      alive = false;
    };
  }, [task.id]);
  const canon = canonicalStatus(task.status);
  const run = (p: Promise<Task>) => {
    setBusy(true);
    setErr(null);
    p.then((u) => {
      setBusy(false);
      onUpdated(u);
    }).catch((e: unknown) => {
      setBusy(false);
      setErr(e instanceof Error ? e.message : t("board.statusError"));
    });
  };
  if (isViewer) return null; // read-only for viewers
  return (
    <section className="dr-drawer__section dr-workflow">
      <h3 className="dr-drawer__h">{t("review.workflow")}</h3>
      <div className="dr-workflow__row">
        <label className="dr-workflow__field">
          <span className="dr-workflow__k">{t("board.moveTo")}</span>
          <select
            className="dr-select dr-workflow__status"
            value={canon}
            disabled={busy}
            onChange={(e) => run(api.setTaskStatus(task.id, e.target.value))}
          >
            {/* ask_human (virtual) is intentionally excluded — it's display-only,
                not a manual status target. Static list: the drawer has no board
                workflow context. */}
            {MANUAL_STATUS_COLUMNS.map((c) => (
              <option key={c.key} value={c.key}>
                {statusLabel(t, c.key)}
              </option>
            ))}
          </select>
        </label>
        <label className="dr-workflow__field">
          <span className="dr-workflow__k">{t("review.reviewer")}</span>
          <select
            className="dr-select dr-workflow__reviewer"
            value={task.reviewer ?? ""}
            disabled={busy}
            onChange={(e) => run(api.setTaskReviewer(task.id, e.target.value || null))}
          >
            <option value="">{t("add.reviewerNone")}</option>
            {reviewerCands.map((c) => (
              <option key={c.name} value={c.name}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
      </div>
      {err && <div className="dr-workflow__err">{err}</div>}
    </section>
  );
}

const PHASE_GLYPH: Record<string, string> = {
  claim: "◇",
  preflight: "⚑",
  "approval-pending": "⏳",
  approve: "★",
  execute: "▶",
  verify: "◎",
  complete: "●",
  abort: "✕",
  rollback: "↺",
  "release-stale": "⮌",
};

// Compact duration: "45s", "3m 20s", "1h 5m".
function fmtDuration(sec: number): string {
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  if (m < 60) return `${m}m ${sec % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

/**
 * Execution timeline as a step / gantt visualization: each audit.execution.*
 * transition is a phase; the duration of a phase is the gap to the next
 * transition. Renders proportional gantt bars + a per-step list with durations,
 * phase colours/icons, the current (latest) phase highlighted, and a total.
 * READ-ONLY (no mutations). Hidden when the task has no execution; partial
 * timelines render gracefully.
 */
function ExecutionTimeline({ taskId, t }: { taskId: string; t: TFn }) {
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    let alive = true;
    api
      .getAudit({ task_id: taskId, limit: 50 })
      .then((page) => {
        if (!alive) return;
        const items = Array.isArray(page.items) ? page.items : [];
        setEvents(items.filter((e) => typeof e.type === "string" && e.type.startsWith("audit.execution.")));
        setLoaded(true);
      })
      .catch(() => {
        if (alive) setLoaded(true);
      });
    return () => {
      alive = false;
    };
  }, [taskId]);

  if (loaded && events.length === 0) return null;

  const tsOf = (e: AuditEvent): number => (typeof e.ts === "number" ? e.ts : Number(e.ts) || 0);
  const steps = events.map((e, i) => {
    const next = events[i + 1];
    // duration = time spent in this phase before the next transition; null for
    // the latest (current/terminal) phase.
    const duration = next ? Math.max(0, tsOf(next) - tsOf(e)) : null;
    return { key: e.cursor ?? i, phase: e.action, duration, actor: e.actor, current: i === events.length - 1 };
  });
  const total = events.length >= 2 ? Math.max(0, tsOf(events[events.length - 1]!) - tsOf(events[0]!)) : 0;

  return (
    <section className="dr-drawer__section exec-timeline">
      <h3 className="dr-drawer__h">
        {t("exec.timeline")} <span className="dr-drawer__hn">{events.length}</span>
        {total > 0 && <span className="exec-timeline__total">{t("exec.totalDuration", { d: fmtDuration(total) })}</span>}
      </h3>

      {/* gantt: each bar proportional to its phase duration */}
      <div className="exec-gantt" aria-hidden="true">
        {steps.map((s) => (
          <span
            key={`bar-${s.key}`}
            className={cx("exec-gantt__bar", `is-${s.phase}`, s.current && "is-current")}
            style={{ flexGrow: s.duration ?? 0.001 }}
            title={`${t(`exec.phase.${s.phase}`)} · ${s.duration !== null ? fmtDuration(s.duration) : t("exec.current")}`}
          />
        ))}
      </div>

      <ol className="exec-timeline__list">
        {steps.map((s) => (
          <li
            key={s.key}
            className={cx("exec-timeline__item", `is-${s.phase}`, s.current && "is-current")}
            data-phase={s.phase}
            data-duration={s.duration ?? ""}
          >
            <span className={cx("exec-timeline__dot", `is-${s.phase}`)} aria-hidden="true">
              {PHASE_GLYPH[s.phase] ?? "·"}
            </span>
            <span className="exec-timeline__phase">{t(`exec.phase.${s.phase}`)}</span>
            <span className="exec-timeline__actor">{actorLabel(s.actor)}</span>
            <span className="exec-timeline__dur">{s.duration !== null ? fmtDuration(s.duration) : t("exec.current")}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}

function fmtScore(v: number | null | undefined): string {
  return typeof v === "number" ? v.toFixed(2) : "—";
}

/**
 * Hand a task off to another room: generate a SIGNED handoff package (read-only —
 * the receiver decides whether to accept). The copyable JSON carries the
 * signature (needed for the receiver to verify); the human preview shows only
 * key_id + allowlist fields, never the signing key. Default-OFF → 404 notice.
 */
function HandoffExport({ taskId, t }: { taskId: string; t: TFn }) {
  const [pkg, setPkg] = useState<HandoffPackage | null>(null);
  const [state, setState] = useState<"idle" | "loading" | "disabled" | "error">("idle");
  const [copied, setCopied] = useState(false);

  const doExport = () => {
    setState("loading");
    api
      .exportHandoff(taskId)
      .then((p) => {
        setPkg(p);
        setState("idle");
      })
      .catch((e: unknown) => {
        const m = e instanceof Error ? e.message : "";
        setState(/\b404\b/.test(m) ? "disabled" : "error");
      });
  };

  const json = pkg ? JSON.stringify(pkg, null, 2) : "";
  const copy = () => {
    void navigator.clipboard?.writeText(json).catch(() => {});
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  };

  return (
    <section className="dr-drawer__section handoff-export">
      <h3 className="dr-drawer__h">{t("handoff.exportTitle")}</h3>
      {!pkg && (
        <button type="button" className="dr-btn dr-btn--ghost handoff-export__btn" disabled={state === "loading"} onClick={doExport}>
          {state === "loading" ? t("handoff.exporting") : t("handoff.export")}
        </button>
      )}
      {state === "disabled" && <div className="handoff-msg is-warn">{t("handoff.disabled")}</div>}
      {state === "error" && <div className="handoff-msg is-error">{t("handoff.exportError")}</div>}
      {pkg && (
        <div className="handoff-pkg" data-handoff="export">
          <div className="handoff-pkg__meta">
            <span className="handoff-pkg__id">{pkg.payload.handoff_id}</span>
            <span className="handoff-pkg__key">{t("handoff.key")}: {pkg.key_id}</span>
            {typeof pkg.payload.expires_at === "number" && (
              <span className="handoff-pkg__exp">{t("handoff.expires")} {fmtAgo(pkg.payload.expires_at)}</span>
            )}
          </div>
          <div className="handoff-pkg__task">{pkg.payload.task?.title}</div>
          <textarea className="dr-input handoff-export__json" name="handoffJson" readOnly rows={4} value={json} spellCheck={false} />
          <button type="button" className="dr-btn dr-btn--primary handoff-export__copy" onClick={copy}>
            {copied ? t("handoff.copied") : t("handoff.copy")}
          </button>
          <p className="handoff-export__note">{t("handoff.exportNote")}</p>
        </div>
      )}
    </section>
  );
}

/**
 * Read-only planner recommendations: ranked candidate nodes for a task+role.
 * The endpoint never claims/assigns — this surfaces the ranking for MANUAL
 * assignment only, mirroring `read_only:true` in the backend response.
 */
function PlannerPanel(props: {
  taskId: string;
  boardId: string | null;
  defaultRole: string;
  taskTitle: string;
  taskBody?: string;
  onDelegated?: () => void;
  t: TFn;
}) {
  const { taskId, boardId, defaultRole, taskTitle, taskBody, onDelegated, t } = props;
  const [role, setRole] = useState(defaultRole);
  const [plan, setPlan] = useState<PlanResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Delegation is an EXPLICIT, two-step user action (button -> confirm) layered
  // over the read-only recommendation; nothing is delegated automatically.
  const [confirmNode, setConfirmNode] = useState<string | null>(null);
  const [busyNode, setBusyNode] = useState<string | null>(null);
  const [doneNode, setDoneNode] = useState<string | null>(null);
  const [delegErr, setDelegErr] = useState<string | null>(null);

  const recommend = () => {
    const r = role.trim();
    if (!r || loading) return;
    setLoading(true);
    setError(null);
    setDoneNode(null);
    setConfirmNode(null);
    setDelegErr(null);
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

  const confirmDelegate = (node: string) => {
    if (busyNode || !boardId) {
      if (!boardId) setDelegErr(t("plan.delegateError"));
      return;
    }
    setBusyNode(node);
    setDelegErr(null);
    api
      .delegate(boardId, node, { title: taskTitle, body: taskBody })
      .then(() => {
        setBusyNode(null);
        setConfirmNode(null);
        setDoneNode(node);
        onDelegated?.(); // bump liveTick -> board + audit refresh
      })
      .catch(() => {
        // Fixed message only (v1.11 pattern) — no raw cause / path / secret.
        setBusyNode(null);
        setConfirmNode(null);
        setDelegErr(t("plan.delegateError"));
      });
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
          {/* read_only:true is the DEFAULT: ranking only. Delegation is opt-in
              per candidate via an explicit button + confirm. */}
          <div className="plan-readonly" role="note">
            🛈 {t("plan.readonly")}
          </div>
          {delegErr && <div className="plan-msg is-error">{delegErr}</div>}
          {candidates.length === 0 && <div className="plan-msg">{t("plan.empty")}</div>}
          <ol className="plan-list">
            {candidates.map((c) => {
              const state =
                doneNode === c.node
                  ? "done"
                  : busyNode === c.node
                    ? "busy"
                    : confirmNode === c.node
                      ? "confirm"
                      : "idle";
              return (
                <PlanRow
                  key={c.node}
                  c={c}
                  t={t}
                  delegState={state}
                  canDelegate={!!boardId}
                  onAsk={() => {
                    setDelegErr(null);
                    setConfirmNode(c.node);
                  }}
                  onConfirm={() => confirmDelegate(c.node)}
                  onCancel={() => setConfirmNode(null)}
                />
              );
            })}
          </ol>
        </>
      )}
    </section>
  );
}

function PlanRow(props: {
  c: PlanCandidate;
  t: TFn;
  delegState: "idle" | "confirm" | "busy" | "done";
  canDelegate: boolean;
  onAsk: () => void;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const { c, t, delegState, canDelegate, onAsk, onConfirm, onCancel } = props;
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
      <div className="plan-cand__deleg">
        {delegState === "done" ? (
          <span className="plan-deleg__ok">✓ {t("plan.delegated", { node: c.node })}</span>
        ) : delegState === "confirm" ? (
          <span className="plan-deleg__confirm">
            <span className="plan-deleg__q">{t("plan.delegateConfirm", { node: c.node })}</span>
            <button type="button" className="dr-btn dr-btn--primary plan-deleg__yes" onClick={onConfirm}>
              {t("plan.delegateYes")}
            </button>
            <button type="button" className="dr-btn dr-btn--ghost plan-deleg__no" onClick={onCancel}>
              {t("node.cancel")}
            </button>
          </span>
        ) : (
          <button
            type="button"
            className="dr-btn dr-btn--ghost plan-deleg__btn"
            disabled={delegState === "busy" || !canDelegate}
            onClick={onAsk}
          >
            {delegState === "busy" ? t("plan.delegating") : t("plan.delegate")}
          </button>
        )}
      </div>
    </li>
  );
}

export function TaskDrawer(props: {
  taskId: string | null;
  boardId: string | null;
  onClose: () => void;
  onDelegated?: () => void;
}) {
  const { taskId, boardId, onClose, onDelegated } = props;
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
            <span className="dr-drawer__ticket" style={{ color: statusColor(canonicalStatus(task?.status)) }}>
              {task?.id ?? taskId}
            </span>
            {task?.status && (
              <span className="dr-pill" style={{ "--accent": statusColor(canonicalStatus(task.status)) } as React.CSSProperties}>
                {statusLabel(t, canonicalStatus(task.status))}
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
              {task.reviewer && (
                <span className="dr-fact" data-reviewer={task.reviewer}>
                  <span className="dr-fact__k">{t("review.reviewer")}</span>
                  <span className="dr-fact__v">⊙ {task.reviewer}</span>
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

            <TaskWorkflow
              task={task}
              onUpdated={(u) => {
                setTask(u);
                onDelegated?.(); // refresh the board (card moves) + audit
              }}
              t={t}
            />

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

            <ExecutionTimeline taskId={task.id} t={t} />

            <HandoffExport taskId={task.id} t={t} />

            <PlannerPanel
              taskId={task.id}
              boardId={boardId}
              defaultRole={task.assignee ?? ""}
              taskTitle={task.title}
              taskBody={task.body}
              onDelegated={onDelegated}
              t={t}
            />
          </div>
        )}
      </aside>
    </div>
  );
}
