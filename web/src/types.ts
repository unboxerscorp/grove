// Wire types — the contract the grove web server implements (mocked in mock/).

export interface Board {
  id: string;
  name: string;
  task_count?: number;
}

export interface Task {
  id: string;
  title: string;
  status: string;
  assignee?: string;
  tenant?: string;
  body?: string;
  updated?: string | number;
  latest_summary?: string;
}

export interface Comment {
  id: string | number;
  author?: string;
  body: string;
  ts?: string | number;
}

export interface Run {
  id: string;
  status?: string;
  node?: string;
  started?: string | number;
  ended?: string | number;
  summary?: string;
}

export interface GroveNode {
  name: string;
  agent: string;
  tmux_pane: string;
  session_id: string;
  status: string;
}

export interface OrgNode extends GroveNode {
  role?: string;
  parent?: string | null;
  children?: string[];
  group?: string;
}

export interface Org {
  nodes: OrgNode[];
  roots: string[];
  groups?: Record<string, string[]> | string[];
  children?: Record<string, string[]>;
}

export interface WsTicket {
  ticket: string;
  ttl_seconds: number;
}

/** One streamed chunk of a tmux pane. bytes_base64 decodes to raw UTF-8 bytes. */
export interface TerminalFrame {
  seq: number;
  pane_id: string;
  bytes_base64: string;
  ts: number;
}

/** Board event-tail message; cursor advances the client's tail position. */
export interface BoardEvent {
  cursor?: number;
  type?: string;
  task_id?: string;
}
