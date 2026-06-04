import { useEffect, useRef, useState } from "react";

import { api } from "../api";
import type { AggregateItem, AggregateResult, SignedSummary } from "../api";
import { cx, fmtAgo } from "../constants";
import { useI18n } from "../i18n";
import type { TFn } from "../i18n";

/** A pasted blob is a usable summary envelope only if it has the 4 signed fields. */
function asEnvelope(value: unknown): SignedSummary | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (typeof v.algorithm !== "string" || typeof v.key_id !== "string") return null;
  if (typeof v.signature !== "string" || typeof v.payload !== "object" || v.payload === null) return null;
  return v as unknown as SignedSummary;
}

function AggMark() {
  return (
    <svg className="agg__mark" viewBox="0 0 24 24" width={20} height={20} aria-hidden="true">
      <circle cx={6} cy={7} r={2.5} fill="none" stroke="currentColor" strokeWidth={1.5} />
      <circle cx={18} cy={7} r={2.5} fill="none" stroke="currentColor" strokeWidth={1.5} />
      <circle cx={12} cy={18} r={2.5} fill="none" stroke="currentColor" strokeWidth={1.5} />
      <path d="M7.5 8.5 11 16M16.5 8.5 13 16M8 7h8" fill="none" stroke="currentColor" strokeWidth={1.4} />
    </svg>
  );
}

function n(v: number | undefined): string {
  return typeof v === "number" ? String(v) : "—";
}

function RoomCard({ item, t }: { item: AggregateItem; t: TFn }) {
  const trusted = item.trust === "trusted";
  const stale = item.freshness === "stale";
  // untrusted OR stale ⇒ NOT part of the live combined rollup — say so explicitly.
  const excluded = !trusted || stale;
  const s = item.payload?.summary;
  return (
    <div
      className={cx("agg-room", trusted ? "is-trusted" : "is-untrusted", stale && "is-stale", excluded && "is-excluded")}
      data-trust={item.trust}
      data-freshness={item.freshness}
      data-key={item.key_id ?? ""}
    >
      <div className="agg-room__head">
        <span className={cx("agg-badge", trusted ? "is-trusted" : "is-untrusted")}>
          {trusted ? `✓ ${t("agg.trusted")}` : `✕ ${t("agg.untrusted")}`}
        </span>
        <span className={cx("agg-fresh", stale ? "is-stale" : item.freshness === "fresh" ? "is-fresh" : "is-unknown")}>
          {item.freshness === "fresh" ? t("agg.fresh") : stale ? t("agg.stale") : t("agg.freshUnknown")}
          {typeof item.generated_at === "number" && <span className="agg-fresh__ago"> · {fmtAgo(item.generated_at)}</span>}
        </span>
        {item.key_id && <span className="agg-room__key">{item.key_id}</span>}
      </div>

      {item.project && <div className="agg-room__project">{item.project}</div>}

      {trusted && s ? (
        <div className="agg-room__counts">
          <span className="agg-count">
            <span className="agg-count__k">{t("agg.boards")}</span> {n(s.boards?.total)}
          </span>
          <span className="agg-count">
            <span className="agg-count__k">{t("agg.tasks")}</span> {n(s.tasks?.total)}
          </span>
          <span className="agg-count">
            <span className="agg-count__k">{t("agg.nodes")}</span> {n(s.nodes?.total)}
          </span>
          <span className="agg-count">
            <span className="agg-count__k">{t("agg.runs")}</span> {n(s.runs?.total)}
          </span>
        </div>
      ) : (
        <div className="agg-room__reason">{item.reason ?? t("agg.noPayload")}</div>
      )}

      {excluded && (
        <div className="agg-room__excluded">
          ⚠ {!trusted ? t("agg.excludedUntrusted") : t("agg.excludedStale")}
        </div>
      )}
    </div>
  );
}

/**
 * Cross-room aggregation view (read-only — no control). Renders the combined
 * rollup plus a card per source room with trust (signed-key) + freshness badges.
 * untrusted / stale rooms are clearly flagged as excluded from the live combined
 * rollup and never shown as live. Aggregation is default-OFF (404) — handled
 * gracefully with a fixed notice; only key_id is shown (no keys/secrets).
 */
export function AggregationPanel({ projectTick }: { projectTick: number }) {
  const { t } = useI18n();
  const [own, setOwn] = useState<SignedSummary | null>(null);
  // Operator-supplied peer summaries (signed JSON pasted from other grove rooms).
  const [peers, setPeers] = useState<SignedSummary[]>([]);
  const [result, setResult] = useState<AggregateResult | null>(null);
  const [disabled, setDisabled] = useState(false);
  const [errCode, setErrCode] = useState<"error" | null>(null);
  const [loading, setLoading] = useState(true);
  const [pasteText, setPasteText] = useState("");
  const [pasteErr, setPasteErr] = useState<string | null>(null);
  const tRef = useRef(t);
  tRef.current = t;

  // This room's own signed summary (re-fetched per project). 404 = disabled.
  useEffect(() => {
    let alive = true;
    setLoading(true);
    setErrCode(null);
    setDisabled(false);
    setPeers([]);
    api
      .getSummary()
      .then((o) => {
        if (alive) setOwn(o);
      })
      .catch((e: unknown) => {
        if (!alive) return;
        setOwn(null);
        setResult(null);
        if (/\b404\b/.test(e instanceof Error ? e.message : "")) setDisabled(true);
        else setErrCode("error");
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [projectTick]);

  // Aggregate own + pasted peers whenever the set changes — the aggregator
  // verifies trust/freshness and combines (read-only).
  useEffect(() => {
    if (!own) return;
    let alive = true;
    api
      .aggregate([own, ...peers])
      .then((res) => {
        if (alive) setResult(res);
      })
      .catch((e: unknown) => {
        if (!alive) return;
        if (/\b404\b/.test(e instanceof Error ? e.message : "")) setDisabled(true);
        else setErrCode("error");
      });
    return () => {
      alive = false;
    };
  }, [own, peers]);

  const addPeer = () => {
    const text = pasteText.trim();
    if (!text) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      setPasteErr(t("agg.pasteInvalid"));
      return;
    }
    const env = asEnvelope(parsed);
    if (!env) {
      setPasteErr(t("agg.pasteInvalid"));
      return;
    }
    setPasteErr(null);
    setPasteText("");
    setPeers((prev) => [...prev, env]);
  };

  const combined = result?.combined;
  const rooms = result?.summaries ?? [];

  return (
    <section className="agg">
      <div className="agg__scroll">
        <header className="agg__head">
          <div className="agg__title-wrap">
            <AggMark />
            <h2 className="agg__title">{t("agg.title")}</h2>
          </div>
        </header>
        <p className="agg__note">{t("agg.note")}</p>

        {disabled && <div className="agg__msg is-warn agg-disabled">{t("agg.disabled")}</div>}
        {errCode === "error" && <div className="agg__msg is-error">{t("agg.loadError")}</div>}
        {loading && !disabled && !errCode && !result && <div className="agg__msg">{t("agg.refreshing")}</div>}

        {/* Add a peer room: paste another grove's signed summary (read-only — adds
            it to the verified combine, not control). */}
        {!disabled && !errCode && own && (
          <div className="agg-paste">
            <textarea
              className="dr-input agg-paste__input"
              name="aggPaste"
              rows={2}
              placeholder={t("agg.pastePlaceholder")}
              value={pasteText}
              spellCheck={false}
              onChange={(e) => setPasteText(e.target.value)}
            />
            <button type="button" className="dr-btn dr-btn--ghost agg-paste__add" disabled={!pasteText.trim()} onClick={addPeer}>
              + {t("agg.pasteAdd")}
            </button>
            {pasteErr && <div className="agg-paste__err">{pasteErr}</div>}
            {peers.length > 0 && <div className="agg-paste__count">{t("agg.peers", { n: peers.length })}</div>}
          </div>
        )}

        {!disabled && !errCode && result && (
          <>
            {combined && (
              <div className="agg-combined" data-agg="combined">
                <div className="agg-combined__head">
                  <span className="agg-combined__title">{t("agg.combined")}</span>
                  <span className="agg-combined__sources">{t("agg.sources", { n: combined.sources ?? 0 })}</span>
                </div>
                <div className="agg-room__counts">
                  <span className="agg-count">
                    <span className="agg-count__k">{t("agg.boards")}</span> {n(combined.boards?.total)}
                  </span>
                  <span className="agg-count">
                    <span className="agg-count__k">{t("agg.tasks")}</span> {n(combined.tasks?.total)}
                  </span>
                  <span className="agg-count">
                    <span className="agg-count__k">{t("agg.nodes")}</span> {n(combined.nodes?.total)}
                  </span>
                  <span className="agg-count">
                    <span className="agg-count__k">{t("agg.runs")}</span> {n(combined.runs?.total)}
                  </span>
                </div>
                {combined.tasks?.by_status && Object.keys(combined.tasks.by_status).length > 0 && (
                  <div className="agg-bystatus">
                    {Object.entries(combined.tasks.by_status).map(([k, v]) => (
                      <span key={k} className="agg-bystatus__chip" data-status={k}>
                        {k} {v}
                      </span>
                    ))}
                  </div>
                )}
                {result.trust && (
                  <div className="agg-combined__trust">
                    {t("agg.trustSummary", {
                      trusted: result.trust.trusted,
                      untrusted: result.trust.untrusted,
                      stale: result.trust.stale,
                    })}
                  </div>
                )}
              </div>
            )}

            <div className="agg-rooms">
              {rooms.length === 0 && <div className="agg__msg">{t("agg.empty")}</div>}
              {rooms.map((item, i) => (
                <RoomCard key={item.key_id ?? `room-${i}`} item={item} t={t} />
              ))}
            </div>
          </>
        )}
      </div>
    </section>
  );
}
