// REST + WebSocket client for the grove web server.
//
// REST is authenticated with the X-Grove-Session-Token header (token injected
// into the page as window.__GROVE_SESSION_TOKEN__). WebSockets can't carry that
// header on upgrade, so every WS connect first POSTs /api/ws-ticket for a
// short-lived single-use ticket and connects with ?ticket=.

import type {
  Board,
  BoardWorkflow,
  Comment,
  GroveNode,
  GuiFeatureKey,
  GuiFeatureUpdate,
  GuiFeatures,
  NodeHealth,
  Org,
  OrgNode,
  Run,
  Task,
  WsTicket,
} from "./types";

export type { NodeHealth, NodeHealthStatus } from "./types";

// Canonical FE status keys (v1.29). The canonical "in progress" key is "running"
// — matching the backend's stored vocabulary (grove-py) so the FE and bridge
// agree on one word. The board groups + transitions use these keys directly.
export const CANONICAL_STATUSES = ["ready", "running", "review", "blocked", "ask_human", "done"] as const;

// Mirrors web_app.py WORKFLOW_ALIASES. Used as a fallback when the live workflow
// payload is unavailable; otherwise prefer the workflow's own alias map. "running"
// is canonical, so only legacy/other raw spellings need mapping onto it.
const WORKFLOW_ALIASES: Record<string, string> = {
  in_progress: "running",
  claimed: "running",
  executing: "running",
  complete: "done",
  completed: "done",
  "ask-human": "ask_human",
  ask_human_pending: "ask_human",
};

/** Map a raw backend task status to its canonical workflow key (e.g. claimed →
 *  running). Prefers the live workflow's alias/column map; falls back to the
 *  static alias table. Unknown statuses pass through unchanged. */
export function canonicalStatus(raw: string | undefined, workflow?: BoardWorkflow | null): string {
  const s = (raw ?? "").trim().toLowerCase().replace(/-/g, "_");
  if (!s) return "ready";
  if (workflow) {
    if (workflow.aliases && s in workflow.aliases) return workflow.aliases[s]!;
    for (const col of workflow.columns ?? []) {
      if (col.key === s) return col.key;
      if ((col.raw_statuses ?? []).map((r) => r.replace(/-/g, "_")).includes(s)) return col.key;
    }
  }
  return WORKFLOW_ALIASES[s] ?? s;
}

export interface NewTask {
  title: string;
  body?: string;
  assignee?: string;
  reviewer?: string; // v1.29 optional per-task reviewer
  status?: string;
  priority?: number | string;
}

// The backend TaskCreatePayload requires `priority: int` (default 0) and a
// non-empty `status` — a string priority like "normal" or a null/empty status is
// the direct cause of a 422. Normalize both before POSTing so every caller is safe.
const PRIORITY_LEVELS: Record<string, number> = { low: -10, normal: 0, high: 10 };
function normalizePriority(value: number | string | undefined | null): number {
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === "string") {
    const s = value.trim();
    if (/^[+-]?\d+$/.test(s)) return parseInt(s, 10);
    if (s in PRIORITY_LEVELS) return PRIORITY_LEVELS[s]!;
  }
  return 0; // default — never null/undefined/""
}
function normalizeStatus(value: string | undefined | null): string {
  return typeof value === "string" && value.trim() ? value.trim() : "ready";
}

export interface NewNode {
  name: string;
  agent: string;
  role?: string;
  // Preset key (e.g. "maker-fe"); the backend re-expands it server-side and
  // passes `--role-preset`. Sent on the wire as snake_case `role_preset`.
  rolePreset?: string;
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

// web_app.py /api/me: the current viewer's role (member is null in local-token
// mode = operator-equivalent). Used to proactively lock controls for viewers.
export interface MeInfo {
  auth_mode?: string;
  member?: { id?: string; name?: string; role?: string } | null;
  csrf?: string | null;
}

// Execution loop (web_app.py). The execution gate + per-node execution flag are
// SEPARATE from autopickup. A task moves claimed→preflight→approval-pending→
// executing→verify→complete (+abort/rollback); approval is an explicit human act.
export interface ExecutionGate {
  project?: string;
  enabled: boolean;
  kill_switch: boolean;
  board_enabled: boolean;
  board_kill_switch: boolean;
}

export interface NodeExecutionState {
  project?: string;
  node: string;
  enabled: boolean;
  configured?: boolean;
  kill_switch: boolean;
  global_enabled: boolean;
  global_kill_switch: boolean;
  board_enabled: boolean;
  board_kill_switch: boolean;
}

// 4-level gate evaluation for a task (global/board/node/task).
export interface ExecutionGateInfo {
  allowed: boolean;
  blocked_by: string[];
  global_enabled: boolean;
  global_kill_switch: boolean;
  board_enabled: boolean;
  board_kill_switch: boolean;
  node_enabled: boolean;
  node_kill_switch: boolean;
  task_kill_switch: boolean;
}

export interface TaskExecution {
  project?: string;
  task_id: string;
  node?: string;
  state: string; // none | claimed | preflight | approval-pending | executing | verify | complete | aborted | ...
  approved: boolean;
  gate: ExecutionGateInfo;
  execution?: Record<string, unknown>;
}

// web_app.py _node_autopickup_payload: the REAL per-node autonomous-pickup
// config (distinct from the audit-inferred ⚡ badge). Enabling is gated by the
// global switch — POST returns 409 when global_enabled is false / kill-switch on.
export interface AutopickupState {
  project?: string;
  node: string;
  enabled: boolean;
  configured?: boolean;
  global_enabled: boolean;
  global_kill_switch: boolean;
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
  type?: string; // event kind, e.g. "audit.execution.approve"
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

export interface NodeHealthResponse {
  project?: string;
  session?: string;
  nodes?: NodeHealth[];
}

export interface NodePatch {
  parent?: string | null;
  group?: string | null;
}

export interface NodeTerminateOptions {
  caller?: string;
  confirm?: boolean;
  confirmationId?: string;
  operatorOverride?: boolean;
}

export interface NodeTerminateResult {
  ok?: boolean;
  confirmed: boolean;
  confirmation_required?: boolean;
  requires_confirmation?: boolean;
  confirmation_id: string;
  node: string;
  caller?: string;
  operator_override?: boolean;
  subtree?: string[];
  result?: {
    session?: string;
    removed?: Array<{
      name: string;
      pane?: string;
      paneKilled?: boolean;
      paneMissing?: boolean;
    }>;
  };
}

// web_app.py _node_connect_payload: tmux attach/select-pane commands to connect
// to a node's pane (the "SSH/connect" string). 404 when the node has no pane.
export interface NodeConnect {
  project?: string;
  node: string;
  tmux_target: string;
  mode?: "local_tmux_attach" | "ssh_tmux_attach" | string;
  label?: string;
  commands: { attach: string; local_attach?: string; ssh_attach?: string; select_pane?: string };
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
  // v1.20 intent-triage intake (default OFF; operators toggle it in the Setup
  // panel — the "intake" gui-feature). Surfaced read-only here so the dashboard
  // can show whether free-form Slack messages become gated tasks.
  intake?: { enabled?: boolean };
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

// Usage rollup (web_app.py _usage_payload): node/day breakdown from run metadata.
// agy credit stays honestly unknown (never fabricated). Metrics reuse CostMetric.
export interface UsageTotals {
  runs: CostMetric;
  input_tokens: CostMetric;
  output_tokens: CostMetric;
  total_tokens: CostMetric;
  cost_usd_estimate: CostMetric;
  confidence?: string;
}

export interface UsageNode {
  node: string;
  agent: string;
  totals: UsageTotals;
  warnings?: string[];
  credit_remaining?: CostMetric;
  credit_status?: string;
  days?: { day: string; totals: UsageTotals }[];
}

export interface UsageDay {
  day: string;
  totals: UsageTotals;
  nodes: UsageNode[];
}

export interface UsageReport {
  project?: string;
  window?: { name?: string };
  totals: UsageTotals;
  nodes: UsageNode[];
  days: UsageDay[];
  limitations?: string[];
}

// Per-member ledger (web_app.py /api/ledger). Reuses UsageTotals (runs/tokens/
// cost as CostMetric — cost + agy credit stay honestly unknown, never invented).
// scope "self" (viewer = own only) vs "all" (operator). A SOFT quota only warns:
// `hard_kill` is always false and running tasks are never killed.
export interface LedgerMember {
  id: string;
  name?: string | null;
  role: string; // "viewer" | "operator" | "admin" | "unknown"
}

export interface QuotaSoftThrottle {
  active: boolean;
  action: string; // "queue-delay" | "none"
  reasons: string[]; // subset of ("runs"|"tokens"|"cost")
  hard_kill: boolean; // always false — soft throttle, never a kill
}

export interface QuotaState {
  configured: boolean;
  enabled: boolean;
  mode: string; // "soft"
  hard_kill: boolean; // false
  status: string; // "exceeded" | "ok" | "disabled"
  soft_throttle: QuotaSoftThrottle;
  soft_run_limit?: number;
  soft_token_limit?: number;
  soft_cost_usd?: number;
  updated_at?: number;
  cost_warning?: string;
}

export interface LedgerMemberRollup {
  member: LedgerMember;
  totals: UsageTotals;
  quota: QuotaState;
  warnings?: string[];
}

export interface HostPressure {
  status: string; // "saturated" | "nominal"
  running: CostMetric;
  capacity: CostMetric;
  ratio: CostMetric;
  load_1m?: CostMetric;
  blocked_tasks?: CostMetric;
}

export interface LedgerReport {
  project?: string;
  generated_at?: CostMetric;
  window?: { name?: string };
  scope: string; // "self" | "all"
  quota_enabled: boolean;
  members: LedgerMemberRollup[];
  host_pressure: HostPressure;
  limitations?: string[];
}

export interface QuotaUpdateBody {
  member_id: string;
  enabled?: boolean;
  soft_run_limit?: number | null;
  soft_token_limit?: number | null;
  soft_cost_usd?: number | null;
}

export interface QuotaUpdateResult {
  ok: boolean;
  project?: string;
  member: LedgerMember;
  quota: QuotaState;
}

// Retro analytics (web_app.py /api/retro/analytics). ADVISORY, READ-ONLY:
// operator-only, default OFF (404). `mode:"advisory"` + `actions:[]` — it never
// creates tasks or dispatches work. `confidence` is "low" for small samples; all
// metrics reuse CostMetric (agy credit stays honestly unknown, never invented).
export interface RetroThroughputBucket {
  bucket: string; // YYYY-MM-DD
  completed: CostMetric;
}
export interface RetroTheme {
  theme: string;
  count: CostMetric;
  keywords: string[];
}
export interface RetroBlockedAssignee {
  assignee: string;
  count: CostMetric;
}
export interface RetroPatterns {
  blocked: { current: CostMetric; by_assignee: RetroBlockedAssignee[]; blocked_runs: CostMetric };
  slow: { threshold_seconds: CostMetric; count: CostMetric; average_duration_seconds: CostMetric };
}
export interface RetroOutcomeItem {
  node?: string;
  role?: string;
  agent?: string;
  completed: CostMetric;
  blocked: CostMetric;
  failed: CostMetric;
  running: CostMetric;
  other: CostMetric;
}
export interface RetroOutcomes {
  by_node: RetroOutcomeItem[];
  by_role: RetroOutcomeItem[];
}
export interface RetroAnalytics {
  ok: boolean;
  project?: string;
  mode: string; // "advisory"
  actions: unknown[]; // always [] — advisory never acts
  generated_at?: CostMetric;
  window?: { name?: string };
  confidence: string; // "low" | "medium"
  sample: { completed_runs: CostMetric; retro_comments: CostMetric; blocked_tasks: CostMetric };
  throughput: RetroThroughputBucket[];
  themes: RetroTheme[];
  patterns: RetroPatterns;
  outcomes: RetroOutcomes;
  cost_signals: { agy_credit: CostMetric };
  limitations?: string[];
}

// Usage trend / anomaly (web_app.py /api/usage/trend). ADVISORY, READ-ONLY:
// operator-only, default OFF (404). `mode:"advisory"`, `actions:[]`,
// `enforcement.called:false` — anomaly flags are SIGNALS only (no throttle/abort).
// Forecast is a labelled extrapolation ("not a prediction"). agy cost is unknown
// across trend/anomaly/forecast/day totals (never treated as a spike).
//
// A trend signal is polymorphic: an object {latest,baseline,delta,ratio} when
// there are ≥2 daily values, otherwise a bare CostMetric (value null / unknown).
export interface TrendSignal {
  latest?: CostMetric;
  baseline?: CostMetric;
  delta?: CostMetric;
  ratio?: CostMetric;
  // bare-CostMetric form (thin data / agy-unknown):
  value?: number | null;
  source?: string;
  confidence?: string;
  status?: string;
}
export interface AnomalySignal {
  flagged: boolean;
  reason: string; // "spike" | "within baseline" | "insufficient baseline data" | "excluded: agy cost is unknown"
  confidence: string;
  latest?: CostMetric;
  baseline?: CostMetric;
  ratio?: CostMetric;
  zscore?: CostMetric;
}
export interface TrendNode {
  node: string;
  agent: string;
  confidence: string; // "low" | "medium"
  days: { day: string; totals: UsageTotals }[];
  trend: { total_tokens: TrendSignal; cost_usd_estimate: TrendSignal };
  anomaly: { total_tokens: AnomalySignal; cost_usd_estimate: AnomalySignal };
  forecast: { label: string; total_tokens_next_day: CostMetric; cost_usd_next_day: CostMetric };
  warnings?: string[];
}
export interface UsageTrendWindow {
  name?: string;
  days?: CostMetric;
  since?: CostMetric;
  until?: CostMetric;
}
export interface UsageTrend {
  ok: boolean;
  project?: string;
  mode: string; // "advisory"
  actions: unknown[]; // []
  enforcement: { called: boolean }; // {called:false} — signals never enforce
  generated_at?: CostMetric;
  window?: UsageTrendWindow;
  filters?: { member?: string | null };
  nodes: TrendNode[];
  limitations?: string[];
}

// Notification routing v2 (web_app.py /api/notifications/routing). Conditional
// rules + escalation. GET is readable by any member (read-only view); POST is
// operator-gated (403 for viewers). DRY-RUN by default (no real sends).
// `configured:false` = never set up (graceful empty). Targets carry only a
// channel_kind + room_id (backend-redacted; no secrets/PII).
export interface NotificationTarget {
  channel_kind: string;
  room_id: string;
}
export interface NotificationRule {
  name: string;
  event_type: string; // "*" | "blocked" | "ask_human_pending" | "anomaly"
  node?: string;
  severity?: string;
  target: NotificationTarget;
  escalation_targets: NotificationTarget[];
  max_escalations: number; // 0..5, bounded by escalation_targets length
  escalate_after_seconds?: number; // 0..86400
}
export interface NotificationRouting {
  configured: boolean;
  enabled: boolean;
  dry_run: boolean;
  rules: NotificationRule[];
}
export interface RoutingResponse {
  project?: string;
  routing: NotificationRouting;
}
export interface RoutingUpdateBody {
  enabled: boolean;
  dry_run: boolean;
  rules: NotificationRule[];
}
export interface RoutingUpdateResult {
  ok: boolean;
  project?: string;
  routing: NotificationRouting;
}

// Cross-room handoff (web_app.py). export → signed allowlist package (task →
// {title,body,priority,labels}); accept → verify (trust/freshness) + EXPLICIT
// accept → local task (idempotent by handoff_id, receiver TTL). Default OFF.
export interface HandoffPackage {
  algorithm: string;
  key_id: string;
  payload: {
    schema?: string;
    handoff_id?: string;
    source_project?: string;
    generated_at?: number;
    expires_at?: number;
    task?: { title?: string; body?: string | null; priority?: number; labels?: string[] };
  };
  signature: string;
}

export interface HandoffAcceptResult {
  status: string; // "created" | "existing"
  created: boolean;
  handoff_id: string;
  task?: { id: string; title?: string; status?: string };
  limitations?: string[];
}

// Cross-room aggregation (web_app.py). GET /api/summary returns a signed
// allowlist summary; POST /api/aggregate verifies a set of summaries by key_id
// trust + freshness and returns a READ-ONLY combined rollup (trusted+fresh only).
// Both 404 when the export is disabled (default OFF). Only key_id is exposed.
export interface AggCounts {
  boards?: { total?: number };
  tasks?: { total?: number; by_status?: Record<string, number> };
  nodes?: { total?: number; by_status?: Record<string, number>; by_agent?: Record<string, number> };
  runs?: { total?: number; by_status?: Record<string, number> };
}

export interface SignedSummary {
  algorithm: string;
  key_id: string;
  payload: { project?: string; generated_at?: number; summary?: AggCounts; [k: string]: unknown };
  signature: string;
}

export interface AggregateItem {
  trust: string; // "trusted" | "untrusted"
  freshness: string; // "fresh" | "stale" | "unknown"
  key_id?: string;
  project?: string;
  generated_at?: number;
  reason?: string;
  payload?: { project?: string; generated_at?: number; summary?: AggCounts };
}

export interface AggregateResult {
  trust?: { trusted: number; untrusted: number; stale: number };
  summaries: AggregateItem[];
  combined?: {
    sources?: number;
    projects?: string[];
    boards?: { total?: number };
    tasks?: { total?: number; by_status?: Record<string, number> };
    nodes?: { total?: number; by_status?: Record<string, number>; by_agent?: Record<string, number> };
    runs?: { total?: number; by_status?: Record<string, number> };
  };
  limitations?: string[];
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

// Planner (web_app.py _plan_payload): READ-ONLY delegation recommendations.
// Ranked candidate nodes with per-factor metrics (source/confidence). The
// endpoint never claims/assigns — `read_only` is always true; the FE surfaces
// the ranking for manual assignment only. Metrics reuse the CostMetric shape.
export type PlanMetric = CostMetric;

export interface PlanCandidate {
  node: string;
  agent?: string;
  role?: string;
  group?: string;
  status?: string;
  status_reason?: string;
  rank?: PlanMetric;
  score?: PlanMetric;
  score_breakdown?: Record<string, PlanMetric>;
  signals?: {
    running_tasks?: PlanMetric;
    blocked_tasks?: PlanMetric;
    cost_basis?: Record<string, PlanMetric>;
  };
}

export interface PlanResult {
  project?: string;
  task?: { id: string; title?: string; status?: string };
  requested_role?: string;
  requirements?: { role_terms?: string[]; capability_terms?: string[] };
  read_only?: boolean;
  recommended_action?: string;
  candidates: PlanCandidate[];
  limitations?: string[];
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
  name: string; // = session (internal identity, e.g. "dev10")
  display_name?: string;
  project?: string;
  session?: string;
  board?: string;
  workspace: string;
  node_count: number;
  status: string;
  dashboardCommand?: string;
  default_assignee?: string;
  project_master?: { name?: string; status?: string };
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

// Shared-access connection (web_app.py /api/share + /api/join). --shared-access
// must be on (else 404). POST /api/share (operator only) mints a ONE-TIME join
// code + a share URL (index?join=<code>); POST /api/join exchanges a code + name
// for a member cookie session. Only the code/url surface — never the signing
// secret. The code itself is shown but treated as a secret (one-time, expiring).
export interface ShareResult {
  code: string;
  role: string;
  expires_at: number;
  url: string;
}

export interface JoinResult {
  auth_mode?: string;
  member?: { id?: string; name?: string; role?: string };
  csrf?: string;
  expires_at?: number;
}

// Master chat (v1.27). Operator-only conversational channel to the project-master
// orchestrator, implemented by grove-py at /api/master/chat. POST is live; the
// history GET may stay unimplemented (POST-only route) and 405 — callers treat
// 404/405/501/503 as a graceful "not yet available" and surface other codes as
// real errors. Replies are keyed by `id` and upserted in place (pending -> sent).
export type MasterChatRole = "user" | "master";

export interface MasterChatMessage {
  id: string;
  role: MasterChatRole;
  text: string;
  ts: number; // epoch ms
  status?: "pending" | "sent";
}

export interface MasterChatHistory {
  messages: MasterChatMessage[];
}

// Request body for POST /api/master/chat (grove-py). request_id = the optimistic
// client message id; conversation_id threads the session (echoed back to reuse).
export interface MasterChatSendBody {
  message: string;
  conversation_id?: string;
  request_id?: string;
  origin_surface?: "floating_web_chat" | "api";
  origin_page?: string;
}

export interface MasterChatConfirmBody {
  confirmation_id: string;
  idempotency_key: string;
  conversation_id?: string;
  request_id?: string;
  origin_surface?: "floating_web_chat" | "api";
  origin_page?: string;
}

// Raw MasterChatResponse from grove-py. Surfaced as-is; masterReplyText() picks
// only assistant-authored answer.text and the FE threads conversation_id forward.
export type MasterChatResponseType = "answer" | "preview" | "denied";

export interface MasterChatFacts {
  project?: { selected?: string; board?: string };
  projects?: { visible?: string[] };
  org?: {
    node_count?: number;
    project_master?: { name?: string; present?: boolean; default_assignee?: boolean };
  };
  board?: { status_counts?: Record<string, number> };
  reviewers?: { count?: number; nodes?: string[] };
  human?: {
    assignee_candidates?: string[];
    reviewers?: string[];
    ask_human_count?: number;
    needs_human_count?: number;
    inbox_endpoint?: string;
    answer_endpoint?: string;
  };
  delegation?: {
    default_assignee?: string;
    create_task_endpoint?: string;
    watch_endpoint?: string;
    watch_ticket_endpoint?: string;
    watch_ticket_kind?: string;
  };
}

export interface MasterChatResponse {
  conversation_id: string;
  request_id: string;
  response_type: MasterChatResponseType;
  classification?: string;
  answer?: { text?: string; metadata?: { facts?: MasterChatFacts; [key: string]: unknown } } | null;
  proposal?: {
    proposal_id?: string;
    summary?: string;
    payload?: {
      confirmation_id?: string;
      confirm?: { command?: string; endpoint?: string };
      [key: string]: unknown;
    };
  } | null;
  feedback_route?: string | { id?: string; title?: string } | null;
  operator_gate?: { reason?: string } | null;
  requires_confirmation?: boolean;
  audit_events?: unknown[];
}

/** User-visible reply text for a master response. Only LLM-authored answer.text is
 *  ever shown. proposal.summary and operator_gate.reason are rule/gate metadata
 *  and must never reach the user; absent answer.text returns "" so the caller
 *  treats the exchange as error/unavailable without inventing a reply. */
export function masterReplyText(res: MasterChatResponse): string {
  switch (res.response_type) {
    case "answer":
      return res.answer?.text ?? "";
    case "preview":
      return res.answer?.text ?? "";
    case "denied":
      return res.answer?.text ?? "";
    default:
      return res.answer?.text ?? "";
  }
}

export function masterReplyFacts(res: MasterChatResponse): MasterChatFacts | undefined {
  return res.response_type === "answer" ? res.answer?.metadata?.facts : undefined;
}

export function masterConfirmationId(res: MasterChatResponse): string | undefined {
  if (res.response_type !== "preview" || !res.requires_confirmation) return undefined;
  const direct = res.proposal?.payload?.confirmation_id;
  if (typeof direct === "string" && direct.trim()) return direct.trim();
  const proposalId = res.proposal?.proposal_id;
  if (typeof proposalId === "string" && proposalId.startsWith("assistant_")) return proposalId;
  const command = res.proposal?.payload?.confirm?.command;
  const match = typeof command === "string" ? /^confirm\s+(\S+)$/i.exec(command.trim()) : null;
  return match?.[1];
}

const TOKEN = window.__GROVE_SESSION_TOKEN__ ?? "";
export const AUTH_REQUIRED = window.__GROVE_AUTH_REQUIRED__ ?? false;
const SESSION_HEADER = "X-Grove-Session-Token";
const PROJECT_HEADER = "X-Grove-Project";
const CSRF_HEADER = "X-Grove-CSRF";

// The active project (= grove session). All REST calls carry it as a header so
// the backend scopes org/boards/nodes to the selected project.
let currentProject = "";
let csrfToken: string | null = null;
export function setProject(name: string): void {
  currentProject = name;
}

function rememberCsrf(payload: { csrf?: string | null }): void {
  if (typeof payload.csrf === "string" && payload.csrf) csrfToken = payload.csrf;
}

function headers(extra?: Record<string, string>): Record<string, string> {
  const base: Record<string, string> = {};
  if (TOKEN) base[SESSION_HEADER] = TOKEN;
  if (currentProject) base[PROJECT_HEADER] = currentProject;
  if (csrfToken) base[CSRF_HEADER] = csrfToken;
  return { ...base, ...(extra ?? {}) };
}

async function getJSON<T>(path: string): Promise<T> {
  const res = await fetch(path, { headers: headers(), credentials: "same-origin" });
  // Strip the query string from the thrown message: it can carry user input
  // (e.g. a role/filter that may be a path or secret) — never put it in an Error
  // that a caller might surface. Callers should still prefer fixed UI messages.
  if (!res.ok) throw new Error(`${path.split("?")[0]}: HTTP ${res.status}`);
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
    // Always send a non-empty status + an INTEGER priority (default 0) — never
    // null/undefined/"" (those 422 against the backend TaskCreatePayload).
    const body: Record<string, unknown> = {
      title: payload.title,
      status: normalizeStatus(payload.status),
      priority: normalizePriority(payload.priority),
    };
    if (payload.body != null && payload.body !== "") body.body = payload.body;
    if (payload.assignee != null && payload.assignee !== "") body.assignee = payload.assignee;
    if (payload.reviewer != null && payload.reviewer !== "") body.reviewer = payload.reviewer; // v1.29
    const res = await fetch(`/api/boards/${enc(boardId)}/tasks`, {
      method: "POST",
      headers: headers({ "Content-Type": "application/json" }),
      credentials: "same-origin",
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`create task: HTTP ${res.status}`);
    return (await res.json()) as Task;
  },

  // v1.29 board workflow: canonical columns/labels/aliases/transitions. The board
  // falls back to local canonical columns if this 404s on an older backend.
  getWorkflow: (boardId: string) => getJSON<BoardWorkflow>(`/api/boards/${enc(boardId)}/workflow`),

  // v1.29 manual status transition (operator only). Send a CANONICAL key
  // (ready|running|review|blocked|ask_human|done) — these match the backend's
  // stored vocabulary directly. Optionally set a reviewer in the same call.
  async setTaskStatus(taskId: string, status: string, reviewer?: string | null): Promise<Task> {
    const body: Record<string, unknown> = { status };
    if (reviewer !== undefined) body.reviewer = reviewer;
    const res = await fetch(`/api/tasks/${enc(taskId)}/status`, {
      method: "PATCH",
      headers: headers({ "Content-Type": "application/json" }),
      credentials: "same-origin",
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`task status: HTTP ${res.status}`);
    return (await res.json()) as Task;
  },

  // v1.29 set/clear a task's reviewer (operator only). null clears it.
  async setTaskReviewer(taskId: string, reviewer: string | null): Promise<Task> {
    const res = await fetch(`/api/tasks/${enc(taskId)}/reviewer`, {
      method: "PATCH",
      headers: headers({ "Content-Type": "application/json" }),
      credentials: "same-origin",
      body: JSON.stringify({ reviewer }),
    });
    if (!res.ok) throw new Error(`task reviewer: HTTP ${res.status}`);
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

  // web→node command input (operator only; 404 when the "node-input" gui-feature
  // is off — toggled in the Setup panel; 429 rate-limited). The live terminal
  // streams the result. Distinct statuses map to FIXED FE messages; the raw cause
  // is never surfaced.
  async sendNode(node: string, text: string): Promise<{ ok?: boolean; node?: string; tmux_pane?: string }> {
    const res = await fetch(`/api/nodes/${enc(node)}/send`, {
      method: "POST",
      headers: headers({ "Content-Type": "application/json" }),
      credentials: "same-origin",
      body: JSON.stringify({ text }),
    });
    if (!res.ok) throw new Error(`/api/nodes/send: HTTP ${res.status}`);
    return (await res.json()) as { ok?: boolean; node?: string; tmux_pane?: string };
  },

  // SSH/attach connect commands for a node (any member; surfaced to operators).
  getNodeConnect: (node: string) => getJSON<NodeConnect>(`/api/nodes/${enc(node)}/connect`),

  async createNode(payload: NewNode): Promise<OrgNode> {
    // Map the camelCase TS field to the backend's snake_case JSON contract
    // (g-py: `role_preset`); only emit it when a preset was chosen.
    const { rolePreset, ...rest } = payload;
    const wire = rolePreset ? { ...rest, role_preset: rolePreset } : rest;
    const res = await fetch("/api/nodes", {
      method: "POST",
      headers: headers({ "Content-Type": "application/json" }),
      credentials: "same-origin",
      body: JSON.stringify(wire),
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

  async terminateNode(name: string, opts: NodeTerminateOptions): Promise<NodeTerminateResult> {
    const body = {
      ...(opts.caller ? { caller: opts.caller } : {}),
      ...(opts.confirm ? { confirm: true } : {}),
      ...(opts.confirmationId ? { confirmation_id: opts.confirmationId } : {}),
      ...(opts.operatorOverride ? { operator_override: true } : {}),
    };
    const res = await fetch(`/api/nodes/${enc(name)}/terminate`, {
      method: "POST",
      headers: headers({ "Content-Type": "application/json" }),
      credentials: "same-origin",
      body: JSON.stringify(body),
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
    return (await res.json()) as NodeTerminateResult;
  },

  // Live status: project + node liveness summary; detail=1 adds per-node rows.
  getStatus: (detail = false) => getJSON<StatusSummary>(`/api/status${detail ? "?detail=1" : ""}`),

  // Current viewer's identity/role (member null in local-token mode = operator).
  async getMe(): Promise<MeInfo> {
    const me = await getJSON<MeInfo>("/api/me");
    rememberCsrf(me);
    return me;
  },

  getGuiFeatures: () => getJSON<GuiFeatures>("/api/gui-features"),

  async setGuiFeature(feature: GuiFeatureKey, enabled: boolean): Promise<GuiFeatureUpdate> {
    const res = await fetch(`/api/gui-features/${enc(feature)}`, {
      method: "POST",
      headers: headers({ "Content-Type": "application/json" }),
      credentials: "same-origin",
      body: JSON.stringify({ enabled }),
    });
    if (!res.ok) throw new Error(`gui feature: HTTP ${res.status}`);
    return (await res.json()) as GuiFeatureUpdate;
  },

  // --- execution loop ------------------------------------------------------
  getExecutionGate: () => getJSON<ExecutionGate>("/api/execution"),

  // Set global/board execution gate or kill-switch (partial). 403 for viewers.
  async setExecutionGate(patch: Partial<Pick<ExecutionGate, "enabled" | "kill_switch" | "board_enabled" | "board_kill_switch">>): Promise<ExecutionGate> {
    const res = await fetch("/api/execution", {
      method: "POST",
      headers: headers({ "Content-Type": "application/json" }),
      credentials: "same-origin",
      body: JSON.stringify(patch),
    });
    if (!res.ok) throw new Error(`execution: HTTP ${res.status}`);
    return (await res.json()) as ExecutionGate;
  },

  getNodeExecution: (node: string) => getJSON<NodeExecutionState>(`/api/nodes/${enc(node)}/execution`),

  async setNodeExecution(node: string, enabled: boolean): Promise<NodeExecutionState> {
    const res = await fetch(`/api/nodes/${enc(node)}/execution`, {
      method: "POST",
      headers: headers({ "Content-Type": "application/json" }),
      credentials: "same-origin",
      body: JSON.stringify({ enabled }),
    });
    if (!res.ok) throw new Error(`execution: HTTP ${res.status}`);
    return (await res.json()) as NodeExecutionState;
  },

  getTaskExecution: (taskId: string) => getJSON<TaskExecution>(`/api/tasks/${enc(taskId)}/execution`),

  // Approve a task awaiting approval (no body). 409 if gate blocked / not pending.
  async approveTask(taskId: string): Promise<TaskExecution> {
    const res = await fetch(`/api/tasks/${enc(taskId)}/approve`, {
      method: "POST",
      headers: headers({ "Content-Type": "application/json" }),
      credentials: "same-origin",
      body: JSON.stringify({}),
    });
    if (!res.ok) throw new Error(`approve: HTTP ${res.status}`);
    return (await res.json()) as TaskExecution;
  },

  async abortTask(taskId: string, reason?: string): Promise<TaskExecution> {
    const res = await fetch(`/api/tasks/${enc(taskId)}/abort`, {
      method: "POST",
      headers: headers({ "Content-Type": "application/json" }),
      credentials: "same-origin",
      body: JSON.stringify(reason ? { reason } : {}),
    });
    if (!res.ok) throw new Error(`abort: HTTP ${res.status}`);
    return (await res.json()) as TaskExecution;
  },

  // Per-node autonomous-pickup config (real state, not the inferred badge).
  getAutopickup: (node: string) => getJSON<AutopickupState>(`/api/nodes/${enc(node)}/autopickup`),

  // Toggle a node's autopickup. 409 when the global gate is off / kill-switch on;
  // 403 for team viewers. The caller surfaces a FIXED message (no raw leak).
  async setAutopickup(node: string, enabled: boolean): Promise<AutopickupState> {
    const res = await fetch(`/api/nodes/${enc(node)}/autopickup`, {
      method: "POST",
      headers: headers({ "Content-Type": "application/json" }),
      credentials: "same-origin",
      body: JSON.stringify({ enabled }),
    });
    if (!res.ok) throw new Error(`autopickup: HTTP ${res.status}`);
    return (await res.json()) as AutopickupState;
  },

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

  // PR1 watchdog: per-node health map keyed by node name. Absent-tolerant — a
  // missing endpoint (404, older backend) or any transport error resolves to {}
  // so the UI degrades to neutral "unknown" badges instead of breaking.
  getNodeHealth: (): Promise<Record<string, NodeHealth>> =>
    getJSON<NodeHealthResponse>("/api/node-health")
      .then((r) => {
        const map: Record<string, NodeHealth> = {};
        for (const h of r?.nodes ?? []) if (h && typeof h.node === "string") map[h.node] = h;
        return map;
      })
      .catch(() => ({})),

  // Dev-tool auth status.
  getAuthStatus: () => getJSON<AuthTool[]>("/api/auth-status"),

  // Cost/credit usage (project-scoped; 403 for team viewers). Per-agent token +
  // cost metrics carry source/confidence; agy credit may be unknown.
  getCost: () => getJSON<CostSummary>("/api/cost"),

  // Usage rollup (node/day) — project-scoped; 403 for team viewers.
  getUsage: () => getJSON<UsageReport>("/api/usage"),

  // Per-member ledger (runs/tokens/cost + soft quota + host pressure). viewer =
  // self-only, operator = all members. Read-only; cost/agy stay honestly unknown.
  getLedger: () => getJSON<LedgerReport>("/api/ledger"),

  // Retro analytics insights (operator only; 404 when the "retro-analytics"
  // gui-feature is off — toggled in the Setup panel). ADVISORY + read-only —
  // never creates/dispatches anything.
  getRetroAnalytics: () => getJSON<RetroAnalytics>("/api/retro/analytics"),

  // Usage trend + anomaly signals (operator only; 404 when the "usage-trend"
  // gui-feature is off — toggled in the Setup panel). ADVISORY + read-only —
  // anomaly flags never throttle/abort. window ∈ 7d|14d|30d (default 14d).
  getUsageTrend: (window?: string) =>
    getJSON<UsageTrend>(`/api/usage/trend${window ? `?window=${encodeURIComponent(window)}` : ""}`),

  // Notification routing config: GET readable by any member; POST operator-only
  // (403 viewer). Default dry-run (no real sends).
  getNotificationRouting: () => getJSON<RoutingResponse>("/api/notifications/routing"),

  async setNotificationRouting(body: RoutingUpdateBody): Promise<RoutingUpdateResult> {
    const res = await fetch("/api/notifications/routing", {
      method: "POST",
      headers: headers({ "Content-Type": "application/json" }),
      credentials: "same-origin",
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`/api/notifications/routing: HTTP ${res.status}`);
    return (await res.json()) as RoutingUpdateResult;
  },

  // Set a member's SOFT budget (operator only; 404 when the "quota" gui-feature
  // is off — toggled in the Setup panel; 403 for viewers). Never hard-kills —
  // exceeding only throttles new work.
  async setQuota(body: QuotaUpdateBody): Promise<QuotaUpdateResult> {
    const res = await fetch("/api/quota", {
      method: "POST",
      headers: headers({ "Content-Type": "application/json" }),
      credentials: "same-origin",
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`/api/quota: HTTP ${res.status}`);
    return (await res.json()) as QuotaUpdateResult;
  },

  // Cross-room handoff (default OFF → 404). export = signed package; accept =
  // verify + EXPLICIT accept → local task (idempotent).
  async exportHandoff(taskId: string): Promise<HandoffPackage> {
    const res = await fetch("/api/handoff/export", {
      method: "POST",
      headers: headers({ "Content-Type": "application/json" }),
      credentials: "same-origin",
      body: JSON.stringify({ task_id: taskId }),
    });
    if (!res.ok) throw new Error(`handoff-export: HTTP ${res.status}`);
    return (await res.json()) as HandoffPackage;
  },

  async acceptHandoff(pkg: HandoffPackage): Promise<HandoffAcceptResult> {
    const res = await fetch("/api/handoff/accept", {
      method: "POST",
      headers: headers({ "Content-Type": "application/json" }),
      credentials: "same-origin",
      body: JSON.stringify({ package: pkg }),
    });
    if (!res.ok) throw new Error(`handoff-accept: HTTP ${res.status}`);
    return (await res.json()) as HandoffAcceptResult;
  },

  // Cross-room aggregation (read-only). 404 when summary export is disabled.
  getSummary: () => getJSON<SignedSummary>("/api/summary"),

  async aggregate(summaries: SignedSummary[]): Promise<AggregateResult> {
    const res = await fetch("/api/aggregate", {
      method: "POST",
      headers: headers({ "Content-Type": "application/json" }),
      credentials: "same-origin",
      body: JSON.stringify({ summaries }),
    });
    if (!res.ok) throw new Error(`aggregate: HTTP ${res.status}`);
    return (await res.json()) as AggregateResult;
  },

  // Presence: who's viewing this project (name/role for team auth; anonymous
  // count for local-token). Project-scoped via headers.
  getPresence: () => getJSON<Presence>("/api/presence"),

  // Planner: read-only ranked node recommendations for a task+role. Never
  // assigns/claims — for manual assignment only.
  getPlan: (params: { role: string; task_id: string }) =>
    getJSON<PlanResult>(`/api/plan?${new URLSearchParams({ role: params.role, task_id: params.task_id }).toString()}`),

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

  // Shared-access invite: operator-only one-time join code + share URL. 404 when
  // --shared-access is off; 403 for non-operators. Secret-free (code/url only).
  async createShare(): Promise<ShareResult> {
    const res = await fetch("/api/share", {
      method: "POST",
      headers: headers({ "Content-Type": "application/json" }),
      credentials: "same-origin",
    });
    if (!res.ok) throw new Error(`/api/share: HTTP ${res.status}`);
    return (await res.json()) as ShareResult;
  },

  // Peer join: exchange a one-time code + display name for a member session.
  // Distinct statuses map to FIXED FE messages (403 invalid / 410 expired / 429
  // rate-limited / 409 name taken / 400 bad name); the raw cause never surfaces.
  async join(code: string, name: string): Promise<JoinResult> {
    const res = await fetch("/api/join", {
      method: "POST",
      headers: headers({ "Content-Type": "application/json" }),
      credentials: "same-origin",
      body: JSON.stringify({ code, name }),
    });
    if (!res.ok) throw new Error(`/api/join: HTTP ${res.status}`);
    const payload = (await res.json()) as JoinResult;
    rememberCsrf(payload);
    return payload;
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

  // Master chat history (operator-only; project-scoped via headers). The GET may
  // be unimplemented (POST-only route) and throw `… HTTP 404/405`; the caller
  // treats that as "no history" and judges availability on send instead.
  getMasterChatHistory: () => getJSON<MasterChatHistory>("/api/master/chat"),

  // POST a message to the project-master. request_id = clientId (optimistic id);
  // conversation_id threads the session (assigned by the backend, reused on the
  // next send). Returns the raw MasterChatResponse — see masterReplyText().
  async sendMasterChat(text: string, clientId: string, conversationId?: string): Promise<MasterChatResponse> {
    const body: MasterChatSendBody = {
      message: text,
      request_id: clientId,
      origin_surface: "floating_web_chat",
      origin_page: window.location.pathname,
    };
    if (conversationId) body.conversation_id = conversationId;
    const res = await fetch("/api/master/chat", {
      method: "POST",
      headers: headers({ "Content-Type": "application/json" }),
      credentials: "same-origin",
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`/api/master/chat: HTTP ${res.status}`);
    return (await res.json()) as MasterChatResponse;
  },

  async confirmMasterChat(
    confirmationId: string,
    idempotencyKey: string,
    conversationId?: string,
    requestId?: string,
  ): Promise<MasterChatResponse> {
    const body: MasterChatConfirmBody = {
      confirmation_id: confirmationId,
      idempotency_key: idempotencyKey,
      request_id: requestId,
      origin_surface: "floating_web_chat",
      origin_page: window.location.pathname,
    };
    if (conversationId) body.conversation_id = conversationId;
    const res = await fetch("/api/master/chat/confirm", {
      method: "POST",
      headers: headers({ "Content-Type": "application/json" }),
      credentials: "same-origin",
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`/api/master/chat/confirm: HTTP ${res.status}`);
    return (await res.json()) as MasterChatResponse;
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
