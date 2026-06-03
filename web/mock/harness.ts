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

interface OrgNodeMock {
  name: string;
  agent: string;
  role?: string;
  description?: string;
  parent?: string | null;
  group?: string;
  tmux_pane: string;
  session_id: string;
  status: string;
}

const ORG_NODES: OrgNodeMock[] = [
  { name: "root", agent: "claude", role: "오케스트레이터", description: "전체 작업 조율·분배", parent: null, group: "core", tmux_pane: "grove:0.0", session_id: "sess-root", status: "running" },
  { name: "backend", agent: "codex", role: "백엔드", description: "API·DB 담당", parent: "root", group: "build", tmux_pane: "grove:0.1", session_id: "sess-be", status: "running" },
  { name: "frontend", agent: "claude", role: "프런트엔드", parent: "root", group: "build", tmux_pane: "grove:0.2", session_id: "sess-fe", status: "idle" },
  { name: "researcher", agent: "claude", role: "리서치", parent: "root", group: "research", tmux_pane: "grove:0.3", session_id: "sess-re", status: "error" },
  { name: "docs", agent: "codex", role: "문서", parent: "backend", group: "build", tmux_pane: "grove:1.0", session_id: "sess-docs", status: "done" },
];

function basicNode(n: OrgNodeMock) {
  return {
    name: n.name,
    agent: n.agent,
    tmux_pane: n.tmux_pane,
    session_id: n.session_id,
    status: n.status,
  };
}

function childMap(): Record<string, string[]> {
  const c: Record<string, string[]> = {};
  for (const n of ORG_NODES) if (n.parent) (c[n.parent] ??= []).push(n.name);
  return c;
}

function isDescendant(ancestor: string, candidate: string): boolean {
  const c = childMap();
  const stack = [...(c[ancestor] ?? [])];
  const seen = new Set<string>();
  while (stack.length) {
    const x = stack.pop()!;
    if (x === candidate) return true;
    if (seen.has(x)) continue;
    seen.add(x);
    for (const k of c[x] ?? []) stack.push(k);
  }
  return false;
}

function buildOrg() {
  const children = childMap();
  const groups: Record<string, string[]> = {};
  for (const n of ORG_NODES) if (n.group) (groups[n.group] ??= []).push(n.name);
  return {
    nodes: ORG_NODES.map((n) => ({ ...n, children: children[n.name] ?? [] })),
    roots: ORG_NODES.filter((n) => !n.parent).map((n) => n.name),
    groups,
    children,
  };
}

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
let slack: { status: string; last_event_at: string | null; last_error: string | null } = {
  status: "not_configured",
  last_event_at: null,
  last_error: null,
};

interface ProjectMock {
  name: string;
  workspace: string;
  node_count: number;
  status: string;
}
const PROJECTS: ProjectMock[] = [
  { name: "dev10", workspace: "~/dev/grove", node_count: 5, status: "running" },
  { name: "infra-ops", workspace: "~/dev/infra", node_count: 2, status: "idle" },
];

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
      diag.assignedAssignee = created.assignee ?? "";
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

  if (p === "/api/projects") {
    if (method === "POST") {
      const body = (init?.body ? JSON.parse(init.body as string) : {}) as Record<string, string>;
      diag.createdProject = body;
      const created: ProjectMock = {
        name: String(body.name ?? "untitled"),
        workspace: body.clone ? `~/dev/${body.name}` : `~/dev/${body.name}`,
        node_count: 1,
        status: "running",
      };
      PROJECTS.push(created);
      return Promise.resolve(json(created));
    }
    return Promise.resolve(json(PROJECTS));
  }
  if (p === "/api/projects/load" && method === "POST") {
    const body = (init?.body ? JSON.parse(init.body as string) : {}) as { path?: string };
    const path = String(body.path ?? "");
    diag.loadedPath = path;
    const name = path.split(/[\\/]/).filter(Boolean).pop() ?? path;
    return Promise.resolve(
      json({ restored: ["root", "backend"], stale: ["docs"], fresh: ["frontend"], ok: true, name }),
    );
  }

  if (p === "/api/auth-status") {
    diag.authStatusFetched = ((diag.authStatusFetched as number) ?? 0) + 1;
    return Promise.resolve(
      json([
        { tool: "claude", label: "Claude Code", authed: true, detail: "~/.claude" },
        { tool: "codex", label: "Codex", authed: false, detail: "not logged in", login_hint: "codex login" },
        { tool: "antigravity", label: "Antigravity", authed: false, detail: "token missing", login_hint: "agy auth login" },
        { tool: "gh", label: "GitHub CLI", authed: true, detail: "user: octocat" },
        { tool: "cf", label: "Cloudflare", authed: false, login_hint: "https://dash.cloudflare.com/login" },
      ]),
    );
  }

  if (p === "/api/org") {
    const hdrs = init?.headers as Record<string, string> | undefined;
    diag.projectHeader = hdrs?.["X-Grove-Project"] ?? "";
    return Promise.resolve(json(buildOrg()));
  }

  if (p === "/api/nodes") {
    if (method === "POST") {
      const body = (init?.body ? JSON.parse(init.body as string) : {}) as Partial<OrgNodeMock>;
      const name = String(body.name ?? "").trim();
      const agent = String(body.agent ?? "");
      if (!/^[A-Za-z0-9_.-]+$/.test(name) || !["codex", "claude", "antigravity"].includes(agent)) {
        return Promise.resolve(
          new Response(JSON.stringify({ detail: "invalid name or agent" }), {
            status: 400,
            headers: { "Content-Type": "application/json" },
          }),
        );
      }
      const node: OrgNodeMock = {
        name,
        agent,
        role: body.role ?? "",
        description: body.description ?? "",
        parent: body.parent || null,
        group: body.group ?? "",
        tmux_pane: `grove:2.${ORG_NODES.length}`,
        session_id: `sess-${name}`,
        status: "running",
      };
      ORG_NODES.push(node);
      diag.createdNode = name;
      diag.createdNodeDesc = node.description;
      return Promise.resolve(json({ ...node, children: [] }));
    }
    return Promise.resolve(json(ORG_NODES.map(basicNode)));
  }

  m = p.match(/^\/api\/nodes\/([^/]+)$/);
  if (m && method === "PATCH") {
    const name = decodeURIComponent(m[1]!);
    const node = ORG_NODES.find((n) => n.name === name);
    if (!node) {
      return Promise.resolve(
        new Response(JSON.stringify({ detail: "unknown node" }), {
          status: 404,
          headers: { "Content-Type": "application/json" },
        }),
      );
    }
    const body = (init?.body ? JSON.parse(init.body as string) : {}) as { parent?: string | null; group?: string | null };
    if ("parent" in body) {
      const target = body.parent ?? null;
      if (target && (target === name || isDescendant(name, target) || !ORG_NODES.some((n) => n.name === target))) {
        return Promise.resolve(
          new Response(JSON.stringify({ detail: "invalid parent (cycle or unknown)" }), {
            status: 400,
            headers: { "Content-Type": "application/json" },
          }),
        );
      }
      node.parent = target;
      diag.patchedParent = `${name}->${target ?? "null"}`;
    }
    if ("group" in body) {
      node.group = body.group ?? "";
      diag.patchedGroup = `${name}:${body.group ?? "null"}`;
    }
    return Promise.resolve(json({ ...node, children: childMap()[name] ?? [] }));
  }

  if (p === "/api/ws-ticket") {
    diag.ticketMethod = method;
    const hdrs = init?.headers as Record<string, string> | undefined;
    diag.ticketHeader = hdrs?.["X-Grove-Session-Token"] ?? "";
    diag.wsTicketProject = hdrs?.["X-Grove-Project"] ?? ""; // project bound into the ticket
    return Promise.resolve(json({ ticket: `mock-ticket-${++ticketSeq}`, ttl_seconds: 30 }));
  }

  // --- Slack integration ----------------------------------------------------
  if (p === "/api/slack/manifest") {
    diag.manifestFetched = true;
    const manifest = {
      display_information: { name: "grove" },
      settings: { socket_mode_enabled: true },
    };
    return Promise.resolve(
      new Response(JSON.stringify(manifest, null, 2), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Content-Disposition": "attachment; filename=grove-slack-manifest.json",
        },
      }),
    );
  }
  if (p === "/api/slack/config/status") return Promise.resolve(json(slack));
  if (p === "/api/slack/config" && method === "POST") {
    const cfg = (init?.body ? JSON.parse(init.body as string) : {}) as Record<string, string>;
    diag.slackConfig = cfg;
    slack = { status: "tokens_saved", last_event_at: null, last_error: null };
    return Promise.resolve(json(slack));
  }
  if (p === "/api/slack/test" && method === "POST") {
    diag.slackTested = true;
    slack = { status: "socket_connected", last_event_at: "2026-06-03T12:00:00Z", last_error: null };
    return Promise.resolve(json(slack));
  }
  if (p === "/api/slack/threads") return Promise.resolve(json([]));

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
    if (this.kind === "board") {
      diag.boardWsConnected = true;
      diag.boardWsTicket = new URLSearchParams(queryPart).get("ticket") ?? "";
      diag.boardWsConnects = ((diag.boardWsConnects as number) ?? 0) + 1;
    }
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
