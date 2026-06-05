// Wire types — the contract the grove web server implements (mocked in mock/).

export interface Board {
  id: string;
  name: string;
  task_count?: number;
}

export interface Task {
  id: string;
  title: string;
  status: string; // RAW backend status (e.g. "running") — canonicalize via workflow aliases
  needs_human?: boolean;
  assignee?: string;
  reviewer?: string; // v1.29 per-task reviewer (web_app.py Task.reviewer)
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

export type NodeHealthStatus =
  | "healthy"
  | "rate_limited"
  | "login_required"
  | "crashed"
  | "cooldown"
  | "hung"
  | "unknown";

export interface NodeHealth {
  node: string;
  status: NodeHealthStatus;
  reason?: string | null;
  message?: string | null;
  detected_at?: number;
  reset_at?: number | null;
  source?: string;
  project?: string;
  session?: string;
  updated_at?: number;
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
  health?: NodeHealth;
}

export interface OrgNode extends GroveNode {
  role?: string;
  parent?: string | null;
  children?: string[];
  group?: string;
  description?: string;
}

// One selectable task assignee (web_app.py _assignee_candidate_payload): a
// project node or lead/orchestrator. `default` marks the default node.
export interface AssigneeCandidate {
  name: string;
  agent?: string;
  role?: string;
  status?: string;
  default?: boolean;
  human?: boolean;
  reviewer?: boolean;
  inbox?: {
    endpoint?: string;
    answer_endpoint?: string;
    route?: string;
  };
}

export interface MasterOrg {
  name: string;
  scope: string;
  selected_project: string;
  visible_projects: string[];
  project_master: {
    name: string;
    present: boolean;
    default_assignee: boolean;
  };
  delegation: {
    default_assignee: string;
    create_task_endpoint: string;
    watch_endpoint: string;
    watch_ticket_endpoint: string;
    watch_ticket_kind: string;
  };
  human: {
    assignee_candidates: string[];
    reviewers: string[];
    inbox_endpoint: string;
    answer_endpoint: string;
  };
}

// v1.29 board workflow (web_app.py _workflow_payload). canonical_statuses +
// columns drive the board; aliases map raw stored statuses (e.g. "claimed") onto
// canonical keys (e.g. "running"). Done is always visible.
export interface WorkflowColumn {
  key: string; // canonical column key
  status: string;
  stored_status?: string;
  label: string;
  raw_statuses: string[];
  aliases: string[];
  virtual?: boolean;
  source?: string;
}
export interface WorkflowTransition {
  from: string;
  to: string;
  requires_reason?: boolean;
}
export interface BoardWorkflow {
  project?: string;
  board?: string;
  done_visible?: boolean;
  canonical_statuses: string[];
  columns: WorkflowColumn[];
  labels?: Record<string, string>;
  aliases?: Record<string, string>;
  allowed_transitions?: WorkflowTransition[];
  manual_transition?: { endpoint?: string; method?: string; body?: Record<string, unknown> };
}

// v1.29 cross-project org metadata (web_app.py _org_payload additions).
export interface ProjectMeta {
  name: string; // internal name (e.g. "dev10")
  board: string;
  display_name: string; // human label (e.g. "grove-dev")
}
export interface MasterMeta {
  id: string;
  name: string; // "GROVE MASTER"
  label: string;
  kind: string; // "master"
  role?: string;
  root?: boolean;
  current_project?: string;
  chat_target?: { endpoint?: string; origin_surface?: string; project?: string };
}
export interface ProjectLead {
  id: string;
  name: string; // "lead"
  label: string; // display_name
  project: string;
  display_name: string;
  status?: string;
  node_count?: number;
  current: boolean;
  switch_target: string;
  click_action?: { type?: string; project?: string };
  chat_target?: { endpoint?: string; origin_surface?: string; project?: string };
}
export interface DelegationEdge {
  from: string;
  to: string;
  kind: string; // implementation | review_pool | review_claim
  task_ids?: string[];
  count?: number;
  latest_assigned_at?: number;
  oldest_open_updated_at?: number;
  stale?: boolean;
  label?: string;
}
export interface DelegationHistoryItem {
  event_id?: string;
  cursor?: number;
  action?: string;
  from?: string;
  to?: string;
  ts?: number;
  label?: string;
}
export interface Delegations {
  current: DelegationEdge[];
  history: DelegationHistoryItem[];
  mode_labels?: { current?: string; history?: string };
}

export interface Org {
  nodes: OrgNode[];
  roots: string[];
  groups?: Record<string, string[]> | string[];
  children?: Record<string, string[]>;
  // v1.27: candidate assignees + the default node for task creation.
  default_assignee?: string;
  assignee_candidates?: AssigneeCandidate[];
  master_org?: MasterOrg;
  // v1.29 orch-product additions.
  project?: ProjectMeta;
  master?: MasterMeta;
  project_leads?: ProjectLead[];
  reviewer_candidates?: AssigneeCandidate[];
  delegations?: Delegations;
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
