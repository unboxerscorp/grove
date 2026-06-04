import { useState } from "react";

import { api } from "../api";
import type { HandoffAcceptResult, HandoffPackage } from "../api";
import { cx } from "../constants";
import { useI18n } from "../i18n";

/** A pasted blob is a usable handoff package only with the 4 signed fields. */
function asHandoff(value: unknown): HandoffPackage | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (typeof v.algorithm !== "string" || typeof v.key_id !== "string") return null;
  if (typeof v.signature !== "string" || typeof v.payload !== "object" || v.payload === null) return null;
  return v as unknown as HandoffPackage;
}

function HandoffMark() {
  return (
    <svg className="handoff__mark" viewBox="0 0 24 24" width={20} height={20} aria-hidden="true">
      <path d="M3 12h13M12 7l5 5-5 5M16 5h5v14h-5" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/**
 * Receive a handoff (RECEIVER-LOCAL accept = human decision). Paste a signed
 * package → local preview (title/body/labels + freshness) → an EXPLICIT accept
 * (confirm) verifies it server-side and creates a local task. Nothing is created
 * or run before the confirm. Tampered / unknown-key / expired packages are
 * rejected with a fixed message (no raw/secret leak); accept is idempotent.
 */
export function HandoffPanel({ onAccepted }: { projectTick: number; onAccepted: () => void }) {
  const { t } = useI18n();
  const [text, setText] = useState("");
  const [preview, setPreview] = useState<HandoffPackage | null>(null);
  const [parseErr, setParseErr] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<HandoffAcceptResult | null>(null);
  const [reject, setReject] = useState<"rejected" | "expired" | "disabled" | "error" | null>(null);

  const doPreview = () => {
    setResult(null);
    setReject(null);
    setConfirming(false);
    let parsed: unknown;
    try {
      parsed = JSON.parse(text.trim());
    } catch {
      setParseErr(t("handoff.pasteInvalid"));
      setPreview(null);
      return;
    }
    const env = asHandoff(parsed);
    if (!env) {
      setParseErr(t("handoff.pasteInvalid"));
      setPreview(null);
      return;
    }
    setParseErr(null);
    setPreview(env);
  };

  const doAccept = () => {
    if (!preview || busy) return;
    setBusy(true);
    setReject(null);
    api
      .acceptHandoff(preview)
      .then((r) => {
        setBusy(false);
        setConfirming(false);
        setResult(r);
        onAccepted(); // refresh board/audit (a local task may have been created)
      })
      .catch((e: unknown) => {
        setBusy(false);
        setConfirming(false);
        const m = e instanceof Error ? e.message : "";
        // Fixed reason codes only — never surface the raw cause / signature.
        if (/\b410\b/.test(m)) setReject("expired");
        else if (/\b404\b/.test(m)) setReject("disabled");
        else if (/\b403\b/.test(m)) setReject("rejected"); // tampered / unknown key
        else setReject("error");
      });
  };

  const p = preview?.payload;
  const task = p?.task;
  // Local freshness hint (server is authoritative on accept).
  const expired = typeof p?.expires_at === "number" && p.expires_at * 1000 < Date.now();
  const labels = Array.isArray(task?.labels) ? task!.labels! : [];

  return (
    <section className="handoff">
      <div className="handoff__scroll">
        <header className="handoff__head">
          <div className="handoff__title-wrap">
            <HandoffMark />
            <h2 className="handoff__title">{t("handoff.acceptTitle")}</h2>
          </div>
        </header>
        <p className="handoff__note">{t("handoff.acceptNote")}</p>

        <div className="handoff-paste">
          <textarea
            className="dr-input handoff-paste__input"
            name="handoffPaste"
            rows={3}
            placeholder={t("handoff.pastePlaceholder")}
            value={text}
            spellCheck={false}
            onChange={(e) => setText(e.target.value)}
          />
          <button type="button" className="dr-btn dr-btn--ghost handoff-preview__btn" disabled={!text.trim()} onClick={doPreview}>
            {t("handoff.previewBtn")}
          </button>
          {parseErr && <div className="handoff-msg is-error">{parseErr}</div>}
        </div>

        {preview && p && (
          <div className="handoff-preview" data-handoff="preview">
            <div className="handoff-preview__badges">
              {/* trust is verified server-side on accept; freshness is a local hint */}
              <span className={cx("handoff-fresh", expired ? "is-expired" : "is-fresh")}>
                {expired ? t("handoff.expiredBadge") : t("handoff.freshBadge")}
              </span>
              <span className="handoff-preview__key">{t("handoff.key")}: {preview.key_id}</span>
              {p.source_project && <span className="handoff-preview__src">{p.source_project}</span>}
            </div>
            <div className="handoff-preview__title">{task?.title}</div>
            {task?.body && <div className="handoff-preview__body">{task.body}</div>}
            {labels.length > 0 && (
              <div className="handoff-preview__labels">
                {labels.map((l) => (
                  <span key={l} className="handoff-label">{l}</span>
                ))}
              </div>
            )}

            {result ? (
              <div className={cx("handoff-result", "is-trusted")} data-status={result.status}>
                ✓ {result.created ? t("handoff.created") : t("handoff.existing")}
                {result.task?.id && <span className="handoff-result__task"> · {result.task.id}</span>}
              </div>
            ) : reject ? (
              <div className="handoff-result is-rejected" data-reject={reject}>
                ✗ {t(`handoff.reject.${reject}`)}
              </div>
            ) : confirming ? (
              <div className="handoff-confirm">
                <span className="handoff-confirm__q">{t("handoff.acceptConfirm")}</span>
                <button type="button" className="dr-btn dr-btn--primary handoff-accept__yes" disabled={busy} onClick={doAccept}>
                  {t("handoff.acceptYes")}
                </button>
                <button type="button" className="dr-btn dr-btn--ghost handoff-accept__no" onClick={() => setConfirming(false)}>
                  {t("handoff.acceptNo")}
                </button>
              </div>
            ) : (
              <button
                type="button"
                className="dr-btn dr-btn--primary handoff-accept__btn"
                onClick={() => {
                  setReject(null);
                  setConfirming(true);
                }}
              >
                {t("handoff.accept")}
              </button>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
