import { useEffect, useMemo, useRef, useState } from "react";

import { api } from "../api";
import type { AutopickupState, NodeDetail, NodeExecutionState, NodeSummary } from "../api";
import { cx, fmtAgo } from "../constants";
import { statusLabel, useI18n } from "../i18n";

function detailClass(s: string): string {
  switch (s) {
    case "running":
      return "is-running";
    case "error":
      return "is-error";
    case "blocked":
      return "is-blocked";
    case "dead":
      return "is-dead";
    default:
      return "is-idle";
  }
}

/**
 * Sub-header node-liveness heatmap for the active project. Reads the server's
 * authoritative summary from GET /api/status ({total,running,stale,idle,error})
 * and renders a proportion bar + chips. idle/error come straight from the
 * backend (_node_liveness_summary) — NOT derived as total-running-stale, which
 * miscounts error nodes as idle. The "Detail" toggle fetches ?detail=1 for a
 * per-node breakdown (status, last-seen, inferred badge). Polls + re-runs on
 * liveTick (board events) and projectTick (project switch).
 */
export function NodeStatusBar({ liveTick, projectTick }: { liveTick: number; projectTick: number }) {
  const { t } = useI18n();
  const [summary, setSummary] = useState<NodeSummary | null>(null);
  const [detail, setDetail] = useState<NodeDetail[] | null>(null);
  const [open, setOpen] = useState(false);
  const openRef = useRef(open);
  openRef.current = open;

  // Per-node autopickup config (real state, distinct from the inferred badge).
  const [pickup, setPickup] = useState<Record<string, AutopickupState>>({});
  const [busyNode, setBusyNode] = useState<string | null>(null);
  const [errNode, setErrNode] = useState<string | null>(null);
  // Set once a POST is rejected with 403 (team viewer): lock all toggles.
  const [denied, setDenied] = useState(false);

  // Per-node EXECUTION flag (separate from autopickup; both gate-aware).
  const [exec, setExec] = useState<Record<string, NodeExecutionState>>({});
  const [execBusy, setExecBusy] = useState<string | null>(null);
  const [execErr, setExecErr] = useState<string | null>(null);
  const [execDenied, setExecDenied] = useState(false);
  // Proactive viewer lock (role-based) for the execution toggle.
  const [execViewer, setExecViewer] = useState(false);

  useEffect(() => {
    let alive = true;
    const load = () =>
      api
        .getStatus(openRef.current)
        .then((s) => {
          if (!alive) return;
          setSummary(s.nodes ?? null);
          if (openRef.current) setDetail(s.node_details ?? []);
        })
        .catch(() => {
          /* keep last */
        });
    void load();
    const id = setInterval(() => void load(), 5000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [liveTick, projectTick]);

  // Fetch the per-node detail as soon as the panel is opened.
  useEffect(() => {
    if (!open) return;
    let alive = true;
    api
      .getStatus(true)
      .then((s) => {
        if (alive) setDetail(s.node_details ?? []);
      })
      .catch(() => {
        /* keep last */
      });
    return () => {
      alive = false;
    };
  }, [open, liveTick, projectTick]);

  // Fetch each node's autopickup config when the panel is open. Keyed on the
  // node-name signature (stable across polls) so it runs once per node set, not
  // every 5s tick. A successful toggle updates the map directly (no refetch).
  const detailNames = useMemo(() => (detail ?? []).map((d) => d.name).join(","), [detail]);
  useEffect(() => {
    // Clear on close so a reopen always reflects fresh state (no stale toggles
    // while the refetch is in flight after a global-gate / role change).
    if (!open) {
      setPickup({});
      setExec({});
      setDenied(false);
      setExecDenied(false);
      setExecViewer(false);
      setErrNode(null);
      setExecErr(null);
      return;
    }
    if (!detailNames) return;
    let alive = true;
    const names = detailNames.split(",");
    Promise.all(names.map((n) => api.getAutopickup(n).catch(() => null))).then((states) => {
      if (!alive) return;
      const map: Record<string, AutopickupState> = {};
      states.forEach((st, i) => {
        if (st) map[names[i]!] = st;
      });
      setPickup(map);
    });
    Promise.all(names.map((n) => api.getNodeExecution(n).catch(() => null))).then((states) => {
      if (!alive) return;
      const map: Record<string, NodeExecutionState> = {};
      states.forEach((st, i) => {
        if (st) map[names[i]!] = st;
      });
      setExec(map);
    });
    api
      .getMe()
      .then((me) => {
        if (alive) setExecViewer(me?.member?.role === "viewer");
      })
      .catch(() => {
        if (alive) setExecViewer(false);
      });
    return () => {
      alive = false;
    };
  }, [open, detailNames, projectTick]);

  const togglePickup = (name: string, next: boolean) => {
    if (busyNode || denied) return;
    setBusyNode(name);
    setErrNode(null);
    api
      .setAutopickup(name, next)
      .then((st) => {
        setBusyNode(null);
        setPickup((p) => ({ ...p, [name]: st }));
      })
      .catch((e: unknown) => {
        setBusyNode(null);
        const msg = e instanceof Error ? e.message : "";
        // Fixed messages only — never surface the raw cause.
        if (/\b403\b/.test(msg)) setDenied(true); // team viewer: lock toggles
        else setErrNode(name); // 409 (global gate) or transient error
      });
  };

  const toggleExec = (name: string, next: boolean) => {
    if (execBusy || execDenied) return;
    setExecBusy(name);
    setExecErr(null);
    api
      .setNodeExecution(name, next)
      .then((st) => {
        setExecBusy(null);
        setExec((p) => ({ ...p, [name]: st }));
      })
      .catch((e: unknown) => {
        setExecBusy(null);
        const msg = e instanceof Error ? e.message : "";
        if (/\b403\b/.test(msg)) setExecDenied(true);
        else setExecErr(name);
      });
  };

  // Use the backend's authoritative counts directly (idle/error are classified
  // server-side; deriving idle would fold error nodes into idle).
  const running = summary?.running ?? 0;
  const total = summary?.total ?? 0;
  const stale = summary?.stale ?? 0;
  const idle = summary?.idle ?? 0;
  const error = summary?.error ?? 0;

  return (
    <div className="nodestat" role="status" aria-label={t("status.nodes")}>
      <span className="nodestat__label">{t("status.nodes")}</span>
      <div className="nodestat__bar" aria-hidden="true">
        <span className="nodestat__seg is-running" style={{ flexGrow: running }} />
        <span className="nodestat__seg is-idle" style={{ flexGrow: idle }} />
        <span className="nodestat__seg is-stale" style={{ flexGrow: stale }} />
        <span className="nodestat__seg is-error" style={{ flexGrow: error }} />
      </div>
      <span className="nodestat__chip is-running">
        <span className="nodestat__led" />
        {running} {t("status.running")}
      </span>
      <span className="nodestat__chip is-idle">
        <span className="nodestat__led" />
        {idle} {t("status.idle")}
      </span>
      <span className="nodestat__chip is-stale">
        <span className="nodestat__led" />
        {stale} {t("status.stale")}
      </span>
      <span className="nodestat__chip is-error">
        <span className="nodestat__led" />
        {error} {t("status.error")}
      </span>
      <span className="nodestat__total">
        {total} {t("status.total")}
      </span>
      <button
        type="button"
        className={cx("nodestat__more", open && "is-open")}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        {t("status.detail")} ▾
      </button>

      {open && (
        <div className="nodestat-detail" role="region" aria-label={t("status.detail")}>
          {(detail ?? []).map((d) => {
            const st = pickup[d.name];
            const globalOff = !!st && (!st.global_enabled || st.global_kill_switch);
            const reason = st?.global_kill_switch
              ? t("pickup.killSwitch")
              : st && !st.global_enabled
                ? t("pickup.globalOff")
                : denied
                  ? t("pickup.denied")
                  : errNode === d.name
                    ? t("pickup.error")
                    : "";
            // Execution toggle (separate flag). Gate = global/board enabled +
            // any kill-switch across global/board/node.
            const ex = exec[d.name];
            const execOff =
              !!ex && (!ex.global_enabled || ex.global_kill_switch || !ex.board_enabled || ex.board_kill_switch || ex.kill_switch);
            const execReason = ex?.global_kill_switch || ex?.board_kill_switch || ex?.kill_switch
              ? t("exec.killSwitch")
              : ex && (!ex.global_enabled || !ex.board_enabled)
                ? t("exec.gateOff")
                : execDenied || execViewer
                  ? t("exec.denied")
                  : execErr === d.name
                    ? t("exec.toggleError")
                    : "";
            return (
              <div key={d.name} className="nodestat-row">
                <span className={cx("nodestat__led", detailClass(d.status))} />
                <span className="nodestat-row__name">{d.name}</span>
                <span className={cx("nodestat-row__status", detailClass(d.status))}>{statusLabel(t, d.status)}</span>
                {d.confidence === "inferred" && (
                  <span className="nodestat-row__inferred" title={d.status_reason ?? ""}>
                    {t("status.inferred")}
                  </span>
                )}
                {st && (
                  <span className="nodestat-row__pickup">
                    <button
                      type="button"
                      role="switch"
                      aria-checked={st.enabled}
                      aria-label={t("pickup.aria", { node: d.name })}
                      title={reason || t("pickup.hint")}
                      data-node={d.name}
                      data-enabled={st.enabled ? "1" : "0"}
                      className={cx("pickup-toggle", st.enabled && "is-on", (globalOff || denied) && "is-locked")}
                      disabled={busyNode === d.name || globalOff || denied}
                      onClick={() => togglePickup(d.name, !st.enabled)}
                    >
                      <span className="pickup-toggle__track">
                        <span className="pickup-toggle__thumb" />
                      </span>
                      <span className="pickup-toggle__label">{t("pickup.label")}</span>
                    </button>
                    {reason && <span className="pickup-toggle__reason">{reason}</span>}
                  </span>
                )}
                {ex && (
                  <span className="nodestat-row__exec">
                    <button
                      type="button"
                      role="switch"
                      aria-checked={ex.enabled}
                      aria-label={t("exec.aria", { node: d.name })}
                      title={execReason || t("exec.hint")}
                      data-exec-node={d.name}
                      data-enabled={ex.enabled ? "1" : "0"}
                      className={cx("exec-toggle", ex.enabled && "is-on", (execOff || execDenied || execViewer) && "is-locked")}
                      disabled={execBusy === d.name || execOff || execDenied || execViewer}
                      onClick={() => toggleExec(d.name, !ex.enabled)}
                    >
                      <span className="exec-toggle__track">
                        <span className="exec-toggle__thumb" />
                      </span>
                      <span className="exec-toggle__label">{t("exec.label")}</span>
                    </button>
                    {execReason && <span className="exec-toggle__reason">{execReason}</span>}
                  </span>
                )}
                <span className="nodestat-row__seen">
                  {t("status.lastSeen")} {fmtAgo(d.last_seen)}
                </span>
              </div>
            );
          })}
          {detail && detail.length === 0 && <div className="nodestat-row nodestat-row--empty">—</div>}
        </div>
      )}
    </div>
  );
}
