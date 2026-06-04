import { useCallback, useEffect, useState } from "react";

import { api } from "../api";
import type { JoinResult, Presence, ShareResult } from "../api";
import { cx } from "../constants";
import { useI18n } from "../i18n";

function ConnectMark() {
  return (
    <svg className="connect__mark" viewBox="0 0 24 24" width={20} height={20} aria-hidden="true">
      <circle cx={7} cy={12} r={3} fill="none" stroke="currentColor" strokeWidth={1.5} />
      <circle cx={17} cy={6} r={2.5} fill="none" stroke="currentColor" strokeWidth={1.5} />
      <circle cx={17} cy={18} r={2.5} fill="none" stroke="currentColor" strokeWidth={1.5} />
      <path d="M9.6 10.7l5-3.4M9.6 13.3l5 3.4" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" />
    </svg>
  );
}

function roleClass(role?: string): string {
  switch ((role ?? "").toLowerCase()) {
    case "admin":
      return "is-admin";
    case "operator":
      return "is-operator";
    case "viewer":
      return "is-viewer";
    default:
      return "is-member";
  }
}

/** Map a join HTTP status to a FIXED reason code — never surface the raw cause. */
function joinReason(message: string): "invalid" | "expired" | "rateLimit" | "nameExists" | "invalidName" | "disabled" | "generic" {
  if (/\b410\b/.test(message)) return "expired";
  if (/\b429\b/.test(message)) return "rateLimit";
  if (/\b409\b/.test(message)) return "nameExists";
  if (/\b400\b/.test(message)) return "invalidName";
  if (/\b404\b/.test(message)) return "disabled";
  if (/\b403\b/.test(message)) return "invalid"; // wrong / consumed code
  return "generic";
}

/**
 * Easy connection hub (v1.18). Two halves, both kept deliberately simple:
 *  - OPERATOR share: one button mints a ONE-TIME join code + share URL (copyable)
 *    with an expiry/one-time notice and a reissue. Hidden for viewers; a 404 means
 *    --shared-access is off. The code is shown but handled as a secret.
 *  - PEER join: paste/enter a code + display name -> "Join". A share URL deep-link
 *    (?join=<code>) pre-fills the code. Failures show a fixed message (no raw leak).
 * A presence strip surfaces who is currently connected (name/role only, no PII).
 */
export function ConnectPanel({
  projectTick,
  initialJoinCode,
  onJoined,
}: {
  projectTick: number;
  initialJoinCode: string | null;
  onJoined: () => void;
}) {
  const { t } = useI18n();
  const [isViewer, setIsViewer] = useState(false);

  // share (operator)
  const [share, setShare] = useState<ShareResult | null>(null);
  const [shareState, setShareState] = useState<"idle" | "loading" | "disabled" | "forbidden" | "error">("idle");
  const [copied, setCopied] = useState<string | null>(null);

  // join (peer)
  const [code, setCode] = useState(initialJoinCode ?? "");
  const [name, setName] = useState("");
  const [joining, setJoining] = useState(false);
  const [joined, setJoined] = useState<JoinResult | null>(null);
  const [joinErr, setJoinErr] = useState<ReturnType<typeof joinReason> | null>(null);

  // presence (who's connected)
  const [presence, setPresence] = useState<Presence | null>(null);

  useEffect(() => {
    let alive = true;
    // member null in local-token mode = operator; only a team "viewer" locks out.
    api
      .getMe()
      .then((me) => alive && setIsViewer(me?.member?.role === "viewer"))
      .catch(() => alive && setIsViewer(false));
    return () => {
      alive = false;
    };
  }, [projectTick]);

  useEffect(() => {
    let alive = true;
    const load = () =>
      api
        .getPresence()
        .then((p) => alive && setPresence(p))
        .catch(() => {
          /* keep last */
        });
    void load();
    const id = setInterval(() => void load(), 4000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [projectTick, joined]);

  const invite = useCallback(() => {
    setShareState("loading");
    api
      .createShare()
      .then((r) => {
        setShare(r);
        setShareState("idle");
      })
      .catch((e: unknown) => {
        const m = e instanceof Error ? e.message : "";
        setShareState(/\b404\b/.test(m) ? "disabled" : /\b403\b/.test(m) ? "forbidden" : "error");
      });
  }, []);

  const copy = (key: string, value: string) => {
    void navigator.clipboard?.writeText(value).catch(() => {});
    setCopied(key);
    window.setTimeout(() => setCopied((c) => (c === key ? null : c)), 1500);
  };

  const doJoin = (e: React.FormEvent) => {
    e.preventDefault();
    const c = code.trim();
    const n = name.trim();
    if (!c || !n || joining) return;
    setJoining(true);
    setJoinErr(null);
    api
      .join(c, n)
      .then((r) => {
        setJoining(false);
        setJoined(r);
        onJoined(); // refresh role/presence/board — a member session now exists
      })
      .catch((err: unknown) => {
        setJoining(false);
        setJoinErr(joinReason(err instanceof Error ? err.message : ""));
      });
  };

  const members = (presence?.viewers ?? []).filter((v) => typeof v.name === "string" && v.name);

  return (
    <section className="connect">
      <div className="connect__scroll">
        <header className="connect__head">
          <div className="connect__title-wrap">
            <ConnectMark />
            <h2 className="connect__title">{t("connect.title")}</h2>
          </div>
          <p className="connect__note">{t("connect.note")}</p>
        </header>

        <div className="connect__grid">
          {/* ── OPERATOR: invite a teammate ─────────────────────────────── */}
          <div className="connect-card connect-share" data-card="share">
            <h3 className="connect-card__h">{t("connect.shareTitle")}</h3>
            {isViewer ? (
              <div className="connect-msg is-warn connect-share__viewer">{t("connect.viewerShareNote")}</div>
            ) : (
              <>
                <p className="connect-card__sub">{t("connect.shareSub")}</p>
                {!share && (
                  <button
                    type="button"
                    className="dr-btn dr-btn--primary connect-invite__btn"
                    disabled={shareState === "loading"}
                    onClick={invite}
                  >
                    {shareState === "loading" ? t("connect.inviting") : t("connect.invite")}
                  </button>
                )}
                {shareState === "disabled" && <div className="connect-msg is-warn">{t("connect.shareDisabled")}</div>}
                {shareState === "forbidden" && <div className="connect-msg is-warn">{t("connect.shareForbidden")}</div>}
                {shareState === "error" && <div className="connect-msg is-error">{t("connect.shareError")}</div>}
                {share && (
                  <div className="connect-invite" data-share="issued">
                    <label className="connect-field">
                      <span className="connect-field__k">{t("connect.url")}</span>
                      <span className="connect-field__row">
                        <input className="dr-input connect-field__val" name="shareUrl" readOnly value={share.url} spellCheck={false} />
                        <button type="button" className="dr-btn dr-btn--ghost connect-copy connect-copy--url" onClick={() => copy("url", share.url)}>
                          {copied === "url" ? t("connect.copied") : t("connect.copy")}
                        </button>
                      </span>
                    </label>
                    <label className="connect-field">
                      <span className="connect-field__k">{t("connect.code")}</span>
                      <span className="connect-field__row">
                        <input className="dr-input connect-field__val connect-field__code" name="shareCode" readOnly value={share.code} spellCheck={false} />
                        <button type="button" className="dr-btn dr-btn--ghost connect-copy connect-copy--code" onClick={() => copy("code", share.code)}>
                          {copied === "code" ? t("connect.copied") : t("connect.copy")}
                        </button>
                      </span>
                    </label>
                    <p className="connect-invite__note">🔒 {t("connect.oneTimeNote")}</p>
                    <button type="button" className="dr-btn dr-btn--ghost connect-reissue" onClick={invite} disabled={shareState === "loading"}>
                      ↻ {t("connect.reissue")}
                    </button>
                  </div>
                )}
              </>
            )}
          </div>

          {/* ── PEER: join with a code ──────────────────────────────────── */}
          <div className="connect-card connect-join" data-card="join">
            <h3 className="connect-card__h">{t("connect.joinTitle")}</h3>
            {joined ? (
              <div className="connect-joined" data-join="ok">
                <div className="connect-joined__badge">✓ {t("connect.joined")}</div>
                <div className="connect-joined__member">
                  <span className={cx("connect-chip", roleClass(joined.member?.role))}>
                    <span className="connect-chip__dot" aria-hidden="true" />
                    {joined.member?.name}
                  </span>
                  <span className="connect-joined__role">{joined.member?.role}</span>
                </div>
                <p className="connect-joined__hint">{t("connect.joinedHint")}</p>
              </div>
            ) : (
              <>
                <p className="connect-card__sub">{t("connect.joinSub")}</p>
                <form className="connect-join__form" onSubmit={doJoin}>
                  <label className="connect-field">
                    <span className="connect-field__k">{t("connect.codeLabel")}</span>
                    <input
                      className="dr-input connect-join__code"
                      name="joinCode"
                      type="text"
                      placeholder={t("connect.codePh")}
                      value={code}
                      autoComplete="off"
                      spellCheck={false}
                      onChange={(e) => setCode(e.target.value)}
                    />
                  </label>
                  <label className="connect-field">
                    <span className="connect-field__k">{t("connect.nameLabel")}</span>
                    <input
                      className="dr-input connect-join__name"
                      name="joinName"
                      type="text"
                      placeholder={t("connect.namePh")}
                      value={name}
                      autoComplete="off"
                      spellCheck={false}
                      onChange={(e) => setName(e.target.value)}
                    />
                  </label>
                  {joinErr && (
                    <div className={cx("connect-msg", joinErr === "generic" ? "is-error" : "is-warn")} data-join-err={joinErr}>
                      {t(`connect.err.${joinErr}`)}
                    </div>
                  )}
                  <button type="submit" className="dr-btn dr-btn--primary connect-join__btn" disabled={!code.trim() || !name.trim() || joining}>
                    {joining ? t("connect.joining") : t("connect.join")}
                  </button>
                </form>
              </>
            )}
          </div>
        </div>

        {/* ── who is currently connected ────────────────────────────────── */}
        <div className="connect-card connect-presence" data-card="presence">
          <h3 className="connect-card__h">{t("connect.presenceTitle")}</h3>
          {members.length > 0 ? (
            <div className="connect-presence__list">
              {members.map((m) => (
                <span key={m.name} data-member={m.name} className={cx("connect-chip", roleClass(m.role))} title={`${m.name} · ${m.role ?? ""}`}>
                  <span className="connect-chip__dot" aria-hidden="true" />
                  {m.name}
                  <span className="connect-chip__role">{m.role}</span>
                </span>
              ))}
            </div>
          ) : (
            <div className="connect-presence__empty">{t("connect.presenceEmpty")}</div>
          )}
        </div>
      </div>
    </section>
  );
}
