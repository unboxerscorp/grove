import { useEffect, useMemo, useState } from "react";

import { api } from "../api";
import { COLUMNS, cx, initials, statusColor } from "../constants";
import type { Task } from "../types";

export function BoardView(props: {
  boardId: string;
  liveTick: number;
  boardLive: boolean;
  onOpenTask: (id: string) => void;
}) {
  const { boardId, liveTick, boardLive, onOpenTask } = props;
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState("");
  const [assigneeFilter, setAssigneeFilter] = useState("");

  useEffect(() => {
    let alive = true;
    setLoading(true);
    api
      .listTasks(boardId, {
        status: statusFilter || undefined,
        assignee: assigneeFilter || undefined,
      })
      .then((t) => {
        if (!alive) return;
        setTasks(Array.isArray(t) ? t : []);
        setError(null);
      })
      .catch((e: unknown) => {
        if (alive) setError(e instanceof Error ? e.message : "failed to load tasks");
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [boardId, statusFilter, assigneeFilter, liveTick]);

  const byColumn = useMemo(() => {
    const map: Record<string, Task[]> = {};
    for (const c of COLUMNS) map[c.key] = [];
    for (const t of tasks) (map[t.status] ??= []).push(t);
    return map;
  }, [tasks]);

  return (
    <section className="dr-board">
      <div className="dr-board__toolbar">
        <div className="dr-board__lead">
          <span className={cx("dr-spark", boardLive && "is-on")} />
          <span className="dr-board__title">Board</span>
          <span className="dr-board__count">{tasks.length} tasks</span>
        </div>
        <div className="dr-board__filters">
          <select
            className="dr-select"
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            aria-label="status filter"
          >
            <option value="">all statuses</option>
            {COLUMNS.map((c) => (
              <option key={c.key} value={c.key}>
                {c.label}
              </option>
            ))}
          </select>
          <input
            className="dr-input"
            type="text"
            placeholder="assignee…"
            value={assigneeFilter}
            spellCheck={false}
            onChange={(e) => setAssigneeFilter(e.target.value)}
          />
        </div>
      </div>

      {error && <div className="dr-board__msg is-error">{error}</div>}

      <div className="dr-board__cols">
        {COLUMNS.map((col) => {
          const items = byColumn[col.key] ?? [];
          return (
            <div key={col.key} className="dr-col">
              <div className="dr-col__head" style={{ "--accent": statusColor(col.key) } as React.CSSProperties}>
                <span className="dr-col__name">{col.label}</span>
                <span className="dr-col__n">{items.length}</span>
              </div>
              <div className="dr-col__cards">
                {items.map((t, i) => (
                  <button
                    key={t.id}
                    type="button"
                    className="dr-card"
                    style={{ animationDelay: `${Math.min(i, 10) * 22}ms` }}
                    onClick={() => onOpenTask(t.id)}
                  >
                    <span className="dr-card__top">
                      <span className="dr-card__id" style={{ color: statusColor(t.status) }}>
                        {t.id}
                      </span>
                      {t.assignee && (
                        <span className="dr-card__who" title={t.assignee}>
                          {initials(t.assignee)}
                        </span>
                      )}
                    </span>
                    <span className="dr-card__title">{t.title}</span>
                    {t.latest_summary && <span className="dr-card__sum">{t.latest_summary}</span>}
                  </button>
                ))}
                {!loading && items.length === 0 && <div className="dr-col__empty">—</div>}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
