import { useEffect, useMemo, useState } from "react";

import { api, CANONICAL_STATUSES, canonicalStatus } from "../api";
import { CANONICAL_COLUMNS, COLUMNS, MANUAL_STATUS_COLUMNS, cx, initials, statusColor } from "../constants";
import { statusLabel, useI18n } from "../i18n";
import type { AssigneeCandidate, BoardWorkflow, Task } from "../types";

const PRIORITIES = ["low", "normal", "high"] as const;

/** Short, de-emphasized id slug for a card — long raw ids (task_2398…) are
 *  truncated so they never dominate or overflow; short ids (G-2) pass through. */
function shortId(id: string): string {
  return id.length > 12 ? `${id.slice(0, 10)}…` : id;
}

function AddTaskForm(props: { boardId: string; onCreated: () => void; onClose: () => void }) {
  const { boardId, onCreated, onClose } = props;
  const { t } = useI18n();
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [assignee, setAssignee] = useState("");
  const [reviewer, setReviewer] = useState(""); // v1.29 optional reviewer
  const [candidates, setCandidates] = useState<AssigneeCandidate[]>([]);
  const [reviewerCands, setReviewerCands] = useState<AssigneeCandidate[]>([]);
  const [status, setStatus] = useState<string>(COLUMNS[0].key);
  const [priority, setPriority] = useState<string>("normal");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // assignee = a REQUIRED dropdown of the project's nodes + lead/orchestrator,
  // defaulting to project-master (web_app.py assignee_candidates/default_assignee;
  // falls back to /api/org nodes if the candidate list is absent). No free input.
  useEffect(() => {
    let alive = true;
    api
      .getOrg()
      .then((o) => {
        if (!alive) return;
        const cands: AssigneeCandidate[] =
          o.assignee_candidates && o.assignee_candidates.length > 0
            ? o.assignee_candidates
            : (o.nodes ?? []).map((n) => ({ name: n.name, role: n.role, agent: n.agent, status: n.status }));
        setCandidates(cands);
        setReviewerCands(o.reviewer_candidates && o.reviewer_candidates.length > 0 ? o.reviewer_candidates : cands);
        const def =
          o.default_assignee && cands.some((c) => c.name === o.default_assignee)
            ? o.default_assignee
            : (cands.find((c) => c.default)?.name ?? cands[0]?.name ?? "");
        setAssignee((prev) => prev || def);
      })
      .catch(() => {
        /* no candidates available — select stays empty */
      });
    return () => {
      alive = false;
    };
  }, []);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const titleTrim = title.trim();
    if (!titleTrim) {
      setError(t("add.titleRequired"));
      return;
    }
    setBusy(true);
    setError(null);
    api
      .createTask(boardId, {
        title: titleTrim,
        body: body.trim() || undefined,
        assignee: assignee.trim() || undefined,
        reviewer: reviewer.trim() || undefined,
        status,
        priority,
      })
      .then(() => {
        setBusy(false);
        onCreated();
        onClose();
      })
      .catch(() => {
        setBusy(false);
        setError(t("add.error"));
      });
  };

  return (
    <form className="dr-addform" onSubmit={submit}>
      <div className="dr-addform__head">{t("add.heading")}</div>
      <input
        className="dr-input dr-addform__title"
        name="title"
        type="text"
        placeholder={t("add.title")}
        value={title}
        autoFocus
        spellCheck={false}
        onChange={(e) => setTitle(e.target.value)}
      />
      <textarea
        className="dr-input dr-addform__body"
        name="body"
        rows={2}
        placeholder={t("add.body")}
        value={body}
        onChange={(e) => setBody(e.target.value)}
      />
      <div className="dr-addform__row">
        <select
          className="dr-select dr-addform__assignee"
          name="assignee"
          required
          value={assignee}
          aria-label={t("add.assignee")}
          onChange={(e) => setAssignee(e.target.value)}
        >
          {candidates.map((c) => (
            <option key={c.name} value={c.name}>
              {c.name}
              {c.default ? ` · ${t("add.master")}` : c.role ? ` · ${c.role}` : ""}
              {c.human ? " · human" : c.reviewer ? " · reviewer" : ""}
            </option>
          ))}
        </select>
        <select
          className="dr-select dr-addform__reviewer"
          name="reviewer"
          value={reviewer}
          aria-label={t("add.reviewer")}
          onChange={(e) => setReviewer(e.target.value)}
        >
          <option value="">{t("add.reviewerNone")}</option>
          {reviewerCands.map((c) => (
            <option key={c.name} value={c.name}>
              {c.name}
              {c.role ? ` · ${c.role}` : ""}
            </option>
          ))}
        </select>
        <select
          className="dr-select"
          name="status"
          value={status}
          aria-label={t("add.status")}
          onChange={(e) => setStatus(e.target.value)}
        >
          {COLUMNS.map((c) => (
            <option key={c.key} value={c.key}>
              {statusLabel(t, c.key)}
            </option>
          ))}
        </select>
        <select
          className="dr-select"
          name="priority"
          value={priority}
          aria-label={t("add.priority")}
          onChange={(e) => setPriority(e.target.value)}
        >
          {PRIORITIES.map((p) => (
            <option key={p} value={p}>
              {t(`priority.${p}`)}
            </option>
          ))}
        </select>
      </div>
      {error && <div className="dr-addform__err">{error}</div>}
      <div className="dr-addform__actions">
        <button type="button" className="dr-btn dr-btn--ghost dr-addform__cancel" onClick={onClose}>
          {t("add.cancel")}
        </button>
        <button type="submit" className="dr-btn dr-btn--primary dr-addform__submit" disabled={busy}>
          {t("add.submit")}
        </button>
      </div>
    </form>
  );
}

export function BoardView(props: {
  boardId: string;
  liveTick: number;
  projectTick: number;
  boardLive: boolean;
  onOpenTask: (id: string) => void;
}) {
  const { boardId, liveTick, projectTick, boardLive, onOpenTask } = props;
  const { t } = useI18n();
  const [tasks, setTasks] = useState<Task[]>([]);
  const [workflow, setWorkflow] = useState<BoardWorkflow | null>(null);
  const [isViewer, setIsViewer] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState("");
  const [assigneeFilter, setAssigneeFilter] = useState("");
  const [reloadKey, setReloadKey] = useState(0);
  const [adding, setAdding] = useState(false);

  // Workflow (canonical columns/aliases). Falls back to local canonical columns
  // when the endpoint is unavailable (older backend).
  useEffect(() => {
    let alive = true;
    api
      .getWorkflow(boardId)
      .then((w) => alive && setWorkflow(w))
      .catch(() => alive && setWorkflow(null));
    api
      .getMe()
      .then((me) => alive && setIsViewer(me?.member?.role === "viewer"))
      .catch(() => alive && setIsViewer(false));
    return () => {
      alive = false;
    };
  }, [boardId, projectTick]);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    api
      .listTasks(boardId, {
        status: statusFilter || undefined,
        assignee: assigneeFilter || undefined,
      })
      .then((tk) => {
        if (!alive) return;
        setTasks(Array.isArray(tk) ? tk : []);
        setError(null);
      })
      .catch((e: unknown) => {
        if (alive) setError(e instanceof Error ? e.message : t("board.loadError"));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
    // projectTick: refetch once the project (and its X-Grove-Project header) is
    // adopted/switched, so "default" resolves against the right project board.
  }, [boardId, statusFilter, assigneeFilter, liveTick, projectTick, reloadKey, t]);

  // Workflow columns (live or fallback). Done is always present + visible.
  const wfColumns = useMemo(
    () =>
      workflow?.columns && workflow.columns.length > 0
        ? workflow.columns.map((c) => ({ key: c.key, label: c.label }))
        : CANONICAL_COLUMNS.map((c) => ({ key: c.key, label: c.label })),
    [workflow],
  );

  // Manual status targets for the on-card dropdown: only NON-virtual workflow
  // columns (a virtual column like ask_human is display-only — the backend rejects
  // a manual PATCH to it). Falls back to the static non-virtual canonical list.
  const manualStatuses = useMemo(
    () =>
      workflow?.columns && workflow.columns.length > 0
        ? workflow.columns.filter((c) => c.virtual !== true).map((c) => c.key)
        : MANUAL_STATUS_COLUMNS.map((c) => c.key),
    [workflow],
  );

  // Group tasks by CANONICAL status (raw "running" → "in_progress" via aliases).
  const byColumn = useMemo(() => {
    const map: Record<string, Task[]> = {};
    for (const c of wfColumns) map[c.key] = [];
    for (const task of tasks) {
      const key = canonicalStatus(task.status, workflow);
      (map[key] ??= []).push(task);
    }
    return map;
  }, [tasks, wfColumns, workflow]);

  // Render workflow columns + a fallback column for any unknown canonical key.
  const columns = useMemo(() => {
    const known = new Set<string>(wfColumns.map((c) => c.key));
    const extra = Object.keys(byColumn)
      .filter((k) => !known.has(k) && (byColumn[k]?.length ?? 0) > 0)
      .sort()
      .map((k) => ({ key: k, label: "" }));
    return [...wfColumns, ...extra];
  }, [byColumn, wfColumns]);

  const transition = (taskId: string, toStatus: string) => {
    setError(null);
    api
      .setTaskStatus(taskId, toStatus)
      .then(() => setReloadKey((k) => k + 1)) // refetch-safe: card moves to its new column
      .catch((e: unknown) => setError(e instanceof Error ? e.message : t("board.statusError")));
  };

  return (
    <section className="dr-board">
      <div className="dr-board__toolbar">
        <div className="dr-board__lead">
          <span className={cx("dr-spark", boardLive && "is-on")} />
          <span className="dr-board__title">{t("board.title")}</span>
          <span className="dr-board__count">{t("board.count", { n: tasks.length })}</span>
        </div>
        <div className="dr-board__filters">
          <select
            className="dr-select"
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            aria-label={t("add.status")}
          >
            <option value="">{t("board.allStatuses")}</option>
            {(workflow?.canonical_statuses ?? CANONICAL_STATUSES).map((k) => (
              <option key={k} value={k}>
                {statusLabel(t, k)}
              </option>
            ))}
          </select>
          <input
            className="dr-input"
            type="text"
            placeholder={t("board.assignee")}
            value={assigneeFilter}
            spellCheck={false}
            onChange={(e) => setAssigneeFilter(e.target.value)}
          />
          <button
            type="button"
            className={cx("dr-addbtn", adding && "is-open")}
            onClick={() => setAdding((v) => !v)}
          >
            {t("add.open")}
          </button>
        </div>
      </div>

      {adding && (
        <AddTaskForm
          boardId={boardId}
          onCreated={() => setReloadKey((k) => k + 1)}
          onClose={() => setAdding(false)}
        />
      )}

      {error && <div className="dr-board__msg is-error">{error}</div>}

      <div className="dr-board__cols">
        {columns.map((col) => {
          const items = byColumn[col.key] ?? [];
          return (
            <div key={col.key} className="dr-col" data-col={col.key}>
              <div
                className="dr-col__head"
                style={{ "--accent": statusColor(col.key) } as React.CSSProperties}
              >
                <span className="dr-col__name">{col.label || statusLabel(t, col.key)}</span>
                <span className="dr-col__n">{items.length}</span>
              </div>
              <div className="dr-col__cards">
                {items.map((task, i) => {
                  const canon = canonicalStatus(task.status, workflow);
                  return (
                    <div
                      key={task.id}
                      className="dr-card"
                      data-task={task.id}
                      data-status={canon}
                      style={{ animationDelay: `${Math.min(i, 10) * 22}ms` }}
                    >
                      {/* Title opens the drawer; the status dropdown + badges live in
                          the meta row (a card can't be a <button> with controls). */}
                      <button type="button" className="dr-card__open" onClick={() => onOpenTask(task.id)}>
                        <span className="dr-card__title">{task.title?.trim() || shortId(task.id)}</span>
                      </button>
                      <span className="dr-card__meta">
                        <span className="dr-card__id" style={{ color: statusColor(canon) }} title={task.id}>
                          {shortId(task.id)}
                        </span>
                        {task.assignee && (
                          <span className="dr-card__who" title={task.assignee}>
                            {initials(task.assignee)}
                          </span>
                        )}
                        {task.reviewer && (
                          <span className="dr-card__reviewer" data-reviewer={task.reviewer} title={t("review.reviewer") + ": " + task.reviewer}>
                            ⊙ {task.reviewer}
                          </span>
                        )}
                      </span>
                      {!isViewer && (
                        <select
                          className="dr-card__status"
                          value={canon}
                          aria-label={t("board.moveTo")}
                          onClick={(e) => e.stopPropagation()}
                          onChange={(e) => transition(task.id, e.target.value)}
                        >
                          {manualStatuses.map((k) => (
                            <option key={k} value={k}>
                              {statusLabel(t, k)}
                            </option>
                          ))}
                        </select>
                      )}
                      {task.latest_summary && <span className="dr-card__sum">{task.latest_summary}</span>}
                    </div>
                  );
                })}
                {!loading && items.length === 0 && <div className="dr-col__empty">{t("board.empty")}</div>}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
