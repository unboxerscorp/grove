// MasterChat — floating web chat widget (Channel-Talk style, bottom-right).
//
// v1.27. Conversational launcher to the project-master orchestrator. Mounted
// once at the app root (see app.tsx). Strings live in i18n.tsx (mchat.*), styles
// in styles.css (.dr-mchat), and the REST calls live in api.ts.
//
// Viewers may ask read-only/factual questions. Action preview/confirmation stays
// operator-gated by grove-py, and this component only renders confirm controls
// for operators.
//
// Backend (POST /api/master/chat) is served by grove-py. A transport failure that
// still has an assistant fallback comes back as a normal answer (answer.text =
// ASSISTANT_TRANSPORT_FALLBACK_TEXT) and renders like any reply; a hard failure
// (503/204) just marks the message retryable — the FE never authors its own
// "backend unavailable" notice. Messages follow the persisted live-update contract
// (per ~/dev/notion-slack-sync-server): each is keyed by `id` and upserted in
// place, with a pending -> sent lifecycle. A reply may arrive as a `pending`
// placeholder and resolve later — a future GET poll / SSE would drive those
// follow-up upserts; the upsert-by-id reducer below already supports them.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useI18n } from "../i18n";
import type { Lang } from "../i18n";
import { api, masterConfirmationId, masterReplyFacts, masterReplyText } from "../api";
import type { MasterChatFacts, MasterChatMessage } from "../api";

// ── types ─────────────────────────────────────────────────────────────────────
type ChatRole = "user" | "master";
type ChatStatus = "pending" | "sent" | "error";

interface ChatMessage {
  id: string;
  role: ChatRole;
  text: string;
  ts: number; // epoch ms
  status: ChatStatus;
  facts?: MasterChatFacts;
  confirmationId?: string;
  confirmationState?: "pending" | "confirmed";
}

type Upsert = (m: ChatMessage) => void;

// ── helpers ────────────────────────────────────────────────────────────────────
let _seq = 0;
function genId(prefix: string): string {
  _seq += 1;
  return `${prefix}-${Date.now().toString(36)}-${_seq}`;
}

function fmtTime(ts: number, lang: Lang): string {
  try {
    return new Date(ts).toLocaleTimeString(lang === "ko" ? "ko-KR" : "en-US", {
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return "";
  }
}

function normalize(dto: MasterChatMessage): ChatMessage {
  return {
    id: dto.id,
    role: dto.role === "user" ? "user" : "master",
    text: typeof dto.text === "string" ? dto.text : "",
    ts: typeof dto.ts === "number" ? dto.ts : Date.now(),
    status: dto.status === "pending" ? "pending" : "sent",
  };
}

// Transport failure is NOT surfaced as a FE-authored "backend unavailable" notice
// (that would be non-LLM dev text). The unified backend returns its own one-line
// assistant fallback (ASSISTANT_TRANSPORT_FALLBACK_TEXT) as a normal answer — the
// FE just renders answer.text. A hard failure with no LLM text (503/204) shows
// nothing extra beyond the message's retryable error affordance.

// ── presentational pieces ──────────────────────────────────────────────────────
function ChatIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M4 5.5A2.5 2.5 0 0 1 6.5 3h11A2.5 2.5 0 0 1 20 5.5v7A2.5 2.5 0 0 1 17.5 15H9l-4 4v-4H6.5"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function TypingDots() {
  return (
    <span className="dr-mchat__dots" aria-hidden="true">
      <i />
      <i />
      <i />
    </span>
  );
}

const FACT_STATUSES = ["ready", "running", "blocked", "done"] as const;

function MasterFacts({ facts }: { facts?: MasterChatFacts }) {
  if (!facts) return null;
  const statusCounts = facts.board?.status_counts ?? {};
  const statusItems = FACT_STATUSES.map((status) => [status, statusCounts[status]] as const).filter(
    ([, count]) => typeof count === "number" && count > 0,
  );
  const reviewers = facts.reviewers?.count;
  const askHuman = facts.human?.ask_human_count;
  const needsHuman = facts.human?.needs_human_count;
  const projects = facts.projects?.visible ?? [];
  const humans = facts.human?.assignee_candidates ?? [];
  const masterName = facts.org?.project_master?.name;
  const hasFacts =
    statusItems.length > 0 ||
    typeof reviewers === "number" ||
    typeof askHuman === "number" ||
    typeof needsHuman === "number" ||
    projects.length > 0 ||
    humans.length > 0 ||
    !!masterName;
  if (!hasFacts) return null;
  return (
    <div className="dr-mchat__facts" data-master-facts="true">
      {masterName && <span className="dr-mchat__fact">MASTER {masterName}</span>}
      {typeof reviewers === "number" && <span className="dr-mchat__fact">reviewers {reviewers}</span>}
      {statusItems.map(([status, count]) => (
        <span key={status} className="dr-mchat__fact">
          {status} {count}
        </span>
      ))}
      {typeof askHuman === "number" && <span className="dr-mchat__fact">ask-human {askHuman}</span>}
      {typeof needsHuman === "number" && <span className="dr-mchat__fact">needs-human {needsHuman}</span>}
      {humans.length > 0 && <span className="dr-mchat__fact">human {humans.join(", ")}</span>}
      {projects.length > 0 && <span className="dr-mchat__fact">projects {projects.join(", ")}</span>}
    </div>
  );
}

function MessageBubble({
  msg,
  lang,
  t,
  onRetry,
  onConfirm,
  confirmingId,
  allowConfirm,
}: {
  msg: ChatMessage;
  lang: Lang;
  t: (k: string) => string;
  onRetry: (m: ChatMessage) => void;
  onConfirm: (m: ChatMessage) => void;
  confirmingId: string | null;
  allowConfirm: boolean;
}) {
  const isUser = msg.role === "user";
  const empty = msg.text.length === 0;
  const canConfirm = allowConfirm && !isUser && msg.confirmationId && msg.confirmationState !== "confirmed";
  return (
    <div className={`dr-mchat__row dr-mchat__row--${isUser ? "user" : "master"}`} data-role={msg.role} data-status={msg.status}>
      <div className="dr-mchat__bubble">
        {empty && msg.status === "pending" ? <TypingDots /> : msg.text}
      </div>
      {canConfirm && (
        <div className="dr-mchat__actions">
          <button
            type="button"
            className="dr-mchat__confirm"
            disabled={confirmingId !== null}
            aria-busy={confirmingId === msg.id}
            onClick={() => onConfirm(msg)}
          >
            {t("mchat.confirm")}
          </button>
        </div>
      )}
      {!isUser && <MasterFacts facts={msg.facts} />}
      <div className={`dr-mchat__meta${msg.status === "error" ? " dr-mchat__meta--error" : ""}`}>
        <span>{isUser ? t("mchat.you") : t("mchat.master")}</span>
        {msg.status === "error" ? (
          <>
            <span>· {t("mchat.error")}</span>
            <button type="button" className="dr-mchat__retry" onClick={() => onRetry(msg)}>
              {t("mchat.retry")}
            </button>
          </>
        ) : msg.status === "pending" && isUser ? (
          <span>· {t("mchat.sending")}</span>
        ) : (
          <span>{fmtTime(msg.ts, lang)}</span>
        )}
      </div>
    </div>
  );
}

// ── main widget ─────────────────────────────────────────────────────────────────
export function MasterChat(props: { openSignal?: number } = {}) {
  const { openSignal = 0 } = props;
  const { t, lang } = useI18n();

  const [role, setRole] = useState<"loading" | "operator" | "viewer" | "unavailable">("loading");
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [unread, setUnread] = useState(0);

  const mounted = useRef(true);
  const listEnd = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  // Conversation id threads the session — assigned by the backend on the first
  // reply, sent back on every subsequent message.
  const conversationId = useRef<string | undefined>(undefined);

  useEffect(() => {
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    if (openSignal > 0) setOpen(true);
  }, [openSignal]);

  // Auth gate: show the launcher only after /api/me succeeds. Operators can
  // preview/confirm actions; viewers can still send factual turns and the
  // backend rejects action-like turns.
  useEffect(() => {
    let alive = true;
    api
      .getMe()
      .then((me) => {
        if (alive) setRole(me?.member?.role === "viewer" ? "viewer" : "operator");
      })
      .catch(() => alive && setRole("unavailable"));
    return () => {
      alive = false;
    };
  }, []);

  // Open the floating chat on a global event (e.g. clicking GROVE MASTER in the
  // org chart). Navigation-safe: only opens the panel, never mutates.
  useEffect(() => {
    const onOpen = () => setOpen(true);
    window.addEventListener("grove:master-chat:open", onOpen);
    return () => window.removeEventListener("grove:master-chat:open", onOpen);
  }, []);

  // Upsert by id — append new, replace existing in place (the persisted
  // live-update contract).
  const upsert = useCallback<Upsert>((m) => {
    if (!mounted.current) return;
    setMessages((prev) => {
      const i = prev.findIndex((x) => x.id === m.id);
      if (i === -1) return [...prev, m];
      const next = prev.slice();
      next[i] = m;
      return next;
    });
  }, []);

  // Load history the first time the panel opens.
  const loadedRef = useRef(false);
  useEffect(() => {
    if (!open || loadedRef.current) return;
    loadedRef.current = true;
    api
      .getMasterChatHistory()
      .then((h) => {
        if (!mounted.current) return;
        if (h.messages.length) setMessages((prev) => (prev.length ? prev : h.messages.map(normalize)));
      })
      .catch(() => {
        // History is best-effort: a 404/405 (GET unimplemented — POST-only route)
        // just means "no prior history". Availability is judged on send, below.
      });
  }, [open]);

  // Auto-scroll + clear unread when open / on new messages or the typing cue.
  useEffect(() => {
    if (open) {
      setUnread(0);
      listEnd.current?.scrollIntoView({ block: "end" });
    }
  }, [open, messages, busy]);

  // Bump unread for master replies that land while the panel is closed.
  const lastMaster = useRef<string | null>(null);
  useEffect(() => {
    const last = [...messages].reverse().find((m) => m.role === "master" && m.status === "sent");
    if (last && last.id !== lastMaster.current) {
      lastMaster.current = last.id;
      if (!open) setUnread((n) => n + 1);
    }
  }, [messages, open]);

  const doSend = useCallback(
    (text: string, reuseId?: string) => {
      const trimmed = text.trim();
      if (!trimmed || !mounted.current) return;
      const clientId = reuseId ?? genId("u");
      const ts = Date.now();
      upsert({ id: clientId, role: "user", text: trimmed, ts, status: "pending" });
      setBusy(true);
      api
        .sendMasterChat(trimmed, clientId, conversationId.current)
        .then((res) => {
          if (!mounted.current) return;
          conversationId.current = res.conversation_id || conversationId.current;
          const replyText = masterReplyText(res);
          if (replyText) {
            const confirmationId = masterConfirmationId(res);
            upsert({ id: clientId, role: "user", text: trimmed, ts, status: "sent" });
            upsert({
              id: res.request_id ? `m-${res.request_id}` : genId("m"),
              role: "master",
              text: replyText,
              ts: Date.now(),
              status: "sent",
              facts: masterReplyFacts(res),
              confirmationId,
              confirmationState: confirmationId ? "pending" : undefined,
            });
          } else {
            // The response carried no user-visible LLM text (e.g. a denied/gate
            // response without answer.text). Treat the exchange as a retryable
            // error — NEVER surface internal gate/rule text (operator_gate.reason)
            // in its place.
            upsert({ id: clientId, role: "user", text: trimmed, ts, status: "error" });
          }
        })
        .catch(() => {
          if (!mounted.current) return;
          // Transport failed (503/204/network): mark the exchange retryable. No
          // FE-authored "unavailable" notice — the backend owns any fallback text.
          upsert({ id: clientId, role: "user", text: trimmed, ts, status: "error" });
        })
        .finally(() => mounted.current && setBusy(false));
    },
    [upsert],
  );

  const doConfirm = useCallback(
    (m: ChatMessage) => {
      const confirmationId = m.confirmationId;
      if (!confirmationId || m.confirmationState === "confirmed" || confirmingId !== null) return;
      const requestId = genId("c");
      const idempotencyKey = `web:${m.id}:${confirmationId}`;
      setConfirmingId(m.id);
      api
        .confirmMasterChat(confirmationId, idempotencyKey, conversationId.current, requestId)
        .then((res) => {
          if (!mounted.current) return;
          conversationId.current = res.conversation_id || conversationId.current;
          setMessages((prev) =>
            prev.map((msg) => (msg.id === m.id ? { ...msg, confirmationState: "confirmed" } : msg)),
          );
          const replyText = masterReplyText(res);
          if (replyText) {
            upsert({
              id: res.request_id ? `m-${res.request_id}` : genId("m"),
              role: "master",
              text: replyText,
              ts: Date.now(),
              status: "sent",
              facts: masterReplyFacts(res),
            });
          }
        })
        .catch(() => {
          // No FE-authored failure notice: the assistant backend owns any visible
          // text. Leave the preview confirmable so the operator can retry.
        })
        .finally(() => mounted.current && setConfirmingId(null));
    },
    [confirmingId, upsert],
  );

  const onSubmit = useCallback(() => {
    if (!draft.trim() || busy) return;
    doSend(draft);
    setDraft("");
  }, [draft, busy, doSend]);

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        onSubmit();
      }
    },
    [onSubmit],
  );

  const onRetry = useCallback((m: ChatMessage) => doSend(m.text, m.id), [doSend]);

  // Focus the composer when the panel opens.
  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  const empty = useMemo(() => messages.length === 0, [messages]);

  if (role === "loading" || role === "unavailable") return null;

  return (
    <div className="dr-mchat">
      {open && (
        <section
          className="dr-mchat__panel"
          role="dialog"
          aria-label={t("mchat.title")}
          onKeyDown={(e) => {
            if (e.key === "Escape") setOpen(false);
          }}
        >
          <header className="dr-mchat__head">
            <div className="dr-mchat__avatar" aria-hidden="true">
              M
            </div>
            <div className="dr-mchat__titles">
              <span className="dr-mchat__title">{t("mchat.title")}</span>
              <span className="dr-mchat__sub">{t("mchat.subtitle")}</span>
            </div>
            <button type="button" className="dr-mchat__x" aria-label={t("mchat.close")} onClick={() => setOpen(false)}>
              ✕
            </button>
          </header>

          <div className="dr-mchat__list">
            {empty && <p className="dr-mchat__empty">{t("mchat.empty")}</p>}
            {messages.map((m) => (
              <MessageBubble
                key={m.id}
                msg={m}
                lang={lang}
                t={t}
                onRetry={onRetry}
                onConfirm={doConfirm}
                confirmingId={confirmingId}
                allowConfirm={role === "operator"}
              />
            ))}
            {busy && (
              <div className="dr-mchat__row dr-mchat__row--master">
                <div className="dr-mchat__bubble">
                  <TypingDots />
                </div>
              </div>
            )}
            <div ref={listEnd} />
          </div>

          <div className="dr-mchat__composer">
            <textarea
              ref={inputRef}
              className="dr-mchat__input"
              rows={1}
              value={draft}
              placeholder={t("mchat.placeholder")}
              spellCheck={false}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={onKeyDown}
            />
            <button type="button" className="dr-mchat__send" disabled={!draft.trim() || busy} onClick={onSubmit}>
              {busy ? t("mchat.sending") : t("mchat.send")}
            </button>
          </div>
        </section>
      )}

      <button
        type="button"
        className="dr-mchat__fab"
        aria-label={open ? t("mchat.close") : t("mchat.open")}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <ChatIcon />
        {!open && unread > 0 && <span className="dr-mchat__badge">{unread > 9 ? "9+" : unread}</span>}
      </button>
    </div>
  );
}

export default MasterChat;
