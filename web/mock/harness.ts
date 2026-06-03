// Standalone mock backend for the Dev Room SPA.
//
// Installs the page globals the grove web server would inject, then intercepts
// fetch + WebSocket so the built bundle runs end-to-end in a plain browser
// (file://) with no server. Loaded BEFORE the app bundle by mock/index.html.

interface MockTask {
  id: string;
  title: string;
  status: string;
  assignee?: string;
  latest_summary?: string;
  body?: string;
  tenant?: string;
}

const BOARDS = [
  { id: "grove", name: "Grove", task_count: 7 },
  { id: "infra", name: "Infra", task_count: 3 },
];

const TASKS: Record<string, MockTask[]> = {
  grove: [
    { id: "G-6", title: "Triage incoming agent reports", status: "triage", assignee: "root" },
    { id: "G-5", title: "Task drawer: comments + runs", status: "todo", assignee: "frontend" },
    {
      id: "G-1",
      title: "Stand up the dev-room SPA",
      status: "running",
      assignee: "frontend",
      latest_summary: "wiring the live xterm stream into the cockpit",
    },
    { id: "G-2", title: "Board event-tail over WebSocket", status: "review", assignee: "backend" },
    { id: "G-4", title: "Single-use ws-ticket auth", status: "ready", assignee: "backend" },
    { id: "G-7", title: "Pane resize policy (read-only beta)", status: "blocked", assignee: "frontend" },
    { id: "G-3", title: "Node registry + tmux pane exposure", status: "done", assignee: "backend" },
  ],
  infra: [
    { id: "I-1", title: "Static build pipeline", status: "todo", assignee: "docs" },
    { id: "I-2", title: "Reverse proxy + TLS", status: "running", assignee: "root" },
    { id: "I-3", title: "Nightly backups", status: "done", assignee: "docs" },
  ],
};

const NODES = [
  { name: "root", agent: "claude", tmux_pane: "grove:0.0", session_id: "sess-root", status: "running" },
  { name: "backend", agent: "codex", tmux_pane: "grove:0.1", session_id: "sess-be", status: "running" },
  { name: "frontend", agent: "claude", tmux_pane: "grove:0.2", session_id: "sess-fe", status: "idle" },
  { name: "researcher", agent: "claude", tmux_pane: "grove:0.3", session_id: "sess-re", status: "error" },
  { name: "docs", agent: "codex", tmux_pane: "grove:1.0", session_id: "sess-docs", status: "done" },
];

function findTask(id: string): MockTask | undefined {
  for (const list of Object.values(TASKS)) {
    const t = list.find((x) => x.id === id);
    if (t) return t;
  }
  return undefined;
}

function commentsFor(id: string) {
  return [
    { id: `${id}-c1`, author: "root", body: "Picked this up — see the linked run for progress." },
    { id: `${id}-c2`, author: "frontend", body: "Stream is flowing; verifying reconnect/backoff next." },
  ];
}

function runsFor(id: string) {
  return [
    { id: `run-${id}-2`, status: "running", node: "frontend", summary: "esbuild bundle + headless verify" },
    { id: `run-${id}-1`, status: "done", node: "backend", summary: "snapshot REST + event-tail wired" },
  ];
}

// --- page globals the server injects ---------------------------------------
window.__GROVE_SESSION_TOKEN__ = "mock-session-token";
window.__GROVE_AUTH_REQUIRED__ = true;

// --- diagnostics for the verifier ------------------------------------------
const diag: Record<string, unknown> = {};
(window as unknown as { __MOCK__: Record<string, unknown> }).__MOCK__ = diag;

let ticketSeq = 0;
let taskSeq = 0;

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

// --- mock REST --------------------------------------------------------------
const realFetch = window.fetch.bind(window);
window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const u = new URL(url, window.location.href);
  const p = u.pathname;
  const method = (init?.method ?? "GET").toUpperCase();

  if (p === "/api/boards") return Promise.resolve(json(BOARDS));

  let m = p.match(/^\/api\/boards\/([^/]+)\/tasks$/);
  if (m) {
    const board = decodeURIComponent(m[1]!);
    if (method === "POST") {
      const payload = (init?.body ? JSON.parse(init.body as string) : {}) as Partial<MockTask>;
      const created: MockTask = {
        id: `N-${++taskSeq}`,
        title: payload.title ?? "untitled",
        status: payload.status || "triage",
        assignee: payload.assignee,
        body: payload.body,
      };
      (TASKS[board] ??= []).unshift(created);
      diag.createdTask = created.title;
      return Promise.resolve(json(created));
    }
    let list = TASKS[board] ?? [];
    const status = u.searchParams.get("status");
    const assignee = u.searchParams.get("assignee");
    if (status) list = list.filter((t) => t.status === status);
    if (assignee) list = list.filter((t) => (t.assignee ?? "").toLowerCase().includes(assignee.toLowerCase()));
    return Promise.resolve(json(list));
  }

  m = p.match(/^\/api\/tasks\/([^/]+)\/comments$/);
  if (m) return Promise.resolve(json(commentsFor(decodeURIComponent(m[1]!))));

  m = p.match(/^\/api\/tasks\/([^/]+)\/runs$/);
  if (m) return Promise.resolve(json(runsFor(decodeURIComponent(m[1]!))));

  m = p.match(/^\/api\/tasks\/([^/]+)$/);
  if (m) {
    const id = decodeURIComponent(m[1]!);
    const t = findTask(id) ?? { id, title: "Unknown task", status: "triage" };
    return Promise.resolve(
      json({ ...t, body: "Mock task body — served by the grove web server in production.", tenant: "grove" }),
    );
  }

  if (p === "/api/nodes") return Promise.resolve(json(NODES));

  if (p === "/api/ws-ticket") {
    diag.ticketMethod = method;
    const hdrs = init?.headers as Record<string, string> | undefined;
    diag.ticketHeader = hdrs?.["X-Grove-Session-Token"] ?? "";
    return Promise.resolve(json({ ticket: `mock-ticket-${++ticketSeq}`, ttl_seconds: 30 }));
  }

  return realFetch(input, init);
}) as typeof fetch;

// --- mock WebSockets (board event-tail + terminal frames) -------------------
function bytesToB64(s: string): string {
  const u = new TextEncoder().encode(s);
  let bin = "";
  for (const b of u) bin += String.fromCharCode(b);
  return btoa(bin);
}

// Full pane snapshot (as the backend's `capture-pane -e -J` would send), using
// \n joins and an incrementing #marker so the screen-replace behaviour is
// observable: if the client appended, multiple #markers would pile up.
function snapshot(pane: string, n: number): string {
  return (
    [
      `\x1b[38;5;79m● 개발실 라이브 미러\x1b[0m  pane \x1b[38;5;111m${pane}\x1b[0m  #${n}`,
      "",
      "\x1b[38;5;179m$\x1b[0m grove status --tree",
      "\x1b[38;5;179mroot\x1b[0m ─┬─ backend   \x1b[38;5;79m●\x1b[0m running",
      "        ├─ frontend  \x1b[38;5;179m○\x1b[0m idle",
      "        └─ docs      \x1b[38;5;111m✓\x1b[0m done",
    ].join("\n") + "\n"
  );
}

class MockWS {
  url: string;
  readyState = 0;
  binaryType = "blob";
  onopen: ((e: unknown) => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: ((e: { code: number }) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;

  private timer: ReturnType<typeof setInterval> | null = null;
  private seq = 0;
  private kind: "term" | "board" | "other";
  private pane = "";

  constructor(url: string) {
    this.url = url;
    // Parse without `new URL` — the mock's file:// origin yields empty-host WS
    // URLs (ws:///ws/board?…) that `new URL` rejects.
    const [pathPart = "", queryPart = ""] = url.split("?");
    this.pane = new URLSearchParams(queryPart).get("pane_id") ?? "";
    this.kind = pathPart.includes("/ws/terminal")
      ? "term"
      : pathPart.includes("/ws/board")
        ? "board"
        : "other";
    if (this.kind === "term") diag.terminalWsUrl = url;
    if (this.kind === "board") diag.boardWsConnected = true;
    setTimeout(() => this.open(), 120);
  }

  private emit(s: string) {
    this.onmessage?.({ data: s });
  }

  private emitSnapshot() {
    const n = ++this.seq;
    const text = snapshot(this.pane, n);
    this.emit(JSON.stringify({ seq: n, pane_id: this.pane, bytes_base64: bytesToB64(text), ts: n }));
  }

  private open() {
    this.readyState = 1;
    this.onopen?.({});
    if (this.kind === "term") {
      // Backend sends a full snapshot on change; emit one periodically.
      this.emitSnapshot();
      this.timer = setInterval(() => this.emitSnapshot(), 700);
    } else if (this.kind === "board") {
      setTimeout(() => this.emit(JSON.stringify({ cursor: 1, type: "task.updated", task_id: "G-1" })), 800);
    }
  }

  send(_data: string) {
    /* read-only viewer */
  }

  close() {
    this.readyState = 3;
    if (this.timer) clearInterval(this.timer);
    this.onclose?.({ code: 1000 });
  }
}

window.WebSocket = MockWS as unknown as typeof WebSocket;
