import { useEffect, useMemo, useState } from "react";

import { api, canonicalStatus } from "../api";
import { COLUMNS, HUMAN_CREATE_STATUS_COLUMNS, HUMAN_LIST_COLUMNS, MANUAL_STATUS_COLUMNS, boardBucket, cx, initials, statusColor } from "../constants";
import { statusLabel, useI18n } from "../i18n";
import type { AssigneeCandidate, BoardWorkflow, GroveNode, Task } from "../types";

const PRIORITIES = ["low", "normal", "high"] as const;
const GROUP_ASSIGNEE_PREFIX = "group:";

/** Short, de-emphasized id slug for a card — long raw ids (task_2398…) are
 *  truncated so they never dominate or overflow; short ids (G-2) pass through. */
function shortId(id: string): string {
  return id.length > 12 ? `${id.slice(0, 10)}…` : id;
}

function boardListKey(
  task: Task,
  workflow: BoardWorkflow | null,
): "staged" | "todo" | "ask_human" | "archive" {
  return boardBucket(canonicalStatus(task.status, workflow), Boolean(task.needs_human));
}

/** Epoch-ms for a task's `updated` field (string ISO or number sec/ms), used to
 *  sort the archive most-recently-completed first. Unknown/missing sorts last. */
function updatedMs(task: Task): number {
  const u = task.updated;
  if (typeof u === "number") return u < 1e12 ? u * 1000 : u;
  if (typeof u === "string") {
    const parsed = Date.parse(u);
    return Number.isNaN(parsed) ? 0 : parsed;
  }
  return 0;
}

function AddTaskForm(props: { boardId: string; initialStatus?: string; onCreated: () => void; onClose: () => void }) {
  const { boardId, initialStatus, onCreated, onClose } = props;
  const { t } = useI18n();
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [assignee, setAssignee] = useState("");
  const [candidates, setCandidates] = useState<AssigneeCandidate[]>([]);
  const [status, setStatus] = useState<string>(initialStatus ?? COLUMNS[0].key);
  const [priority, setPriority] = useState<string>("normal");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const groupTargets = useMemo(() => {
    const grouped = new Map<string, AssigneeCandidate[]>();
    for (const candidate of candidates) {
      const group = candidate.group?.trim();
      if (!group) continue;
      const members = grouped.get(group) ?? [];
      members.push(candidate);
      grouped.set(group, members);
    }
    return Array.from(grouped.entries())
      .map(([group, members]) => ({
        group,
        members: members.slice().sort((a, b) => a.name.localeCompare(b.name)),
      }))
      .sort((a, b) => a.group.localeCompare(b.group));
  }, [candidates]);

  const selectedGroup = assignee.startsWith(GROUP_ASSIGNEE_PREFIX) ? assignee.slice(GROUP_ASSIGNEE_PREFIX.length) : "";
  const selectedGroupMembers = selectedGroup ? (groupTargets.find((target) => target.group === selectedGroup)?.members ?? []) : [];

  // assignee = a REQUIRED dropdown of the project's nodes + default node
  // (web_app.py assignee_candidates/default_assignee; falls back to /api/org
  // nodes if the candidate list is absent). No free input.
  useEffect(() => {
    let alive = true;
    api
      .getOrg()
      .then((o) => {
        if (!alive) return;
        const nodeByName = new Map((o.nodes ?? []).map((node) => [node.name, node]));
        const baseCandidates: AssigneeCandidate[] =
          o.assignee_candidates && o.assignee_candidates.length > 0
            ? o.assignee_candidates
            : (o.nodes ?? []).map((n) => ({ name: n.name, role: n.role, agent: n.agent, status: n.status }));
        const cands = baseCandidates.map((candidate) => ({
          ...candidate,
          group: candidate.group ?? nodeByName.get(candidate.name)?.group ?? "",
        }));
        setCandidates(cands);
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
    const assignees =
      selectedGroupMembers.length > 0 ? selectedGroupMembers.map((member) => member.name) : [assignee.trim()].filter(Boolean);
    const bodyTrim = body.trim() || undefined;
    Promise.all(
      assignees.map((targetAssignee) =>
        api.createTask(boardId, {
          title: titleTrim,
          body: bodyTrim,
          assignee: targetAssignee || undefined,
          status,
          priority,
        }),
      ),
    )
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
          {groupTargets.length > 0 && (
            <optgroup label={t("add.groups")}>
              {groupTargets.map((target) => (
                <option key={target.group} value={`${GROUP_ASSIGNEE_PREFIX}${target.group}`}>
                  {t("add.groupTarget", { group: target.group, n: target.members.length })}
                </option>
              ))}
            </optgroup>
          )}
        </select>
        <select
          className="dr-select"
          name="status"
          value={status}
          aria-label={t("add.status")}
          onChange={(e) => setStatus(e.target.value)}
        >
          {HUMAN_CREATE_STATUS_COLUMNS.map((c) => (
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

/** A single board card — used identically in the active human lists and in the
 *  archive section. `canon` is the pre-canonicalized status; the status dropdown
 *  (operators only) doubles as the re-open control for archived cards. */
function TaskCard(props: {
  task: Task;
  canon: string;
  manualStatuses: string[];
  isViewer: boolean;
  index: number;
  onOpenTask: (id: string) => void;
  onTransition: (taskId: string, toStatus: string) => void;
}) {
  const { task, canon, manualStatuses, isViewer, index, onOpenTask, onTransition } = props;
  const { t } = useI18n();
  const statusOptions = manualStatuses.includes(canon) ? manualStatuses : [canon, ...manualStatuses];
  return (
    <div
      className="dr-card"
      data-task={task.id}
      data-status={canon}
      style={{ animationDelay: `${Math.min(index, 10) * 22}ms` }}
    >
      {/* Title opens the drawer; the status dropdown + badges live in the meta
          row (a card can't be a <button> with controls). */}
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
          onChange={(e) => onTransition(task.id, e.target.value)}
        >
          {statusOptions.map((k) => (
            <option key={k} value={k}>
              {statusLabel(t, k)}
            </option>
          ))}
        </select>
      )}
      {task.latest_summary && <span className="dr-card__sum">{task.latest_summary}</span>}
    </div>
  );
}

// Dispatch/answer targets are executor-eligible nodes only (lead + worker
// groups); the backend rejects others — mirror that so the picker never offers a
// node the dispatch would 400 on.
const EXECUTOR_GROUPS = new Set(["lead", "workers"]);

/** Staged item: a stacked, not-yet-dispatched task. The operator executes/submits
 *  it ONE at a time — optional comment + executor-eligible assignee → POST
 *  /dispatch (staged -> ready). The composer is collapsed until opened; there is
 *  no bulk submit (anti-spam). */
function StagedCard(props: {
  task: Task;
  executorNodes: string[];
  isViewer: boolean;
  index: number;
  onOpenTask: (id: string) => void;
  onDispatch: (id: string, comment: string, assignee: string) => Promise<unknown>;
}) {
  const { task, executorNodes, isViewer, index, onOpenTask, onDispatch } = props;
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [comment, setComment] = useState("");
  const [assignee, setAssignee] = useState(task.assignee ?? "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const submit = () => {
    if (busy) return;
    setBusy(true);
    setErr(null);
    // On success the parent refetches → the card leaves the staged queue (unmounts).
    onDispatch(task.id, comment.trim(), assignee).catch((e: unknown) => {
      setBusy(false);
      setErr(e instanceof Error ? e.message : t("staged.error"));
    });
  };
  return (
    <div className="dr-card dr-staged" data-task={task.id} style={{ animationDelay: `${Math.min(index, 10) * 22}ms` }}>
      <button type="button" className="dr-card__open" onClick={() => onOpenTask(task.id)}>
        <span className="dr-card__title">{task.title?.trim() || shortId(task.id)}</span>
      </button>
      <span className="dr-card__meta">
        <span className="dr-card__id" title={task.id}>
          {shortId(task.id)}
        </span>
        {task.assignee && (
          <span className="dr-card__who" title={task.assignee}>
            {initials(task.assignee)}
          </span>
        )}
      </span>
      {!isViewer &&
        (open ? (
          <div className="dr-staged__composer">
            <textarea
              className="dr-input dr-staged__comment"
              rows={2}
              placeholder={t("staged.commentPh")}
              value={comment}
              onChange={(e) => setComment(e.target.value)}
            />
            <select
              className="dr-select dr-staged__assignee"
              value={assignee}
              aria-label={t("staged.assignee")}
              onChange={(e) => setAssignee(e.target.value)}
            >
              <option value="">{t("staged.assigneeNone")}</option>
              {assignee && !executorNodes.includes(assignee) && <option value={assignee}>{assignee}</option>}
              {executorNodes.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
            <div className="dr-staged__actions">
              <button type="button" className="dr-btn dr-btn--ghost" onClick={() => setOpen(false)}>
                {t("staged.cancel")}
              </button>
              <button
                type="button"
                className="dr-btn dr-btn--primary dr-staged__submit"
                disabled={busy}
                onClick={submit}
              >
                {busy ? t("staged.dispatching") : t("staged.submit")}
              </button>
            </div>
            {err && <div className="dr-staged__err">{err}</div>}
          </div>
        ) : (
          <button type="button" className="dr-btn dr-btn--primary dr-staged__open" onClick={() => setOpen(true)}>
            {t("staged.open")}
          </button>
        ))}
      {task.latest_summary && <span className="dr-card__sum">{task.latest_summary}</span>}
    </div>
  );
}

/** Inline ask-human answer composer (the board IS the answer surface; the inbox no
 *  longer answers ask-human). Collapsed until opened; submit POSTs the answer and
 *  unblocks the item (parent refetch drops it from the list). */
function AnswerComposer(props: { taskId: string; onAnswer: (id: string, text: string) => Promise<unknown> }) {
  const { taskId, onAnswer } = props;
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const submit = () => {
    const v = text.trim();
    if (!v || busy) return;
    setBusy(true);
    setErr(null);
    onAnswer(taskId, v).catch((e: unknown) => {
      setBusy(false);
      setErr(e instanceof Error ? e.message : t("answer.error"));
    });
  };
  if (!open) {
    return (
      <button type="button" className="dr-btn dr-btn--primary dr-answer__open" onClick={() => setOpen(true)}>
        {t("answer.open")}
      </button>
    );
  }
  return (
    <div className="dr-answer">
      <textarea
        className="dr-input dr-answer__input"
        rows={2}
        placeholder={t("answer.placeholder")}
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      <div className="dr-answer__actions">
        <button type="button" className="dr-btn dr-btn--ghost" onClick={() => setOpen(false)}>
          {t("answer.cancel")}
        </button>
        <button
          type="button"
          className="dr-btn dr-btn--primary dr-answer__submit"
          disabled={busy || !text.trim()}
          onClick={submit}
        >
          {busy ? t("answer.submitting") : t("answer.submit")}
        </button>
      </div>
      {err && <div className="dr-answer__err">{err}</div>}
    </div>
  );
}

export function BoardView(props: {
  boardId: string;
  nodes: GroveNode[];
  liveTick: number;
  projectTick: number;
  boardLive: boolean;
  project?: string | null;
  onOpenTask: (id: string) => void;
}) {
  const { boardId, nodes, liveTick, projectTick, boardLive, project, onOpenTask } = props;
  const { t } = useI18n();
  const [tasks, setTasks] = useState<Task[]>([]);
  const [workflow, setWorkflow] = useState<BoardWorkflow | null>(null);
  const [isViewer, setIsViewer] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [adding, setAdding] = useState(false);
  const [addStatus, setAddStatus] = useState<string | undefined>(undefined);
  const [groupFilter, setGroupFilter] = useState("");
  const [archiveOpen, setArchiveOpen] = useState(false);

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
      .listTasks(boardId)
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
  }, [boardId, liveTick, projectTick, reloadKey, t]);

  useEffect(() => {
    setGroupFilter("");
    setArchiveOpen(false);
  }, [projectTick]);

  const nodeByName = useMemo(() => new Map(nodes.map((node) => [node.name, node])), [nodes]);

  const groups = useMemo(
    () => Array.from(new Set(nodes.map((node) => node.group).filter((group): group is string => Boolean(group)))).sort(),
    [nodes],
  );

  useEffect(() => {
    if (groupFilter && !groups.includes(groupFilter)) setGroupFilter("");
  }, [groupFilter, groups]);

  const visibleTasks = useMemo(() => {
    if (!groupFilter) return tasks;
    return tasks.filter((task) => {
      const assignee = task.assignee?.trim();
      return Boolean(assignee && nodeByName.get(assignee)?.group === groupFilter);
    });
  }, [groupFilter, nodeByName, tasks]);

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

  // The operator-facing board is two active human lists (todo, ask_human) plus a
  // separated archive (done/archived) so completed work never clutters the lists.
  // Internal task status still exists for compatibility but does not drive columns.
  const buckets = useMemo(() => {
    const map: { staged: Task[]; todo: Task[]; ask_human: Task[]; archive: Task[] } = {
      staged: [],
      todo: [],
      ask_human: [],
      archive: [],
    };
    for (const task of visibleTasks) map[boardListKey(task, workflow)].push(task);
    map.archive.sort((a, b) => updatedMs(b) - updatedMs(a)); // most recently completed first
    return map;
  }, [visibleTasks, workflow]);
  const activeCount = buckets.todo.length + buckets.ask_human.length;
  // Executor-eligible nodes for the staged dispatch assignee picker (lead/workers).
  const executorNodes = useMemo(
    () => nodes.filter((n) => EXECUTOR_GROUPS.has(n.group ?? "")).map((n) => n.name),
    [nodes],
  );

  const dispatchStaged = (id: string, comment: string, assignee: string) =>
    api
      .dispatchTask(id, { comment: comment || undefined, assignee: assignee || undefined })
      .then(() => setReloadKey((k) => k + 1)); // staged -> ready: card leaves the queue

  const answerAskHuman = (id: string, text: string) =>
    api
      .answerTask(`/api/tasks/${encodeURIComponent(id)}/answer`, text)
      .then(() => setReloadKey((k) => k + 1)); // answered: card leaves the ask-human list

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
          {project && (
            <span className="dr-board__count dr-board__project" title={`${t("board.project")}: ${project}`}>
              {project}
            </span>
          )}
          <span className="dr-board__count">{t("board.count", { n: activeCount })}</span>
        </div>
        <div className="dr-board__actions">
          {groups.length > 0 && (
            <select
              className="dr-select dr-board__group-filter"
              aria-label={t("board.groupFilter")}
              value={groupFilter}
              onChange={(e) => setGroupFilter(e.target.value)}
            >
              <option value="">{t("board.groupAll")}</option>
              {groups.map((group) => (
                <option key={group} value={group}>
                  {group}
                </option>
              ))}
            </select>
          )}
          <button
            type="button"
            className={cx("dr-addbtn", adding && "is-open")}
            onClick={() => {
              setAddStatus(undefined);
              setAdding((v) => !v);
            }}
          >
            {t("add.open")}
          </button>
        </div>
      </div>

      {adding && (
        <AddTaskForm
          key={addStatus ?? "default"}
          boardId={boardId}
          initialStatus={addStatus}
          onCreated={() => setReloadKey((k) => k + 1)}
          onClose={() => setAdding(false)}
        />
      )}

      {error && <div className="dr-board__msg is-error">{error}</div>}

      {/* Staged action queue (top, full-width): new items the operator triages +
          dispatches one at a time. Hidden when empty. */}
      {buckets.staged.length > 0 && (
        <div className="dr-board__staged" data-col="staged">
          <div className="dr-staged-head">
            <span className="dr-staged-head__name">{t("staged.title")}</span>
            <span className="dr-col__n">{buckets.staged.length}</span>
          </div>
          <div className="dr-staged-grid">
            {buckets.staged.map((task, i) => (
              <StagedCard
                key={task.id}
                task={task}
                executorNodes={executorNodes}
                isViewer={isViewer}
                index={i}
                onOpenTask={onOpenTask}
                onDispatch={dispatchStaged}
              />
            ))}
          </div>
        </div>
      )}

      <div className="dr-board__cols">
        {HUMAN_LIST_COLUMNS.map((col) => {
          const items = buckets[col.key] ?? [];
          const label = t(col.labelKey);
          const canAdd = !isViewer;
          return (
            <div key={col.key} className="dr-col" data-col={col.key}>
              <div
                className="dr-col__head"
                style={{ "--accent": statusColor(col.key) } as React.CSSProperties}
              >
                <div className="dr-col__title">
                  <span className="dr-col__name">{label}</span>
                  <span className="dr-col__n">{items.length}</span>
                </div>
                {canAdd && (
                  <button
                    type="button"
                    className="dr-col__add"
                    aria-label={t("board.addToList", { list: label })}
                    title={t("board.addToList", { list: label })}
                    onClick={() => {
                      setAddStatus(col.createStatus);
                      setAdding(true);
                    }}
                  >
                    +
                  </button>
                )}
              </div>
              <div className="dr-col__cards">
                {items.map((task, i) =>
                  col.key === "ask_human" ? (
                    // ask-human: card + the inline answer composer (the board IS the
                    // answer surface; the inbox no longer answers ask-human).
                    <div key={task.id} className="dr-card-stack">
                      <TaskCard
                        task={task}
                        canon={canonicalStatus(task.status, workflow)}
                        manualStatuses={manualStatuses}
                        isViewer={isViewer}
                        index={i}
                        onOpenTask={onOpenTask}
                        onTransition={transition}
                      />
                      {!isViewer && <AnswerComposer taskId={task.id} onAnswer={answerAskHuman} />}
                    </div>
                  ) : (
                    <TaskCard
                      key={task.id}
                      task={task}
                      canon={canonicalStatus(task.status, workflow)}
                      manualStatuses={manualStatuses}
                      isViewer={isViewer}
                      index={i}
                      onOpenTask={onOpenTask}
                      onTransition={transition}
                    />
                  ),
                )}
                {!loading && items.length === 0 && <div className="dr-col__empty">{t("board.empty")}</div>}
              </div>
            </div>
          );
        })}
      </div>

      {/* Completed work, separated out of the active lists. Collapsed by default;
          cards keep their status dropdown so an operator can re-open one. Hidden
          entirely when empty. Reuses the design-system button + card classes. */}
      {buckets.archive.length > 0 && (
        <div className="dr-board__archive" data-col="archive">
          <button
            type="button"
            className="dr-btn dr-btn--ghost dr-board__archive-toggle"
            aria-expanded={archiveOpen}
            aria-label={t("board.archive.toggle")}
            onClick={() => setArchiveOpen((v) => !v)}
          >
            <span className="dr-board__archive-chevron" aria-hidden="true">
              {archiveOpen ? "▾" : "▸"}
            </span>
            <span className="dr-col__name">{t("board.list.archive")}</span>
            <span className="dr-col__n">{buckets.archive.length}</span>
          </button>
          {archiveOpen && (
            <div className="dr-col__cards dr-board__archive-cards">
              {buckets.archive.map((task, i) => (
                <TaskCard
                  key={task.id}
                  task={task}
                  canon={canonicalStatus(task.status, workflow)}
                  manualStatuses={manualStatuses}
                  isViewer={isViewer}
                  index={i}
                  onOpenTask={onOpenTask}
                  onTransition={transition}
                />
              ))}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
