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
  // N1: a distinct, isolated project so a switch swaps the whole context and
  // leaves no residue from the default project's boards/tasks.
  "solo-x": [{ id: "S-1", title: "solo task", status: "running", assignee: "solo" }],
};

// N1 scope target: switching to this project must re-scope org/board/nodes to a
// single distinct node with none of the default project's data bleeding through.
const SOLO_PROJECT = "solo-x";

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

// N1: solo-x's own org/nodes — one node, no relation to ORG_NODES above.
const SOLO_NODES: OrgNodeMock[] = [
  { name: "solo", agent: "claude", role: "혼자", parent: null, group: "", tmux_pane: "solo-x:0.0", session_id: "sess-solo", status: "running" },
];
function buildSoloOrg() {
  return {
    nodes: SOLO_NODES.map((n) => ({ ...n, children: [] as string[] })),
    roots: ["solo"],
    groups: {} as Record<string, string[]>,
    children: {} as Record<string, string[]>,
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
// Mirrors the backend: each ws-ticket is bound to a kind (terminal|board), an
// optional pane, and the request's project. The WS endpoints reject (1008) when
// the ticket's binding doesn't match the socket it's used on.
const ticketBindings: Record<string, { kind: string; pane: string; project: string }> = {};
let taskSeq = 0;

// Audit log seed — MIRRORS web_app.py _audit_event_payload exactly: object
// `actor` ({kind,id,login,role}) and object `target` ({type,id,node}), a numeric
// `cursor` (rowid), epoch-seconds `ts`, and top-level task_id/from_node/to_node.
// assign/delegate events feed the OrgChart delegation overlay (root->backend
// twice => edge count 2). The /api/audit handler paginates by cursor (rowid>).
type MockAuditActor = { kind: string; id: string; login: string; role: string };
type MockAuditTarget = { type: string; id?: string; node?: string };
type MockAuditEvent = {
  cursor: number;
  id: string;
  actor: MockAuditActor;
  action: string;
  target: MockAuditTarget;
  ts: number;
  task_id: string | null;
  from_node?: string | null;
  to_node?: string | null;
};
const nodeActor = (id: string): MockAuditActor => ({ kind: "node", id, login: id, role: "none" });
const AUDIT_TS0 = 1_780_542_000; // ~2026-06-04T03:00Z, epoch seconds
const AUDIT_EVENTS: MockAuditEvent[] = [
  { cursor: 1, id: "e1", actor: nodeActor("root"), action: "spawn", target: { type: "node", id: "backend", node: "backend" }, ts: AUDIT_TS0 + 5, task_id: null },
  { cursor: 2, id: "e2", actor: nodeActor("root"), action: "delegate", target: { type: "task", id: "G-4", node: "backend" }, ts: AUDIT_TS0 + 30, task_id: "G-4" },
  { cursor: 3, id: "e3", actor: nodeActor("backend"), action: "claim", target: { type: "task", id: "G-4", node: "backend" }, ts: AUDIT_TS0 + 70, task_id: "G-4" },
  { cursor: 4, id: "e4", actor: nodeActor("root"), action: "assign", target: { type: "task", id: "G-5", node: "frontend" }, ts: AUDIT_TS0 + 100, task_id: "G-5" },
  { cursor: 5, id: "e5", actor: nodeActor("backend"), action: "complete", target: { type: "task", id: "G-4", node: "backend" }, ts: AUDIT_TS0 + 120, task_id: "G-4" },
  { cursor: 6, id: "e6", actor: nodeActor("backend"), action: "delegate", target: { type: "task", id: "G-6", node: "researcher" }, ts: AUDIT_TS0 + 150, task_id: "G-6" },
  { cursor: 7, id: "e7", actor: nodeActor("frontend"), action: "reparent", target: { type: "node", id: "docs", node: "docs" }, ts: AUDIT_TS0 + 180, task_id: null, from_node: "frontend", to_node: "docs" },
  { cursor: 8, id: "e8", actor: nodeActor("root"), action: "delegate", target: { type: "task", id: "G-8", node: "backend" }, ts: AUDIT_TS0 + 210, task_id: "G-8" },
  { cursor: 9, id: "e9", actor: nodeActor("root"), action: "block", target: { type: "task", id: "G-7", node: "frontend" }, ts: AUDIT_TS0 + 240, task_id: "G-7" },
  { cursor: 10, id: "e10", actor: nodeActor("root"), action: "spawn", target: { type: "node", id: "frontend", node: "frontend" }, ts: AUDIT_TS0 + 300, task_id: null },
];
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
  { name: SOLO_PROJECT, workspace: "~/dev/solo", node_count: 1, status: "running" },
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

  if (p === "/api/health") {
    diag.healthFetched = true;
    return Promise.resolve(json({ ok: true, board_ok: true }));
  }

  if (p === "/api/status") {
    diag.statusFetches = ((diag.statusFetches as number) ?? 0) + 1;
    const proj = (init?.headers as Record<string, string> | undefined)?.["X-Grove-Project"] ?? "dev10";
    // Mirrors web_app.py _node_liveness_summary: each node classified once into
    // running/stale/error, everything else idle. error is NOT folded into stale.
    const running = ORG_NODES.filter((n) => n.status === "running").length;
    const stale = ORG_NODES.filter((n) => n.status === "stale").length;
    const error = ORG_NODES.filter((n) => n.status === "error").length;
    const idle = ORG_NODES.length - running - stale - error;
    const body: Record<string, unknown> = {
      project: proj,
      nodes: { total: ORG_NODES.length, running, stale, idle, error },
    };
    if (u.searchParams.get("detail")) {
      // Mirrors web_app.py _node_status_details: field is `node_details`; source
      // is always "registry"; the estimate signal is `confidence` ("explicit" |
      // "inferred") as a STRING; last_seen is epoch seconds (int).
      diag.statusDetailFetched = true;
      body.node_details = ORG_NODES.map((n) => {
        // explicit registry status -> "explicit"; derived (error/done) -> "inferred".
        const status = n.status === "done" ? "dead" : n.status;
        const inferred = n.status === "error" || n.status === "done";
        return {
          name: n.name,
          status,
          last_seen: inferred ? AUDIT_TS0 - 300 : AUDIT_TS0 + 330,
          status_reason: inferred ? "no recent heartbeat" : `registry status: ${n.status}`,
          source: "registry",
          confidence: inferred ? "inferred" : "explicit",
        };
      });
    }
    return Promise.resolve(json(body));
  }

  if (p === "/api/audit") {
    // Mirrors web_app.py audit_endpoint + store.list_audit_events: rowid>cursor,
    // ORDER BY rowid ASC LIMIT; exact action match; node matches actor.id /
    // target.node / from_node / to_node; returns {items, next_cursor} where
    // next_cursor is the last item's cursor (or the request cursor if empty).
    diag.auditFetches = ((diag.auditFetches as number) ?? 0) + 1;
    const sp = u.searchParams;
    diag.auditFilter = `action=${sp.get("action") ?? ""}&node=${sp.get("node") ?? ""}&task=${sp.get("task_id") ?? ""}`;
    if (sp.get("cursor")) diag.auditCursorUsed = true;
    const limit = Number(sp.get("limit") ?? "100") || 100;
    const start = Number(sp.get("cursor") ?? "0") || 0;
    const action = sp.get("action");
    const node = sp.get("node");
    const taskId = sp.get("task_id");
    let events = AUDIT_EVENTS.filter((e) => e.cursor > start);
    if (action) events = events.filter((e) => e.action === action);
    if (node)
      events = events.filter(
        (e) =>
          e.actor.id === node ||
          e.target.node === node ||
          e.from_node === node ||
          e.to_node === node,
      );
    if (taskId) events = events.filter((e) => e.task_id === taskId || e.target.id === taskId);
    const items = events.slice(0, limit);
    const nextCursor = items.length ? items[items.length - 1]!.cursor : start;
    return Promise.resolve(json({ items, next_cursor: nextCursor }));
  }

  if (p === "/api/cost") {
    // Mirrors web_app.py _cost_payload/_cost_by_agent: `by_agent` is an OBJECT
    // keyed by COST_AGENTS order; tokens live in `total_tokens`, money in
    // `cost_usd_estimate`; agy adds credit_remaining (value null / unknown) +
    // credit_status + warnings[]. codex = explicit (not flagged); claude/agy =
    // partial + estimate source (flagged).
    diag.costFetched = true;
    const proj = (init?.headers as Record<string, string> | undefined)?.["X-Grove-Project"] ?? "dev10";
    const m = (value: number | null, source: string, confidence: string, status?: string) =>
      status ? { value, source, confidence, status } : { value, source, confidence };
    return Promise.resolve(
      json({
        project: proj,
        generated_at: m(AUDIT_TS0 + 300, "server", "explicit"),
        window: { name: "24h" },
        totals: {
          turns: m(16, "run_metadata", "explicit"),
          input_tokens: m(1_730_000, "mixed", "partial"),
          output_tokens: m(439_690, "mixed", "partial"),
          total_tokens: m(2_169_690, "mixed", "partial"),
          cost_usd_estimate: m(23.34, "estimate", "partial"),
          confidence: "partial",
        },
        by_agent: {
          codex: {
            nodes: m(2, "registry", "explicit"),
            turns: m(8, "run_metadata", "explicit"),
            input_tokens: m(1_000_000, "run_metadata", "explicit"),
            output_tokens: m(234_567, "run_metadata", "explicit"),
            total_tokens: m(1_234_567, "run_metadata", "explicit"),
            cost_usd_estimate: m(12.34, "run_metadata", "explicit"),
            confidence: "explicit",
          },
          claude: {
            nodes: m(2, "registry", "explicit"),
            turns: m(5, "run_metadata", "explicit"),
            input_tokens: m(700_000, "transcript", "partial"),
            output_tokens: m(190_123, "transcript", "partial"),
            total_tokens: m(890_123, "transcript", "partial"),
            cost_usd_estimate: m(8.9, "estimate", "partial"),
            confidence: "partial",
          },
          agy: {
            nodes: m(1, "registry", "explicit"),
            turns: m(3, "run_metadata", "explicit"),
            input_tokens: m(30_000, "transcript", "partial"),
            output_tokens: m(15_000, "transcript", "partial"),
            total_tokens: m(45_000, "transcript", "partial"),
            cost_usd_estimate: m(2.1, "estimate", "partial"),
            confidence: "partial",
            credit_remaining: m(null, "none", "unknown", "unknown"),
            credit_status: "unknown",
            warnings: ["agy credit is unknown because no reliable local credit source is configured"],
          },
        },
        nodes: [],
        limitations: ["token usage is best-effort from transcripts where available"],
      }),
    );
  }

  if (p === "/api/boards") {
    const scoped = (init?.headers as Record<string, string> | undefined)?.["X-Grove-Project"];
    if (scoped === SOLO_PROJECT) {
      return Promise.resolve(json([{ id: "solo-x", name: "Solo", task_count: 1 }]));
    }
    return Promise.resolve(json(BOARDS));
  }

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
      // Full record of the last task POST so verify can assert the delegate
      // contract (assignee + status "ready" + optional body) precisely.
      diag.lastTaskPost = {
        board,
        title: created.title,
        assignee: created.assignee ?? "",
        status: created.status,
        hasBody: Boolean(created.body),
      };
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
    const proj = hdrs?.["X-Grove-Project"] ?? "";
    diag.projectHeader = proj;
    return Promise.resolve(json(proj === SOLO_PROJECT ? buildSoloOrg() : buildOrg()));
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
    const proj = (init?.headers as Record<string, string> | undefined)?.["X-Grove-Project"];
    if (proj === SOLO_PROJECT) return Promise.resolve(json(SOLO_NODES.map(basicNode)));
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
    const reqBody = (init?.body ? JSON.parse(init.body as string) : {}) as { kind?: string; pane_id?: string };
    diag.wsTicketKind = reqBody.kind ?? "";
    const ticket = `mock-ticket-${++ticketSeq}`;
    ticketBindings[ticket] = {
      kind: reqBody.kind ?? "",
      pane: reqBody.pane_id ?? "",
      project: (hdrs?.["X-Grove-Project"] ?? "") as string,
    };
    return Promise.resolve(json({ ticket, ttl_seconds: 30 }));
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

// The board / terminal sockets currently held open by the SPA. Live controls
// push events or simulate server-side closes through these refs to exercise the
// client's reload / reconnect / close-code paths.
let boardSocket: MockWS | null = null;
let termSocket: MockWS | null = null;

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
  private ticket = "";

  constructor(url: string) {
    this.url = url;
    // Parse without `new URL` — the mock's file:// origin yields empty-host WS
    // URLs (ws:///ws/board?…) that `new URL` rejects.
    const [pathPart = "", queryPart = ""] = url.split("?");
    const params = new URLSearchParams(queryPart);
    this.pane = params.get("pane_id") ?? "";
    this.ticket = params.get("ticket") ?? "";
    this.kind = pathPart.includes("/ws/terminal")
      ? "term"
      : pathPart.includes("/ws/board")
        ? "board"
        : "other";
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
    // Backend mirror: a ticket is bound to a kind (+ pane for terminals). Reject
    // (1008) when the socket's endpoint/pane doesn't match the ticket binding,
    // so verify catches the FE sending a board ticket to /ws/terminal etc.
    const endpointKind = this.kind === "term" ? "terminal" : this.kind === "board" ? "board" : "";
    const binding = ticketBindings[this.ticket];
    const valid =
      this.kind === "other" ||
      (!!binding && binding.kind === endpointKind && (this.kind !== "term" || binding.pane === this.pane));
    if (!valid) {
      this.readyState = 3;
      diag.wsRejected = ((diag.wsRejected as number) ?? 0) + 1;
      this.onclose?.({ code: 1008 });
      return;
    }

    this.readyState = 1;
    this.onopen?.({});
    if (this.kind === "term") {
      diag.terminalWsUrl = this.url;
      diag.terminalTicketKind = binding!.kind;
      diag.terminalWsConnects = ((diag.terminalWsConnects as number) ?? 0) + 1;
      termSocket = this;
      // Backend sends a full snapshot on change; emit one periodically.
      this.emitSnapshot();
      this.timer = setInterval(() => this.emitSnapshot(), 700);
    } else if (this.kind === "board") {
      diag.boardWsConnected = true;
      diag.boardWsTicket = this.ticket;
      diag.boardWsConnects = ((diag.boardWsConnects as number) ?? 0) + 1;
      boardSocket = this;
      setTimeout(() => this.emit(JSON.stringify({ cursor: 1, type: "task.updated", task_id: "G-1" })), 800);
    }
  }

  emitBoard(payload: unknown) {
    this.emit(JSON.stringify(payload));
  }

  // Simulate a server-initiated close with a specific code (4401 auth-reject,
  // 1008 pane-unavailable, 1006 abnormal) so the SPA's close-code handling and
  // reconnect/backoff paths can be exercised without our own teardown guard.
  simulateClose(code: number) {
    this.readyState = 3;
    if (this.timer) clearInterval(this.timer);
    if (boardSocket === this) boardSocket = null;
    if (termSocket === this) termSocket = null;
    this.onclose?.({ code });
  }

  send(_data: string) {
    /* read-only viewer */
  }

  close() {
    this.readyState = 3;
    if (this.timer) clearInterval(this.timer);
    if (boardSocket === this) boardSocket = null;
    if (termSocket === this) termSocket = null;
    this.onclose?.({ code: 1000 });
  }
}

// --- board-live controls for the verifier -----------------------------------
// claim/complete mutate a task's status AND push the matching board event, so
// the SPA reloads the board snapshot and the card moves to its new column —
// exactly the production claim->running->done flow over the event-tail.
let boardEventSeq = 1;
function pushBoardEvent(taskId: string, type: string): void {
  boardSocket?.emitBoard({ cursor: ++boardEventSeq, type, task_id: taskId });
}
function mutateTaskStatus(id: string, status: string): boolean {
  const task = findTask(id);
  if (!task) return false;
  task.status = status;
  return true;
}
diag.claimTask = (id: string): boolean => {
  const ok = mutateTaskStatus(id, "running");
  if (ok) pushBoardEvent(id, "task.claimed");
  return ok;
};
diag.completeTask = (id: string): boolean => {
  const ok = mutateTaskStatus(id, "done");
  if (ok) pushBoardEvent(id, "task.completed");
  return ok;
};
// Mutate a task's status WITHOUT emitting an event — used to prove the board's
// onopen catch-up reload (a forced reconnect must surface the silent change).
diag.silentSetStatus = (id: string, status: string): boolean => mutateTaskStatus(id, status);
// Force a server-side close on the live board / terminal socket.
diag.closeBoard = (code: number): boolean => {
  const s = boardSocket;
  boardSocket = null;
  if (!s) return false;
  s.simulateClose(code);
  return true;
};
diag.closeTerminal = (code: number): boolean => {
  const s = termSocket;
  termSocket = null;
  if (!s) return false;
  s.simulateClose(code);
  return true;
};

window.WebSocket = MockWS as unknown as typeof WebSocket;
