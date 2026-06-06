import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { useEffect, useRef, useState } from "react";

import "@xterm/xterm/css/xterm.css";

import { api, b64ToBytes, wsUrl } from "../api";
import { agentGlyph, cx } from "../constants";
import { useI18n } from "../i18n";
import type { TFn } from "../i18n";
import type { GroveNode, TerminalFrame } from "../types";
import { NodeHealthBadge } from "./NodeHealthBadge";

type ConnState = "connecting" | "live" | "reconnecting" | "error";

const FONT = '"Spline Sans Mono", ui-monospace, SFMono-Regular, Menlo, monospace';

// Clear screen + scrollback + home cursor. Written before a full-screen
// "snapshot" frame (the pipe-pane stream's initial seed, or a legacy/fallback
// capture frame) so it mirrors; "chunk" frames append incrementally instead.
const CLEAR = "\x1b[2J\x1b[3J\x1b[H";
const XTERM_DISABLE_STDIN = true;

const THEME = {
  background: "#0a0c11",
  foreground: "#d3d8e0",
  cursor: "#f0b860",
  cursorAccent: "#0a0c11",
  selectionBackground: "rgba(240,184,96,0.22)",
  black: "#0a0c11",
  red: "#ff6b6b",
  green: "#54c7b8",
  yellow: "#f0b860",
  blue: "#7aa2f7",
  magenta: "#c9a6ff",
  cyan: "#5fd0e0",
  white: "#d3d8e0",
  brightBlack: "#525a6b",
  brightRed: "#ff8a8a",
  brightGreen: "#79e0d2",
  brightYellow: "#ffce85",
  brightBlue: "#9cbcff",
  brightMagenta: "#e0c4ff",
  brightCyan: "#8ee6f2",
  brightWhite: "#ffffff",
};

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** Operator-only web→node command input → POST /api/nodes/{node}/send. The live
 *  terminal streams the result. Fixed error messages (no raw cause). */
function NodeSendBox({ node, t }: { node: GroveNode; t: TFn }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<"disabled" | "forbidden" | "rate" | "failed" | null>(null);
  const [sent, setSent] = useState(false);
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const v = text.trim();
    if (!v || busy) return;
    setBusy(true);
    setErr(null);
    api
      .sendNode(node.name, v)
      .then(() => {
        setBusy(false);
        setText("");
        setSent(true);
        window.setTimeout(() => setSent(false), 1500);
      })
      .catch((e2: unknown) => {
        setBusy(false);
        const m = e2 instanceof Error ? e2.message : "";
        setErr(/\b404\b/.test(m) ? "disabled" : /\b403\b/.test(m) ? "forbidden" : /\b429\b/.test(m) ? "rate" : "failed");
      });
  };
  return (
    <form className="dr-term__send" onSubmit={submit}>
      <input
        className="dr-input dr-term__send-input"
        name="nodeInput"
        type="text"
        placeholder={t("term.send.placeholder")}
        value={text}
        spellCheck={false}
        autoComplete="off"
        onChange={(e) => setText(e.target.value)}
      />
      <button type="submit" className="dr-btn dr-btn--primary dr-term__send-btn" disabled={!text.trim() || busy}>
        {busy ? t("term.send.sending") : t("term.send.btn")}
      </button>
      {err && (
        <span className="dr-term__send-err" data-send-err={err}>
          {t(`term.send.err.${err}`)}
        </span>
      )}
      {sent && <span className="dr-term__send-ok">{t("term.send.ok")}</span>}
    </form>
  );
}

/** Footer tools for a node: operator-only send box (viewer locked). */
function TerminalTools({ node, t }: { node: GroveNode; t: TFn }) {
  const [isViewer, setIsViewer] = useState(false);
  useEffect(() => {
    let alive = true;
    api
      .getMe()
      .then((me) => alive && setIsViewer(me?.member?.role === "viewer"))
      .catch(() => alive && setIsViewer(false));
    return () => {
      alive = false;
    };
  }, [node.name]);
  if (node.input_allowed === false) {
    return (
      <div className="dr-term__tools">
        <div className="dr-term__send-viewer" data-viewonly="1">{t("term.send.viewOnly")}</div>
      </div>
    );
  }
  return (
    <div className="dr-term__tools">
      {isViewer ? (
        <div className="dr-term__send-viewer">{t("term.send.viewer")}</div>
      ) : (
        <NodeSendBox node={node} t={t} />
      )}
    </div>
  );
}

export function TerminalPane({ node, compact = false }: { node: GroveNode | null; compact?: boolean }) {
  const { t } = useI18n();
  const hostRef = useRef<HTMLDivElement | null>(null);
  // Keep the current translator in a ref so the terminal effect (keyed only on
  // the pane) doesn't tear down/recreate when the language toggles.
  const tRef = useRef<TFn>(t);
  tRef.current = t;

  const [state, setState] = useState<ConnState>("connecting");
  const [bytes, setBytes] = useState(0);

  // Only attach when the node is terminal-viewable (terminal_allowed !== false).
  const viewable = !!node && node.terminal_allowed !== false;
  const paneId = viewable ? (node?.tmux_pane ?? null) : null;

  useEffect(() => {
    const mount = hostRef.current;
    if (!mount || !node) return;

    let disposed = false;
    let ws: WebSocket | null = null;
    let backoff = 1000;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let lastSeq = -1;
    let capacityNotified = false; // show the "at capacity" notice once, not per retry

    setState("connecting");
    setBytes(0);

    const term = new Terminal({
      convertEol: true, // capture frames use \n; convert to CRLF (no staircase)
      cursorBlink: false,
      disableStdin: XTERM_DISABLE_STDIN, // input is sent through the explicit send form below
      fontFamily: FONT,
      fontSize: 13,
      lineHeight: 1.3,
      scrollback: 1000,
      theme: THEME,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(mount);
    const refit = () => {
      try {
        fit.fit();
      } catch {
        /* not measurable yet */
      }
    };
    requestAnimationFrame(refit);
    const ro = new ResizeObserver(refit);
    ro.observe(mount);

    const scheduleReconnect = () => {
      if (disposed) return;
      const delay = Math.min(backoff, 15000);
      backoff = Math.min(backoff * 2, 15000);
      timer = setTimeout(connect, delay);
    };

    function connect() {
      if (disposed || !node) return;
      const target = node;
      api
        .wsTicket({ kind: "terminal", pane_id: target.tmux_pane })
        .then(({ ticket }) => {
          if (disposed) return;
          const url = wsUrl("/ws/terminal", { ticket, pane_id: target.tmux_pane });
          try {
            ws = new WebSocket(url);
          } catch {
            setState("reconnecting");
            scheduleReconnect();
            return;
          }
          // Stay "connecting" until the first snapshot actually arrives.
          ws.onopen = () => {
            backoff = 1000;
          };
          ws.onmessage = (ev: MessageEvent) => {
            let frame: TerminalFrame;
            try {
              frame = JSON.parse(ev.data as string) as TerminalFrame;
            } catch {
              return;
            }
            if (frame.type === "error") return; // surfaced via onclose; nothing to render
            if (frame.pane_id && frame.pane_id !== target.tmux_pane) return;
            if (typeof frame.seq === "number") {
              if (frame.seq <= lastSeq) return; // drop duplicates / out-of-order
              lastSeq = frame.seq;
            }
            const data = b64ToBytes(frame.bytes_base64);
            // Capture-only: each frame is a full-screen snapshot → mirror (CLEAR
            // then write). The pipe-pane streaming path was dropped (it can freeze
            // the operator's pane), so there are no incremental "chunk" frames.
            term.write(CLEAR);
            term.write(data);
            setBytes((b) => b + data.length);
            setState("live");
          };
          ws.onerror = () => {
            try {
              ws?.close();
            } catch {
              /* noop */
            }
          };
          ws.onclose = (ev: CloseEvent) => {
            if (disposed) return;
            // 4401 = session/ticket rejected, 1008 = pane not available. Both
            // terminal: reconnecting won't help, so surface and stop.
            if (ev.code === 4401) {
              setState("error");
              term.write(`\r\n\x1b[38;5;203m${tRef.current("term.authError")}\x1b[0m\r\n`);
              return;
            }
            if (ev.code === 1008) {
              setState("error");
              term.write(`\r\n\x1b[38;5;203m${tRef.current("term.paneError")}\x1b[0m\r\n`);
              return;
            }
            // 4429 (custom, mirrors HTTP 429) / 1013 = stream cap reached. Not
            // terminal: a slot may free, so notice once + retry with backoff.
            if (ev.code === 4429 || ev.code === 1013) {
              setState("reconnecting");
              if (!capacityNotified) {
                capacityNotified = true;
                term.write(`\r\n\x1b[38;5;203m${tRef.current("term.capacity")}\x1b[0m\r\n`);
              }
              scheduleReconnect();
              return;
            }
            setState("reconnecting");
            scheduleReconnect();
          };
        })
        .catch(() => {
          if (disposed) return;
          setState("reconnecting");
          scheduleReconnect();
        });
    }

    connect();

    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
      try {
        ws?.close();
      } catch {
        /* noop */
      }
      ro.disconnect();
      term.dispose();
    };
  }, [paneId]);

  const conn = {
    connecting: { label: t("conn.connecting"), cls: "is-connecting" },
    live: { label: t("conn.live"), cls: "is-live" },
    reconnecting: { label: t("conn.reconnecting"), cls: "is-reconnecting" },
    error: { label: t("conn.error"), cls: "is-error" },
  }[state];

  return (
    <section className={cx("dr-term", compact && "dr-term--compact")}>
      {/* Compact (grid cell) drops the whole header — the grid cell bar carries
          the node name + full-view/close controls — leaving just screen + composer. */}
      {!compact && (
        <header className="dr-term__bar">
          <div className="dr-term__id">
            <span className={cx("dr-led", conn.cls)} />
            <span className="dr-term__name">{node ? node.name : t("term.noNode")}</span>
            {node && <NodeHealthBadge health={node.health} />}
            {node && (
              <span className="dr-term__pane">
                {agentGlyph(node.agent)} {node.agent} · {node.tmux_pane}
              </span>
            )}
          </div>
          <div className="dr-term__meta">
            <span className="dr-term__ro" title={t("term.readOnly")}>
              {t("term.readOnly")}
            </span>
            <span className={cx("dr-conn", conn.cls)}>{conn.label}</span>
            <span className="dr-term__bytes">{t("term.streamed", { x: formatBytes(bytes) })}</span>
          </div>
        </header>
      )}
      <div className="dr-term__screen">
        {node && viewable ? (
          <div className="dr-term__host" data-xterm-stdin={XTERM_DISABLE_STDIN ? "disabled" : "enabled"} ref={hostRef} />
        ) : node && !viewable ? (
          <div className="dr-term__empty" data-notviewable="1">
            <div className="dr-term__empty-mark">⛔</div>
            <p>{t("term.notViewable")}</p>
          </div>
        ) : (
          <div className="dr-term__empty">
            <div className="dr-term__empty-mark">▦</div>
            <p>{t("term.empty")}</p>
          </div>
        )}
      </div>
      {/* Composer (send box) is present in EVERY view — compact grid cells AND the
          full single view — so each node has its own bottom input (operator UX). */}
      {node && viewable && <TerminalTools node={node} t={t} />}
    </section>
  );
}
