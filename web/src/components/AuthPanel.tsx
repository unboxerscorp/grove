import { useCallback, useEffect, useState } from "react";

import { api } from "../api";
import type { AuthTool } from "../api";
import { cx } from "../constants";
import { useI18n } from "../i18n";

function AuthMark() {
  return (
    <svg className="auth__mark" viewBox="0 0 24 24" width={20} height={20} aria-hidden="true">
      <path
        d="M12 3l7 3v5c0 4.5-3 7.8-7 9-4-1.2-7-4.5-7-9V6l7-3z"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.5}
        strokeLinejoin="round"
      />
      <path d="M9 12l2 2 4-4" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function AuthPanel() {
  const { t } = useI18n();
  const [tools, setTools] = useState<AuthTool[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [revealed, setRevealed] = useState<Set<string>>(new Set());
  const [copied, setCopied] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    api
      .getAuthStatus()
      .then((list) => {
        setTools(Array.isArray(list) ? list : []);
        setError(null);
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : t("auth.loadError")))
      .finally(() => setLoading(false));
  }, [t]);

  useEffect(() => {
    load();
  }, [load]);

  const toggle = (tool: string) =>
    setRevealed((prev) => {
      const next = new Set(prev);
      if (next.has(tool)) next.delete(tool);
      else next.add(tool);
      return next;
    });

  const copy = (tool: string, hint: string) => {
    void navigator.clipboard?.writeText(hint).catch(() => {});
    setCopied(tool);
  };

  return (
    <section className="auth">
      <div className="auth__scroll">
        <header className="auth__head">
          <div className="auth__title-wrap">
            <AuthMark />
            <h2 className="auth__title">{t("auth.title")}</h2>
          </div>
          <button type="button" className="dr-btn dr-btn--ghost auth-refresh" onClick={load} disabled={loading}>
            ↻ {loading ? t("auth.refreshing") : t("auth.refresh")}
          </button>
        </header>

        {error && <div className="auth__msg is-error">{error}</div>}

        <div className="auth-list">
          {tools.map((tool, i) => {
            const hint = tool.login_hint ?? "";
            const isUrl = hint.startsWith("http");
            return (
              <div
                key={tool.tool}
                data-tool={tool.tool}
                className="auth-row"
                style={{ animationDelay: `${Math.min(i, 8) * 30}ms` }}
              >
                <span className={cx("auth-led", tool.authed ? "is-ok" : "is-warn")} />
                <div className="auth-row__body">
                  <div className="auth-row__top">
                    <span className="auth-row__label">{tool.label}</span>
                    <span className="auth-row__tool">{tool.tool}</span>
                  </div>
                  {tool.detail && <div className="auth-row__detail">{tool.detail}</div>}
                  {revealed.has(tool.tool) && hint && !isUrl && (
                    <div className="auth-hint">
                      <span className="auth-hint__label">{t("auth.hintLabel")}</span>
                      <code className="auth-hint__cmd">{hint}</code>
                      <button type="button" className="auth-hint__copy" onClick={() => copy(tool.tool, hint)}>
                        {copied === tool.tool ? t("auth.copied") : t("auth.copy")}
                      </button>
                    </div>
                  )}
                </div>
                <div className="auth-row__action">
                  {tool.authed ? (
                    <span className="auth-badge is-ok">✓ {t("auth.authed")}</span>
                  ) : isUrl ? (
                    <a
                      className="dr-btn dr-btn--primary auth-login"
                      href={hint}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {t("auth.loginUrl")}
                    </a>
                  ) : (
                    <button
                      type="button"
                      className="dr-btn dr-btn--primary auth-login"
                      onClick={() => toggle(tool.tool)}
                      disabled={!hint}
                    >
                      {t("auth.login")}
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
