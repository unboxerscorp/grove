// Standalone mock backend for the Dev Room SPA.
//
// Installs the page globals the grove web server would inject, then intercepts
// fetch + WebSocket so the built bundle runs end-to-end in a plain browser
// (file://) with no server. Loaded BEFORE the app bundle by mock/index.html.

interface MockTask {
  id: string;
  title: string;
  status: string; // RAW stored status (e.g. "running") — FE canonicalizes via workflow aliases
  assignee?: string;
  reviewer?: string; // v1.29 per-task reviewer
  latest_summary?: string;
  body?: string;
  tenant?: string;
}

interface MockSlackThread {
  task_id: string;
  team_id: string;
  channel_id: string;
  thread_ts: string;
  mode: string;
  node?: string;
}

const BOARDS = [
  { id: "grove", name: "Grove", task_count: 7 },
  { id: "infra", name: "Infra", task_count: 3 },
];

const TASKS: Record<string, MockTask[]> = {
  grove: [
    { id: "G-6", title: "Triage incoming agent reports", status: "ready", assignee: "root" },
    { id: "G-5", title: "Task drawer: comments + runs", status: "ready", assignee: "frontend" },
    {
      id: "G-1",
      // raw stored status "running" is the canonical "running" column key.
      title: "Stand up the dev-room SPA",
      status: "running",
      assignee: "frontend",
      latest_summary: "wiring the live xterm stream into the cockpit",
    },
    { id: "G-2", title: "Board event-tail over WebSocket", status: "review", assignee: "backend", reviewer: "researcher" },
    { id: "G-4", title: "Single-use ws-ticket auth", status: "ready", assignee: "backend" },
    { id: "G-7", title: "Pane resize policy (mirror beta)", status: "blocked", assignee: "frontend" },
    { id: "G-3", title: "Node registry + tmux pane exposure", status: "done", assignee: "backend" },
  ],
  infra: [
    { id: "I-1", title: "Static build pipeline", status: "ready", assignee: "docs" },
    { id: "I-2", title: "Reverse proxy + TLS", status: "running", assignee: "root" },
    { id: "I-3", title: "Nightly backups", status: "done", assignee: "docs" },
  ],
  // N1: a distinct, isolated project so a switch swaps the whole context and
  // leaves no residue from the default project's boards/tasks.
  "solo-x": [{ id: "S-1", title: "solo task", status: "running", assignee: "solo" }],
};

const SLACK_THREADS: MockSlackThread[] = [
  {
    task_id: "G-7",
    team_id: "TMOCK",
    channel_id: "CDECIDE",
    thread_ts: "1780700000.123456",
    mode: "human_gate",
    node: "frontend",
  },
];

// v1.29 workflow contract — mirrors web_app.py WORKFLOW_ALIASES + _workflow_columns
// + MANUAL_TASK_STATUS_ALIASES. Raw stored statuses map onto canonical keys; the
// canonical "in progress" key is "running" (the backend's stored value), so only
// legacy/alternate spellings need mapping onto it.
const MOCK_WORKFLOW_ALIASES: Record<string, string> = {
  in_progress: "running",
  claimed: "running",
  executing: "running",
  complete: "done",
  completed: "done",
  "ask-human": "ask_human",
  ask_human_pending: "ask_human",
};
const MOCK_MANUAL_STATUS_ALIASES: Record<string, string> = {
  ready: "ready",
  in_progress: "running",
  running: "running",
  claimed: "running",
  executing: "running",
  review: "review",
  done: "done",
  complete: "done",
  completed: "done",
  blocked: "blocked",
  // ask_human is intentionally NOT a manual alias (P1): it's a virtual/display-only
  // column, so a manual PATCH to "ask_human" falls through to 400 invalid status.
  archived: "archived",
};
const MOCK_WORKFLOW_COLUMNS = [
  { key: "ready", status: "ready", label: "Ready", raw_statuses: ["ready"], aliases: [] as string[], virtual: false },
  { key: "running", status: "running", stored_status: "running", label: "In Progress", raw_statuses: ["running", "in_progress", "claimed", "executing"], aliases: ["in_progress", "claimed", "executing"], virtual: false },
  { key: "review", status: "review", label: "Review", raw_statuses: ["review"], aliases: [] as string[], virtual: false },
  { key: "blocked", status: "blocked", label: "Blocked", raw_statuses: ["blocked"], aliases: [] as string[], virtual: false },
  { key: "ask_human", status: "ask_human", label: "Ask Human", raw_statuses: ["blocked"], aliases: ["ask-human", "ask_human_pending"], virtual: true, source: "status=blocked and metadata.needs_human=true" },
  { key: "done", status: "done", label: "Done", raw_statuses: ["done", "complete", "completed"], aliases: ["complete", "completed"], virtual: false },
];
function mockWorkflowPayload(project: string, board: string): Record<string, unknown> {
  return {
    project,
    board,
    done_visible: true,
    canonical_statuses: MOCK_WORKFLOW_COLUMNS.map((c) => c.key),
    columns: MOCK_WORKFLOW_COLUMNS,
    labels: Object.fromEntries(MOCK_WORKFLOW_COLUMNS.map((c) => [c.key, c.label])),
    aliases: MOCK_WORKFLOW_ALIASES,
    // No transition targets the virtual ask_human column, and none requires a
    // reason — mirrors the backend P1 contract.
    allowed_transitions: [
      { from: "ready", to: "running", requires_reason: false },
      { from: "running", to: "review", requires_reason: false },
      { from: "running", to: "done", requires_reason: false },
      { from: "review", to: "done", requires_reason: false },
      { from: "review", to: "running", requires_reason: false },
      { from: "ready", to: "blocked", requires_reason: false },
      { from: "blocked", to: "ready", requires_reason: false },
    ],
    manual_transition: { endpoint: "/api/tasks/{task_id}/status", method: "PATCH", body: { status: "review", reviewer: "optional-node" } },
  };
}

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
  { name: "backend", agent: "codex", role: "백엔드", description: "API·DB 담당", parent: "root", group: "build", tmux_pane: "grove:0.1", session_id: "sess-be", status: "running" },
  { name: "root", agent: "claude", role: "오케스트레이터", description: "전체 작업 조율·분배", parent: null, group: "core", tmux_pane: "grove:0.0", session_id: "sess-root", status: "running" },
  { name: "frontend", agent: "claude", role: "프런트엔드", parent: "root", group: "build", tmux_pane: "grove:0.2", session_id: "sess-fe", status: "idle" },
  { name: "researcher", agent: "claude", role: "리서치", parent: "root", group: "research", tmux_pane: "grove:0.3", session_id: "sess-re", status: "error" },
  { name: "docs", agent: "codex", role: "문서", parent: "backend", group: "build", tmux_pane: "grove:1.0", session_id: "sess-docs", status: "done" },
  { name: "human-reviewer", agent: "human", role: "reviewer", parent: "root", group: "human", tmux_pane: "", session_id: "", status: "external" },
];
const LEAD_NODE: OrgNodeMock = {
  name: "lead",
  agent: "claude",
  role: "orchestrator",
  description: "External lead/orchestrator.",
  parent: null,
  group: "",
  tmux_pane: "",
  session_id: "",
  status: "external",
};

// v2 access flags — mirror web_app.py NodeRecord + _pane_allowed: any valid pane
// is terminal/connect visible and input-capable; auth/origin/node-input/rate
// limits guard sends, not hierarchy.
function nodeAccessFlags(pane: string): {
  exposed: boolean;
  terminal_allowed: boolean;
  input_allowed: boolean;
  unavailable_reason: string;
} {
  const match = /^[A-Za-z0-9_.-]+:(\d+)\.(\d+)$/.exec(pane || "");
  if (!match) {
    return { exposed: false, terminal_allowed: false, input_allowed: false, unavailable_reason: pane ? "tmux_pane invalid" : "no live pane" };
  }
  return {
    exposed: true,
    terminal_allowed: true,
    input_allowed: true,
    unavailable_reason: "",
  };
}

function mockNodeLivenessStatus(status: string): "running" | "stale" | "error" | "idle" {
  switch (status.trim().toLowerCase()) {
    case "active":
    case "running":
      return "running";
    case "stale":
      return "stale";
    case "error":
      return "error";
    default:
      return "idle";
  }
}

function mockNodeDetailStatus(status: string): string {
  const clean = status.trim().toLowerCase();
  if (clean === "active") return "running";
  if (clean === "done") return "dead";
  return clean || "idle";
}

function basicNode(n: OrgNodeMock) {
  return {
    name: n.name,
    agent: n.agent,
    role: n.role,
    parent: n.parent,
    group: n.group,
    description: n.description,
    tmux_pane: n.tmux_pane,
    session_id: n.session_id,
    status: n.status,
    ...nodeAccessFlags(n.tmux_pane),
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

// Assignee candidates mirror web_app.py _assignee_candidates: visible persistent
// nodes are the default, with a synthetic lead only when no master node exists.
const ASSIGNEE_CANDIDATES = [
  ...ORG_NODES.map((n) => ({
    name: n.name,
    agent: n.agent,
    role: n.role ?? "",
    status: n.status,
    default: n.name === "root",
    ...(n.agent === "human"
      ? {
          human: true,
          reviewer: /review/i.test(n.role ?? ""),
          inbox: { endpoint: "/api/inbox", answer_endpoint: "/api/tasks/{task_id}/answer", route: n.name },
        }
      : {}),
  })),
  { name: "lead", agent: "claude", role: "none", status: "external", default: false },
];

function buildMasterOrg(selected: string) {
  const visible = PROJECTS.map((p) => p.name).sort();
  const humans = ORG_NODES.filter((n) => n.agent === "human").map((n) => n.name).sort();
  return {
    name: "GROVE MASTER",
    scope: "cross_project",
    selected_project: selected,
    visible_projects: visible,
    project_master: { name: "root", present: true, default_assignee: true },
    delegation: {
      default_assignee: "root",
      create_task_endpoint: "/api/boards/{board_id}/tasks",
      watch_endpoint: "/ws/board",
      watch_ticket_endpoint: "/api/ws-ticket",
      watch_ticket_kind: "board",
    },
    human: {
      assignee_candidates: humans,
      reviewers: humans,
      inbox_endpoint: "/api/inbox",
      answer_endpoint: "/api/tasks/{task_id}/answer",
    },
  };
}

function buildOrg(proj = "dev10") {
  const orgNodes = [...ORG_NODES, LEAD_NODE];
  const children = childMap();
  const groups: Record<string, string[]> = {};
  for (const n of ORG_NODES) if (n.group) (groups[n.group] ??= []).push(n.name);
  return {
    nodes: orgNodes.map((n) => ({
      ...n,
      children: children[n.name] ?? [],
      kind: n.agent === "human" ? "human" : "registry",
      ...nodeAccessFlags(n.tmux_pane),
      ...(n.agent === "human" ? { terminal_allowed: false, input_allowed: false, unavailable_reason: "human node has no pane" } : {}),
    })),
    roots: orgNodes.filter((n) => !n.parent).map((n) => n.name),
    groups,
    children,
    default_assignee: "root",
    assignee_candidates: ASSIGNEE_CANDIDATES,
    master_org: buildMasterOrg(proj),
    ...mockOrgExtras(proj),
  };
}

// N1: solo-x's own org/nodes — one node, no relation to ORG_NODES above.
const SOLO_NODES: OrgNodeMock[] = [
  { name: "solo", agent: "claude", role: "혼자", parent: null, group: "", tmux_pane: "solo-x:0.0", session_id: "sess-solo", status: "running" },
];
function buildSoloOrg() {
  return {
    nodes: SOLO_NODES.map((n) => ({ ...n, children: [] as string[], ...nodeAccessFlags(n.tmux_pane) })),
    roots: ["solo"],
    groups: {} as Record<string, string[]>,
    children: {} as Record<string, string[]>,
    default_assignee: "solo",
    assignee_candidates: [{ name: "solo", agent: "claude", role: "혼자", status: "running", default: true }],
    master_org: buildMasterOrg(SOLO_PROJECT),
    ...mockOrgExtras(SOLO_PROJECT),
  };
}

// v1.29 cross-project org metadata — mirrors web_app.py _org_payload additions:
// project {name,board,display_name}, GROVE MASTER root, project_leads (current +
// switch targets), reviewer_candidates, delegations {current(open tasks), history}.
function mockCanon(raw: string): string {
  const s = (raw ?? "").trim().toLowerCase().replace(/-/g, "_");
  return MOCK_WORKFLOW_ALIASES[s] ?? s;
}
function mockOrgExtras(proj: string): Record<string, unknown> {
  const board = proj === SOLO_PROJECT ? "solo-x" : "grove";
  const open = (TASKS[board] ?? []).filter((t) => mockCanon(t.status) !== "done");
  type Edge = { from: string; to: string; kind: string; task_ids: string[]; count: number; latest_assigned_at: number; oldest_open_updated_at: number; stale: boolean; label: string };
  const edges: Record<string, Edge> = {};
  const add = (from: string, to: string, kind: string, id: string) => {
    const key = `${from}|${to}|${kind}`;
    const e = (edges[key] ??= { from, to, kind, task_ids: [], count: 0, latest_assigned_at: AUDIT_TS0, oldest_open_updated_at: AUDIT_TS0, stale: false, label: "Current delegation: open tasks" });
    e.task_ids.push(id);
    e.count += 1;
  };
  // The mock org's orchestrator node is "root" (grove:0.0) — use it as the edge
  // source so current-delegation edges resolve against real graph nodes.
  for (const t of open) {
    if (t.assignee) add("root", t.assignee, "implementation", t.id);
    if (t.reviewer) add(t.assignee ?? "root", t.reviewer, "review_pool", t.id);
  }
  const current = Object.values(edges).sort((a, b) => (a.from + a.to).localeCompare(b.from + b.to));
  const history = [
    { event_id: "de1", cursor: 2, action: "delegate", from: "lead", to: "backend", ts: AUDIT_TS0 + 30, label: "Delegation history: delegate" },
    { event_id: "de2", cursor: 5, action: "assign", from: "lead", to: "frontend", ts: AUDIT_TS0 + 100, label: "Delegation history: assign" },
    { event_id: "de3", cursor: 8, action: "reviewer-set", from: "backend", to: "researcher", ts: AUDIT_TS0 + 150, label: "Delegation history: reviewer-set" },
  ];
  return {
    project: { name: proj, board, display_name: projectDisplayName(proj) },
    master: {
      id: "grove-master",
      name: "GROVE MASTER",
      label: "GROVE MASTER",
      kind: "master",
      role: "orchestrator",
      root: true,
      current_project: proj,
      chat_target: { endpoint: "/api/master/chat", origin_surface: "floating_web_chat", project: proj },
    },
    project_leads: PROJECTS.map((pr) => ({
      id: `project:${pr.name}:lead`,
      name: "lead",
      label: pr.display_name,
      project: pr.name,
      display_name: pr.display_name,
      status: pr.status,
      node_count: pr.node_count,
      current: pr.name === proj,
      switch_target: pr.name,
      click_action: { type: "switch_project", project: pr.name },
      chat_target: { endpoint: "/api/master/chat", origin_surface: "floating_web_chat", project: pr.name },
    })),
    reviewer_candidates:
      proj === SOLO_PROJECT ? [{ name: "solo", agent: "claude", role: "혼자", status: "running", default: true }] : ASSIGNEE_CANDIDATES,
    delegations: {
      current,
      history,
      mode_labels: { current: "Current delegation: open tasks only", history: "Delegation history: audit trail summary" },
    },
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

let orgDelayMs = 0;
diag.setOrgDelay = (ms: number): void => {
  orgDelayMs = Math.max(0, Math.min(5000, Math.floor(ms)));
};
let statusDelayMs = Math.max(
  0,
  Math.min(5000, Math.floor(Number((window as unknown as { __GROVE_MOCK_STATUS_DELAY_MS__?: number }).__GROVE_MOCK_STATUS_DELAY_MS__ ?? 0))),
);
diag.setStatusDelay = (ms: number): void => {
  statusDelayMs = Math.max(0, Math.min(5000, Math.floor(ms)));
};
diag.setNodeStatus = (name: string, status: string): boolean => {
  const node = ORG_NODES.find((n) => n.name === name);
  if (!node) return false;
  node.status = status;
  return true;
};

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
  type?: string; // event kind (e.g. audit.execution.approve) — for the timeline
  actor: MockAuditActor;
  action: string;
  target: MockAuditTarget;
  ts: number;
  task_id: string | null;
  from_node?: string | null;
  to_node?: string | null;
};
const nodeActor = (id: string): MockAuditActor => ({ kind: "node", id, login: id, role: "none" });
// Slack identity actor (mirrors slack.py _slack_member_actor: kind="slack",
// id=slack user, login=member name). Drives the audit drawer's Slack-intake chip.
const slackActor = (id: string, login: string, role: string): MockAuditActor => ({ kind: "slack", id, login, role });
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
  // v1.10 autonomy events: node self-claim (autopickup) + retrospective (retro).
  { cursor: 11, id: "e11", actor: nodeActor("backend"), action: "autopickup", target: { type: "task", id: "G-10", node: "backend" }, ts: AUDIT_TS0 + 330, task_id: "G-10" },
  { cursor: 12, id: "e12", actor: nodeActor("researcher"), action: "retro", target: { type: "task", id: "G-6", node: "researcher" }, ts: AUDIT_TS0 + 360, task_id: "G-6" },
  // v1.15 execution-loop transitions for G-2 — MIRRORS store.py _add_execution_audit
  // action names + the full 7-step happy path (incl. approval-pending). kind =
  // audit.execution.<action>. Spaced ts → distinct per-phase durations:
  // claim 10s, preflight 30s, approval-pending 60s (human wait), approve 10s,
  // execute 60s, verify 20s, complete = current.
  { cursor: 13, id: "e13", type: "audit.execution.claim", actor: nodeActor("backend"), action: "claim", target: { type: "task", id: "G-2", node: "backend" }, ts: AUDIT_TS0 + 400, task_id: "G-2" },
  { cursor: 14, id: "e14", type: "audit.execution.preflight", actor: nodeActor("backend"), action: "preflight", target: { type: "task", id: "G-2", node: "backend" }, ts: AUDIT_TS0 + 410, task_id: "G-2" },
  { cursor: 15, id: "e15", type: "audit.execution.approval-pending", actor: nodeActor("backend"), action: "approval-pending", target: { type: "task", id: "G-2", node: "backend" }, ts: AUDIT_TS0 + 440, task_id: "G-2" },
  { cursor: 16, id: "e16", type: "audit.execution.approve", actor: nodeActor("root"), action: "approve", target: { type: "task", id: "G-2", node: "backend" }, ts: AUDIT_TS0 + 500, task_id: "G-2" },
  { cursor: 17, id: "e17", type: "audit.execution.execute", actor: nodeActor("backend"), action: "execute", target: { type: "task", id: "G-2", node: "backend" }, ts: AUDIT_TS0 + 510, task_id: "G-2" },
  { cursor: 18, id: "e18", type: "audit.execution.verify", actor: nodeActor("backend"), action: "verify", target: { type: "task", id: "G-2", node: "backend" }, ts: AUDIT_TS0 + 570, task_id: "G-2" },
  { cursor: 19, id: "e19", type: "audit.execution.complete", actor: nodeActor("backend"), action: "complete", target: { type: "task", id: "G-2", node: "backend" }, ts: AUDIT_TS0 + 590, task_id: "G-2" },
  // v1.20 Slack intent-triage intake: free-form Slack message -> gated task-create.
  // actor.kind="slack" (the slack identity), action="slack_intake_create" (mirrors
  // slack.py: kind="audit.task.create", action="slack_intake_create"). Distinct
  // slack chip + quick filter in the audit drawer; appended at the tail so the
  // existing page-1 assertions (cursors 1-4) are untouched.
  { cursor: 20, id: "e20", type: "audit.task.create", actor: slackActor("U07JIWOO", "jiwoo", "operator"), action: "slack_intake_create", target: { type: "task", id: "G-20" }, ts: AUDIT_TS0 + 620, task_id: "G-20" },
  { cursor: 21, id: "e21", type: "audit.task.create", actor: slackActor("U07MINJI", "minji", "operator"), action: "slack_intake_create", target: { type: "task", id: "G-21" }, ts: AUDIT_TS0 + 640, task_id: "G-21" },
];

// Decision inbox seed — MIRRORS web_app.py _inbox_item_payload: blocked +
// ask-human tasks with answer.endpoint. Distinct ids (H-*) so answering them
// doesn't disturb the board-card assertions. `let` so /answer can drop items.
type MockInboxItem = {
  id: string;
  type: string;
  task_id: string;
  title: string;
  body?: string;
  status: string;
  node?: string;
  blocked_reason?: string;
  blocked_since: number;
  waiting_seconds: number;
  needs_human: boolean;
  sources: string[];
  answer: { endpoint: string; method: string; slack_thread_reply: boolean; note: string };
};
const inboxItem = (id: string, ask: boolean, extra: Partial<MockInboxItem>): MockInboxItem => ({
  id,
  type: ask ? "ask_human" : "blocked_task",
  task_id: id,
  title: extra.title ?? id,
  status: "blocked",
  blocked_since: AUDIT_TS0,
  waiting_seconds: 600,
  needs_human: ask,
  sources: ask ? ["blocked_task", "ask_human"] : ["blocked_task"],
  answer: {
    endpoint: `/api/tasks/${id}/answer`,
    method: "POST",
    slack_thread_reply: ask,
    note: "answer adds a comment and unblocks the task",
  },
  ...extra,
});
let INBOX_ITEMS: MockInboxItem[] = [
  inboxItem("H-1", true, {
    title: "Approve prod deploy window?",
    body: "Agent needs a human to confirm the Friday deploy window.",
    node: "backend",
    blocked_reason: "needs human decision: deploy window",
    blocked_since: AUDIT_TS0 - 600,
  }),
  inboxItem("H-2", false, {
    title: "Schema migration conflict",
    node: "researcher",
    blocked_reason: "two migrations touch the same table",
    blocked_since: AUDIT_TS0 - 300,
    waiting_seconds: 300,
  }),
];

let slack: { status: string; last_event_at: string | null; last_error: string | null } = {
  status: "not_configured",
  last_event_at: null,
  last_error: null,
};
// v1.20 intent-triage intake (--enable-intake). Mirrors the EXACT backend
// config_status contract (bridge slack.py): a top-level `"intake": {"enabled":
// <bool>}` object — nothing invented, no flat field. Tri-state so verify can
// exercise an OLDER backend that omits the key entirely (null => field absent =>
// the FE must render "unknown", never silently "disabled"). Kept separate from
// `slack` so config/test reassignments preserve it.
let slackIntakeEnabled: boolean | null = true;
diag.setSlackIntake = (on: boolean | null): void => {
  slackIntakeEnabled = on;
};

// Presence mode for /api/presence: "team" (member chips) by default; verify can
// flip to "local" (anonymous count) to exercise both render paths.
let presenceMode: "team" | "local" = "team";
diag.setPresenceMode = (m: "team" | "local"): void => {
  presenceMode = m;
};

// Autopickup config mirror: global gate/kill-switch + per-node enabled. Verify
// can flip the global gate (disabled+reason) and deny POST (viewer 403).
let autopickupGlobal = { enabled: true, kill_switch: false };
const autopickupNodes: Record<string, boolean> = {};
diag.setAutopickupGlobal = (enabled: boolean, killSwitch: boolean): void => {
  autopickupGlobal = { enabled, kill_switch: killSwitch };
};

// Execution loop state (SEPARATE from autopickup). Global/board gate, per-node
// execution flag, and per-task execution state machine.
let executionGate = { enabled: true, kill_switch: false, board_enabled: true, board_kill_switch: false };
const nodeExec: Record<string, boolean> = {};
const taskExec: Record<string, { state: string; approved: boolean; node: string }> = {
  "G-5": { state: "approval-pending", approved: false, node: "frontend" },
  "G-6": { state: "approval-pending", approved: false, node: "root" },
};
diag.setExecutionGlobal = (enabled: boolean, killSwitch: boolean): void => {
  executionGate = { ...executionGate, enabled, kill_switch: killSwitch };
};

// Current-viewer role for /api/me. Default: local-token (operator-equivalent,
// member null). Verify flips to a team "viewer" to prove proactive control lock.
// ?viewer=1 seeds viewer at load so a fresh goto/reload mounts the app as a
// viewer; diag.setViewer still flips it at runtime for re-fetch-based checks.
let viewerMode = new URLSearchParams(window.location.search).get("viewer") === "1";
diag.setViewer = (on: boolean): void => {
  viewerMode = on;
};

function isMasterChatActionRequest(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    /\b(add|assign|build|create|delete|deploy|destroy|drop|execute|fix|handoff|implement|make|prod|production|route|run|setup|spawn|task)\b/.test(
      lower,
    ) || /(만들|생성|추가|셋업|설정|라우팅|위임|맡겨|배정|배포|실행|삭제|제거|수정|고쳐)/.test(message)
  );
}

// master chat (GET/POST /api/master/chat). Mirrors grove-py: POST returns a raw
// MasterChatResponse (response_type answer|preview|denied + answer/proposal/
// operator_gate); the history GET is unimplemented (POST-only route) -> 405, which
// the FE treats as "no history". default ON so the floating widget is demoable;
// diag.setMasterChatEnabled(false) -> 503 {detail} (hard transport death, no LLM
// text); viewer factual POST is allowed, while viewer action-like POST -> 403.
let masterChatEnabled = true;
diag.setMasterChatEnabled = (on: boolean): void => {
  masterChatEnabled = on;
};

// The unified backend's transport fallback (assistant.py ASSISTANT_TRANSPORT_FALLBACK_TEXT):
// a NORMAL 200 answer whose answer.text carries the one-line assistant fallback —
// NOT a 503. diag.setMasterTransportBusy(true) reproduces it for verify.
const MOCK_TRANSPORT_FALLBACK_TEXT = "지금은 답변을 만들 수 없어요. 잠시 뒤 다시 시도해 주세요.";
let masterTransportBusy = false;
diag.setMasterTransportBusy = (on: boolean): void => {
  masterTransportBusy = on;
};
let masterSeq = 0;

// v1.27 web→node input (the "node-input" gui-feature, toggled in the Setup
// panel). default ON here so the box is exercisable; diag.setNodeInput(false) ->
// 404. diag.nodeSendRateLimited -> 429.
let nodeInputEnabled = true;
diag.setNodeInput = (on: boolean): void => {
  nodeInputEnabled = on;
};

// Summary export / aggregation. Default ENABLED for the view; verify flips it OFF
// (404) to exercise the default-off graceful path.
let summaryEnabled = true;
diag.setSummaryEnabled = (on: boolean): void => {
  summaryEnabled = on;
};
// Aggregation reference clock + freshness window (mirrors web_app.py 300s).
const AGG_NOW = AUDIT_TS0 + 1000;
const AGG_FRESHNESS = 300;

// Handoff (V17-W2): export task -> signed allowlist package; receiver-local
// accept after explicit human decision. Mirrors web_app.py /api/handoff/*:
// signed envelope {algorithm, key_id, payload, signature}, trust = key_id in
// allowlist + signature match, expiry by payload + receiver ttl, idempotent by
// handoff_id. default OFF on the real backend — mock defaults ON so the panel
// is exercisable; diag.setHandoffEnabled(false) reproduces the disabled path.
let handoffEnabled = true;
diag.setHandoffEnabled = (on: boolean): void => {
  handoffEnabled = on;
};

// Slack board digest (a real Setup toggle — operators turn it on/off in the GUI).
let digestEnabled = true;
diag.setDigestEnabled = (on: boolean): void => {
  digestEnabled = on;
};

const guiFeatureKeys = [
  "quota",
  "intake",
  "node-input",
  "digest",
  "summary",
  "handoff",
  "usage-trend",
  "retro-analytics",
] as const;
type GuiFeatureKey = (typeof guiFeatureKeys)[number];

function guiFeatureEnabled(key: GuiFeatureKey): boolean {
  switch (key) {
    case "quota":
      return quotaEnabled;
    case "intake":
      return slackIntakeEnabled === true;
    case "node-input":
      return nodeInputEnabled;
    case "summary":
      return summaryEnabled;
    case "handoff":
      return handoffEnabled;
    case "usage-trend":
      return usageTrendEnabled;
    case "retro-analytics":
      return retroAnalyticsEnabled;
    case "digest":
      return digestEnabled;
  }
}

function setGuiFeatureEnabled(key: GuiFeatureKey, enabled: boolean): void {
  switch (key) {
    case "quota":
      quotaEnabled = enabled;
      return;
    case "intake":
      slackIntakeEnabled = enabled;
      return;
    case "node-input":
      nodeInputEnabled = enabled;
      return;
    case "summary":
      summaryEnabled = enabled;
      return;
    case "handoff":
      handoffEnabled = enabled;
      return;
    case "usage-trend":
      usageTrendEnabled = enabled;
      return;
    case "retro-analytics":
      retroAnalyticsEnabled = enabled;
      return;
    case "digest":
      digestEnabled = enabled;
      return;
  }
}

function guiFeaturesPayload() {
  return {
    project: "dev10",
    features: Object.fromEntries(
      guiFeatureKeys.map((key) => [
        key,
        {
          enabled: guiFeatureEnabled(key),
          configured: false,
          source: "cli",
        },
      ]),
    ),
  };
}

const HANDOFF_NOW = AUDIT_TS0 + 1000; // accept reference clock (epoch seconds)
const HANDOFF_TTL = 86_400; // receiver ttl (seconds)
const HANDOFF_TRUSTED = new Set(["room-alpha"]); // allowlisted signer key_ids
const acceptedHandoffs = new Set<string>(); // idempotency ledger (handoff_id)
let handoffSeq = 0;
// Deterministic stand-in for HMAC-SHA256 over key_id + canonical payload. Any
// mutation of payload (tampering) flips the digest; recompute-and-compare on
// accept is what rejects tampered packages. Stable across parse->stringify.
function mockHandoffSig(keyId: string, payload: unknown): string {
  const s = keyId + "|" + JSON.stringify(payload);
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0;
  return "hs_" + (h >>> 0).toString(16).padStart(8, "0");
}

// Shared-access connection (V18-W2): one-time join codes + share URL. Mirrors
// web_app.py /api/share (operator-only) + /api/join (code -> member session) +
// _require_shared_access_enabled (404 when off). default ON in the mock so the
// connect panel is exercisable; diag.setSharedAccess(false) reproduces the 404
// disabled path. A stable demo code is seeded so a ?join= deep-link verifies
// even after a fresh page load (the real code would be the issued one).
let sharedAccessEnabled = true;
diag.setSharedAccess = (on: boolean): void => {
  sharedAccessEnabled = on;
};
const JOIN_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_. -]{0,63}$/; // mirrors JOIN_MEMBER_NAME_RE
const SHARE_DEMO_CODE = "grove-demo-join-0001"; // stable valid one-time code (deep-link demo)
const SHARE_EXPIRED_CODE = "grove-expired-0002"; // always 410 (expiry path)
const joinCodes = new Set<string>([SHARE_DEMO_CODE]); // live one-time codes
const joinedNames = new Set<string>(["root"]); // existing member names -> 409 on collision
let joinSeq = 0;

// Per-member ledger + soft quota + host pressure (V19-W2). Mirrors web_app.py
// /api/ledger + /api/quota + _host_pressure_payload. quota default ON so the
// operator control is exercisable; diag.setQuotaEnabled(false) -> 404 + the
// graceful disabled notice. diag.setHostSaturated(true) flips the pressure warn.
// agy member -> cost/credit honestly unknown; soft quota NEVER hard-kills.
let quotaEnabled = true;
diag.setQuotaEnabled = (on: boolean): void => {
  quotaEnabled = on;
};
let hostSaturated = false;
diag.setHostSaturated = (on: boolean): void => {
  hostSaturated = on;
};
type LedMetric = { value: number | null; source: string; confidence: string; status?: string };
const ledMetric = (value: number, source: string, confidence: string): LedMetric => ({ value, source, confidence });
const ledUnknown = (source = "none"): LedMetric => ({ value: null, source, confidence: "unknown", status: "unknown" });
type QuotaSeed = {
  configured: boolean;
  enabled: boolean;
  soft_run_limit?: number;
  soft_token_limit?: number;
  soft_cost_usd?: number;
  updated_at?: number;
};
// member_id -> operator-set soft quota. Seeded so verify sees an exceeded case.
const quotaStates: Record<string, QuotaSeed> = {
  "m-alice": { configured: true, enabled: true, soft_run_limit: 50, soft_token_limit: 1_000_000, updated_at: AUDIT_TS0 },
  "m-bob": { configured: true, enabled: true, soft_run_limit: 20, updated_at: AUDIT_TS0 }, // 30 runs > 20 -> throttle
};
const LEDGER_MEMBERS: Record<string, { name: string; role: string }> = {
  "m-alice": { name: "alice", role: "operator" },
  "m-bob": { name: "bob", role: "operator" },
  "m-carol": { name: "carol", role: "viewer" },
  v1: { name: "viewer1", role: "viewer" },
};
function quotaPublic(memberId: string, runs: number, totalTokens: number | null): Record<string, unknown> {
  const st = quotaEnabled ? quotaStates[memberId] : undefined;
  const configured = !!st?.configured;
  const enabled = quotaEnabled && !!st?.enabled && configured;
  const reasons: string[] = [];
  if (enabled && st) {
    if (st.soft_run_limit != null && runs > st.soft_run_limit) reasons.push("runs");
    if (st.soft_token_limit != null && totalTokens != null && totalTokens > st.soft_token_limit) reasons.push("tokens");
    // cost is honestly unknown -> never counts as a cost exceed.
  }
  const exceeded = reasons.length > 0;
  const payload: Record<string, unknown> = {
    configured,
    enabled,
    mode: "soft",
    hard_kill: false,
    status: exceeded ? "exceeded" : enabled ? "ok" : "disabled",
    soft_throttle: { active: exceeded, action: exceeded ? "queue-delay" : "none", reasons, hard_kill: false },
  };
  if (st?.soft_run_limit != null) payload.soft_run_limit = st.soft_run_limit;
  if (st?.soft_token_limit != null) payload.soft_token_limit = st.soft_token_limit;
  if (st?.soft_cost_usd != null) payload.soft_cost_usd = st.soft_cost_usd;
  if (st?.updated_at != null) payload.updated_at = st.updated_at;
  if (enabled && st?.soft_cost_usd != null) payload.cost_warning = "cost usage is unknown; cost quota is warning-only";
  return payload;
}
function ledgerRollup(memberId: string, runs: number, totalTokens: number | null, agy: boolean): Record<string, unknown> {
  const known = totalTokens != null;
  const quota = quotaPublic(memberId, runs, totalTokens);
  const warnings: string[] = [];
  if (agy) warnings.push("agy credit is unknown because no reliable local credit source is configured");
  const throttle = quota.soft_throttle as { active?: boolean } | undefined;
  if (throttle?.active) warnings.push("soft quota exceeded; new work may be delayed, running tasks are not killed");
  if (typeof quota.cost_warning === "string") warnings.push(quota.cost_warning);
  const meta = LEDGER_MEMBERS[memberId] ?? { name: "", role: "unknown" };
  const rollup: Record<string, unknown> = {
    member: { id: memberId, name: meta.name || null, role: meta.role },
    totals: {
      runs: ledMetric(runs, "run_metadata", "explicit"),
      input_tokens: known ? ledMetric(Math.round(totalTokens * 0.6), "run_metadata", "explicit") : ledUnknown(),
      output_tokens: known ? ledMetric(Math.round(totalTokens * 0.4), "run_metadata", "explicit") : ledUnknown(),
      total_tokens: known ? ledMetric(totalTokens, "run_metadata", "explicit") : ledUnknown(),
      cost_usd_estimate: ledUnknown("estimate"), // cost honestly unknown — never invented
      confidence: known ? "explicit" : "unknown",
    },
    quota,
  };
  if (warnings.length) rollup.warnings = [...new Set(warnings)].sort();
  return rollup;
}
function hostPressurePayload(): Record<string, unknown> {
  const running = hostSaturated ? 6 : 4;
  const capacity = 5;
  const ratio = Math.round((running / capacity) * 1000) / 1000;
  return {
    status: ratio >= 1 ? "saturated" : "nominal",
    running: ledMetric(running, "run_metadata", "explicit"),
    capacity: ledMetric(capacity, "registry", "inferred"),
    ratio: ledMetric(ratio, "run_metadata+registry", "inferred"),
    load_1m: ledMetric(2.5, "os", "explicit"),
    blocked_tasks: ledMetric(1, "board", "explicit"),
  };
}

// Retro analytics (V22-W2). Mirrors web_app.py /api/retro/analytics EXACTLY:
// ADVISORY + read-only (mode "advisory", actions []), operator-only (403 viewer),
// default OFF (404). confidence "low" for small samples. agy credit unknown.
// quotaEnabled-style toggles let verify exercise enabled/disabled + low/medium.
let retroAnalyticsEnabled = true;
diag.setRetroAnalyticsEnabled = (on: boolean): void => {
  retroAnalyticsEnabled = on;
};
let retroLowConfidence = false;
diag.setRetroLowConfidence = (on: boolean): void => {
  retroLowConfidence = on;
};
// Allowlist theme keywords — mirror web_app.py RETRO_THEME_TERMS.
const RETRO_THEME_TERMS: Record<string, string[]> = {
  testing: ["test", "tests", "pytest", "coverage", "flake", "flaky"],
  blocked: ["blocked", "stuck", "waiting", "dependency"],
  scope: ["scope", "requirement", "contract"],
  review: ["review", "reviewer", "feedback"],
  tooling: ["ruff", "mypy", "pytest", "lint", "format", "tooling"],
};
function retroAnalyticsPayload(): Record<string, unknown> {
  const low = retroLowConfidence;
  const conf = low ? "low" : "medium";
  const cm = (v: number, src: string, c = conf) => ledMetric(v, src, c);
  const theme = (name: string, count: number) => ({ theme: name, count: cm(count, "retro_comments"), keywords: RETRO_THEME_TERMS[name] ?? [] });
  const outcome = (key: "node" | "role", name: string, vals: [number, number, number, number, number], extra?: Record<string, string>) => ({
    [key]: name,
    ...(extra ?? {}),
    completed: cm(vals[0], "run_metadata"),
    blocked: cm(vals[1], "run_metadata"),
    failed: cm(vals[2], "run_metadata"),
    running: cm(vals[3], "run_metadata"),
    other: cm(vals[4], "run_metadata"),
  });
  const limitations = [
    "advisory-only: this endpoint does not create tasks, change config, or dispatch work",
    "themes are deterministic allowlist categories from redacted retro text",
    "slow patterns use measured run timestamps only",
    "agy credit is unknown; no credit or cost values are invented",
  ];
  if (low) limitations.push("small sample size; confidence is low");
  const throughput = low
    ? [{ bucket: "2026-06-03", completed: cm(1, "run_metadata") }]
    : [
        { bucket: "2026-05-31", completed: cm(2, "run_metadata") },
        { bucket: "2026-06-01", completed: cm(3, "run_metadata") },
        { bucket: "2026-06-02", completed: cm(1, "run_metadata") },
        { bucket: "2026-06-03", completed: cm(4, "run_metadata") },
        { bucket: "2026-06-04", completed: cm(3, "run_metadata") },
      ];
  const themes = low ? [theme("testing", 1)] : [theme("testing", 4), theme("blocked", 2), theme("review", 1)];
  return {
    ok: true,
    project: "dev10",
    mode: "advisory",
    actions: [],
    generated_at: ledMetric(AUDIT_TS0 + 700, "server", "explicit"),
    window: { name: "7d" },
    confidence: conf,
    sample: {
      completed_runs: ledMetric(low ? 1 : 13, "run_metadata", "explicit"),
      retro_comments: ledMetric(low ? 1 : 6, "comments", "explicit"),
      blocked_tasks: ledMetric(low ? 1 : 2, "tasks", "explicit"),
    },
    throughput,
    themes,
    patterns: {
      blocked: {
        current: ledMetric(low ? 1 : 2, "tasks", "explicit"),
        by_assignee: low
          ? [{ assignee: "frontend", count: cm(1, "tasks") }]
          : [
              { assignee: "frontend", count: cm(1, "tasks") },
              { assignee: "backend", count: cm(1, "tasks") },
            ],
        blocked_runs: cm(1, "run_metadata"),
      },
      slow: {
        threshold_seconds: ledMetric(3600, "server", "explicit"),
        count: cm(low ? 0 : 1, "run_metadata"),
        average_duration_seconds: low ? ledUnknown() : cm(5400, "run_metadata"),
      },
    },
    outcomes: {
      by_node: low
        ? [outcome("node", "backend", [1, 1, 0, 0, 0], { role: "backend", agent: "codex" })]
        : [
            outcome("node", "backend", [5, 1, 0, 1, 0], { role: "backend", agent: "codex" }),
            outcome("node", "frontend", [4, 0, 1, 0, 0], { role: "frontend", agent: "claude" }),
          ],
      by_role: low
        ? [outcome("role", "backend", [1, 1, 0, 0, 0])]
        : [
            outcome("role", "backend", [5, 1, 0, 1, 0]),
            outcome("role", "frontend", [4, 0, 1, 0, 0]),
          ],
    },
    cost_signals: { agy_credit: ledUnknown() },
    limitations,
  };
}

// Usage trend / anomaly (V23-W2). Mirrors web_app.py /api/usage/trend EXACTLY:
// ADVISORY read-only (mode "advisory", actions [], enforcement.called false),
// operator-only (403 viewer), default OFF (404). Deterministic anomaly flag
// (ratio>=2 or z>=3), labelled forecast ("not a prediction"), agy cost unknown
// across trend/anomaly/forecast/day-totals (never a spike). thin data -> low conf.
let usageTrendEnabled = true;
diag.setUsageTrendEnabled = (on: boolean): void => {
  usageTrendEnabled = on;
};

// Notification routing v2 (V24-W2). Mirrors web_app.py /api/notifications/routing:
// GET readable by any member; POST operator-only (403 viewer). default dry-run.
// configured=false => never set up (graceful). diag.setRoutingConfigured(false)
// reproduces the unconfigured path.
let routingConfigured = true;
diag.setRoutingConfigured = (on: boolean): void => {
  routingConfigured = on;
};
type RoutingTarget = { channel_kind: string; room_id: string };
type RoutingRule = {
  name: string;
  event_type: string;
  node?: string;
  severity?: string;
  target: RoutingTarget;
  escalation_targets: RoutingTarget[];
  max_escalations: number;
  escalate_after_seconds?: number;
};
let routingState: { configured: boolean; enabled: boolean; dry_run: boolean; rules: RoutingRule[] } = {
  configured: true,
  enabled: true,
  dry_run: true, // default OFF the wire — dry-run, no real sends
  rules: [
    {
      name: "blocked-to-ops",
      event_type: "blocked",
      node: "backend",
      severity: "high",
      target: { channel_kind: "slack", room_id: "C-ops" },
      escalation_targets: [{ channel_kind: "slack", room_id: "C-leads" }],
      max_escalations: 1,
      escalate_after_seconds: 900,
    },
    {
      name: "ask-human",
      event_type: "ask_human_pending",
      target: { channel_kind: "slack", room_id: "C-team" },
      escalation_targets: [],
      max_escalations: 0,
    },
  ],
};
const UT_WINDOWS: Record<string, number> = { "7d": 7, "14d": 14, "30d": 30 };
const utMean = (vals: number[]): number => (vals.length ? vals.reduce((s, v) => s + v, 0) / vals.length : 0);
const utStdev = (vals: number[], mean: number): number =>
  vals.length ? Math.sqrt(vals.reduce((s, v) => s + (v - mean) ** 2, 0) / vals.length) : 0;
const round6 = (n: number): number => Math.round(n * 1e6) / 1e6;
function utTotals(tokens: number, cost: number | null, runs: number, conf: string): Record<string, unknown> {
  return {
    runs: ledMetric(runs, "run_metadata", "explicit"),
    input_tokens: ledMetric(Math.round(tokens * 0.6), "run_metadata", conf),
    output_tokens: ledMetric(Math.round(tokens * 0.4), "run_metadata", conf),
    total_tokens: ledMetric(tokens, "run_metadata", conf),
    cost_usd_estimate: cost === null ? ledUnknown("estimate") : ledMetric(cost, "run_metadata", conf),
    confidence: conf,
  };
}
function utTrendSignal(values: number[], conf: string, unknown: boolean): Record<string, unknown> {
  if (unknown) return ledUnknown("estimate");
  if (values.length < 2) return { value: null, source: "run_metadata", confidence: "low", status: "unknown" };
  const baseline = utMean(values.slice(0, -1));
  const latest = values[values.length - 1]!;
  return {
    latest: ledMetric(round6(latest), "run_metadata", conf),
    baseline: ledMetric(round6(baseline), "run_metadata", conf),
    delta: ledMetric(round6(latest - baseline), "run_metadata", conf),
    ratio: baseline > 0 ? ledMetric(round6(latest / baseline), "run_metadata", conf) : ledUnknown("none"),
  };
}
function utAnomalySignal(values: number[], conf: string, excluded: boolean): Record<string, unknown> {
  if (excluded) return { flagged: false, reason: "excluded: agy cost is unknown", confidence: "unknown" };
  if (values.length < 4) return { flagged: false, reason: "insufficient baseline data", confidence: "low" };
  const baselineVals = values.slice(0, -1);
  const latest = values[values.length - 1]!;
  const baseline = utMean(baselineVals);
  const stdev = utStdev(baselineVals, baseline);
  const ratio = baseline > 0 ? latest / baseline : 0;
  const zscore = stdev > 0 ? (latest - baseline) / stdev : 0;
  const flagged = ratio >= 2.0 || zscore >= 3.0;
  return {
    flagged,
    reason: flagged ? "spike" : "within baseline",
    latest: ledMetric(round6(latest), "run_metadata", conf),
    baseline: ledMetric(round6(baseline), "run_metadata", conf),
    ratio: ledMetric(round6(ratio), "run_metadata", conf),
    zscore: ledMetric(round6(zscore), "run_metadata", conf),
    confidence: conf,
  };
}
function utForecastSignal(values: number[], conf: string, unknown: boolean): Record<string, unknown> {
  if (unknown) return ledUnknown("estimate");
  if (values.length < 2) return { value: null, source: "run_metadata", confidence: "low", status: "unknown" };
  const latest = values[values.length - 1]!;
  const prev = values[values.length - 2]!;
  return ledMetric(round6(Math.max(0, latest + (latest - prev))), "run_metadata", conf);
}
function utNode(node: string, agent: string, dayTokens: number[], dayCosts: number[]): Record<string, unknown> {
  const conf = dayTokens.length < 4 ? "low" : "medium";
  const isAgy = agent === "agy";
  const costValues = isAgy ? [] : dayCosts;
  const days = dayTokens.map((tok, i) => ({
    day: `2026-06-${String(i + 1).padStart(2, "0")}`,
    totals: utTotals(tok, isAgy ? null : (dayCosts[i] ?? null), 3, conf),
  }));
  const warnings: string[] = [];
  if (conf === "low") warnings.push("thin data; trend and forecast confidence is low");
  if (isAgy) warnings.push("agy cost is unknown and excluded from cost anomaly checks");
  return {
    node,
    agent,
    confidence: conf,
    days,
    trend: { total_tokens: utTrendSignal(dayTokens, conf, false), cost_usd_estimate: utTrendSignal(costValues, conf, isAgy) },
    anomaly: { total_tokens: utAnomalySignal(dayTokens, conf, false), cost_usd_estimate: utAnomalySignal(costValues, conf, isAgy) },
    forecast: {
      label: "simple extrapolation; not a prediction",
      total_tokens_next_day: utForecastSignal(dayTokens, conf, false),
      cost_usd_next_day: utForecastSignal(costValues, conf, isAgy),
    },
    ...(warnings.length ? { warnings } : {}),
  };
}
function usageTrendPayload(windowName: string): Record<string, unknown> {
  const name = UT_WINDOWS[windowName] ? windowName : "14d";
  const days = UT_WINDOWS[name]!;
  const since = AUDIT_TS0 - days * 86_400;
  const hasAgy = true;
  const limitations = [
    "advisory-only: signals do not throttle, abort, kill, dispatch, or change config",
    "trend and anomaly signals use explicit run metadata only",
    "forecast is a simple labeled extrapolation, not a prediction",
    "agy cost is unknown and excluded from cost anomaly checks",
  ];
  if (!hasAgy) limitations.pop();
  return {
    ok: true,
    project: "dev10",
    mode: "advisory",
    actions: [],
    enforcement: { called: false },
    generated_at: ledMetric(AUDIT_TS0 + 800, "server", "explicit"),
    window: {
      name,
      days: ledMetric(days, "server", "explicit"),
      since: ledMetric(since, "server", "explicit"),
      until: ledMetric(AUDIT_TS0, "server", "explicit"),
    },
    filters: { member: null },
    nodes: [
      // codex node with a clear token spike on the latest day (ratio ~2.86 -> flagged).
      utNode("backend", "codex", [100_000, 110_000, 105_000, 300_000], [3.0, 3.2, 3.1, 4.0]),
      // agy node: tokens known + within baseline (no spike), cost unknown -> cost
      // anomaly excluded. Kept flat so neither ratio>=2 nor z>=3 trips a token flag.
      utNode("frontend", "agy", [52_000, 53_000, 52_500, 53_000], []),
      // thin-data node: 2 days -> low confidence, anomaly "insufficient baseline".
      utNode("researcher", "codex", [20_000, 40_000], [1.0, 2.0]),
    ],
    limitations,
  };
}

const execGateInfo = () => {
  const blocked: string[] = [];
  if (!executionGate.enabled) blocked.push("global-disabled");
  if (executionGate.kill_switch) blocked.push("global-kill-switch");
  if (!executionGate.board_enabled) blocked.push("board-disabled");
  if (executionGate.board_kill_switch) blocked.push("board-kill-switch");
  return {
    allowed: blocked.length === 0,
    blocked_by: blocked,
    global_enabled: executionGate.enabled,
    global_kill_switch: executionGate.kill_switch,
    board_enabled: executionGate.board_enabled,
    board_kill_switch: executionGate.board_kill_switch,
    node_enabled: true,
    node_kill_switch: false,
    task_kill_switch: false,
  };
};

interface ProjectMock {
  name: string;
  display_name?: string;
  board?: string;
  dashboardCommand?: string;
  default_assignee?: string;
  project_master?: { name: string; status: string };
  workspace: string;
  node_count: number;
  status: string;
}
// internal name (e.g. dev10) stays the identity; display_name is the human label.
const PROJECTS: ProjectMock[] = [
  { name: "dev10", display_name: "grove-dev", workspace: "~/dev/grove", node_count: 5, status: "running" },
  { name: "infra-ops", workspace: "~/dev/infra", node_count: 2, status: "idle", display_name: "grove-infra" },
  { name: SOLO_PROJECT, workspace: "~/dev/solo", node_count: 1, status: "running", display_name: "solo-x" },
];
function projectDisplayName(name: string): string {
  return PROJECTS.find((p) => p.name === name)?.display_name ?? name;
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

// PR1 watchdog: per-node health, mirroring web_app.py _node_health_payload
// (GET /api/node-health -> { project, session, nodes: [...] }). Covers a spread
// of the six real statuses; nodes absent here render a neutral "unknown" badge.
const MOCK_NODE_HEALTH = [
  { node: "root", status: "healthy", reason: null, message: null, detected_at: 1780540000, reset_at: null, source: "watchdog", project: "dev10", session: "grove", updated_at: 1780540000 },
  { node: "backend", status: "rate_limited", reason: "provider 429", message: "retry after 30s", detected_at: 1780540100, reset_at: 1780540400, source: "watchdog", project: "dev10", session: "grove", updated_at: 1780540100 },
  { node: "frontend", status: "login_required", reason: "session expired", message: null, detected_at: 1780540200, reset_at: null, source: "watchdog", project: "dev10", session: "grove", updated_at: 1780540200 },
  { node: "researcher", status: "crashed", reason: "exited non-zero", message: null, detected_at: 1780540300, reset_at: null, source: "watchdog", project: "dev10", session: "grove", updated_at: 1780540300 },
  { node: "docs", status: "cooldown", reason: "post-rate-limit backoff", message: null, detected_at: 1780540400, reset_at: 1780540700, source: "watchdog", project: "dev10", session: "grove", updated_at: 1780540400 },
];

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

  if (p === "/api/node-health") {
    diag.nodeHealthFetched = true;
    const one = u.searchParams.get("node");
    const nodes = one ? MOCK_NODE_HEALTH.filter((h) => h.node === one) : MOCK_NODE_HEALTH;
    return Promise.resolve(json({ project: "dev10", session: "grove", nodes }));
  }

  if (p === "/api/status") {
    diag.statusFetches = ((diag.statusFetches as number) ?? 0) + 1;
    const proj = (init?.headers as Record<string, string> | undefined)?.["X-Grove-Project"] ?? "dev10";
    // Mirrors web_app.py _node_liveness_summary: each node classified once into
    // running/stale/error, everything else idle. Registry "active" aliases to
    // running/live; error is NOT folded into stale.
    const statuses = ORG_NODES.map((n) => mockNodeLivenessStatus(n.status));
    const running = statuses.filter((s) => s === "running").length;
    const stale = statuses.filter((s) => s === "stale").length;
    const error = statuses.filter((s) => s === "error").length;
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
        const status = mockNodeDetailStatus(n.status);
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
    const response = json(body);
    if (statusDelayMs > 0) {
      return new Promise((resolve) => setTimeout(() => resolve(response), statusDelayMs));
    }
    return Promise.resolve(response);
  }

  if (p === "/api/gui-features") {
    diag.guiFeaturesFetched = true;
    return Promise.resolve(json(guiFeaturesPayload()));
  }

  const guiMatch = p.match(/^\/api\/gui-features\/([^/]+)$/);
  if (guiMatch && method === "POST") {
    const key = decodeURIComponent(guiMatch[1] ?? "") as GuiFeatureKey;
    if (!guiFeatureKeys.includes(key)) {
      return Promise.resolve(new Response(JSON.stringify({ detail: "unknown GUI feature" }), { status: 404 }));
    }
    if (viewerMode) {
      return Promise.resolve(new Response(JSON.stringify({ detail: "GUI feature toggles require operator role" }), { status: 403 }));
    }
    const body = (init?.body ? JSON.parse(init.body as string) : {}) as { enabled?: boolean };
    setGuiFeatureEnabled(key, body.enabled === true);
    diag.guiFeaturePost = { key, enabled: body.enabled === true };
    diag.guiFeaturePostCount = ((diag.guiFeaturePostCount as number) ?? 0) + 1;
    return Promise.resolve(
      json({
        ok: true,
        project: "dev10",
        key,
        feature: {
          enabled: guiFeatureEnabled(key),
          configured: true,
          source: "gui",
        },
        features: guiFeaturesPayload().features,
      }),
    );
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

  if (p === "/api/usage") {
    // Mirrors web_app.py _usage_payload: node/day rollup. agy stays honestly
    // unknown (credit_remaining null/unknown + warnings) — never fabricated.
    diag.usageFetched = true;
    const proj = (init?.headers as Record<string, string> | undefined)?.["X-Grove-Project"] ?? "dev10";
    const um = (value: number | null, source: string, confidence: string, status?: string) =>
      status ? { value, source, confidence, status } : { value, source, confidence };
    // Mirrors web_app.py _usage_from_runs/_usage_*_metric: tokens come from run
    // metadata (source "run_metadata", confidence "explicit" when present);
    // tokens stay KNOWN even when cost is unknown. Cost when absent -> source
    // "estimate"/unknown; agy credit -> source "none"/unknown. (P2 fix: agy
    // tokens are known from metadata — only cost + credit are honestly unknown.)
    const tokM = (tok: number | null) =>
      tok === null ? um(null, "none", "unknown", "unknown") : um(tok, "run_metadata", "explicit");
    const totals = (runs: number, tok: number | null, usd: number | null) => ({
      runs: um(runs, "run_metadata", "explicit"),
      input_tokens: tokM(tok === null ? null : Math.round(tok * 0.8)),
      output_tokens: tokM(tok === null ? null : Math.round(tok * 0.2)),
      total_tokens: tokM(tok),
      cost_usd_estimate: usd === null ? um(null, "estimate", "unknown", "unknown") : um(usd, "run_metadata", "explicit"),
      confidence: tok === null ? "unknown" : "explicit",
    });
    const agyWarn = ["agy credit is unknown because no reliable local credit source is configured"];
    return Promise.resolve(
      json({
        project: proj,
        generated_at: um(AUDIT_TS0 + 600, "server", "explicit"),
        window: { name: "7d" },
        filters: { node: null, agent: null },
        totals: totals(11, 890123, 8.9),
        nodes: [
          {
            node: "backend",
            agent: "codex",
            totals: totals(8, 890123, 8.9),
            days: [
              { day: "2026-06-03", totals: totals(3, 300000, 3.0) },
              { day: "2026-06-04", totals: totals(5, 590123, 5.9) },
            ],
          },
          {
            node: "agy-1",
            agent: "agy",
            // agy tokens ARE known from run metadata (44); only cost + credit are
            // honestly unknown — never fabricated.
            totals: totals(3, 44, null),
            warnings: agyWarn,
            credit_remaining: um(null, "none", "unknown", "unknown"),
            credit_status: "unknown",
            days: [{ day: "2026-06-04", totals: totals(3, 44, null) }],
          },
        ],
        days: [
          {
            day: "2026-06-03",
            totals: totals(3, 300000, 3.0),
            nodes: [{ node: "backend", agent: "codex", totals: totals(3, 300000, 3.0) }],
          },
          {
            day: "2026-06-04",
            totals: totals(8, 590123, 5.9),
            nodes: [
              { node: "backend", agent: "codex", totals: totals(5, 590123, 5.9) },
              { node: "agy-1", agent: "agy", totals: totals(3, 44, null), warnings: agyWarn, credit_remaining: um(null, "none", "unknown", "unknown"), credit_status: "unknown" },
            ],
          },
        ],
        limitations: ["usage rollups only use explicit run metadata fields", "agy credit is unknown without a reliable local credit source"],
      }),
    );
  }

  if (p === "/api/summary") {
    // Mirrors web_app.py _signed_summary_payload (signed allowlist summary). 404
    // when export disabled. Only key_id is exposed (signature is opaque). The
    // raw counts may include a non-allowlist status ("weird") — the aggregator's
    // public view buckets it to "other".
    if (!summaryEnabled) {
      return Promise.resolve(new Response(JSON.stringify({ detail: "summary export is not enabled" }), { status: 404 }));
    }
    diag.summaryFetched = true;
    const proj = (init?.headers as Record<string, string> | undefined)?.["X-Grove-Project"] ?? "dev10";
    return Promise.resolve(
      json({
        algorithm: "hmac-sha256",
        key_id: "room-alpha",
        payload: {
          schema: "grove.summary.v1",
          project: proj,
          version: "1.16",
          generated_at: AGG_NOW,
          summary: {
            boards: { total: 1 },
            tasks: { total: 7, by_status: { ready: 2, running: 1, done: 3, weird: 1 } },
            nodes: { total: 5, by_status: { running: 2, idle: 2, error: 1 }, by_agent: { codex: 2, claude: 3 } },
            runs: { total: 3, by_status: { ok: 3 } },
          },
        },
        signature: "sig-alpha-opaque",
      }),
    );
  }

  if (p === "/api/aggregate" && method === "POST") {
    // Mirrors web_app.py _aggregate_summary_payload: process the ACTUALLY
    // submitted summaries — key_id trust (allowlist), freshness by generated_at,
    // public view clamped to enum allowlists ("other"), combined=trusted+fresh.
    // No fabrication: only submitted rooms appear.
    if (!summaryEnabled) {
      return Promise.resolve(new Response(JSON.stringify({ detail: "summary export is not enabled" }), { status: 404 }));
    }
    diag.aggregated = true;
    const body = (init?.body ? JSON.parse(init.body as string) : {}) as { summaries?: unknown[] };
    const submitted = Array.isArray(body.summaries) ? body.summaries : [];
    diag.aggregateSubmitted = submitted.length;
    const TRUSTED = new Set(["room-alpha", "room-beta"]); // own + allowlisted peer
    const TASK = new Set(["ready", "running", "blocked", "done", "archived"]);
    const RUN = new Set(["running", "ok", "blocked", "failed", "released"]);
    const NSTAT = new Set(["running", "idle", "error", "blocked", "dead", "stale"]);
    const NAGENT = new Set(["codex", "claude", "antigravity", "agy"]);
    const clamp = (obj: unknown, allowed: Set<string>): Record<string, number> => {
      const out: Record<string, number> = {};
      if (obj && typeof obj === "object") {
        for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
          const key = allowed.has(String(k).toLowerCase()) ? String(k).toLowerCase() : "other";
          out[key] = (out[key] ?? 0) + (Number(v) || 0);
        }
      }
      return out;
    };
    const publicView = (pl: Record<string, unknown>) => {
      const s = (pl.summary ?? {}) as Record<string, Record<string, unknown>>;
      const sec = (k: string) => (s[k] ?? {}) as Record<string, unknown>;
      return {
        schema: "grove.summary.v1",
        project: pl.project,
        version: pl.version,
        generated_at: Number(pl.generated_at) || 0,
        summary: {
          boards: { total: Number(sec("boards").total) || 0 },
          tasks: { total: Number(sec("tasks").total) || 0, by_status: clamp(sec("tasks").by_status, TASK) },
          nodes: {
            total: Number(sec("nodes").total) || 0,
            by_status: clamp(sec("nodes").by_status, NSTAT),
            by_agent: clamp(sec("nodes").by_agent, NAGENT),
          },
          runs: { total: Number(sec("runs").total) || 0, by_status: clamp(sec("runs").by_status, RUN) },
        },
      };
    };
    const items = submitted.map((raw) => {
      const env = (raw ?? {}) as Record<string, unknown>;
      if (typeof env.payload !== "object" || env.payload === null || typeof env.signature !== "string")
        return { trust: "untrusted", freshness: "unknown", reason: "invalid summary envelope" };
      if (env.algorithm !== "hmac-sha256")
        return { trust: "untrusted", freshness: "unknown", reason: "unsupported summary algorithm" };
      if (typeof env.key_id !== "string" || !TRUSTED.has(env.key_id))
        return { trust: "untrusted", freshness: "unknown", reason: "unknown summary key" };
      const pv = publicView(env.payload as Record<string, unknown>);
      if (pv.generated_at > AGG_NOW + 60)
        return { trust: "untrusted", freshness: "unknown", reason: "summary timestamp is invalid" };
      const freshness = AGG_NOW - pv.generated_at > AGG_FRESHNESS ? "stale" : "fresh";
      return { trust: "trusted", freshness, key_id: env.key_id, project: pv.project, generated_at: pv.generated_at, payload: pv };
    });
    const fresh = items.filter((i) => i.trust === "trusted" && i.freshness === "fresh").map((i) => i.payload!);
    const combineSec = (section: string, keys: string[]) => {
      const out: Record<string, unknown> = { total: 0 };
      let total = 0;
      const grouped: Record<string, Record<string, number>> = {};
      for (const key of keys) grouped[key] = {};
      for (const p of fresh) {
        const sec = ((p.summary as Record<string, Record<string, unknown>>)[section] ?? {}) as Record<string, unknown>;
        total += Number(sec.total) || 0;
        for (const key of keys) {
          for (const [k, v] of Object.entries((sec[key] ?? {}) as Record<string, unknown>)) {
            grouped[key]![k] = (grouped[key]![k] ?? 0) + (Number(v) || 0);
          }
        }
      }
      out.total = total;
      for (const key of keys) out[key] = grouped[key];
      return out;
    };
    return Promise.resolve(
      json({
        generated_at: { value: AGG_NOW, source: "server", confidence: "explicit" },
        trust: {
          trusted: items.filter((i) => i.trust === "trusted").length,
          untrusted: items.filter((i) => i.trust === "untrusted").length,
          stale: items.filter((i) => i.trust === "trusted" && i.freshness === "stale").length,
        },
        summaries: items,
        combined: {
          sources: fresh.length,
          projects: [...new Set(fresh.map((p) => p.project).filter((x): x is string => typeof x === "string"))].sort(),
          boards: combineSec("boards", []),
          tasks: combineSec("tasks", ["by_status"]),
          nodes: combineSec("nodes", ["by_status", "by_agent"]),
          runs: combineSec("runs", ["by_status"]),
        },
        limitations: [
          "aggregate is read-only and does not perform cross-machine control",
          "stale summaries are excluded from the live combined rollup",
        ],
      }),
    );
  }

  if (p === "/api/handoff/export" && method === "POST") {
    // Mirrors web_app.py /api/handoff/export: a task -> signed package whose
    // payload is an ALLOWLIST projection (title/body/priority/labels only) plus
    // a key_id; the signing secret never appears (signature is opaque). 404 when
    // handoff is off. Read-only: exporting mutates nothing on the sender.
    if (!handoffEnabled) {
      return Promise.resolve(new Response(JSON.stringify({ detail: "handoff is not enabled" }), { status: 404 }));
    }
    const proj = (init?.headers as Record<string, string> | undefined)?.["X-Grove-Project"] ?? "dev10";
    const body = (init?.body ? JSON.parse(init.body as string) : {}) as { task_id?: string };
    const taskId = body.task_id ?? "G-4";
    const task = findTask(taskId) ?? { id: taskId, title: `task ${taskId}`, status: "ready" };
    const handoff_id = "handoff_pkg" + String(++handoffSeq).padStart(13, "0");
    // far-future expiry so receiver-local freshness reads "valid" regardless of
    // wall clock; accept still validates against the fixed HANDOFF_NOW clock.
    const payload = {
      schema: "grove.handoff.v1",
      handoff_id,
      source_project: proj,
      generated_at: HANDOFF_NOW,
      expires_at: 4_102_444_800,
      task: {
        title: task.title,
        body: task.body ?? null,
        priority: 0,
        labels: ["handoff", task.status],
      },
    };
    diag.handoffExported = handoff_id;
    return Promise.resolve(
      json({ algorithm: "hmac-sha256", key_id: "room-alpha", payload, signature: mockHandoffSig("room-alpha", payload) }),
    );
  }

  if (p === "/api/handoff/accept" && method === "POST") {
    // Mirrors web_app.py /api/handoff/accept: verify trust (key_id allowlist +
    // signature) and freshness, then create a local task ONLY on this explicit
    // call. tampered/unknown-key -> 403; expired -> 410; disabled -> 404. The
    // reason strings mirror _verify_handoff_envelope; fixed-message only, no raw
    // payload/secret echoed. Idempotent by handoff_id (created vs existing).
    const reject = (status: number, detail: string) =>
      Promise.resolve(new Response(JSON.stringify({ detail }), { status }));
    if (!handoffEnabled) return reject(404, "handoff is not enabled");
    const body = (init?.body ? JSON.parse(init.body as string) : {}) as { package?: Record<string, unknown> };
    const pkg = (body.package ?? {}) as Record<string, unknown>;
    if (typeof pkg.payload !== "object" || pkg.payload === null || typeof pkg.signature !== "string")
      return reject(403, "invalid handoff envelope");
    if (pkg.algorithm !== "hmac-sha256") return reject(403, "unsupported handoff algorithm");
    if (typeof pkg.key_id !== "string" || !HANDOFF_TRUSTED.has(pkg.key_id)) return reject(403, "unknown handoff key");
    if (pkg.signature !== mockHandoffSig(pkg.key_id, pkg.payload))
      return reject(403, "handoff signature verification failed");
    const pl = pkg.payload as Record<string, unknown>;
    const hid = pl.handoff_id;
    if (pl.schema !== "grove.handoff.v1" || typeof hid !== "string" || !/^handoff_[A-Za-z0-9_-]{16,}$/.test(hid))
      return reject(403, "invalid handoff payload");
    const gen = Number(pl.generated_at) || 0;
    const exp = Number(pl.expires_at) || 0;
    if (gen > HANDOFF_NOW + 60) return reject(403, "handoff timestamp is invalid");
    if (exp < HANDOFF_NOW) return reject(410, "handoff package expired");
    if (gen + HANDOFF_TTL < HANDOFF_NOW) return reject(410, "handoff package expired by receiver ttl");
    const ptask = (pl.task ?? {}) as Record<string, unknown>;
    const existing = acceptedHandoffs.has(hid);
    if (!existing) acceptedHandoffs.add(hid);
    diag.handoffAccepted = { id: hid, created: !existing };
    return Promise.resolve(
      json({
        status: existing ? "existing" : "created",
        created: !existing,
        handoff_id: hid,
        task: { id: "H-" + hid.slice(-4), title: ptask.title ?? "", status: "ready" },
        limitations: [
          "accept created a local task only; nothing was executed",
          "the receiver controls the local lifecycle from here",
        ],
      }),
    );
  }

  if (p === "/api/share" && method === "POST") {
    // Mirrors web_app.py /api/share: operator-only one-time join code + share URL
    // (index?join=<code>). 404 when shared access is off; 403 for viewers. The
    // signing secret never appears — only code/url/role/expiry.
    if (!sharedAccessEnabled)
      return Promise.resolve(new Response(JSON.stringify({ detail: "shared access is not enabled" }), { status: 404 }));
    if (viewerMode)
      return Promise.resolve(new Response(JSON.stringify({ detail: "share requires operator role" }), { status: 403 }));
    joinSeq += 1;
    const code = "join-" + String(joinSeq).padStart(4, "0") + "-" + (Math.abs((joinSeq * 2654435761) | 0)).toString(36);
    joinCodes.add(code);
    diag.shareIssued = code;
    const url = `${(window.location.href.split("?")[0] ?? "")}?join=${code}`;
    return Promise.resolve(json({ code, role: "operator", expires_at: HANDOFF_NOW + 600, url }));
  }

  if (p === "/api/join" && method === "POST") {
    // Mirrors web_app.py /api/join: exchange a one-time code + display name for a
    // member session. Validation order matches the backend: 404 disabled, then
    // name (400), rate-limit (429), expired (410), invalid (403), name-taken
    // (409). Codes are one-time (consumed). Joined role = shared_join_role
    // ("operator") so a joined peer can create projects. Fixed detail strings.
    if (!sharedAccessEnabled)
      return Promise.resolve(new Response(JSON.stringify({ detail: "shared access is not enabled" }), { status: 404 }));
    const body = (init?.body ? JSON.parse(init.body as string) : {}) as { code?: string; name?: string };
    const cleanName = (typeof body.name === "string" ? body.name : "").replace(/\s+/g, " ").trim();
    if (!JOIN_NAME_RE.test(cleanName))
      return Promise.resolve(new Response(JSON.stringify({ detail: "invalid member name" }), { status: 400 }));
    if (diag.joinRateLimited)
      return Promise.resolve(new Response(JSON.stringify({ detail: "join rate limit exceeded" }), { status: 429 }));
    const cleanCode = (typeof body.code === "string" ? body.code : "").trim();
    if (cleanCode === SHARE_EXPIRED_CODE)
      return Promise.resolve(new Response(JSON.stringify({ detail: "join code expired" }), { status: 410 }));
    if (!joinCodes.has(cleanCode))
      return Promise.resolve(new Response(JSON.stringify({ detail: "invalid join code" }), { status: 403 }));
    if (joinedNames.has(cleanName))
      return Promise.resolve(new Response(JSON.stringify({ detail: "member name already exists" }), { status: 409 }));
    joinCodes.delete(cleanCode); // one-time
    joinedNames.add(cleanName);
    joinSeq += 1;
    const member = { id: "member_" + String(joinSeq).padStart(3, "0"), name: cleanName, role: "operator" };
    diag.joined = { name: cleanName, role: member.role };
    return Promise.resolve(
      json({ auth_mode: "team_cookie", member, csrf: "csrf-" + member.id, expires_at: HANDOFF_NOW + 3600 }),
    );
  }

  if (p === "/api/notifications/routing") {
    // Mirrors web_app.py: GET any member (read-only view); POST operator-only.
    const proj = (init?.headers as Record<string, string> | undefined)?.["X-Grove-Project"] ?? "dev10";
    if (method === "POST") {
      if (viewerMode)
        return Promise.resolve(
          new Response(JSON.stringify({ detail: "notification routing requires operator role" }), { status: 403 }),
        );
      const body = (init?.body ? JSON.parse(init.body as string) : {}) as Partial<typeof routingState>;
      routingState = {
        configured: true,
        enabled: !!body.enabled,
        dry_run: body.dry_run !== false, // default dry-run unless explicitly false
        rules: Array.isArray(body.rules) ? (body.rules as RoutingRule[]) : [],
      };
      routingConfigured = true;
      diag.routingPosted = { enabled: routingState.enabled, dry_run: routingState.dry_run, rules: routingState.rules.length };
      return Promise.resolve(json({ ok: true, project: proj, routing: routingState }));
    }
    diag.routingFetches = ((diag.routingFetches as number) ?? 0) + 1;
    const routing = routingConfigured
      ? routingState
      : { configured: false, enabled: false, dry_run: true, rules: [] };
    return Promise.resolve(json({ project: proj, routing }));
  }

  if (p === "/api/usage/trend") {
    // Mirrors web_app.py /api/usage/trend: operator-only (403 viewer), default OFF
    // (404), ADVISORY read-only. window ∈ 7d|14d|30d (default 14d).
    diag.usageTrendFetches = ((diag.usageTrendFetches as number) ?? 0) + 1;
    if (!usageTrendEnabled)
      return Promise.resolve(new Response(JSON.stringify({ detail: "usage trend is not enabled" }), { status: 404 }));
    if (viewerMode)
      return Promise.resolve(new Response(JSON.stringify({ detail: "cost requires operator role" }), { status: 403 }));
    // Mirror web_app.py _usage_trend_window: trim+lowercase, then REJECT any window
    // outside the 7d/14d/30d allowlist with 400 (no silent fallback). Absent param
    // keeps the backend's 14d default.
    const win = (u.searchParams.get("window") ?? "14d").trim().toLowerCase();
    if (!UT_WINDOWS[win])
      return Promise.resolve(new Response(JSON.stringify({ detail: "invalid usage trend window" }), { status: 400 }));
    diag.usageTrendWindow = win;
    return Promise.resolve(json(usageTrendPayload(win)));
  }

  if (p === "/api/retro/analytics") {
    // Mirrors web_app.py /api/retro/analytics: operator-only (403 viewer), default
    // OFF (404), ADVISORY read-only. Shape matches _retro_analytics_payload.
    diag.retroAnalyticsFetches = ((diag.retroAnalyticsFetches as number) ?? 0) + 1;
    if (!retroAnalyticsEnabled)
      return Promise.resolve(new Response(JSON.stringify({ detail: "retro analytics is not enabled" }), { status: 404 }));
    if (viewerMode)
      return Promise.resolve(new Response(JSON.stringify({ detail: "retro requires operator role" }), { status: 403 }));
    return Promise.resolve(json(retroAnalyticsPayload()));
  }

  if (p === "/api/ledger") {
    // Mirrors web_app.py /api/ledger: per-member runs/tokens/cost rollup. viewer
    // = self-only (scope "self"); operator = all (scope "all"). cost + agy credit
    // stay honestly unknown; soft quota never hard-kills (hard_kill:false).
    diag.ledgerFetches = ((diag.ledgerFetches as number) ?? 0) + 1;
    const proj = (init?.headers as Record<string, string> | undefined)?.["X-Grove-Project"] ?? "dev10";
    const members = viewerMode
      ? [ledgerRollup("v1", 4, 5_000, false)] // self only
      : [
          ledgerRollup("m-alice", 12, 340_000, false),
          ledgerRollup("m-bob", 30, 890_000, true), // agy -> unknown cost/credit; 30>20 -> throttle
          ledgerRollup("m-carol", 3, 12_000, false),
        ];
    return Promise.resolve(
      json({
        project: proj,
        generated_at: ledMetric(AUDIT_TS0, "server", "explicit"),
        window: { name: "7d" },
        scope: viewerMode ? "self" : "all",
        quota_enabled: quotaEnabled,
        members,
        host_pressure: hostPressurePayload(),
        limitations: [
          "ledger uses explicit run metadata and task creator attribution only",
          "soft quota never hard-kills running tasks",
          "agy credit and missing cost fields remain unknown; no costs are invented",
        ],
      }),
    );
  }

  if (p === "/api/quota" && method === "POST") {
    // Mirrors web_app.py /api/quota: operator-only soft budget. 404 when quotas
    // are off; 403 for viewers. Sets a member's soft limits — never a hard kill.
    if (!quotaEnabled)
      return Promise.resolve(new Response(JSON.stringify({ detail: "quota is not enabled" }), { status: 404 }));
    if (viewerMode)
      return Promise.resolve(new Response(JSON.stringify({ detail: "quota requires operator role" }), { status: 403 }));
    const body = (init?.body ? JSON.parse(init.body as string) : {}) as {
      member_id?: string;
      enabled?: boolean;
      soft_run_limit?: number | null;
      soft_token_limit?: number | null;
      soft_cost_usd?: number | null;
    };
    const memberId = typeof body.member_id === "string" && body.member_id ? body.member_id : "m-alice";
    const seed: QuotaSeed = { configured: true, enabled: body.enabled !== false, updated_at: AUDIT_TS0 + 2000 };
    if (typeof body.soft_run_limit === "number") seed.soft_run_limit = body.soft_run_limit;
    if (typeof body.soft_token_limit === "number") seed.soft_token_limit = body.soft_token_limit;
    if (typeof body.soft_cost_usd === "number") seed.soft_cost_usd = body.soft_cost_usd;
    quotaStates[memberId] = seed;
    diag.quotaSet = { member: memberId, ...seed };
    const meta = LEDGER_MEMBERS[memberId] ?? { name: "", role: "unknown" };
    return Promise.resolve(
      json({
        ok: true,
        project: (init?.headers as Record<string, string> | undefined)?.["X-Grove-Project"] ?? "dev10",
        member: { id: memberId, name: meta.name || null, role: meta.role },
        quota: quotaPublic(memberId, 0, null), // fresh quota uses unknown usage
      }),
    );
  }

  if (p === "/api/me") {
    // Mirrors web_app.py /api/me: member null = local-token (operator); a team
    // "viewer" member drives proactive control-lock in the FE.
    diag.meFetches = ((diag.meFetches as number) ?? 0) + 1;
    return Promise.resolve(
      json(
        viewerMode
          ? { auth_mode: "team_cookie", member: { id: "v1", name: "viewer1", role: "viewer" } }
          : { auth_mode: "local_token", member: null },
      ),
    );
  }

  if (p === "/api/master/chat") {
    // Mirrors grove-py /api/master/chat. 503 while disabled (backend WIP); the
    // history GET is unimplemented (POST-only route) -> 405. POST returns a raw
    // MasterChatResponse, with a deterministic mock classification so all three
    // response_types are demoable.
    const reject = (status: number, detail: string) =>
      Promise.resolve(new Response(JSON.stringify({ detail }), { status }));
    if (!masterChatEnabled) return reject(503, "master chat is not available yet");
    if (method === "GET") return reject(405, "method not allowed");
    if (method === "POST") {
      const body = (init?.body ? JSON.parse(init.body as string) : {}) as {
        message?: string;
        conversation_id?: string;
        request_id?: string;
        origin_surface?: string;
        origin_page?: string;
      };
      const message = typeof body.message === "string" ? body.message : "";
      if (viewerMode && isMasterChatActionRequest(message)) return reject(403, "master chat requires operator role");
      masterSeq += 1;
      const conversationId = body.conversation_id || `conv-${masterSeq}`;
      const requestId = body.request_id || `req-${masterSeq}`;
      diag.masterChatSent = ((diag.masterChatSent as number) ?? 0) + 1;
      diag.masterChatOrigin = body.origin_surface ?? "";
      // Transport fallback (unified backend): a NORMAL 200 answer carrying the
      // one-line assistant fallback in answer.text — the FE renders it like any
      // reply (no FE-authored "unavailable" notice).
      if (masterTransportBusy) {
        return Promise.resolve(
          json({
            conversation_id: conversationId,
            request_id: requestId,
            response_type: "answer",
            classification: "question",
            answer: { text: MOCK_TRANSPORT_FALLBACK_TEXT, metadata: { mode: "transport_fallback" } },
            proposal: null,
            feedback_route: "general",
            operator_gate: null,
            requires_confirmation: false,
            audit_events: [],
          }),
        );
      }
      // Deterministic classification: deploy/destructive -> denied (operator gate);
      // add/create/build -> preview (proposal + requires_confirmation); else answer.
      const lower = message.toLowerCase();
      let response_type: "answer" | "preview" | "denied" = "answer";
      let answer: { text: string; metadata?: Record<string, unknown> } | null = null;
      let proposal: {
        proposal_id: string;
        summary: string;
        payload: { confirmation_id: string; confirm: { command: string; endpoint: string } };
      } | null = null;
      let operator_gate: { reason: string } | null = null;
      let requires_confirmation = false;
      let classification = "question";
      if (/\b(deploy|prod|production|delete|drop|destroy)\b/.test(lower)) {
        response_type = "denied";
        classification = "command";
        // The user-visible denial is LLM-authored answer.text. operator_gate.reason
        // is non-LLM rule/gate metadata — present for audit, NEVER rendered.
        answer = {
          text: "⚠ that's a production/destructive action — I can't run it from chat; an operator must approve it directly. (mock-llm)",
        };
        operator_gate = { reason: "GATE: operator_role_required — non-llm rule text (must not reach the user)" };
      } else if (/\b(add|create|build|make|implement|task|fix)\b/.test(lower)) {
        response_type = "preview";
        classification = "task";
        const confirmationId = `assistant_mock_${masterSeq}`;
        answer = {
          text: `I'll prepare that handoff for MASTER review. Use the confirmation control to record it in the decision ledger. (mock-llm)`,
        };
        proposal = {
          proposal_id: confirmationId,
          summary: `proposed: ${message.slice(0, 60)} — review and confirm to proceed. (mock)`,
          payload: {
            confirmation_id: confirmationId,
            confirm: {
              command: `confirm ${confirmationId}`,
              endpoint: "/api/master/chat/confirm",
            },
          },
        };
        requires_confirmation = true;
      } else {
        answer = {
          text: `received: “${message.slice(0, 60)}” — root will follow up. Reviewers: 2. Human items: ready=1, running=1, blocked=1, done=1. Human queue: ask-human=1, needs_human=1. (mock)`,
          metadata: {
            facts: {
              project: { selected: "dev10", board: "dev10" },
              projects: { visible: PROJECTS.map((p) => p.name).sort() },
              org: { node_count: ORG_NODES.length, project_master: { name: "root", present: true, default_assignee: true } },
              board: { status_counts: { ready: 1, running: 1, blocked: 1, done: 1, archived: 0 } },
              reviewers: { count: 2, nodes: ["human-reviewer", "researcher"] },
              human: {
                assignee_candidates: ["human-reviewer"],
                reviewers: ["human-reviewer"],
                ask_human_count: 1,
                needs_human_count: 1,
                inbox_endpoint: "/api/inbox",
                answer_endpoint: "/api/tasks/{task_id}/answer",
              },
              delegation: {
                default_assignee: "root",
                create_task_endpoint: "/api/boards/{board_id}/tasks",
                watch_endpoint: "/ws/board",
                watch_ticket_endpoint: "/api/ws-ticket",
                watch_ticket_kind: "board",
              },
            },
          },
        };
      }
      return Promise.resolve(
        json({
          conversation_id: conversationId,
          request_id: requestId,
          response_type,
          classification,
          answer,
          proposal,
          feedback_route: "general",
          operator_gate,
          requires_confirmation,
          audit_events: [],
        }),
      );
    }
  }

  if (p === "/api/master/chat/confirm") {
    const reject = (status: number, detail: string) =>
      Promise.resolve(new Response(JSON.stringify({ detail }), { status }));
    if (!masterChatEnabled) return reject(503, "master chat is not available yet");
    if (method !== "POST") return reject(405, "method not allowed");
    if (viewerMode) return reject(403, "master chat requires operator role");
    const body = (init?.body ? JSON.parse(init.body as string) : {}) as {
      confirmation_id?: string;
      conversation_id?: string;
      request_id?: string;
    };
    masterSeq += 1;
    const conversationId = body.conversation_id || `conv-${masterSeq}`;
    const requestId = body.request_id || `confirm-${masterSeq}`;
    return Promise.resolve(
      json({
        conversation_id: conversationId,
        request_id: requestId,
        response_type: "answer",
        classification: "command",
        answer: {
          text: `Recorded ${body.confirmation_id || "the request"} in MASTER's decision ledger for review. (mock-llm)`,
        },
        proposal: null,
        feedback_route: "general",
        operator_gate: null,
        requires_confirmation: false,
        audit_events: [],
      }),
    );
  }

  if (p === "/api/execution") {
    // Mirrors web_app.py _execution_gate_payload + POST partial update.
    const proj = (init?.headers as Record<string, string> | undefined)?.["X-Grove-Project"] ?? "dev10";
    if (method === "POST") {
      if (diag.denyExecution) {
        diag.execDenied = ((diag.execDenied as number) ?? 0) + 1;
        return Promise.resolve(new Response(JSON.stringify({ detail: "execution requires operator role" }), { status: 403 }));
      }
      const body = (init?.body ? JSON.parse(init.body as string) : {}) as Partial<typeof executionGate>;
      if (typeof body.enabled === "boolean") executionGate.enabled = body.enabled;
      if (typeof body.kill_switch === "boolean") executionGate.kill_switch = body.kill_switch;
      if (typeof body.board_enabled === "boolean") executionGate.board_enabled = body.board_enabled;
      if (typeof body.board_kill_switch === "boolean") executionGate.board_kill_switch = body.board_kill_switch;
      diag.execGatePost = { ...executionGate };
      return Promise.resolve(json({ project: proj, ...executionGate }));
    }
    diag.execGateFetches = ((diag.execGateFetches as number) ?? 0) + 1;
    return Promise.resolve(json({ project: proj, ...executionGate }));
  }

  if (p === "/api/presence") {
    // Mirrors web_app.py _presence_payload: team → viewers [{name,role}] (no
    // id/secret) + anonymous_count 0; local → [{kind:"anonymous",count}] +
    // anonymous_count. Default team (member chips); setPresenceMode toggles.
    diag.presenceFetches = ((diag.presenceFetches as number) ?? 0) + 1;
    const proj = (init?.headers as Record<string, string> | undefined)?.["X-Grove-Project"] ?? "dev10";
    if (presenceMode === "local") {
      return Promise.resolve(
        json({
          project: proj,
          auth_mode: "local_token",
          active_window_seconds: 60,
          viewers: [{ kind: "anonymous", count: 1 }],
          anonymous_count: 1,
        }),
      );
    }
    return Promise.resolve(
      json({
        project: proj,
        auth_mode: "team_cookie",
        active_window_seconds: 60,
        viewers: [
          { name: "alice", role: "admin" },
          { name: "bob", role: "operator" },
          { name: "carol", role: "viewer" },
        ],
        anonymous_count: 0,
      }),
    );
  }

  if (p === "/api/plan") {
    // Mirrors web_app.py _plan_payload: READ-ONLY ranked candidates with per-
    // factor metrics (source/confidence), redacted requirements, read_only:true.
    diag.planFetches = ((diag.planFetches as number) ?? 0) + 1;
    if (diag.planError) {
      // Server-error path so verify can prove the FE shows a FIXED message and
      // never leaks the request path / role input.
      return Promise.resolve(new Response(JSON.stringify({ detail: "plan failed" }), { status: 500 }));
    }
    const proj = (init?.headers as Record<string, string> | undefined)?.["X-Grove-Project"] ?? "dev10";
    const role = u.searchParams.get("role") ?? "";
    const taskId = u.searchParams.get("task_id") ?? "";
    diag.planRole = role;
    diag.planTaskId = taskId;
    // Mirror web_app.py _plan_public_terms EXACTLY, in two stages and that order:
    //   1) _safe_log_text: mask absolute paths -> "[path]" (ABSOLUTE_PATH_RE),
    //      then secret tokens -> "[redacted]" (auth_status.TOKEN_RE), collapse ws.
    //   2) tokenize [a-z0-9]+, then _plan_public_term: >48 -> "redacted",
    //      path segment -> "path", else the term.
    // Masking BEFORE tokenizing is essential: "/etc/passwd" must not leak
    // "passwd", and "xoxb-…" must not leak "xoxb".
    const ABSOLUTE_PATH_RE = /(?<![A-Za-z0-9_./-])\/(?!\/)[^\s'"()<>]+/g;
    const SECRET_RE =
      /\b(?:(?:xox[baprs]|xapp)-[A-Za-z0-9-]+|gh[pousr]_[A-Za-z0-9_]+|sk-[A-Za-z0-9_-]+|[A-Za-z0-9_-]{40,})\b/gi;
    const safeLogText = (value: string): string =>
      String(value)
        .replace(/\r/g, "\n")
        .replace(ABSOLUTE_PATH_RE, "[path]")
        .replace(SECRET_RE, "[redacted]")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 500);
    const PATH_SEGMENTS = new Set(["applications", "etc", "home", "opt", "private", "tmp", "users", "usr", "var"]);
    const planPublicTerms = (value: string): string[] => {
      const out = new Set<string>();
      for (const m of safeLogText(value).toLowerCase().matchAll(/[a-z0-9]+/g)) {
        const term = m[0];
        if (!term) continue;
        if (term.length > 48) out.add("redacted");
        else if (PATH_SEGMENTS.has(term)) out.add("path");
        else out.add(term);
      }
      return [...out].sort();
    };
    const roleTerms = planPublicTerms(role);
    diag.planRoleTerms = roleTerms;
    const met = (value: number | null, source: string, confidence: string, status?: string) =>
      status ? { value, source, confidence, status } : { value, source, confidence };
    const candidate = (
      node: string,
      agent: string,
      crole: string,
      rank: number,
      score: number,
      roleM: number,
      capM: number,
      load: number,
      cost: number,
      running: number,
    ) => ({
      node,
      agent,
      role: crole,
      group: "build",
      status: "idle",
      status_reason: "no active turn recorded",
      rank: met(rank, "planner", "explicit"),
      score: met(score, "planner", "partial"),
      score_breakdown: {
        role_match: met(roleM, "registry+request", "inferred"),
        capability_match: met(capM, "registry+task_metadata", "inferred"),
        load: met(load, "registry+board_store", "explicit"),
        cost: met(cost, "transcript", "partial"),
      },
      signals: {
        running_tasks: met(running, "board_store", "explicit"),
        blocked_tasks: met(0, "board_store", "explicit"),
        cost_basis: {
          total_tokens: met(node === "researcher" ? null : 120000, node === "researcher" ? "none" : "transcript", node === "researcher" ? "unknown" : "partial", node === "researcher" ? "unknown" : undefined),
          cost_usd: met(node === "researcher" ? null : 1.2, node === "researcher" ? "none" : "estimate", node === "researcher" ? "unknown" : "partial", node === "researcher" ? "unknown" : undefined),
        },
      },
    });
    return Promise.resolve(
      json({
        project: proj,
        task: { id: taskId, title: "task", status: "ready" },
        requested_role: role,
        requirements: { role_terms: roleTerms, capability_terms: [] },
        generated_at: met(AUDIT_TS0 + 400, "server", "explicit"),
        read_only: true,
        recommended_action: "review the ranked candidates and assign manually",
        candidates: [
          candidate("backend", "codex", "백엔드", 1, 2.41, 1.0, 0.6, 0.55, 0.26, 1),
          candidate("frontend", "claude", "프런트엔드", 2, 1.78, 0.5, 0.4, 0.6, 0.28, 0),
          candidate("researcher", "claude", "리서치", 3, 1.12, 0.3, 0.2, 0.5, 0.12, 0),
        ],
        limitations: [
          "Scores are best-effort routing hints from registry, board load, and usage metadata.",
          "No task is claimed, assigned, spawned, or executed by this endpoint.",
        ],
      }),
    );
  }

  if (p === "/api/inbox") {
    // Mirrors web_app.py _inbox_payload: {project, items, next_cursor, total}.
    diag.inboxFetches = ((diag.inboxFetches as number) ?? 0) + 1;
    const proj = (init?.headers as Record<string, string> | undefined)?.["X-Grove-Project"] ?? "dev10";
    const cursor = Number(u.searchParams.get("cursor") ?? "0") || 0;
    const limit = Number(u.searchParams.get("limit") ?? "50") || 50;
    const page = INBOX_ITEMS.slice(cursor, cursor + limit);
    const nextIdx = cursor + page.length;
    return Promise.resolve(
      json({
        project: proj,
        items: page,
        next_cursor: nextIdx < INBOX_ITEMS.length ? nextIdx : null,
        total: INBOX_ITEMS.length,
        answer: { endpoint: "/api/tasks/{task_id}/answer", method: "POST", body: { text: "human answer" } },
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
    const rawBoard = decodeURIComponent(m[1]!);
    const boardProj = (init?.headers as Record<string, string> | undefined)?.["X-Grove-Project"] ?? "dev10";
    // Mirror web_app.py _resolve_board_id: the "default"/"main" alias resolves to
    // the active project's single board (project.board) for both reads and writes.
    const projectBoard = boardProj === SOLO_PROJECT ? "solo-x" : "grove";
    const board = rawBoard === "default" || rawBoard === "main" ? projectBoard : rawBoard;
    if (method === "POST") {
      const payload = (init?.body ? JSON.parse(init.body as string) : {}) as Partial<MockTask>;
      const created: MockTask = {
        id: `N-${++taskSeq}`,
        title: payload.title ?? "untitled",
        status: payload.status || "ready",
        assignee: payload.assignee,
        reviewer: payload.reviewer,
        body: payload.body,
      };
      (TASKS[board] ??= []).unshift(created);
      diag.createdTask = created.title;
      diag.assignedAssignee = created.assignee ?? "";
      // Full record of the last task POST so verify can assert the delegate
      // contract (assignee + status "ready" + optional body + reviewer) precisely.
      diag.lastTaskPost = {
        board,
        title: created.title,
        assignee: created.assignee ?? "",
        reviewer: created.reviewer ?? "",
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

  m = p.match(/^\/api\/boards\/([^/]+)\/workflow$/);
  if (m) {
    // Mirror web_app.py board_workflow_endpoint/_workflow_payload.
    const rawBoard = decodeURIComponent(m[1]!);
    const boardProj = (init?.headers as Record<string, string> | undefined)?.["X-Grove-Project"] ?? "dev10";
    const projectBoard = boardProj === SOLO_PROJECT ? "solo-x" : "grove";
    const board = rawBoard === "default" || rawBoard === "main" ? projectBoard : rawBoard;
    diag.workflowFetched = board;
    return Promise.resolve(json(mockWorkflowPayload(boardProj, board)));
  }

  m = p.match(/^\/api\/tasks\/([^/]+)\/status$/);
  if (m && method === "PATCH") {
    // Mirror web_app.py update_task_status_endpoint: operator-only; canonical
    // status maps to the stored value (canonical "running" stores "running";
    // legacy "in_progress" still tolerated); optional reviewer in same call.
    if (viewerMode)
      return Promise.resolve(new Response(JSON.stringify({ detail: "task status mutation requires operator role" }), { status: 403 }));
    const id = decodeURIComponent(m[1]!);
    const task = findTask(id);
    if (!task) return Promise.resolve(new Response(JSON.stringify({ detail: "task not found" }), { status: 404 }));
    const body = (init?.body ? JSON.parse(init.body as string) : {}) as { status?: string; reviewer?: string | null };
    const canon = String(body.status ?? "").trim().toLowerCase().replace(/-/g, "_");
    const stored = MOCK_MANUAL_STATUS_ALIASES[canon];
    if (!stored) return Promise.resolve(new Response(JSON.stringify({ detail: "invalid task status" }), { status: 400 }));
    task.status = stored;
    if (body.reviewer !== undefined) task.reviewer = body.reviewer ? body.reviewer : undefined;
    diag.statusPatched = { id, status: stored, canonical: canon };
    return Promise.resolve(json({ ...task }));
  }

  m = p.match(/^\/api\/tasks\/([^/]+)\/reviewer$/);
  if (m && method === "PATCH") {
    // Mirror web_app.py update_task_reviewer_endpoint: operator-only; null clears.
    if (viewerMode)
      return Promise.resolve(new Response(JSON.stringify({ detail: "task reviewer mutation requires operator role" }), { status: 403 }));
    const id = decodeURIComponent(m[1]!);
    const task = findTask(id);
    if (!task) return Promise.resolve(new Response(JSON.stringify({ detail: "task not found" }), { status: 404 }));
    const body = (init?.body ? JSON.parse(init.body as string) : {}) as { reviewer?: string | null };
    task.reviewer = body.reviewer ? body.reviewer : undefined;
    diag.reviewerPatched = { id, reviewer: task.reviewer ?? null };
    return Promise.resolve(json({ ...task }));
  }

  m = p.match(/^\/api\/tasks\/([^/]+)\/answer$/);
  if (m && method === "POST") {
    const id = decodeURIComponent(m[1]!);
    // Team-viewer denial path (verify can flip this to exercise the safe error).
    if (diag.denyAnswer) {
      diag.answerDenied = ((diag.answerDenied as number) ?? 0) + 1;
      return Promise.resolve(new Response(JSON.stringify({ detail: "answer requires operator role" }), { status: 403 }));
    }
    const payload = (init?.body ? JSON.parse(init.body as string) : {}) as { text?: string };
    diag.answeredTask = id;
    diag.answerText = payload.text ?? "";
    const before = INBOX_ITEMS.length;
    INBOX_ITEMS = INBOX_ITEMS.filter((it) => it.task_id !== id); // unblock -> drops out of inbox
    diag.inboxRemoved = before - INBOX_ITEMS.length;
    return Promise.resolve(
      json({ ok: true, task: { id, status: "ready" }, comment: { id: "c-ans", body: payload.text ?? "" } }),
    );
  }

  m = p.match(/^\/api\/tasks\/([^/]+)\/execution$/);
  if (m) {
    // Mirrors web_app.py _task_execution_payload {state, approved, gate, execution}.
    const id = decodeURIComponent(m[1]!);
    const proj = (init?.headers as Record<string, string> | undefined)?.["X-Grove-Project"] ?? "dev10";
    const e = taskExec[id] ?? { state: "none", approved: false, node: "root" };
    return Promise.resolve(
      json({
        project: proj,
        task_id: id,
        node: e.node,
        state: e.state,
        approved: e.approved,
        gate: execGateInfo(),
        execution: { state: e.state, node: e.node, approved: e.approved },
      }),
    );
  }

  m = p.match(/^\/api\/tasks\/([^/]+)\/approve$/);
  if (m && method === "POST") {
    const id = decodeURIComponent(m[1]!);
    const proj = (init?.headers as Record<string, string> | undefined)?.["X-Grove-Project"] ?? "dev10";
    if (diag.denyExecution) {
      diag.execDenied = ((diag.execDenied as number) ?? 0) + 1;
      return Promise.resolve(new Response(JSON.stringify({ detail: "execution requires operator role" }), { status: 403 }));
    }
    const g = execGateInfo();
    if (!g.allowed) return Promise.resolve(new Response(JSON.stringify({ detail: "execution gate is blocked" }), { status: 409 }));
    const e = taskExec[id];
    if (!e || e.state !== "approval-pending") {
      return Promise.resolve(new Response(JSON.stringify({ detail: "task is not awaiting approval" }), { status: 409 }));
    }
    taskExec[id] = { ...e, state: "approved", approved: true };
    diag.execApprove = id;
    return Promise.resolve(
      json({ project: proj, task_id: id, node: e.node, state: "approved", approved: true, gate: g, execution: taskExec[id] }),
    );
  }

  m = p.match(/^\/api\/tasks\/([^/]+)\/abort$/);
  if (m && method === "POST") {
    const id = decodeURIComponent(m[1]!);
    const proj = (init?.headers as Record<string, string> | undefined)?.["X-Grove-Project"] ?? "dev10";
    if (diag.denyExecution) {
      diag.execDenied = ((diag.execDenied as number) ?? 0) + 1;
      return Promise.resolve(new Response(JSON.stringify({ detail: "execution requires operator role" }), { status: 403 }));
    }
    const e = taskExec[id];
    if (!e || e.state === "aborted" || e.state === "complete") {
      return Promise.resolve(new Response(JSON.stringify({ detail: "task execution is already terminal" }), { status: 409 }));
    }
    taskExec[id] = { ...e, state: "aborted" };
    diag.execAbort = id;
    return Promise.resolve(
      json({ project: proj, task_id: id, node: e.node, state: "aborted", approved: e.approved, gate: execGateInfo(), execution: taskExec[id] }),
    );
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
        board: String(body.name ?? "untitled"),
        dashboardCommand: `grove-web --session ${String(body.name ?? "untitled")}`,
        default_assignee: "lead",
        project_master: { name: "lead", status: "idle" },
        workspace: body.clone ? `~/dev/${body.name}` : `~/dev/${body.name}`,
        node_count: 1,
        status: "running",
        display_name: String(body.display_name ?? body.name ?? "untitled"),
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
    const response = json(proj === SOLO_PROJECT ? buildSoloOrg() : buildOrg(proj || "dev10"));
    if (orgDelayMs > 0) {
      return new Promise((resolve) => setTimeout(() => resolve(response), orgDelayMs));
    }
    return Promise.resolve(response);
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
      // PR-E: surface the role-preset passthrough + free role override so the
      // verifier can assert the snake_case wire contract (g-py: `role_preset`).
      const raw = (init?.body ? JSON.parse(init.body as string) : {}) as Record<string, unknown>;
      diag.createdNodeRolePreset = typeof raw.role_preset === "string" ? raw.role_preset : "";
      diag.createdNodeRole = typeof raw.role === "string" ? raw.role : "";
      return Promise.resolve(json({ ...node, children: [] }));
    }
    const proj = (init?.headers as Record<string, string> | undefined)?.["X-Grove-Project"];
    if (proj === SOLO_PROJECT) return Promise.resolve(json(SOLO_NODES.map(basicNode)));
    return Promise.resolve(json(ORG_NODES.map(basicNode)));
  }

  m = p.match(/^\/api\/nodes\/([^/]+)\/send$/);
  if (m && method === "POST") {
    // Mirrors web_app.py send_node_input_endpoint: operator-only (403 viewer),
    // 404 when --enable-node-input is off / node unknown, 429 rate-limited. On
    // success the live terminal streams the result; returns {ok,project,node,pane}.
    const node = decodeURIComponent(m[1]!).trim();
    const proj = (init?.headers as Record<string, string> | undefined)?.["X-Grove-Project"] ?? "dev10";
    const reject = (status: number, detail: string) =>
      Promise.resolve(new Response(JSON.stringify({ detail }), { status }));
    if (viewerMode) return reject(403, "node input requires operator role");
    if (!nodeInputEnabled) return reject(404, "node input is not enabled");
    const projNodes = proj === SOLO_PROJECT ? SOLO_NODES : ORG_NODES;
    const rec = projNodes.find((n) => n.name === node);
    if (!rec) return reject(404, "node not found");
    // Mirror _pane_allowed: any valid live pane is input-capable; auth/origin,
    // node-input feature state, and rate limits are the send guardrails.
    if (!nodeAccessFlags(rec.tmux_pane).input_allowed) return reject(404, "node not found");
    if (diag.nodeSendRateLimited) return reject(429, "node input rate limit exceeded");
    const body = (init?.body ? JSON.parse(init.body as string) : {}) as { text?: string };
    diag.nodeSent = { node, text: typeof body.text === "string" ? body.text : "" };
    return Promise.resolve(json({ ok: true, project: proj, node, tmux_pane: rec.tmux_pane }));
  }

  m = p.match(/^\/api\/nodes\/([^/]+)\/connect$/);
  if (m) {
    // Mirrors web_app.py node_connect_endpoint/_node_connect_payload: any member
    // can read the tmux attach/select-pane connect commands; 404 unknown node.
    const node = decodeURIComponent(m[1]!).trim();
    const proj = (init?.headers as Record<string, string> | undefined)?.["X-Grove-Project"] ?? "dev10";
    const projNodes = proj === SOLO_PROJECT ? SOLO_NODES : ORG_NODES;
    const rec = projNodes.find((n) => n.name === node);
    if (!rec)
      return Promise.resolve(new Response(JSON.stringify({ detail: "node not found" }), { status: 404 }));
    // Mirror _node_connect_payload (_pane_allowed): any terminal_allowed pane can
    // return a connect command, including the lead pane.
    if (!nodeAccessFlags(rec.tmux_pane).terminal_allowed)
      return Promise.resolve(new Response(JSON.stringify({ detail: "node not found" }), { status: 404 }));
    diag.nodeConnectFetched = node;
    const session = rec.tmux_pane.split(":")[0];
    return Promise.resolve(
      json({
        project: proj,
        node,
        tmux_target: rec.tmux_pane,
        mode: "local_tmux_attach",
        label: "Local tmux attach",
        commands: { attach: `tmux attach -t ${session}`, local_attach: `tmux attach -t ${session}`, select_pane: `tmux select-pane -t ${rec.tmux_pane}` },
      }),
    );
  }

  m = p.match(/^\/api\/nodes\/([^/]+)\/autopickup$/);
  if (m) {
    // Mirrors web_app.py _node_autopickup_payload + _node_in_project: validate
    // the node name (400) and require it to exist in THIS project (404) before
    // GET or POST; only a known node returns 200. + the 409 global-gate rule.
    // Normalize like backend _validated_node_ref (trim) ONCE, then use the
    // canonical name everywhere — payload `node`, store key, and diag.
    const node = decodeURIComponent(m[1]!).trim();
    const proj = (init?.headers as Record<string, string> | undefined)?.["X-Grove-Project"] ?? "dev10";
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(node)) {
      return Promise.resolve(
        new Response(JSON.stringify({ detail: "node must contain only letters, digits, hyphen, or underscore" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        }),
      );
    }
    const projNodes = proj === SOLO_PROJECT ? SOLO_NODES : ORG_NODES;
    if (!projNodes.some((n) => n.name === node)) {
      return Promise.resolve(
        new Response(JSON.stringify({ detail: "node not found" }), {
          status: 404,
          headers: { "Content-Type": "application/json" },
        }),
      );
    }
    const apPayload = () => ({
      project: proj,
      node,
      enabled: !!autopickupNodes[node],
      configured: node in autopickupNodes,
      global_enabled: autopickupGlobal.enabled,
      global_kill_switch: autopickupGlobal.kill_switch,
    });
    if (method === "POST") {
      if (diag.denyAutopickup) {
        diag.autopickupDenied = ((diag.autopickupDenied as number) ?? 0) + 1;
        return Promise.resolve(new Response(JSON.stringify({ detail: "node mutation requires operator role" }), { status: 403 }));
      }
      const body = (init?.body ? JSON.parse(init.body as string) : {}) as { enabled?: boolean };
      const wantEnable = !!body.enabled;
      if (wantEnable && (!autopickupGlobal.enabled || autopickupGlobal.kill_switch)) {
        return Promise.resolve(
          new Response(JSON.stringify({ detail: "global autopickup gate is disabled" }), { status: 409 }),
        );
      }
      autopickupNodes[node] = wantEnable;
      diag.autopickupPost = { node, enabled: wantEnable };
      return Promise.resolve(json(apPayload()));
    }
    diag.autopickupFetches = ((diag.autopickupFetches as number) ?? 0) + 1;
    return Promise.resolve(json(apPayload()));
  }

  m = p.match(/^\/api\/nodes\/([^/]+)\/execution$/);
  if (m) {
    // Mirrors web_app.py _node_execution_payload + _node_in_project (400/404).
    const node = decodeURIComponent(m[1]!).trim();
    const proj = (init?.headers as Record<string, string> | undefined)?.["X-Grove-Project"] ?? "dev10";
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(node)) {
      return Promise.resolve(new Response(JSON.stringify({ detail: "node must contain only letters, digits, hyphen, or underscore" }), { status: 400, headers: { "Content-Type": "application/json" } }));
    }
    const projNodes = proj === SOLO_PROJECT ? SOLO_NODES : ORG_NODES;
    if (!projNodes.some((n) => n.name === node)) {
      return Promise.resolve(new Response(JSON.stringify({ detail: "node not found" }), { status: 404, headers: { "Content-Type": "application/json" } }));
    }
    const nePayload = () => ({
      project: proj,
      node,
      enabled: !!nodeExec[node],
      configured: node in nodeExec,
      kill_switch: false,
      global_enabled: executionGate.enabled,
      global_kill_switch: executionGate.kill_switch,
      board_enabled: executionGate.board_enabled,
      board_kill_switch: executionGate.board_kill_switch,
    });
    if (method === "POST") {
      if (diag.denyExecution) {
        diag.execDenied = ((diag.execDenied as number) ?? 0) + 1;
        return Promise.resolve(new Response(JSON.stringify({ detail: "execution requires operator role" }), { status: 403 }));
      }
      const body = (init?.body ? JSON.parse(init.body as string) : {}) as { enabled?: boolean };
      const wantEnable = !!body.enabled;
      // Mirror web_app.py set_node_execution_endpoint 409 rules.
      if (wantEnable && (!executionGate.enabled || !executionGate.board_enabled)) {
        return Promise.resolve(new Response(JSON.stringify({ detail: "execution gate is disabled" }), { status: 409 }));
      }
      if (wantEnable && (executionGate.kill_switch || executionGate.board_kill_switch)) {
        return Promise.resolve(new Response(JSON.stringify({ detail: "execution kill switch is enabled" }), { status: 409 }));
      }
      nodeExec[node] = wantEnable;
      diag.execTogglePost = { node, enabled: wantEnable };
      return Promise.resolve(json(nePayload()));
    }
    diag.execNodeFetches = ((diag.execNodeFetches as number) ?? 0) + 1;
    return Promise.resolve(json(nePayload()));
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
  if (p === "/api/slack/config/status") {
    // Mirror the backend shape exactly: attach `intake: {enabled: <bool>}` ONLY
    // when the backend reports it. null => omit the key (older backend) so the FE
    // graceful "unknown" path is real, not a fabricated default.
    const body: Record<string, unknown> = { ...slack };
    if (slackIntakeEnabled !== null) body.intake = { enabled: slackIntakeEnabled };
    return Promise.resolve(json(body));
  }
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
  if (p === "/api/slack/threads") {
    const taskId = u.searchParams.get("task_id") ?? "";
    return Promise.resolve(json(SLACK_THREADS.filter((thread) => thread.task_id === taskId)));
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
  private cursorParam = "";

  constructor(url: string) {
    this.url = url;
    // Parse without `new URL` — the mock's file:// origin yields empty-host WS
    // URLs (ws:///ws/board?…) that `new URL` rejects.
    const [pathPart = "", queryPart = ""] = url.split("?");
    const params = new URLSearchParams(queryPart);
    this.pane = params.get("pane_id") ?? "";
    this.ticket = params.get("ticket") ?? "";
    this.cursorParam = params.get("cursor") ?? "";
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

  // Deliver a board event live and record the high-water cursor handed to a
  // connected client (== the cursor the FE will track + send on reconnect).
  deliverBoard(payload: { cursor: number; type: string; task_id: string }) {
    diag.boardLiveMaxCursor = Math.max((diag.boardLiveMaxCursor as number) ?? 0, payload.cursor);
    this.emit(JSON.stringify(payload));
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
      // Mirror /ws/board?cursor=N (web_app.py board_ws -> list_events_after):
      // replay ONLY events after the client's cursor — the downtime-missed ones,
      // not a from-0 dump. Record the requested cursor + replay count so verify
      // can prove the FE tracked and sent its last-seen cursor.
      const since = Number(this.cursorParam) || 0;
      diag.boardCursorParam = since;
      const missed = boardEventLog.filter((e) => e.cursor > since);
      diag.boardLastReplayCount = missed.length;
      if (missed.length > 0) {
        setTimeout(() => {
          for (const e of missed) this.deliverBoard(e);
        }, 100);
      } else if (since === 0) {
        // First connect / no cursor: initial heartbeat (drives the live spark).
        setTimeout(() => this.deliverBoard({ cursor: 1, type: "task.updated", task_id: "G-1" }), 800);
      }
      // Reconnect with nothing missed: emit nothing — the FE's onopen catch-up
      // reload is the fallback for silent (eventless) changes.
    }
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
    /* server-pushed mirror; browser input goes through /api/nodes/{node}/send */
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
// Durable log of board events so a reconnect can replay events-after-cursor
// (events pushed while disconnected are "missed" and recovered on reconnect).
const boardEventLog: { cursor: number; type: string; task_id: string }[] = [];
function pushBoardEvent(taskId: string, type: string): void {
  const ev = { cursor: ++boardEventSeq, type, task_id: taskId };
  boardEventLog.push(ev);
  boardSocket?.deliverBoard(ev); // live delivery; no-op while disconnected
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
// Mutate a task AND log a board event while disconnected: the event is "missed"
// live (no socket) but recoverable via the reconnect's events-after-cursor
// replay — proves precise cursor replay (V7-W3).
diag.missEvent = (id: string, status: string, type: string): boolean => {
  if (!mutateTaskStatus(id, status)) return false;
  const ev = { cursor: ++boardEventSeq, type, task_id: id };
  boardEventLog.push(ev);
  boardSocket?.deliverBoard(ev); // boardSocket is null during downtime -> not delivered
  return true;
};
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
