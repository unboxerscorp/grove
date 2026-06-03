import { useEffect, useRef, useState } from "react";

import { api } from "../api";
import type { InboxItem } from "../api";
import { cx, fmtAgo } from "../constants";
import { useI18n } from "../i18n";
import { useFocusTrap } from "../useFocusTrap";

/**
 * Decision inbox drawer. Consumes GET /api/inbox (project-scoped via the shared
 * client headers) and lists blocked / ask-human tasks awaiting a human, each
 * with an answer box that POSTs to the item's answer.endpoint
 * (/api/tasks/{id}/answer → comment + unblock). On success the item is removed
 * (refetch) and `onAnswered` bumps liveTick so the board + audit refresh.
 * A team viewer's POST is rejected (403); the drawer then surfaces a safe
 * message and disables further answering (no role is exposed to the FE).
 */
export function InboxDrawer(props: { open: boolean; projectTick: number; onAnswered: () => void; onClose: () => void }) {
  const { open, projectTick, onAnswered, onClose } = props;
  const { t } = useI18n();
  const panelRef = useRef<HTMLElement | null>(null);
  useFocusTrap(open, panelRef);

  const [items, setItems] = useState<InboxItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busyId, setBusyId] = useState<string | null>(null);
  const [itemError, setItemError] = useState<Record<string, string>>({});
  // Set once an answer is rejected with 403 (team viewer): hide the answer UI.
  const [denied, setDenied] = useState(false);

  const load = () => {
    setLoading(true);
    setError(null);
    api
      .getInbox()
      .then((page) => {
        setItems(Array.isArray(page.items) ? page.items : []);
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : t("inbox.loadError")))
      .finally(() => setLoading(false));
  };

  // (Re)load on open / project switch.
  useEffect(() => {
    if (!open) return;
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, projectTick]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const submit = (item: InboxItem) => {
    const endpoint = item.answer?.endpoint;
    const text = (drafts[item.task_id] ?? "").trim();
    if (!endpoint || !text || busyId) return;
    setBusyId(item.task_id);
    setItemError((m) => ({ ...m, [item.task_id]: "" }));
    api
      .answerTask(endpoint, text)
      .then(() => {
        setBusyId(null);
        setDrafts((d) => {
          const next = { ...d };
          delete next[item.task_id];
          return next;
        });
        load(); // success → the answered item drops out of the inbox
        onAnswered(); // bump liveTick → board + audit + header badge refresh
      })
      .catch((e: unknown) => {
        setBusyId(null);
        const msg = e instanceof Error ? e.message : "";
        if (/\b403\b/.test(msg)) {
          setDenied(true); // team viewer: lock the answer UI behind a safe notice
        } else {
          setItemError((m) => ({ ...m, [item.task_id]: t("inbox.answerError") }));
        }
      });
  };

  if (!open) return null;

  return (
    <div className="dr-drawer inbox-drawer">
      <div className="dr-drawer__scrim" onClick={onClose} />
      <aside
        className="dr-drawer__panel inbox-panel"
        role="dialog"
        aria-modal="true"
        aria-label={t("inbox.title")}
        tabIndex={-1}
        ref={panelRef}
      >
        <header className="dr-drawer__head">
          <div className="dr-drawer__id">
            <span className="dr-drawer__ticket">⚑ {t("inbox.title")}</span>
            {items.length > 0 && <span className="inbox-count">{items.length}</span>}
          </div>
          <button type="button" className="dr-drawer__close" onClick={onClose} aria-label={t("drawer.close")}>
            ✕
          </button>
        </header>

        {denied && <div className="inbox-denied" role="alert">⚠ {t("inbox.denied")}</div>}

        <div className="dr-drawer__scroll inbox-list">
          {error && <div className="inbox-msg is-error">{error}</div>}
          {!error && loading && items.length === 0 && <div className="inbox-msg">{t("inbox.loading")}</div>}
          {!error && !loading && items.length === 0 && <div className="inbox-msg">{t("inbox.empty")}</div>}

          {items.map((item) => {
            const askHuman = item.type === "ask_human" || item.needs_human;
            return (
              <div key={item.task_id} data-task={item.task_id} className="inbox-item">
                <div className="inbox-item__head">
                  <span className={cx("inbox-type", askHuman ? "is-human" : "is-blocked")}>
                    {askHuman ? t("inbox.askHuman") : t("inbox.blocked")}
                  </span>
                  <span className="inbox-item__title">{item.title}</span>
                  <span className="inbox-item__wait">{t("inbox.waiting")} {fmtAgo(item.blocked_since)}</span>
                </div>
                <div className="inbox-item__meta">
                  {item.node && <span className="inbox-item__node">⬡ {item.node}</span>}
                  <span className="inbox-item__id">{item.task_id}</span>
                </div>
                {item.blocked_reason && <div className="inbox-item__reason">{item.blocked_reason}</div>}
                {item.body && <div className="inbox-item__body">{item.body}</div>}

                {!denied && (
                  <div className="inbox-answer">
                    <textarea
                      className="dr-input inbox-answer__input"
                      name={`answer-${item.task_id}`}
                      rows={2}
                      placeholder={t("inbox.answerPlaceholder")}
                      value={drafts[item.task_id] ?? ""}
                      spellCheck={false}
                      onChange={(e) => setDrafts((d) => ({ ...d, [item.task_id]: e.target.value }))}
                    />
                    <button
                      type="button"
                      className="dr-btn dr-btn--primary inbox-answer__submit"
                      disabled={busyId === item.task_id || !(drafts[item.task_id] ?? "").trim()}
                      onClick={() => submit(item)}
                    >
                      {busyId === item.task_id ? t("inbox.answering") : t("inbox.answer")}
                    </button>
                    {itemError[item.task_id] && <div className="inbox-answer__err">{itemError[item.task_id]}</div>}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </aside>
    </div>
  );
}
