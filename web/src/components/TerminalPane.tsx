import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { useEffect, useRef, useState } from "react";

import "@xterm/xterm/css/xterm.css";

import { api, b64ToBytes, wsUrl } from "../api";
import { agentGlyph, cx } from "../constants";
import type { GroveNode, TerminalFrame } from "../types";

type ConnState = "connecting" | "live" | "reconnecting" | "error";

const FONT = '"Spline Sans Mono", ui-monospace, SFMono-Regular, Menlo, monospace';

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

export function TerminalPane({ node }: { node: GroveNode | null }) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [state, setState] = useState<ConnState>("connecting");
  const [bytes, setBytes] = useState(0);

  const paneId = node?.tmux_pane ?? null;

  useEffect(() => {
    const mount = hostRef.current;
    if (!mount || !node) return;

    let disposed = false;
    let ws: WebSocket | null = null;
    let backoff = 1000;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let lastSeq = -1;

    setState("connecting");
    setBytes(0);

    const term = new Terminal({
      convertEol: false,
      cursorBlink: true,
      disableStdin: true, // read-only viewer
      fontFamily: FONT,
      fontSize: 13,
      lineHeight: 1.3,
      scrollback: 6000,
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
        .wsTicket()
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
          ws.onopen = () => {
            backoff = 1000;
            setState("live");
          };
          ws.onmessage = (ev: MessageEvent) => {
            let frame: TerminalFrame;
            try {
              frame = JSON.parse(ev.data as string) as TerminalFrame;
            } catch {
              return;
            }
            if (frame.pane_id && frame.pane_id !== target.tmux_pane) return;
            if (typeof frame.seq === "number") {
              if (frame.seq <= lastSeq) return; // drop duplicates / out-of-order
              lastSeq = frame.seq;
            }
            const data = b64ToBytes(frame.bytes_base64);
            term.write(data);
            setBytes((b) => b + data.length);
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
              term.write("\r\n\x1b[38;5;203m[session expired — reload the page]\x1b[0m\r\n");
              return;
            }
            if (ev.code === 1008) {
              setState("error");
              term.write("\r\n\x1b[38;5;203m[pane not available]\x1b[0m\r\n");
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
    connecting: { label: "connecting", cls: "is-connecting" },
    live: { label: "live", cls: "is-live" },
    reconnecting: { label: "reconnecting", cls: "is-reconnecting" },
    error: { label: "error", cls: "is-error" },
  }[state];

  return (
    <section className="dr-term">
      <header className="dr-term__bar">
        <div className="dr-term__id">
          <span className={cx("dr-led", conn.cls)} />
          <span className="dr-term__name">{node ? node.name : "no node selected"}</span>
          {node && (
            <span className="dr-term__pane">
              {agentGlyph(node.agent)} {node.agent} · {node.tmux_pane}
            </span>
          )}
        </div>
        <div className="dr-term__meta">
          <span className="dr-term__ro" title="read-only viewer">
            read-only
          </span>
          <span className={cx("dr-conn", conn.cls)}>{conn.label}</span>
          <span className="dr-term__bytes">{formatBytes(bytes)} streamed</span>
        </div>
      </header>
      <div className="dr-term__screen">
        {node ? (
          <div className="dr-term__host" ref={hostRef} />
        ) : (
          <div className="dr-term__empty">
            <div className="dr-term__empty-mark">▦</div>
            <p>Select a node to attach to its terminal.</p>
          </div>
        )}
      </div>
    </section>
  );
}
