// REST + WebSocket client for the grove web server.
//
// REST is authenticated with the X-Grove-Session-Token header (token injected
// into the page as window.__GROVE_SESSION_TOKEN__). WebSockets can't carry that
// header on upgrade, so every WS connect first POSTs /api/ws-ticket for a
// short-lived single-use ticket and connects with ?ticket=.

import type { Board, Comment, GroveNode, Org, OrgNode, Run, Task, WsTicket } from "./types";

export interface NewTask {
  title: string;
  body?: string;
  assignee?: string;
  status?: string;
  priority?: string;
}

export interface NewNode {
  name: string;
  agent: string;
  role?: string;
  parent?: string;
  group?: string;
  description?: string;
  window?: number;
}

export interface AuthTool {
  tool: string; // codex | claude | antigravity | gh | cf
  label: string;
  authed: boolean;
  detail?: string;
  login_hint?: string;
}

// Mirrors web_app.py _node_liveness_summary: the backend already classifies
// every node, so `idle` and `error` are authoritative — never derive them.
export interface NodeSummary {
  total: number;
  running: number;
  stale: number;
  idle: number;
  error: number;
}

// Mirrors web_app.py _node_status_details: source is always "registry"; the
// estimate signal lives in `confidence` ("explicit" | "inferred"), NOT source.
export interface NodeDetail {
  name: string;
  status: string; // running | idle | error | blocked | dead
  last_seen?: number | null; // epoch seconds
  status_reason?: string;
  source?: string; // "registry"
  confidence?: string; // "explicit" | "inferred"
}

export interface StatusSummary {
  project?: string;
  nodes?: NodeSummary;
  node_details?: NodeDetail[]; // present when ?detail=1
}

// web_app.py _audit_event_payload returns `actor` and `target` as objects
// (store.py _node_actor / target dicts). Both may also be a bare string in
// other event sources, so the FE accepts the union and labels defensively.
export type AuditActor = string | { kind?: string; id?: string; login?: string; role?: string };
export type AuditTarget =
  | string
  | { type?: string; id?: string; node?: string; task?: string; label?: string };

export interface AuditEvent {
  cursor?: number;
  id?: string;
  actor: AuditActor;
  action: string;
  target: AuditTarget;
  ts: string | number; // created_at (epoch seconds)
  task_id?: string | null;
  from_node?: string | null;
  to_node?: string | null;
}

/** Display label for an audit actor ({kind,id,login} → login/id) or a string. */
export function actorLabel(actor: AuditActor): string {
  if (typeof actor === "string") return actor;
  if (!actor) return "";
  return actor.login ?? actor.id ?? actor.kind ?? "";
}

/** The node identity of an actor (delegation edge source); null if not a node. */
export function actorId(actor: AuditActor): string | null {
  if (typeof actor === "string") return actor;
  if (!actor) return null;
  return actor.id ?? actor.login ?? null;
}

/** Human-readable label for an audit target (drawer display). */
export function targetLabel(target: AuditTarget): string {
  if (typeof target === "string") return target;
  if (!target) return "";
  return target.label ?? target.task ?? target.id ?? target.node ?? "";
}

/** The node an event delegates/assigns to, if any (delegation edge endpoint). */
export function targetNode(target: AuditTarget): string | null {
  if (!target || typeof target === "string") return null;
  return target.node ?? null;
}

// web_app.py audit_endpoint returns `items` + a numeric `next_cursor` that is
// always present (= last item's cursor). End-of-list is therefore detected by a
// short page (items.length < limit), NOT by a null cursor.
export interface AuditPage {
  items: AuditEvent[];
  next_cursor?: number;
}

export interface Health {
  ok: boolean;
  board_ok?: boolean;
}

export interface NodePatch {
  parent?: string | null;
  group?: string | null;
}

export interface SlackConfig {
  app_token?: string;
  bot_token?: string;
  default_channel?: string;
  default_node?: string;
}

export interface SlackStatus {
  status: string; // not_configured | tokens_saved | bot_auth_ok | socket_connected
  last_event_at?: string | number | null;
  last_error?: string | null;
}

// Mirrors web_app.py _cost_metric: every number carries provenance so estimates
// are never shown as hard facts. `value` is null when the backend can't
// determine it (e.g. agy credit_remaining) — rendered "unknown", never
// back-filled. `source` ∈ registry|run_metadata|transcript|estimate|none|mixed,
// `confidence` ∈ explicit|partial|unknown.
export interface CostMetric {
  value: number | null;
  source: string;
  confidence: string;
  status?: string; // "unknown"
}

// web_app.py _cost_by_agent item. Tokens live in `total_tokens`, money in
// `cost_usd_estimate`. agy adds credit_remaining + credit_status + warnings.
export interface CostAgentMetrics {
  nodes?: CostMetric;
  turns?: CostMetric;
  input_tokens?: CostMetric;
  output_tokens?: CostMetric;
  total_tokens: CostMetric;
  cost_usd_estimate: CostMetric;
  confidence?: string;
  credit_remaining?: CostMetric;
  credit_status?: string;
  warnings?: string[];
}

export interface CostSummary {
  project?: string;
  totals?: {
    total_tokens: CostMetric;
    cost_usd_estimate: CostMetric;
    [k: string]: unknown;
  };
  by_agent: Record<string, CostAgentMetrics>;
}

// Decision inbox (web_app.py _inbox_item_payload). A blocked / ask-human task
// awaiting a human decision. `answer.endpoint` is the POST target that comments
// + unblocks the task (operator/admin; team viewers get 403).
export interface InboxAnswer {
  endpoint: string;
  method?: string;
  slack_thread_reply?: boolean;
  note?: string;
}

export interface InboxItem {
  id: string;
  type: string; // "ask_human" | "blocked_task"
  task_id: string;
  title: string;
  body?: string | null;
  status?: string;
  assignee?: string | null;
  node?: string | null;
  blocked_reason?: string | null;
  blocked_since?: number; // epoch seconds
  waiting_seconds?: number;
  needs_human?: boolean;
  sources?: string[];
  answer?: InboxAnswer;
}

export interface InboxPage {
  project?: string;
  items: InboxItem[];
  next_cursor?: number | null;
  total?: number;
}

// Presence (web_app.py _presence_payload). Team-auth → viewers carry {name,role}
// only (no id/secret); local-token → a single {kind:"anonymous",count} + an
// anonymous_count. The FE renders members as chips or "anonymous N".
export interface PresenceViewer {
  name?: string;
  role?: string;
  kind?: string; // "anonymous"
  count?: number;
}

export interface Presence {
  project?: string;
  auth_mode?: string;
  active_window_seconds?: number;
  viewers: PresenceViewer[];
  anonymous_count?: number;
}

export interface Project {
  name: string; // = session
  workspace: string;
  node_count: number;
  status: string;
}

export interface NewProject {
  name: string;
  template?: string;
  clone?: string;
}

export interface LoadResult {
  restored: string[];
  stale: string[];
  fresh: string[];
  ok: boolean;
  name?: string;
}

const TOKEN = window.__GROVE_SESSION_TOKEN__ ?? "";
export const AUTH_REQUIRED = window.__GROVE_AUTH_REQUIRED__ ?? false;
const SESSION_HEADER = "X-Grove-Session-Token";
const PROJECT_HEADER = "X-Grove-Project";

// The active project (= grove session). All REST calls carry it as a header so
// the backend scopes org/boards/nodes to the selected project.
let currentProject = "";
export function setProject(name: string): void {
  currentProject = name;
}

function headers(extra?: Record<string, string>): Record<string, string> {
  const base: Record<string, string> = {};
  if (TOKEN) base[SESSION_HEADER] = TOKEN;
  if (currentProject) base[PROJECT_HEADER] = currentProject;
  return { ...base, ...(extra ?? {}) };
}

async function getJSON<T>(path: string): Promise<T> {
  const res = await fetch(path, { headers: headers(), credentials: "same-origin" });
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return (await res.json()) as T;
}

function enc(s: string): string {
  return encodeURIComponent(s);
}

export const api = {
  listBoards: () => getJSON<Board[]>("/api/boards"),

  listTasks: (boardId: string, filters?: { status?: string; assignee?: string }) => {
    const q = new URLSearchParams();
    if (filters?.status) q.set("status", filters.status);
    if (filters?.assignee) q.set("assignee", filters.assignee);
    const qs = q.toString();
    return getJSON<Task[]>(`/api/boards/${enc(boardId)}/tasks${qs ? `?${qs}` : ""}`);
  },

  async createTask(boardId: string, payload: NewTask): Promise<Task> {
    const res = await fetch(`/api/boards/${enc(boardId)}/tasks`, {
      method: "POST",
      headers: headers({ "Content-Type": "application/json" }),
      credentials: "same-origin",
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error(`create task: HTTP ${res.status}`);
    return (await res.json()) as Task;
  },

  // Web equivalent of `grove delegate`: hand a node a task by creating a board
  // task assigned to it. Reuses POST /api/boards/{board}/tasks (project-scoped
  // via the X-Grove-Project header on the shared client); status defaults to
  // "ready" so the assignee can pick it up. The backend records audit.task.assign.
  delegate(boardId: string, node: string, payload: { title: string; body?: string }): Promise<Task> {
    return api.createTask(boardId, {
      title: payload.title,
      body: payload.body,
      assignee: node,
      status: "ready",
    });
  },

  getTask: (id: string) => getJSON<Task>(`/api/tasks/${enc(id)}`),
  getComments: (id: string) => getJSON<Comment[]>(`/api/tasks/${enc(id)}/comments`),
  getRuns: (id: string) => getJSON<Run[]>(`/api/tasks/${enc(id)}/runs`),

  listNodes: () => getJSON<GroveNode[]>("/api/nodes"),

  getOrg: () => getJSON<Org>("/api/org"),

  async createNode(payload: NewNode): Promise<OrgNode> {
    const res = await fetch("/api/nodes", {
      method: "POST",
      headers: headers({ "Content-Type": "application/json" }),
      credentials: "same-origin",
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      let detail = `HTTP ${res.status}`;
      try {
        const j = (await res.json()) as { detail?: string };
        if (j.detail) detail = j.detail;
      } catch {
        /* non-JSON error body */
      }
      throw new Error(detail);
    }
    return (await res.json()) as OrgNode;
  },

  async patchNode(name: string, patch: NodePatch): Promise<OrgNode> {
    const res = await fetch(`/api/nodes/${enc(name)}`, {
      method: "PATCH",
      headers: headers({ "Content-Type": "application/json" }),
      credentials: "same-origin",
      body: JSON.stringify(patch),
    });
    if (!res.ok) {
      let detail = `HTTP ${res.status}`;
      try {
        const j = (await res.json()) as { detail?: string };
        if (j.detail) detail = j.detail;
      } catch {
        /* non-JSON error body */
      }
      throw new Error(detail);
    }
    return (await res.json()) as OrgNode;
  },

  // Live status: project + node liveness summary; detail=1 adds per-node rows.
  getStatus: (detail = false) => getJSON<StatusSummary>(`/api/status${detail ? "?detail=1" : ""}`),

  // Read-only audit log (cursor-paged; filter by action/node/task_id).
  getAudit: (params: { cursor?: string | number; limit?: number; action?: string; node?: string; task_id?: string } = {}) => {
    const q = new URLSearchParams();
    if (params.cursor !== undefined && params.cursor !== "") q.set("cursor", String(params.cursor));
    if (params.limit) q.set("limit", String(params.limit));
    if (params.action) q.set("action", params.action);
    if (params.node) q.set("node", params.node);
    if (params.task_id) q.set("task_id", params.task_id);
    const qs = q.toString();
    return getJSON<AuditPage>(`/api/audit${qs ? `?${qs}` : ""}`);
  },

  // Server liveness (unauthenticated; the extra headers are harmless).
  getHealth: () => getJSON<Health>("/api/health"),

  // Dev-tool auth status.
  getAuthStatus: () => getJSON<AuthTool[]>("/api/auth-status"),

  // Cost/credit usage (project-scoped; 403 for team viewers). Per-agent token +
  // cost metrics carry source/confidence; agy credit may be unknown.
  getCost: () => getJSON<CostSummary>("/api/cost"),

  // Presence: who's viewing this project (name/role for team auth; anonymous
  // count for local-token). Project-scoped via headers.
  getPresence: () => getJSON<Presence>("/api/presence"),

  // Decision inbox: blocked + ask-human tasks awaiting a human (project-scoped).
  getInbox: (params: { cursor?: number; limit?: number } = {}) => {
    const q = new URLSearchParams();
    if (params.cursor !== undefined) q.set("cursor", String(params.cursor));
    if (params.limit) q.set("limit", String(params.limit));
    const qs = q.toString();
    return getJSON<InboxPage>(`/api/inbox${qs ? `?${qs}` : ""}`);
  },

  // Answer a blocked/ask-human task: POSTs to the item's answer.endpoint
  // (/api/tasks/{id}/answer) which comments + unblocks. 403 for team viewers.
  async answerTask(endpoint: string, text: string): Promise<{ ok?: boolean }> {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: headers({ "Content-Type": "application/json" }),
      credentials: "same-origin",
      body: JSON.stringify({ text }),
    });
    if (!res.ok) throw new Error(`answer: HTTP ${res.status}`);
    return (await res.json()) as { ok?: boolean };
  },

  // Projects (= sessions).
  listProjects: () => getJSON<Project[]>("/api/projects"),

  async createProject(body: NewProject): Promise<Project> {
    const res = await fetch("/api/projects", {
      method: "POST",
      headers: headers({ "Content-Type": "application/json" }),
      credentials: "same-origin",
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`/api/projects: HTTP ${res.status}`);
    return (await res.json()) as Project;
  },

  async loadProject(path: string): Promise<LoadResult> {
    const res = await fetch("/api/projects/load", {
      method: "POST",
      headers: headers({ "Content-Type": "application/json" }),
      credentials: "same-origin",
      body: JSON.stringify({ path }),
    });
    if (!res.ok) throw new Error(`/api/projects/load: HTTP ${res.status}`);
    return (await res.json()) as LoadResult;
  },

  // Slack integration. The manifest is a file download, so this returns the raw
  // Response (the caller turns it into a blob + download).
  slackManifest: () =>
    fetch("/api/slack/manifest", { headers: headers(), credentials: "same-origin" }),

  getSlackStatus: () => getJSON<SlackStatus>("/api/slack/config/status"),

  async saveSlackConfig(cfg: SlackConfig): Promise<SlackStatus> {
    const res = await fetch("/api/slack/config", {
      method: "POST",
      headers: headers({ "Content-Type": "application/json" }),
      credentials: "same-origin",
      body: JSON.stringify(cfg),
    });
    if (!res.ok) throw new Error(`/api/slack/config: HTTP ${res.status}`);
    return (await res.json()) as SlackStatus;
  },

  async testSlack(): Promise<SlackStatus> {
    const res = await fetch("/api/slack/test", {
      method: "POST",
      headers: headers(),
      credentials: "same-origin",
    });
    if (!res.ok) throw new Error(`/api/slack/test: HTTP ${res.status}`);
    return (await res.json()) as SlackStatus;
  },

  // Mint a single-use ws-ticket bound to the active project AND the requested
  // WS kind (+ pane for terminals). The backend rejects (1008) a terminal/board
  // WS whose ticket kind/pane doesn't match, so the ticket must be requested for
  // the exact socket it will be used on.
  async wsTicket(req: { kind: "terminal" | "board"; pane_id?: string }): Promise<WsTicket> {
    const res = await fetch("/api/ws-ticket", {
      method: "POST",
      headers: headers({ "Content-Type": "application/json" }),
      credentials: "same-origin",
      body: JSON.stringify(req),
    });
    if (!res.ok) throw new Error(`/api/ws-ticket: HTTP ${res.status}`);
    return (await res.json()) as WsTicket;
  },
};

export function wsUrl(path: string, params: Record<string, string>): string {
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${window.location.host}${path}?${new URLSearchParams(params)}`;
}

/** Decode a base64 frame payload to its raw bytes (xterm decodes the UTF-8). */
export function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return arr;
}
