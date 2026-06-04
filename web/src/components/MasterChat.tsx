// MasterChat — floating web chat widget (Channel-Talk style, bottom-right).
//
// v1.27. Operator-only conversational launcher to the project-master orchestrator.
// Mounted once at the app root (see app.tsx). Strings live in i18n.tsx (mchat.*)
// and styles in styles.css (.dr-mchat); the REST calls live in api.ts.
//
// operator-only: viewers (team read-only members) never see the launcher — the
// component renders null for them, mirroring grove's operator-gated controls.
//
// Backend (POST /api/master/chat) is still being built in grove-master / grove-py.
// api.ts throws `… HTTP 404/501/503` while it's unavailable; we map those to a
// graceful "not yet available" notice and surface any other failure as a
// retryable error bubble. Messages follow the persisted live-update contract
// (per ~/dev/notion-slack-sync-server): each is keyed by `id` and upserted in
// place, with a pending -> sent lifecycle. A reply may arrive as a `pending`
// placeholder and resolve later — a future GET poll / SSE would drive those
// follow-up upserts; the upsert-by-id reducer below already supports them.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useI18n } from "../i18n";
import type { Lang } from "../i18n";
import { api, masterReplyText } from "../api";
import type { MasterChatMessage } from "../api";

// ── types ─────────────────────────────────────────────────────────────────────
type ChatRole = "user" | "master";
type ChatStatus = "pending" | "sent" | "error";

interface ChatMessage {
  id: string;
  role: ChatRole;
  text: string;
  ts: number; // epoch ms
  status: ChatStatus;
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

// HTTP statuses that mean master chat (or its history GET) isn't available →
// render a graceful notice instead of a scary error. 405 = GET history is a
// POST-only route. Parsed from api.ts's `… HTTP <code>`.
const UNAVAILABLE = new Set([404, 405, 501, 503]);
function statusOf(e: unknown): number | null {
  const m = e instanceof Error ? e.message : "";
  const hit = m.match(/HTTP (\d{3})/);
  return hit ? Number(hit[1]) : null;
}
function isUnavailable(e: unknown): boolean {
  const s = statusOf(e);
  return s !== null && UNAVAILABLE.has(s);
}

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

function MessageBubble({
  msg,
  lang,
  t,
  onRetry,
}: {
  msg: ChatMessage;
  lang: Lang;
  t: (k: string) => string;
  onRetry: (m: ChatMessage) => void;
}) {
  const isUser = msg.role === "user";
  const empty = msg.text.length === 0;
  return (
    <div className={`dr-mchat__row dr-mchat__row--${isUser ? "user" : "master"}`} data-role={msg.role} data-status={msg.status}>
      <div className="dr-mchat__bubble">
        {empty && msg.status === "pending" ? <TypingDots /> : msg.text}
      </div>
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
export function MasterChat() {
  const { t, lang } = useI18n();

  const [role, setRole] = useState<"loading" | "operator" | "viewer">("loading");
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [unread, setUnread] = useState(0);
  const [unavailable, setUnavailable] = useState(false);

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

  // operator-only gate — fails CLOSED: the launcher shows only on a successful
  // /api/me with a non-viewer member (local-token member null = operator). A
  // viewer member OR any /api/me failure resolves to a non-operator role and
  // hides the widget — never expose the operator launcher when the role is
  // unknown (an operator can reload to recover).
  useEffect(() => {
    let alive = true;
    api
      .getMe()
      .then((me) => {
        if (alive) setRole(me?.member?.role === "viewer" ? "viewer" : "operator");
      })
      .catch(() => alive && setRole("viewer"));
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
        setUnavailable(false);
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
          setUnavailable(false);
          conversationId.current = res.conversation_id || conversationId.current;
          upsert({ id: clientId, role: "user", text: trimmed, ts, status: "sent" });
          const replyText = masterReplyText(res);
          if (replyText) {
            upsert({
              id: res.request_id ? `m-${res.request_id}` : genId("m"),
              role: "master",
              text: replyText,
              ts: Date.now(),
              status: "sent",
            });
          }
        })
        .catch((e) => {
          if (!mounted.current) return;
          upsert({ id: clientId, role: "user", text: trimmed, ts, status: "error" });
          if (isUnavailable(e)) setUnavailable(true);
        })
        .finally(() => mounted.current && setBusy(false));
    },
    [upsert],
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

  // operator-only: render nothing for viewers (and while the role is resolving).
  if (role !== "operator") return null;

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
            {unavailable && <p className="dr-mchat__notice">{t("mchat.unavailable")}</p>}
            {empty && !unavailable && <p className="dr-mchat__empty">{t("mchat.empty")}</p>}
            {messages.map((m) => (
              <MessageBubble key={m.id} msg={m} lang={lang} t={t} onRetry={onRetry} />
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
