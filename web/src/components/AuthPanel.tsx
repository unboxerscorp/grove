import { useCallback, useEffect, useRef, useState } from "react";

import { api } from "../api";
import type { AuthTool, ChatProviderStatus } from "../api";
import { cx } from "../constants";
import { useI18n } from "../i18n";
import type { GuiFeatureKey, GuiFeatureState } from "../types";

const GUI_FEATURES: { key: GuiFeatureKey; labelKey: string; noteKey: string }[] = [
  { key: "node-input", labelKey: "setup.feature.nodeInput", noteKey: "setup.feature.nodeInput.note" },
  {
    key: "chat_bridge_runtime",
    labelKey: "setup.feature.chatRuntime",
    noteKey: "setup.feature.chatRuntime.note",
  },
];

// Features whose ENABLE direction is consequential. Enabling requires a 2-step
// confirm (arm -> confirm/cancel); disabling stays a single immediate POST.
const RISK_FEATURES = new Set<GuiFeatureKey>(["node-input", "intake", "chat_bridge_runtime"]);

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
  const [features, setFeatures] = useState<Record<GuiFeatureKey, GuiFeatureState> | null>(null);
  const [featuresLoading, setFeaturesLoading] = useState(true);
  const [featureError, setFeatureError] = useState<string | null>(null);
  const [featureBusy, setFeatureBusy] = useState<GuiFeatureKey | null>(null);
  const [armed, setArmed] = useState<GuiFeatureKey | null>(null); // P1 risk-enable confirm
  const [isViewer, setIsViewer] = useState(false);
  const [chatProvider, setChatProvider] = useState<ChatProviderStatus | null>(null);
  const [chatKey, setChatKey] = useState("");
  const [chatModel, setChatModel] = useState("gemini-2.5-flash");
  const [chatProviderBusy, setChatProviderBusy] = useState(false);
  const [chatProviderError, setChatProviderError] = useState<string | null>(null);

  // Keep the translator in a ref so `load` is stable — a language toggle must
  // NOT re-trigger /api/auth-status (same pattern as TerminalPane's tRef).
  const tRef = useRef(t);
  tRef.current = t;

  const load = useCallback(() => {
    setLoading(true);
    api
      .getAuthStatus()
      .then((list) => {
        setTools(Array.isArray(list) ? list : []);
        setError(null);
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : tRef.current("auth.loadError")))
      .finally(() => setLoading(false));
  }, []);

  const loadFeatures = useCallback(() => {
    setFeaturesLoading(true);
    api
      .getGuiFeatures()
      .then((payload) => {
        setFeatures(payload.features);
        setFeatureError(null);
      })
      .catch(() => setFeatureError(tRef.current("setup.features.loadError")))
      .finally(() => setFeaturesLoading(false));
  }, []);

  const loadChatProvider = useCallback(() => {
    api
      .getChatProvider()
      .then((payload) => {
        setChatProvider(payload);
        setChatModel(payload.model || "gemini-2.5-flash");
        setChatProviderError(null);
      })
      .catch(() => setChatProviderError(tRef.current("setup.chatProvider.loadError")));
  }, []);

  useEffect(() => {
    load();
    loadFeatures();
    loadChatProvider();
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
  }, [load, loadFeatures, loadChatProvider]);

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
    // Reset the "copied" affordance so it doesn't stick permanently.
    window.setTimeout(() => setCopied((c) => (c === tool ? null : c)), 1500);
  };

  // The actual mutation — a single operator-gated, CSRF-protected POST.
  const commitFeature = (key: GuiFeatureKey, next: boolean) => {
    setFeatureBusy(key);
    setFeatureError(null);
    api
      .setGuiFeature(key, next)
      .then((payload) => setFeatures(payload.features))
      .catch(() => setFeatureError(tRef.current("setup.features.saveError")))
      .finally(() => setFeatureBusy(null));
  };

  // P1: enabling a risk feature ARMS a confirm step (no POST yet); everything else
  // (disabling, or any non-risk toggle) commits immediately.
  const requestFeature = (key: GuiFeatureKey) => {
    const current = features?.[key];
    if (!current || featureBusy) return;
    const next = !current.enabled;
    if (next && RISK_FEATURES.has(key)) {
      setFeatureError(null);
      setArmed(key); // arm — wait for explicit confirm before POSTing
      return;
    }
    setArmed(null);
    commitFeature(key, next);
  };

  const confirmFeature = (key: GuiFeatureKey) => {
    setArmed(null);
    commitFeature(key, true); // the single POST happens here, on explicit confirm
  };

  const cancelFeature = () => setArmed(null); // no POST

  const saveChatProvider = () => {
    const apiKey = chatKey.trim();
    if (!apiKey) {
      setChatProviderError(tRef.current("setup.chatProvider.keyRequired"));
      return;
    }
    setChatProviderBusy(true);
    setChatProviderError(null);
    api
      .setChatProvider({ api_key: apiKey, model: chatModel.trim() || "gemini-2.5-flash" })
      .then((payload) => {
        setChatProvider(payload);
        setChatKey("");
        setChatModel(payload.model || "gemini-2.5-flash");
      })
      .catch(() => setChatProviderError(tRef.current("setup.chatProvider.saveError")))
      .finally(() => setChatProviderBusy(false));
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

        <section className="chat-provider" aria-label={t("setup.chatProvider.title")}>
          <div className="chat-provider__head">
            <div>
              <h3 className="chat-provider__title">{t("setup.chatProvider.title")}</h3>
              <p className="chat-provider__note">{t("setup.chatProvider.note")}</p>
            </div>
            <span className={cx("auth-badge", chatProvider?.configured ? "is-ok" : "is-warn")}>
              {chatProvider?.configured
                ? t("setup.chatProvider.configured", { hint: chatProvider.key_hint ?? "" })
                : t("setup.chatProvider.notConfigured")}
            </span>
          </div>
          {chatProviderError && <div className="auth__msg is-error">{chatProviderError}</div>}
          <form
            className="chat-provider__form"
            onSubmit={(e) => {
              e.preventDefault();
              saveChatProvider();
            }}
          >
            <label className="chat-provider__field">
              <span>{t("setup.chatProvider.model")}</span>
              <input
                className="dr-input"
                value={chatModel}
                onChange={(e) => setChatModel(e.target.value)}
                disabled={isViewer || chatProviderBusy}
              />
            </label>
            <label className="chat-provider__field is-key">
              <span>{t("setup.chatProvider.key")}</span>
              <input
                className="dr-input"
                type="password"
                value={chatKey}
                onChange={(e) => setChatKey(e.target.value)}
                disabled={isViewer || chatProviderBusy}
                autoComplete="off"
              />
            </label>
            <button
              type="submit"
              className="dr-btn dr-btn--primary"
              disabled={isViewer || chatProviderBusy}
            >
              {chatProviderBusy ? t("setup.chatProvider.saving") : t("setup.chatProvider.save")}
            </button>
          </form>
        </section>

        <section className="setup-features" aria-label={t("setup.features.title")}>
          <div className="setup-features__head">
            <div>
              <h3 className="setup-features__title">{t("setup.features.title")}</h3>
              <p className="setup-features__note">{t("setup.features.note")}</p>
            </div>
            {isViewer && <span className="setup-features__readonly">{t("setup.features.readonly")}</span>}
          </div>
          {featureError && <div className="auth__msg is-error">{featureError}</div>}
          <div className="setup-feature-grid">
            {GUI_FEATURES.map((item, i) => {
              const state = features?.[item.key];
              const enabled = state?.enabled === true;
              const busy = featureBusy === item.key;
              return (
                <div
                  key={item.key}
                  className={cx("setup-feature", enabled && "is-on")}
                  data-feature={item.key}
                  style={{ animationDelay: `${Math.min(i, 8) * 26}ms` }}
                >
                  <div className="setup-feature__copy">
                    <span className="setup-feature__label">{t(item.labelKey)}</span>
                    <span className="setup-feature__note">{t(item.noteKey)}</span>
                  </div>
                  {armed === item.key ? (
                    // P1 risk-enable confirm: arming POSTs nothing; confirm = one
                    // POST, cancel = none. Operator-only (only operators can arm).
                    <div className="setup-confirm" data-confirm={item.key}>
                      <span className="setup-confirm__q">{t("setup.features.confirmEnable")}</span>
                      <button
                        type="button"
                        className="dr-btn dr-btn--primary setup-confirm__yes"
                        onClick={() => confirmFeature(item.key)}
                      >
                        {t("setup.features.confirm")}
                      </button>
                      <button
                        type="button"
                        className="dr-btn dr-btn--ghost setup-confirm__no"
                        onClick={cancelFeature}
                      >
                        {t("setup.features.cancel")}
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      className={cx("setup-switch", enabled && "is-on")}
                      role="switch"
                      aria-checked={enabled}
                      data-enabled={enabled ? "1" : "0"}
                      data-risk={RISK_FEATURES.has(item.key) ? "1" : undefined}
                      disabled={featuresLoading || busy || isViewer || !state}
                      onClick={() => requestFeature(item.key)}
                    >
                      <span className="setup-switch__track">
                        <span className="setup-switch__knob" />
                      </span>
                      <span className="setup-switch__text">
                        {busy ? t("setup.features.saving") : enabled ? t("setup.features.on") : t("setup.features.off")}
                      </span>
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        </section>

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
