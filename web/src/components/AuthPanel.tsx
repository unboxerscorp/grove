import { useCallback, useEffect, useRef, useState } from "react";

import { api } from "../api";
import { cx } from "../constants";
import { statusLabel, useI18n } from "../i18n";
import type { GroveNode, GuiFeatureKey, GuiFeatureState } from "../types";

const GUI_FEATURES: { key: GuiFeatureKey; labelKey: string; noteKey: string }[] = [
  { key: "node-input", labelKey: "setup.feature.nodeInput", noteKey: "setup.feature.nodeInput.note" },
];

// Features whose ENABLE direction is consequential. Enabling requires a 2-step
// confirm (arm -> confirm/cancel); disabling stays a single immediate POST.
const RISK_FEATURES = new Set<GuiFeatureKey>(["node-input", "intake"]);

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
  const [features, setFeatures] = useState<Record<GuiFeatureKey, GuiFeatureState> | null>(null);
  const [featuresLoading, setFeaturesLoading] = useState(true);
  const [featureError, setFeatureError] = useState<string | null>(null);
  const [featureBusy, setFeatureBusy] = useState<GuiFeatureKey | null>(null);
  const [armed, setArmed] = useState<GuiFeatureKey | null>(null); // P1 risk-enable confirm
  const [isViewer, setIsViewer] = useState(false);
  // Chatbot routes directly to the CHAT MASTER node (no external provider).
  // Read-only: surface that node's presence/status, no provider config.
  const [chatMaster, setChatMaster] = useState<GroveNode | null>(null);

  // Keep the translator in a ref so `load` is stable — a language toggle must
  // NOT re-trigger /api/auth-status (same pattern as TerminalPane's tRef).
  const tRef = useRef(t);
  tRef.current = t;

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

  // The CHAT MASTER node from the live node list (no provider endpoint).
  const loadChatMaster = useCallback(() => {
    api
      .listNodes()
      .then((nodes) => setChatMaster(nodes.find((n) => n.name === "chat-master") ?? null))
      .catch(() => setChatMaster(null));
  }, []);

  useEffect(() => {
    loadFeatures();
    loadChatMaster();
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
  }, [loadFeatures, loadChatMaster]);

  const refresh = () => {
    loadFeatures();
    loadChatMaster();
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

  return (
    <section className="auth">
      <div className="auth__scroll">
        <header className="auth__head">
          <div className="auth__title-wrap">
            <AuthMark />
            <h2 className="auth__title">{t("auth.title")}</h2>
          </div>
          <button
            type="button"
            className="dr-btn dr-btn--ghost auth-refresh"
            onClick={refresh}
            disabled={featuresLoading}
          >
            ↻ {featuresLoading ? t("auth.refreshing") : t("auth.refresh")}
          </button>
        </header>

        <section className="chat-status" aria-label={t("setup.chat.title")}>
          <div className="chat-status__head">
            <div>
              <h3 className="chat-status__title">{t("setup.chat.title")}</h3>
              <p className="chat-status__note">{t("setup.chat.note")}</p>
            </div>
            <span className="auth-badge is-ok">{t("setup.chat.routeBadge")}</span>
          </div>
          <div className="chat-status__row">
            <span className="chat-status__k">{t("setup.chat.node")}</span>
            {chatMaster ? (
              <span className="chat-status__v">
                <span
                  className={cx(
                    "chat-status__dot",
                    chatMaster.status === "active" || chatMaster.status === "running"
                      ? "is-on"
                      : chatMaster.status === "error"
                        ? "is-error"
                        : "is-idle",
                  )}
                />
                <span className="chat-status__name">{chatMaster.name}</span>
                <span className="chat-status__state">{statusLabel(t, chatMaster.status)}</span>
              </span>
            ) : (
              <span className="chat-status__v is-muted">{t("setup.chat.nodeUnknown")}</span>
            )}
          </div>
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

      </div>
    </section>
  );
}
