import { useCallback, useEffect, useState } from "react";

import { api } from "../api";
import type { NotificationRouting, NotificationRule } from "../api";
import { cx } from "../constants";
import { useI18n } from "../i18n";
import type { TFn } from "../i18n";

const EVENT_TYPES = ["*", "blocked", "ask_human_pending", "anomaly"] as const;

function RoutingMark() {
  return (
    <svg className="routing__mark" viewBox="0 0 24 24" width={20} height={20} aria-hidden="true">
      <circle cx={5} cy={12} r={2.4} fill="none" stroke="currentColor" strokeWidth={1.5} />
      <circle cx={19} cy={6} r={2.4} fill="none" stroke="currentColor" strokeWidth={1.5} />
      <circle cx={19} cy={18} r={2.4} fill="none" stroke="currentColor" strokeWidth={1.5} />
      <path d="M7.3 11l9.4-4.4M7.3 13l9.4 4.4" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" />
    </svg>
  );
}

function fmtWindow(seconds: number): string {
  if (seconds >= 3600) return `${(seconds / 3600).toFixed(seconds % 3600 ? 1 : 0)}h`;
  if (seconds >= 60) return `${Math.round(seconds / 60)}m`;
  return `${seconds}s`;
}

function RuleCard({ rule, t }: { rule: NotificationRule; t: TFn }) {
  const conds: string[] = [`${t("routing.event")}: ${rule.event_type}`];
  if (rule.node) conds.push(`${t("routing.node")}: ${rule.node}`);
  if (rule.severity) conds.push(`${t("routing.severity")}: ${rule.severity}`);
  const esc = rule.escalation_targets ?? [];
  return (
    <div className="routing-rule" data-rule={rule.name}>
      <div className="routing-rule__head">
        <span className="routing-rule__name">{rule.name}</span>
        <span className="routing-rule__event" data-event={rule.event_type}>{rule.event_type}</span>
      </div>
      <div className="routing-rule__conds">
        {conds.map((c) => (
          <span key={c} className="routing-cond">{c}</span>
        ))}
      </div>
      <div className="routing-rule__target">
        <span className="routing-rule__k">{t("routing.target")}</span>
        <span className="routing-target">{rule.target.channel_kind}:{rule.target.room_id}</span>
      </div>
      {/* escalation — bounded window + max */}
      <div className="routing-rule__esc" data-esc={esc.length > 0 || rule.max_escalations > 0 ? "1" : "0"}>
        <span className="routing-rule__k">{t("routing.escalation")}</span>
        {esc.length > 0 || (rule.escalate_after_seconds ?? 0) > 0 ? (
          <span className="routing-esc">
            {typeof rule.escalate_after_seconds === "number" && (
              <span className="routing-esc__window">⏱ {t("routing.after")} {fmtWindow(rule.escalate_after_seconds)}</span>
            )}
            <span className="routing-esc__max">{t("routing.maxEsc")}: {rule.max_escalations}</span>
            {esc.map((e, i) => (
              <span key={i} className="routing-target is-esc">{e.channel_kind}:{e.room_id}</span>
            ))}
          </span>
        ) : (
          <span className="routing-esc__none">{t("routing.noEscalation")}</span>
        )}
      </div>
    </div>
  );
}

/** Operator-only inline config: a minimal single-rule editor. Edit → save →
 *  CONFIRM → POST. Hidden for viewers. dry-run stays on by default. */
function RoutingEditor({ routing, onSaved, t }: { routing: NotificationRouting; onSaved: () => void; t: TFn }) {
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [enabled, setEnabled] = useState(routing.enabled);
  const [dryRun, setDryRun] = useState(routing.dry_run);
  const [name, setName] = useState("");
  const [eventType, setEventType] = useState<string>("blocked");
  const [channel, setChannel] = useState("slack");
  const [room, setRoom] = useState("");
  const [escRoom, setEscRoom] = useState("");
  const [afterSec, setAfterSec] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<"forbidden" | "error" | null>(null);

  const submit = () => {
    setBusy(true);
    setErr(null);
    const escalation_targets = escRoom.trim() ? [{ channel_kind: channel.trim() || "slack", room_id: escRoom.trim() }] : [];
    const rule: NotificationRule = {
      name: name.trim() || "rule",
      event_type: eventType,
      target: { channel_kind: channel.trim() || "slack", room_id: room.trim() || "room" },
      escalation_targets,
      max_escalations: escalation_targets.length,
      ...(afterSec.trim() ? { escalate_after_seconds: Number(afterSec) || 0 } : {}),
    };
    api
      .setNotificationRouting({ enabled, dry_run: dryRun, rules: [rule] })
      .then(() => {
        setBusy(false);
        setConfirming(false);
        setOpen(false);
        onSaved();
      })
      .catch((e: unknown) => {
        setBusy(false);
        setConfirming(false);
        const m = e instanceof Error ? e.message : "";
        setErr(/\b403\b/.test(m) ? "forbidden" : "error");
      });
  };

  if (!open) {
    return (
      <button type="button" className="dr-btn dr-btn--ghost routing-edit__btn" onClick={() => setOpen(true)}>
        {t("routing.configure")}
      </button>
    );
  }

  return (
    <div className="routing-editor" data-editor="open">
      <div className="routing-editor__toggles">
        <label className="routing-editor__toggle">
          <input type="checkbox" name="routingEnabled" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          {t("routing.enabledLabel")}
        </label>
        <label className="routing-editor__toggle">
          <input type="checkbox" name="routingDryRun" checked={dryRun} onChange={(e) => setDryRun(e.target.checked)} />
          {t("routing.dryRunLabel")}
        </label>
      </div>
      <div className="routing-editor__fields">
        <label className="routing-editor__field">
          <span className="routing-editor__k">{t("routing.name")}</span>
          <input className="dr-input routing-edit__name" name="ruleName" value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="routing-editor__field">
          <span className="routing-editor__k">{t("routing.event")}</span>
          <select className="dr-select routing-edit__event" name="ruleEvent" value={eventType} onChange={(e) => setEventType(e.target.value)}>
            {EVENT_TYPES.map((ev) => (
              <option key={ev} value={ev}>{ev}</option>
            ))}
          </select>
        </label>
        <label className="routing-editor__field">
          <span className="routing-editor__k">{t("routing.channel")}</span>
          <input className="dr-input routing-edit__channel" name="ruleChannel" value={channel} onChange={(e) => setChannel(e.target.value)} />
        </label>
        <label className="routing-editor__field">
          <span className="routing-editor__k">{t("routing.room")}</span>
          <input className="dr-input routing-edit__room" name="ruleRoom" value={room} onChange={(e) => setRoom(e.target.value)} />
        </label>
        <label className="routing-editor__field">
          <span className="routing-editor__k">{t("routing.after")}(s)</span>
          <input className="dr-input routing-edit__after" name="ruleAfter" type="number" min={0} value={afterSec} onChange={(e) => setAfterSec(e.target.value)} />
        </label>
        <label className="routing-editor__field">
          <span className="routing-editor__k">{t("routing.escRoom")}</span>
          <input className="dr-input routing-edit__escroom" name="ruleEscRoom" value={escRoom} onChange={(e) => setEscRoom(e.target.value)} />
        </label>
      </div>
      {err && <div className="routing-msg is-error" data-err={err}>{t(`routing.err.${err}`)}</div>}
      {confirming ? (
        <div className="routing-confirm">
          <span className="routing-confirm__q">{t("routing.confirm")}</span>
          <button type="button" className="dr-btn dr-btn--primary routing-confirm__yes" disabled={busy} onClick={submit}>
            {busy ? t("routing.saving") : t("routing.yes")}
          </button>
          <button type="button" className="dr-btn dr-btn--ghost routing-confirm__no" onClick={() => setConfirming(false)}>
            {t("routing.no")}
          </button>
        </div>
      ) : (
        <div className="routing-editor__actions">
          <button type="button" className="dr-btn dr-btn--primary routing-edit__save" onClick={() => setConfirming(true)}>
            {t("routing.save")}
          </button>
          <button type="button" className="dr-btn dr-btn--ghost routing-edit__cancel" onClick={() => setOpen(false)}>
            {t("routing.cancel")}
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * Notification routing v2 (v1.24) — READ-ONLY view + operator config. Shows the
 * current conditional routing rules (condition → target + escalation), with the
 * DRY-RUN state surfaced prominently ("dry-run — 실제 전송 안 함"). Operators get an
 * explicit-confirm config editor; viewers are locked to read-only. Unconfigured
 * routing degrades to a graceful notice. Targets are backend-redacted (no secrets).
 */
export function RoutingPanel({ projectTick }: { projectTick: number }) {
  const { t } = useI18n();
  const [routing, setRouting] = useState<NotificationRouting | null>(null);
  const [isViewer, setIsViewer] = useState(false);
  const [errCode, setErrCode] = useState<"error" | null>(null);
  const [tick, setTick] = useState(0);

  const refresh = useCallback(() => setTick((x) => x + 1), []);

  useEffect(() => {
    let alive = true;
    api
      .getMe()
      .then((me) => alive && setIsViewer(me?.member?.role === "viewer"))
      .catch(() => alive && setIsViewer(false));
    return () => {
      alive = false;
    };
  }, [projectTick, tick]);

  useEffect(() => {
    let alive = true;
    api
      .getNotificationRouting()
      .then((r) => {
        if (!alive) return;
        setRouting(r.routing);
        setErrCode(null);
      })
      .catch(() => alive && setErrCode("error"));
    return () => {
      alive = false;
    };
  }, [projectTick, tick]);

  return (
    <section className="routing">
      <div className="routing__scroll">
        <header className="routing__head">
          <div className="routing__title-wrap">
            <RoutingMark />
            <h2 className="routing__title">{t("routing.title")}</h2>
          </div>
          {routing && (
            <span
              className={cx("routing-dryrun", routing.dry_run ? "is-dry" : "is-live")}
              data-dryrun={routing.dry_run ? "1" : "0"}
            >
              {routing.dry_run ? `🧪 ${t("routing.dryRun")}` : `📣 ${t("routing.live")}`}
            </span>
          )}
        </header>
        <p className="routing__note">{t("routing.note")}</p>

        {errCode === "error" && <div className="routing-msg is-error">{t("routing.loadError")}</div>}

        {routing && (
          <>
            <div className="routing-status" data-enabled={routing.enabled ? "1" : "0"} data-configured={routing.configured ? "1" : "0"}>
              <span className={cx("routing-badge", routing.enabled ? "is-on" : "is-off")}>
                {routing.enabled ? t("routing.enabled") : t("routing.disabled")}
              </span>
            </div>

            {!routing.configured ? (
              <div className="routing-empty" data-empty="1">{t("routing.unconfigured")}</div>
            ) : routing.rules.length > 0 ? (
              <div className="routing-rules">
                {routing.rules.map((rule) => (
                  <RuleCard key={rule.name} rule={rule} t={t} />
                ))}
              </div>
            ) : (
              <div className="routing-empty">{t("routing.noRules")}</div>
            )}

            {/* operator config (explicit confirm); viewers see a read-only note */}
            {isViewer ? (
              <div className="routing-readonly">{t("routing.readonly")}</div>
            ) : (
              <RoutingEditor routing={routing} onSaved={refresh} t={t} />
            )}
          </>
        )}
      </div>
    </section>
  );
}
