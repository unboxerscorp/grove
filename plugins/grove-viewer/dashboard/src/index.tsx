/**
 * grove-viewer — "Dev Room" Legacy dashboard plugin (frontend)
 *
 * Core value: watch ANY grove agent's terminal live. Pick a node, the
 * centerpiece terminal streams its tmux pane over a WebSocket into xterm.js;
 * a compact board strip links out to the full Kanban tab.
 *
 * Runtime contract with the host dashboard:
 *   - React comes from window.__LEGACY_PLUGIN_SDK__.React (NOT bundled here).
 *   - The component mounts via window.__LEGACY_PLUGINS__.register("grove-viewer", C).
 *   - Assets are served from /dashboard-plugins/grove-viewer/<file>.
 *
 * Backend contract (implemented by the grove-py lane; mocked in mock/ for
 * standalone verification):
 *   GET  /api/plugins/grove-viewer/nodes          -> Node[]
 *   GET  /api/plugins/grove-viewer/board-summary  -> BoardSummary
 *   WS   /api/plugins/grove-viewer/term?pane&ticket-> raw tmux text stream
 *   POST /api/plugins/grove-viewer/send {pane,data}-> forward keystrokes (optional)
 */
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";

import "@xterm/xterm/css/xterm.css";
import "./styles.css";

// ---------------------------------------------------------------------------
// Host SDK access (React only — we own the rest of the surface for design
// control, with plain-fetch fallbacks so the bundle also runs standalone).
// ---------------------------------------------------------------------------
const SDK: LegacySDK = window.__LEGACY_PLUGIN_SDK__ ?? ({} as LegacySDK);
const React = SDK.React;
const h = React.createElement;
const Fragment = React.Fragment;
const { useState, useEffect, useRef, useCallback, useMemo } = React;

const API = "/api/plugins/grove-viewer";
const API_AUTH_TICKET = "/api/auth/ws-ticket";

// ---------------------------------------------------------------------------
// Types (mirror the backend contract above)
// ---------------------------------------------------------------------------
type NodeStatus = "running" | "idle" | "error" | "done" | string;

interface GroveNode {
  name: string;
  agent: string;
  tmux_pane: string;
  session_id: string;
  status: NodeStatus;
}

interface BoardColumn {
  key: string;
  label: string;
  count: number;
}

interface BoardSummary {
  board?: string;
  url?: string;
  columns?: BoardColumn[];
  recent?: { id: string; title: string; status?: string }[];
}

type ConnState = "connecting" | "live" | "reconnecting" | "closed" | "error";

// ---------------------------------------------------------------------------
// Networking helpers
// ---------------------------------------------------------------------------
function authHeaders(extra?: Record<string, string>): Record<string, string> {
  const token = window.__LEGACY_SESSION_TOKEN__ ?? "";
  const base: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};
  return { ...base, ...(extra ?? {}) };
}

const fetchJSON: <T>(url: string) => Promise<T> =
  (SDK.fetchJSON as <T>(url: string) => Promise<T>) ??
  (async <T,>(url: string): Promise<T> => {
    const r = await fetch(url, { credentials: "same-origin", headers: authHeaders() });
    if (!r.ok) throw new Error(`${r.status}: ${await r.text()}`);
    return (await r.json()) as T;
  });

/**
 * Resolve the WS auth query-param pair, mirroring Legacy' web SDK
 * `buildWsAuthParam()` (legacy web/src/lib/api.ts) exactly:
 *
 *   - Gated mode (window.__LEGACY_AUTH_REQUIRED__ — public bind, no --insecure):
 *     POST /api/auth/ws-ticket (cookie auth) for a single-use ticket and return
 *     ["ticket", t]. Browsers can't set Authorization on a WS upgrade, so this
 *     REST round-trip bridges cookie auth to the WS. The legacy ?token= path is
 *     rejected by the backend in this mode.
 *   - Loopback / --insecure: return ["token", injected session token].
 *
 * Backend validation: legacy_cli.web_server._ws_auth_ok (ticket store in gated
 * mode, constant-time token compare in loopback). Tickets are single-use,
 * TTL 30s, so a fresh one is minted on every (re)connect.
 */
async function buildWsAuthParam(): Promise<[string, string]> {
  if (window.__LEGACY_AUTH_REQUIRED__) {
    const res = await fetch(API_AUTH_TICKET, { method: "POST", credentials: "include" });
    if (!res.ok) throw new Error(`${API_AUTH_TICKET}: HTTP ${res.status}`);
    const body = (await res.json()) as { ticket: string };
    return ["ticket", body.ticket];
  }
  return ["token", window.__LEGACY_SESSION_TOKEN__ ?? ""];
}

async function sendInput(pane: string, data: string): Promise<void> {
  try {
    await fetch(`${API}/send`, {
      method: "POST",
      credentials: "same-origin",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ pane, data }),
    });
  } catch {
    /* best-effort; read-only viewers ignore failures */
  }
}

// ---------------------------------------------------------------------------
// Presentation helpers
// ---------------------------------------------------------------------------
function statusMeta(status: NodeStatus): { label: string; cls: string } {
  switch (status) {
    case "running":
      return { label: "running", cls: "is-running" };
    case "idle":
      return { label: "idle", cls: "is-idle" };
    case "error":
      return { label: "error", cls: "is-error" };
    case "done":
      return { label: "done", cls: "is-done" };
    default:
      return { label: String(status || "unknown"), cls: "is-idle" };
  }
}

function agentGlyph(agent: string): string {
  const a = (agent || "").toLowerCase();
  if (a.includes("claude")) return "◇";
  if (a.includes("codex")) return "▸";
  return "•";
}

function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(" ");
}

const TERM_THEME = {
  background: "#0b0d10",
  foreground: "#d6dbe1",
  cursor: "#c2f032",
  cursorAccent: "#0b0d10",
  selectionBackground: "rgba(194,240,50,0.22)",
  black: "#0b0d10",
  red: "#ff5d5d",
  green: "#a6e22e",
  yellow: "#f5c451",
  blue: "#6fb3ff",
  magenta: "#c792ea",
  cyan: "#5ad1ff",
  white: "#d6dbe1",
  brightBlack: "#5a626d",
  brightRed: "#ff7a7a",
  brightGreen: "#c2f032",
  brightYellow: "#ffd479",
  brightBlue: "#9ecbff",
  brightMagenta: "#e0b0ff",
  brightCyan: "#8ee6ff",
  brightWhite: "#ffffff",
};

const TERM_FONT = '"IBM Plex Mono", ui-monospace, SFMono-Regular, "JetBrains Mono", Menlo, monospace';

// ---------------------------------------------------------------------------
// Live terminal (centerpiece)
// ---------------------------------------------------------------------------
function LiveTerminal(props: { node: GroveNode | null; interactive: boolean }) {
  const { node, interactive } = props;
  const hostRef = useRef<HTMLDivElement | null>(null);
  const interactiveRef = useRef(interactive);
  interactiveRef.current = interactive;

  const [state, setState] = useState<ConnState>("connecting");
  const [bytes, setBytes] = useState(0);

  const pane = node?.tmux_pane ?? null;

  useEffect(() => {
    const mount = hostRef.current;
    if (!mount || !node) return;

    let disposed = false;
    let ws: WebSocket | null = null;
    let backoff = 1000;
    let timer: ReturnType<typeof setTimeout> | null = null;

    setState("connecting");
    setBytes(0);

    const term = new Terminal({
      convertEol: false,
      cursorBlink: true,
      fontFamily: TERM_FONT,
      fontSize: 13,
      lineHeight: 1.25,
      letterSpacing: 0,
      scrollback: 6000,
      theme: TERM_THEME,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(mount);
    const refit = () => {
      try {
        fit.fit();
      } catch {
        /* element not measurable yet */
      }
    };
    requestAnimationFrame(refit);

    const dataDisp = term.onData((d) => {
      if (interactiveRef.current && node) void sendInput(node.tmux_pane, d);
    });
    const ro = new ResizeObserver(refit);
    ro.observe(mount);

    const decoder = new TextDecoder();
    const scheduleReconnect = () => {
      if (disposed) return;
      const delay = Math.min(backoff, 15000);
      backoff = Math.min(backoff * 2, 15000);
      timer = setTimeout(connect, delay);
    };

    function connect() {
      if (disposed || !node) return;
      const target = node;
      buildWsAuthParam()
        .then(([authName, authValue]) => {
          if (disposed) return;
          const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
          const params = new URLSearchParams({ pane: target.tmux_pane });
          if (authValue) params.set(authName, authValue);
          const url = `${proto}//${window.location.host}${API}/term?${params}`;
          try {
            ws = new WebSocket(url);
          } catch {
            setState("reconnecting");
            scheduleReconnect();
            return;
          }
          ws.binaryType = "arraybuffer";
          ws.onopen = () => {
            backoff = 1000;
            setState("live");
          };
          ws.onmessage = (ev: MessageEvent) => {
            const text = typeof ev.data === "string" ? ev.data : decoder.decode(ev.data as ArrayBuffer);
            term.write(text);
            setBytes((b) => b + text.length);
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
            // Terminal close codes from _ws_auth_ok / the /term route: 4401 =
            // WS auth rejected, 1008 = pane not exposed. Reconnecting cannot
            // fix either, so surface the reason and stop the backoff loop.
            if (ev.code === 4401) {
              setState("error");
              term.write("\r\n\x1b[31m[auth rejected — reload the page to refresh the session]\x1b[0m\r\n");
              return;
            }
            if (ev.code === 1008) {
              setState("error");
              term.write("\r\n\x1b[31m[pane not exposed by grove-viewer]\x1b[0m\r\n");
              return;
            }
            setState("reconnecting");
            scheduleReconnect();
          };
        })
        .catch(() => {
          // Ticket mint failed (e.g. expired session) — back off and retry.
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
      dataDisp.dispose();
      ro.disconnect();
      term.dispose();
    };
    // Re-create the terminal whenever the selected pane changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pane]);

  const conn = {
    connecting: { label: "connecting", cls: "is-connecting" },
    live: { label: "live", cls: "is-live" },
    reconnecting: { label: "reconnecting", cls: "is-reconnecting" },
    closed: { label: "closed", cls: "is-closed" },
    error: { label: "error", cls: "is-error" },
  }[state];

  return h(
    "section",
    { className: "gv-console" },
    h(
      "header",
      { className: "gv-console__bar" },
      h(
        "div",
        { className: "gv-console__id" },
        h("span", { className: cx("gv-led", conn.cls) }),
        h(
          "span",
          { className: "gv-console__name" },
          node ? node.name : "no node selected",
        ),
        node &&
          h(
            "span",
            { className: "gv-console__pane" },
            `${agentGlyph(node.agent)} ${node.agent} · ${node.tmux_pane}`,
          ),
      ),
      h(
        "div",
        { className: "gv-console__meta" },
        h("span", { className: cx("gv-conn", conn.cls) }, conn.label),
        h("span", { className: "gv-console__bytes" }, `${formatBytes(bytes)} streamed`),
      ),
    ),
    h(
      "div",
      { className: "gv-console__screen" },
      node
        ? h("div", { className: "gv-term-host", ref: hostRef })
        : h(
            "div",
            { className: "gv-console__empty" },
            h("div", { className: "gv-console__empty-mark" }, "▦"),
            h("p", null, "Select a node to attach to its terminal."),
          ),
    ),
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

// ---------------------------------------------------------------------------
// Node selector (left rail)
// ---------------------------------------------------------------------------
function NodeRail(props: {
  nodes: GroveNode[];
  selectedPane: string | null;
  onSelect: (pane: string) => void;
  loading: boolean;
  error: string | null;
}) {
  const { nodes, selectedPane, onSelect, loading, error } = props;
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return nodes;
    return nodes.filter((n) =>
      `${n.name} ${n.agent} ${n.tmux_pane} ${n.session_id} ${n.status}`.toLowerCase().includes(q),
    );
  }, [nodes, query]);

  return h(
    "aside",
    { className: "gv-rail" },
    h(
      "div",
      { className: "gv-rail__head" },
      h("span", { className: "gv-rail__title" }, "Nodes"),
      h("span", { className: "gv-rail__count" }, String(nodes.length)),
    ),
    h("input", {
      className: "gv-rail__search",
      type: "text",
      placeholder: "filter nodes…",
      value: query,
      onChange: (e: { target: { value: string } }) => setQuery(e.target.value),
      spellCheck: false,
    }),
    h(
      "div",
      { className: "gv-rail__list" },
      error && h("div", { className: "gv-rail__msg is-error" }, error),
      !error && loading && nodes.length === 0 && h("div", { className: "gv-rail__msg" }, "loading nodes…"),
      !error &&
        !loading &&
        filtered.length === 0 &&
        h("div", { className: "gv-rail__msg" }, nodes.length ? "no match" : "no nodes online"),
      filtered.map((n, i) => {
        const sm = statusMeta(n.status);
        const selected = n.tmux_pane === selectedPane;
        return h(
          "button",
          {
            key: n.tmux_pane || n.session_id || n.name,
            type: "button",
            className: cx("gv-node", selected && "is-selected"),
            style: { animationDelay: `${Math.min(i, 12) * 28}ms` },
            onClick: () => onSelect(n.tmux_pane),
          },
          h("span", { className: cx("gv-dot", sm.cls) }),
          h(
            "span",
            { className: "gv-node__body" },
            h(
              "span",
              { className: "gv-node__top" },
              h("span", { className: "gv-node__name" }, n.name),
              h("span", { className: "gv-node__agent" }, agentGlyph(n.agent)),
            ),
            h(
              "span",
              { className: "gv-node__sub" },
              h("span", { className: "gv-node__pane" }, n.tmux_pane),
              h("span", { className: cx("gv-node__status", sm.cls) }, sm.label),
            ),
          ),
        );
      }),
    ),
  );
}

// ---------------------------------------------------------------------------
// Compact kanban strip (summary + link, not a re-implementation)
// ---------------------------------------------------------------------------
function KanbanStrip(props: { summary: BoardSummary | null }) {
  const { summary } = props;
  const columns = summary?.columns ?? [];
  const href = summary?.url ?? (summary?.board ? `/kanban?board=${encodeURIComponent(summary.board)}` : "/kanban");

  return h(
    "footer",
    { className: "gv-strip" },
    h(
      "div",
      { className: "gv-strip__cols" },
      h("span", { className: "gv-strip__label" }, "Board"),
      columns.length === 0
        ? h("span", { className: "gv-strip__empty" }, "—")
        : columns.map((c) =>
            h(
              "span",
              { key: c.key, className: "gv-chip" },
              h("span", { className: "gv-chip__n" }, String(c.count)),
              h("span", { className: "gv-chip__l" }, c.label),
            ),
          ),
    ),
    h(
      "a",
      { className: "gv-strip__link", href, target: "_top", rel: "noreferrer" },
      "Open board ↗",
    ),
  );
}

// ---------------------------------------------------------------------------
// Root
// ---------------------------------------------------------------------------
function GroveViewer() {
  const [nodes, setNodes] = useState<GroveNode[]>([]);
  const [summary, setSummary] = useState<BoardSummary | null>(null);
  const [selectedPane, setSelectedPane] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [interactive, setInteractive] = useState(false);

  const loadNodes = useCallback(async () => {
    try {
      const data = await fetchJSON<GroveNode[]>(`${API}/nodes`);
      setNodes(Array.isArray(data) ? data : []);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed to load nodes");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadNodes();
    void fetchJSON<BoardSummary>(`${API}/board-summary`)
      .then(setSummary)
      .catch(() => setSummary(null));
    const poll = setInterval(() => void loadNodes(), 5000);
    return () => clearInterval(poll);
  }, [loadNodes]);

  // Keep a valid selection: default to the first node, recover if it vanishes.
  useEffect(() => {
    if (nodes.length === 0) return;
    if (!selectedPane || !nodes.some((n) => n.tmux_pane === selectedPane)) {
      setSelectedPane(nodes[0]!.tmux_pane);
    }
  }, [nodes, selectedPane]);

  const selected = useMemo(
    () => nodes.find((n) => n.tmux_pane === selectedPane) ?? null,
    [nodes, selectedPane],
  );
  const liveCount = useMemo(() => nodes.filter((n) => n.status === "running").length, [nodes]);

  return h(
    "div",
    { className: "grove-viewer" },
    h(
      "header",
      { className: "gv-top" },
      h(
        "div",
        { className: "gv-brand" },
        h(GroveMark),
        h(
          "div",
          { className: "gv-brand__text" },
          h("span", { className: "gv-brand__title" }, "Dev Room"),
          h("span", { className: "gv-brand__sub" }, "grove · live agent terminals"),
        ),
      ),
      h(
        "div",
        { className: "gv-top__right" },
        h(
          "div",
          { className: "gv-stat" },
          h("span", { className: "gv-stat__n" }, String(nodes.length)),
          h("span", { className: "gv-stat__l" }, "nodes"),
        ),
        h(
          "div",
          { className: "gv-stat" },
          h("span", { className: "gv-stat__n is-live" }, String(liveCount)),
          h("span", { className: "gv-stat__l" }, "live"),
        ),
        h(
          "label",
          { className: cx("gv-toggle", interactive && "is-on"), title: "Forward keystrokes to the pane (POST /send)" },
          h("input", {
            type: "checkbox",
            checked: interactive,
            onChange: (e: { target: { checked: boolean } }) => setInteractive(e.target.checked),
          }),
          h("span", { className: "gv-toggle__track" }, h("span", { className: "gv-toggle__knob" })),
          h("span", { className: "gv-toggle__label" }, interactive ? "interactive" : "read-only"),
        ),
      ),
    ),
    h(
      "main",
      { className: "gv-main" },
      h(NodeRail, {
        nodes,
        selectedPane,
        onSelect: setSelectedPane,
        loading,
        error,
      }),
      h(
        "div",
        { className: "gv-stage" },
        h(LiveTerminal, { node: selected, interactive }),
        h(KanbanStrip, { summary }),
      ),
    ),
  );
}

function GroveMark() {
  // Stylised grove: a branching mark in the accent lime.
  return h(
    "svg",
    { className: "gv-mark", viewBox: "0 0 24 24", width: 24, height: 24, "aria-hidden": "true" },
    h("path", {
      d: "M12 22V13M12 13L7 9M12 13l5-4M12 9V3",
      fill: "none",
      stroke: "currentColor",
      strokeWidth: 1.6,
      strokeLinecap: "round",
    }),
    h("circle", { cx: 12, cy: 3, r: 1.8, fill: "currentColor" }),
    h("circle", { cx: 7, cy: 9, r: 1.6, fill: "currentColor" }),
    h("circle", { cx: 17, cy: 9, r: 1.6, fill: "currentColor" }),
  );
}

// ---------------------------------------------------------------------------
// Register with the host (guarded; no-op if host registry absent)
// ---------------------------------------------------------------------------
if (React && window.__LEGACY_PLUGINS__ && typeof window.__LEGACY_PLUGINS__.register === "function") {
  window.__LEGACY_PLUGINS__.register("grove-viewer", GroveViewer);
}

export { GroveViewer };
