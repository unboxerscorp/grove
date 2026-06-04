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
  role?: string;
  parent?: string | null;
  children?: string[];
  group?: string;
  description?: string;
  // v1.28 backend-authoritative access flags (web_app.py NodeRecord). The lead
  // pane (window.pane == 0.0) is terminal_allowed:true but input_allowed:false;
  // meta / no-pane nodes are neither. Optional — older payloads omit them, so the
  // FE treats `undefined`/`true` as allowed and only `=== false` as blocked.
  terminal_allowed?: boolean;
  input_allowed?: boolean;
  exposed?: boolean;
  unavailable_reason?: string;
}

export interface OrgNode extends GroveNode {
  role?: string;
  parent?: string | null;
  children?: string[];
  group?: string;
  description?: string;
}

// One selectable task assignee (web_app.py _assignee_candidate_payload): a
// project node or the lead/orchestrator. `default` marks the project-master.
export interface AssigneeCandidate {
  name: string;
  agent?: string;
  role?: string;
  status?: string;
  default?: boolean;
}

export interface Org {
  nodes: OrgNode[];
  roots: string[];
  groups?: Record<string, string[]> | string[];
  children?: Record<string, string[]>;
  // v1.27: candidate assignees + the default (project-master) for task creation.
  default_assignee?: string;
  assignee_candidates?: AssigneeCandidate[];
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

export type GuiFeatureKey =
  | "quota"
  | "intake"
  | "node-input"
  | "digest"
  | "summary"
  | "handoff"
  | "usage-trend"
  | "retro-analytics";

export interface GuiFeatureState {
  enabled: boolean;
  configured: boolean;
  source: "default" | "cli" | "config" | "gui";
}

export interface GuiFeatures {
  project?: string;
  features: Record<GuiFeatureKey, GuiFeatureState>;
}

export interface GuiFeatureUpdate {
  ok: boolean;
  project?: string;
  key: GuiFeatureKey;
  feature: GuiFeatureState;
  features: Record<GuiFeatureKey, GuiFeatureState>;
}
