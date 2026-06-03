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
  window?: number;
}

export interface NodePatch {
  parent?: string | null;
  group?: string | null;
}

const TOKEN = window.__GROVE_SESSION_TOKEN__ ?? "";
export const AUTH_REQUIRED = window.__GROVE_AUTH_REQUIRED__ ?? false;
const SESSION_HEADER = "X-Grove-Session-Token";

function headers(extra?: Record<string, string>): Record<string, string> {
  const base: Record<string, string> = {};
  if (TOKEN) base[SESSION_HEADER] = TOKEN;
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

  async wsTicket(): Promise<WsTicket> {
    const res = await fetch("/api/ws-ticket", {
      method: "POST",
      headers: headers(),
      credentials: "same-origin",
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
