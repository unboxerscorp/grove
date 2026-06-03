import { useEffect, useState } from "react";

import { api } from "../api";
import type { SlackStatus } from "../api";
import { cx } from "../constants";
import { useI18n } from "../i18n";
import type { GroveNode } from "../types";

const STATUS_ORDER = ["not_configured", "tokens_saved", "bot_auth_ok", "socket_connected"];

function statusClass(status: string, hasError: boolean): string {
  if (hasError) return "is-error";
  switch (status) {
    case "socket_connected":
      return "is-live";
    case "bot_auth_ok":
      return "is-auth";
    case "tokens_saved":
      return "is-pending";
    default:
      return "is-idle";
  }
}

function last4(token: string): string {
  return token.length >= 4 ? token.slice(-4) : token;
}

export function SlackPanel() {
  const { t } = useI18n();
  const [status, setStatus] = useState<SlackStatus | null>(null);
  const [nodes, setNodes] = useState<GroveNode[]>([]);

  const [appToken, setAppToken] = useState("");
  const [botToken, setBotToken] = useState("");
  const [appSaved, setAppSaved] = useState(false);
  const [botSaved, setBotSaved] = useState(false);
  const [app4, setApp4] = useState("");
  const [bot4, setBot4] = useState("");

  const [channel, setChannel] = useState("");
  const [node, setNode] = useState("");

  const [appErr, setAppErr] = useState<string | null>(null);
  const [botErr, setBotErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveErr, setSaveErr] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [manifestBusy, setManifestBusy] = useState(false);
  const [manifestErr, setManifestErr] = useState<string | null>(null);

  const refreshStatus = () =>
    api
      .getSlackStatus()
      .then((s) => {
        setStatus(s);
        if (s.status !== "not_configured") {
          setAppSaved(true);
          setBotSaved(true);
        }
      })
      .catch(() => setStatus({ status: "not_configured" }));

  useEffect(() => {
    void refreshStatus();
    void api
      .listNodes()
      .then((n) => setNodes(Array.isArray(n) ? n : []))
      .catch(() => setNodes([]));
  }, []);

  const downloadManifest = () => {
    setManifestBusy(true);
    setManifestErr(null);
    void (async () => {
      try {
        const res = await api.slackManifest();
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = "grove-slack-manifest.json";
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
      } catch {
        setManifestErr(t("slack.manifest.error"));
      } finally {
        setManifestBusy(false);
      }
    })();
  };

  const save = (e: React.FormEvent) => {
    e.preventDefault();
    setAppErr(null);
    setBotErr(null);
    setSaveErr(null);

    if (appToken && !appToken.startsWith("xapp-")) return setAppErr(t("slack.tokens.appErr"));
    if (botToken && !botToken.startsWith("xoxb-")) return setBotErr(t("slack.tokens.botErr"));
    if (!appSaved && !appToken) return setAppErr(t("slack.tokens.required"));
    if (!botSaved && !botToken) return setBotErr(t("slack.tokens.required"));

    const cfg: Record<string, string> = {};
    if (appToken) cfg.app_token = appToken;
    if (botToken) cfg.bot_token = botToken;
    if (channel.trim()) cfg.default_channel = channel.trim();
    if (node) cfg.default_node = node;

    setSaving(true);
    api
      .saveSlackConfig(cfg)
      .then((s) => {
        setStatus(s);
        if (appToken) {
          setApp4(last4(appToken));
          setAppSaved(true);
          setAppToken("");
        }
        if (botToken) {
          setBot4(last4(botToken));
          setBotSaved(true);
          setBotToken("");
        }
        setSaving(false);
      })
      .catch(() => {
        setSaving(false);
        setSaveErr(t("slack.saveError"));
      });
  };

  const runTest = () => {
    setTesting(true);
    api
      .testSlack()
      .then((s) => {
        setStatus(s);
        setTesting(false);
      })
      .catch(() => {
        void refreshStatus();
        setTesting(false);
      });
  };

  const st = status?.status ?? "not_configured";
  const hasError = !!status?.last_error;
  const stepIdx = STATUS_ORDER.indexOf(st);

  return (
    <section className="slack">
      <div className="slack__scroll">
        <header className="slack__head">
          <div className="slack__title-wrap">
            <SlackMark />
            <h2 className="slack__title">{t("slack.title")}</h2>
          </div>
          <div className={cx("slack-status", statusClass(st, hasError))}>
            <span className="slack-status__led" />
            <span className="slack-status__label">{t(`slack.status.${st}`)}</span>
          </div>
        </header>

        <p className="slack__flow">{t("slack.flow")}</p>

        {/* connection status */}
        <div className="slack-card slack-status-card">
          <div className="slack-card__title">{t("slack.status.title")}</div>
          <div className="slack-status-card__row">
            <span className={cx("slack-status", statusClass(st, hasError))}>
              <span className="slack-status__led" />
              <span className="slack-status__label">{t(`slack.status.${st}`)}</span>
            </span>
            <button type="button" className="dr-btn dr-btn--ghost slack-test" onClick={runTest} disabled={testing}>
              {testing ? t("slack.testing") : t("slack.test")}
            </button>
          </div>
          {status?.last_event_at && (
            <div className="slack-status-card__meta">
              {t("slack.status.lastEvent")}: <span>{String(status.last_event_at)}</span>
            </div>
          )}
          {status?.last_error && (
            <div className="slack-status-card__meta is-error">
              {t("slack.status.lastError")}: <span>{status.last_error}</span>
            </div>
          )}
        </div>

        {/* manifest */}
        <div className="slack-card">
          <div className="slack-card__title">{t("slack.manifest.title")}</div>
          <p className="slack-card__desc">{t("slack.manifest.desc")}</p>
          <button
            type="button"
            className="dr-btn dr-btn--primary slack-manifest__btn"
            onClick={downloadManifest}
            disabled={manifestBusy}
          >
            ↓ {manifestBusy ? t("slack.manifest.downloading") : t("slack.manifest.download")}
          </button>
          {manifestErr && <div className="slack-field__err">{manifestErr}</div>}
        </div>

        {/* tokens + mapping (saved together via POST /api/slack/config) */}
        <form className="slack-card" onSubmit={save}>
          <div className="slack-card__title">{t("slack.tokens.title")}</div>

          <label className="slack-field">
            <span className="slack-field__label">{t("slack.tokens.app")}</span>
            {appSaved ? (
              <span className="slack-masked" data-token="app">
                <code>xapp-••••{app4 || "····"}</code>
                <button type="button" className="slack-edit" onClick={() => setAppSaved(false)}>
                  {t("slack.tokens.edit")}
                </button>
              </span>
            ) : (
              <input
                className="dr-input"
                name="appToken"
                type="password"
                placeholder="xapp-…"
                value={appToken}
                spellCheck={false}
                autoComplete="off"
                onChange={(e) => setAppToken(e.target.value)}
              />
            )}
            {appErr && <span className="slack-field__err">{appErr}</span>}
          </label>

          <label className="slack-field">
            <span className="slack-field__label">{t("slack.tokens.bot")}</span>
            {botSaved ? (
              <span className="slack-masked" data-token="bot">
                <code>xoxb-••••{bot4 || "····"}</code>
                <button type="button" className="slack-edit" onClick={() => setBotSaved(false)}>
                  {t("slack.tokens.edit")}
                </button>
              </span>
            ) : (
              <input
                className="dr-input"
                name="botToken"
                type="password"
                placeholder="xoxb-…"
                value={botToken}
                spellCheck={false}
                autoComplete="off"
                onChange={(e) => setBotToken(e.target.value)}
              />
            )}
            {botErr && <span className="slack-field__err">{botErr}</span>}
          </label>

          <div className="slack-card__title slack-card__title--sub">{t("slack.mapping.title")}</div>
          <div className="slack-map">
            <label className="slack-field">
              <span className="slack-field__label">{t("slack.mapping.channel")}</span>
              <input
                className="dr-input"
                name="channel"
                type="text"
                placeholder={t("slack.mapping.channelPh")}
                value={channel}
                spellCheck={false}
                onChange={(e) => setChannel(e.target.value)}
              />
            </label>
            <label className="slack-field">
              <span className="slack-field__label">{t("slack.mapping.node")}</span>
              <select className="dr-select" name="node" value={node} onChange={(e) => setNode(e.target.value)}>
                <option value="">{t("slack.mapping.nodeNone")}</option>
                {nodes.map((n) => (
                  <option key={n.name} value={n.name}>
                    {n.name}
                  </option>
                ))}
              </select>
            </label>
          </div>

          {saveErr && <div className="slack-field__err">{saveErr}</div>}
          <div className="slack-actions">
            <button type="submit" className="dr-btn dr-btn--primary slack-save" disabled={saving}>
              {saving ? t("slack.saving") : t("slack.save")}
            </button>
            {stepIdx >= 1 && (
              <a className="slack-threads" href="/api/slack/threads" target="_top" rel="noreferrer">
                {t("slack.threads")}
              </a>
            )}
          </div>
        </form>
      </div>
    </section>
  );
}

function SlackMark() {
  return (
    <svg className="slack__mark" viewBox="0 0 24 24" width={20} height={20} aria-hidden="true">
      <path
        d="M7 14a2 2 0 1 1-2-2h2v2zm1 0a2 2 0 0 1 4 0v5a2 2 0 0 1-4 0v-5zM10 7a2 2 0 1 1 2-2v2h-2zm0 1a2 2 0 0 1 0 4H5a2 2 0 0 1 0-4h5zM17 10a2 2 0 1 1 2 2h-2v-2zm-1 0a2 2 0 0 1-4 0V5a2 2 0 0 1 4 0v5zM14 17a2 2 0 1 1-2 2v-2h2zm0-1a2 2 0 0 1 0-4h5a2 2 0 0 1 0 4h-5z"
        fill="currentColor"
      />
    </svg>
  );
}
