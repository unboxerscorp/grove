import { useCallback, useEffect, useRef, useState } from "react";

import { api } from "../api";
import type { ExecutionGate, TaskExecution } from "../api";
import { cx } from "../constants";
import { useI18n } from "../i18n";
import type { TFn } from "../i18n";

type QueueItem = { task_id: string; title: string; exec: TaskExecution };
type Confirm = { kind: "approve" | "abort" | "gate"; id: string; label: string } | null;

function ExecMark() {
  return (
    <svg className="exec__mark" viewBox="0 0 24 24" width={20} height={20} aria-hidden="true">
      <path d="M5 4l7 4M5 4v16l7-4M5 4l7 4m7-4l-7 4m7-4v16l-7-4m0-12v12" fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinejoin="round" />
    </svg>
  );
}

/**
 * Execution loop control surface: global/board gate + kill-switch status and
 * controls, plus an approval queue of approval-pending tasks. Reading is the
 * default; approve / abort / kill-switch are EXPLICIT two-step (button → confirm)
 * actions that POST. Errors surface as fixed messages (no raw/secret leak).
 * The execution gate is SEPARATE from autopickup.
 */
export function ExecutionPanel(props: {
  boardId: string | null;
  liveTick: number;
  projectTick: number;
  onChanged: () => void;
}) {
  const { boardId, liveTick, projectTick, onChanged } = props;
  const { t } = useI18n();
  const [gate, setGate] = useState<ExecutionGate | null>(null);
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [errCode, setErrCode] = useState<"forbidden" | "error" | null>(null);
  const [confirm, setConfirm] = useState<Confirm>(null);
  const [busy, setBusy] = useState(false);
  const [actionErr, setActionErr] = useState<string | null>(null);
  // Proactive role lock: a team viewer cannot approve/abort/kill-switch, so the
  // controls are hidden up front (member null in local-token mode = operator).
  const [isViewer, setIsViewer] = useState(false);
  const tRef = useRef(t);
  tRef.current = t;

  useEffect(() => {
    let alive = true;
    api
      .getMe()
      .then((me) => {
        if (alive) setIsViewer(me?.member?.role === "viewer");
      })
      .catch(() => {
        if (alive) setIsViewer(false);
      });
    return () => {
      alive = false;
    };
  }, [projectTick]);

  const loadGate = useCallback(() => {
    api
      .getExecutionGate()
      .then((g) => {
        setGate(g);
        setErrCode(null);
      })
      .catch((e: unknown) => {
        const msg = e instanceof Error ? e.message : "";
        setErrCode(/\b403\b/.test(msg) ? "forbidden" : "error");
      });
  }, []);

  const loadQueue = useCallback(() => {
    if (!boardId) {
      setQueue([]);
      return;
    }
    api
      .listTasks(boardId)
      .then(async (tasks) => {
        const list = Array.isArray(tasks) ? tasks : [];
        const execs = await Promise.all(
          list.map((tk) =>
            api
              .getTaskExecution(tk.id)
              .then((ex) => ({ task_id: tk.id, title: tk.title, exec: ex }))
              .catch(() => null),
          ),
        );
        setQueue(execs.filter((x): x is QueueItem => !!x && x.exec.state === "approval-pending"));
      })
      .catch(() => setQueue([]));
  }, [boardId]);

  useEffect(() => {
    loadGate();
    loadQueue();
  }, [loadGate, loadQueue, liveTick, projectTick]);

  const run = (fn: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true);
    setActionErr(null);
    fn()
      .then(() => {
        setBusy(false);
        setConfirm(null);
        loadGate();
        loadQueue();
        onChanged();
      })
      .catch((e: unknown) => {
        setBusy(false);
        setConfirm(null);
        const msg = e instanceof Error ? e.message : "";
        // Fixed message only — never surface raw cause / path / secret.
        setActionErr(/\b403\b/.test(msg) ? t("exec.denied") : t("exec.actionError"));
      });
  };

  const doConfirm = () => {
    if (!confirm) return;
    if (confirm.kind === "approve") run(() => api.approveTask(confirm.id));
    else if (confirm.kind === "abort") run(() => api.abortTask(confirm.id));
    else if (confirm.kind === "gate") {
      // id encodes which gate field to flip, e.g. "kill_switch:true".
      const [field, val] = confirm.id.split(":");
      run(() => api.setExecutionGate({ [field as "enabled" | "kill_switch" | "board_kill_switch"]: val === "true" }));
    }
  };

  if (errCode === "forbidden") {
    return (
      <section className="exec">
        <div className="exec__scroll">
          <div className="exec__msg is-warn">{t("exec.forbidden")}</div>
        </div>
      </section>
    );
  }

  return (
    <section className="exec">
      <div className="exec__scroll">
        <header className="exec__head">
          <div className="exec__title-wrap">
            <ExecMark />
            <h2 className="exec__title">{t("exec.title")}</h2>
          </div>
        </header>
        <p className="exec__note">{t("exec.note")}</p>
        {isViewer && <div className="exec__msg is-warn exec-viewer-note">{t("exec.viewerNote")}</div>}
        {errCode === "error" && <div className="exec__msg is-error">{t("exec.loadError")}</div>}
        {actionErr && <div className="exec__msg is-error">{actionErr}</div>}

        {/* ── gate + kill-switch ───────────────────────────────────────── */}
        {gate && (
          <div className="exec-gate">
            <div className="exec-gate__row">
              <span className={cx("exec-gate__chip", gate.enabled ? "is-on" : "is-off")} data-gate="enabled">
                {t("exec.gate.enabled")}: {gate.enabled ? t("exec.on") : t("exec.off")}
              </span>
              <span className={cx("exec-gate__chip", gate.kill_switch ? "is-kill" : "is-ok")} data-gate="kill">
                {t("exec.gate.kill")}: {gate.kill_switch ? t("exec.on") : t("exec.off")}
              </span>
              <span className={cx("exec-gate__chip", gate.board_enabled ? "is-on" : "is-off")} data-gate="board">
                {t("exec.gate.board")}: {gate.board_enabled ? t("exec.on") : t("exec.off")}
              </span>
              <span className={cx("exec-gate__chip", gate.board_kill_switch ? "is-kill" : "is-ok")} data-gate="boardKill">
                {t("exec.gate.boardKill")}: {gate.board_kill_switch ? t("exec.on") : t("exec.off")}
              </span>
            </div>
            {/* Kill-switch is a dangerous control → explicit confirm. Hidden for
                viewers (read-only). */}
            {!isViewer && (
              <div className="exec-ks">
                <button
                  type="button"
                  className={cx("exec-ks__btn", gate.kill_switch && "is-armed")}
                  data-ks="global"
                  onClick={() => setConfirm({ kind: "gate", id: `kill_switch:${!gate.kill_switch}`, label: t("exec.gate.kill") })}
                >
                  {gate.kill_switch ? t("exec.ks.clear") : t("exec.ks.arm")}
                </button>
              </div>
            )}
          </div>
        )}

        {/* ── approval queue ───────────────────────────────────────────── */}
        <div className="exec-queue">
          <div className="exec-queue__title">
            {t("exec.queue.title")} <span className="exec-queue__n">{queue.length}</span>
          </div>
          {queue.length === 0 && <div className="exec__msg">{t("exec.queue.empty")}</div>}
          {queue.map((q) => (
            <ApprovalRow
              key={q.task_id}
              q={q}
              t={t}
              busy={busy}
              viewer={isViewer}
              confirm={confirm}
              onAsk={(kind) => {
                setActionErr(null);
                setConfirm({ kind, id: q.task_id, label: q.title });
              }}
              onConfirm={doConfirm}
              onCancel={() => setConfirm(null)}
            />
          ))}
        </div>

        {confirm?.kind === "gate" && (
          <div className="exec-confirm exec-confirm--gate" data-confirm="gate">
            <span className="exec-confirm__q">{t("exec.ks.confirm")}</span>
            <button type="button" className="dr-btn dr-btn--primary exec-confirm-yes" disabled={busy} onClick={doConfirm}>
              {t("exec.confirmYes")}
            </button>
            <button type="button" className="dr-btn dr-btn--ghost exec-confirm-no" onClick={() => setConfirm(null)}>
              {t("exec.confirmNo")}
            </button>
          </div>
        )}
      </div>
    </section>
  );
}

function ApprovalRow(props: {
  q: QueueItem;
  t: TFn;
  busy: boolean;
  viewer: boolean;
  confirm: Confirm;
  onAsk: (kind: "approve" | "abort") => void;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const { q, t, busy, viewer, confirm, onAsk, onConfirm, onCancel } = props;
  const pending = confirm && confirm.id === q.task_id && (confirm.kind === "approve" || confirm.kind === "abort");
  return (
    <div className="exec-queue__item" data-task={q.task_id}>
      <div className="exec-queue__head">
        <span className="exec-queue__state">{q.exec.state}</span>
        <span className="exec-queue__id">{q.task_id}</span>
        <span className="exec-queue__name">{q.title}</span>
      </div>
      {viewer ? (
        <span className="exec-queue__readonly">{t("exec.viewerReadonly")}</span>
      ) : pending ? (
        <div className="exec-confirm" data-confirm={confirm.kind}>
          <span className="exec-confirm__q">
            {confirm.kind === "approve" ? t("exec.approveConfirm", { task: q.task_id }) : t("exec.abortConfirm", { task: q.task_id })}
          </span>
          <button type="button" className="dr-btn dr-btn--primary exec-confirm-yes" disabled={busy} onClick={onConfirm}>
            {t("exec.confirmYes")}
          </button>
          <button type="button" className="dr-btn dr-btn--ghost exec-confirm-no" onClick={onCancel}>
            {t("exec.confirmNo")}
          </button>
        </div>
      ) : (
        <div className="exec-queue__actions">
          <button type="button" className="dr-btn dr-btn--primary exec-approve-btn" onClick={() => onAsk("approve")}>
            {t("exec.approve")}
          </button>
          <button type="button" className="dr-btn dr-btn--ghost exec-abort-btn" onClick={() => onAsk("abort")}>
            {t("exec.abort")}
          </button>
        </div>
      )}
    </div>
  );
}
