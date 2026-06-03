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

export interface NodeSummary {
  running: number;
  total: number;
  stale: number;
}

export interface StatusSummary {
  project?: string;
  nodes?: NodeSummary;
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

  // Live status: project + node liveness summary (token-scoped via headers()).
  getStatus: () => getJSON<StatusSummary>("/api/status"),

  // Server liveness (unauthenticated; the extra headers are harmless).
  getHealth: () => getJSON<Health>("/api/health"),

  // Dev-tool auth status.
  getAuthStatus: () => getJSON<AuthTool[]>("/api/auth-status"),

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
