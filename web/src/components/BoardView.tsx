import { useEffect, useMemo, useState } from "react";

import { api } from "../api";
import { COLUMNS, cx, initials, statusColor } from "../constants";
import { statusLabel, useI18n } from "../i18n";
import type { Task } from "../types";

const PRIORITIES = ["low", "normal", "high"] as const;

function AddTaskForm(props: { boardId: string; onCreated: () => void; onClose: () => void }) {
  const { boardId, onCreated, onClose } = props;
  const { t } = useI18n();
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [assignee, setAssignee] = useState("");
  const [status, setStatus] = useState<string>(COLUMNS[0].key);
  const [priority, setPriority] = useState<string>("normal");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
        <input
          className="dr-input"
          name="assignee"
          type="text"
          placeholder={t("add.assignee")}
          value={assignee}
          spellCheck={false}
          onChange={(e) => setAssignee(e.target.value)}
        />
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
        <button type="button" className="dr-btn dr-btn--ghost" onClick={onClose}>
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
  boardLive: boolean;
  onOpenTask: (id: string) => void;
}) {
  const { boardId, liveTick, boardLive, onOpenTask } = props;
  const { t } = useI18n();
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState("");
  const [assigneeFilter, setAssigneeFilter] = useState("");
  const [reloadKey, setReloadKey] = useState(0);
  const [adding, setAdding] = useState(false);

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
  }, [boardId, statusFilter, assigneeFilter, liveTick, reloadKey, t]);

  const byColumn = useMemo(() => {
    const map: Record<string, Task[]> = {};
    for (const c of COLUMNS) map[c.key] = [];
    for (const task of tasks) (map[task.status] ??= []).push(task);
    return map;
  }, [tasks]);

  // Render the known COLUMNS plus a fallback column for any task whose status
  // isn't in COLUMNS — otherwise those tasks vanish from the board yet still
  // count in the total (a confusing mismatch).
  const columns = useMemo(() => {
    const known = new Set<string>(COLUMNS.map((c) => c.key));
    const extra = Object.keys(byColumn)
      .filter((k) => !known.has(k) && (byColumn[k]?.length ?? 0) > 0)
      .sort()
      .map((k) => ({ key: k }));
    return [...COLUMNS.map((c) => ({ key: c.key })), ...extra];
  }, [byColumn]);

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
            {COLUMNS.map((c) => (
              <option key={c.key} value={c.key}>
                {statusLabel(t, c.key)}
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
            <div key={col.key} className="dr-col">
              <div
                className="dr-col__head"
                style={{ "--accent": statusColor(col.key) } as React.CSSProperties}
              >
                <span className="dr-col__name">{statusLabel(t, col.key)}</span>
                <span className="dr-col__n">{items.length}</span>
              </div>
              <div className="dr-col__cards">
                {items.map((task, i) => (
                  <button
                    key={task.id}
                    type="button"
                    className="dr-card"
                    style={{ animationDelay: `${Math.min(i, 10) * 22}ms` }}
                    onClick={() => onOpenTask(task.id)}
                  >
                    <span className="dr-card__top">
                      <span className="dr-card__id" style={{ color: statusColor(task.status) }}>
                        {task.id}
                      </span>
                      {task.assignee && (
                        <span className="dr-card__who" title={task.assignee}>
                          {initials(task.assignee)}
                        </span>
                      )}
                    </span>
                    <span className="dr-card__title">{task.title}</span>
                    {task.latest_summary && <span className="dr-card__sum">{task.latest_summary}</span>}
                  </button>
                ))}
                {!loading && items.length === 0 && <div className="dr-col__empty">{t("board.empty")}</div>}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
