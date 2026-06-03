import { useEffect, useState } from "react";

import { api } from "../api";
import { initials, statusColor } from "../constants";
import type { Comment, Run, Task } from "../types";

export function TaskDrawer(props: { taskId: string | null; onClose: () => void }) {
  const { taskId, onClose } = props;
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
        if (alive) setError(e instanceof Error ? e.message : "failed to load task");
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
      <aside className="dr-drawer__panel" role="dialog" aria-label="task detail">
        <header className="dr-drawer__head">
          <div className="dr-drawer__id">
            <span className="dr-drawer__ticket" style={{ color: statusColor(task?.status ?? "") }}>
              {task?.id ?? taskId}
            </span>
            {task?.status && (
              <span className="dr-pill" style={{ "--accent": statusColor(task.status) } as React.CSSProperties}>
                {task.status}
              </span>
            )}
          </div>
          <button type="button" className="dr-drawer__close" onClick={onClose} aria-label="close">
            ✕
          </button>
        </header>

        {loading && <div className="dr-drawer__msg">loading…</div>}
        {error && <div className="dr-drawer__msg is-error">{error}</div>}

        {task && (
          <div className="dr-drawer__scroll">
            <h2 className="dr-drawer__title">{task.title}</h2>
            <div className="dr-drawer__facts">
              {task.assignee && (
                <span className="dr-fact">
                  <span className="dr-fact__k">assignee</span>
                  <span className="dr-fact__v">
                    <span className="dr-card__who">{initials(task.assignee)}</span> {task.assignee}
                  </span>
                </span>
              )}
              {task.tenant && (
                <span className="dr-fact">
                  <span className="dr-fact__k">tenant</span>
                  <span className="dr-fact__v">{task.tenant}</span>
                </span>
              )}
            </div>
            {task.body && <p className="dr-drawer__body">{task.body}</p>}

            <section className="dr-drawer__section dr-drawer__runs">
              <h3 className="dr-drawer__h">Runs <span className="dr-drawer__hn">{runs.length}</span></h3>
              {runs.length === 0 && <div className="dr-drawer__empty">no runs yet</div>}
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
                  {r.status && <span className="dr-run__status">{r.status}</span>}
                </div>
              ))}
            </section>

            <section className="dr-drawer__section dr-drawer__comments">
              <h3 className="dr-drawer__h">Comments <span className="dr-drawer__hn">{comments.length}</span></h3>
              {comments.length === 0 && <div className="dr-drawer__empty">no comments</div>}
              {comments.map((c) => (
                <div key={c.id} className="dr-comment">
                  <span className="dr-comment__who">{c.author ?? "—"}</span>
                  <p className="dr-comment__body">{c.body}</p>
                </div>
              ))}
            </section>
          </div>
        )}
      </aside>
    </div>
  );
}
