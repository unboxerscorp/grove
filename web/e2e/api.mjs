// Full-stack API e2e against the REAL grove-web server.
//
// Boots `grove_bridge.web_app` (the bridge venv python) on a temp/ephemeral
// port with a throwaway board db + a read-only registry under a temp GROVE_HOME,
// scrapes the injected session token from the served index (exactly how the SPA
// bootstraps), then asserts the documented backend contract:
//
//   - token gating (401 without X-Grove-Session-Token)
//   - auth-status   (5-tool shape + leaks no secrets)
//   - projects      (registry-session enumeration + shape)
//   - project scope (X-Grove-Project -> 400 invalid / 404 unknown / board scope)
//   - slack status  (not_configured, empty tokens, no secrets)
//   - ws-ticket     (issuance, ttl, project binding, single-use over real WS)
//   - plan          (read-only ranked candidates, redaction, project/task scope)
//   - autopickup    (node toggle auth, global gate, scope, team viewer denial)
//   - execution     (global/node gates, approval/abort, scope, viewer denial)
//   - usage         (node/day rollups, agy unknowns, project scope, redaction)
//   - summary       (signed counts-only export, aggregate trust, redaction)
//   - handoff       (signed export, trusted local accept, idempotency, redaction)
//   - shared-access (one-time joins, viewer read-only, CSRF/origin/host guards)
//   - notification routing (operator config, dry-run default, bounded escalation)
//   - ledger/quota  (member ledger, soft quotas, host pressure, no hard-kill)
//   - retro analytics (operator-only advisory insights, privacy, low-confidence honesty)
//   - usage trend   (advisory-only trend/anomaly signals, agy cost honesty)
//
// Each check asserts the CORRECT contract. A failing check is a real defect to
// report as `# BUG(Pn)` — never relax the assertion to match a bug.
//
// Setup/teardown is self-contained: spawn -> wait-ready -> assert -> kill +
// remove the temp tree. Headless: `npm run e2e` (or `pnpm run e2e`) from web/.

import { spawn, spawnSync } from "node:child_process";
import { createHash, createHmac, pbkdf2Sync } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url)); // web/e2e
const repoRoot = path.resolve(here, "..", "..");
const python = path.join(repoRoot, "bridge", ".venv", "bin", "python");

const SESSION_HEADER = "X-Grove-Session-Token";
const PROJECT_HEADER = "X-Grove-Project";
const ALPHA = "qae2e_alpha"; // default --session project (unlikely tmux collision)
const BETA = "qae2e_beta"; // second registry, used to prove header binding/scope
const EMPTY = "qae2e_empty"; // created during the plan checks to prove empty-registry behavior
const SCOPE = "qae2e_scope"; // created during the autopickup checks to prove node scope
const TEAM = "qae2e_team"; // created during the autopickup checks for team-auth viewer denial
const USAGE = "qae2e_usage"; // created during the usage checks for run rollups
const USAGE_EMPTY = "qae2e_usage_empty"; // created during the usage checks for graceful empty data
const SUMMARY = "qae2e_summary"; // created during the summary checks for signed aggregate coverage
const HANDOFF_SOURCE = "qae2e_handoff_source"; // created during the handoff checks as the sender project
const HANDOFF_RECEIVER = "qae2e_handoff_receiver"; // created during the handoff checks as the receiver project
const SHARE = "qae2e_share"; // created during the shared-access checks
const ROUTING = "qae2e_routing"; // created during the notification routing checks
const ROUTING_OTHER = "qae2e_routing_other"; // second project used to prove notification routing scope isolation
const LEDGER = "qae2e_ledger"; // created during the ledger/quota checks
const RETRO = "qae2e_retro"; // created during the retro analytics checks
const RETRO_OTHER = "qae2e_retro_other"; // second project used to prove retro scope isolation
const USAGE_TREND = "qae2e_usage_trend"; // created during the usage trend checks
const USAGE_TREND_OTHER = "qae2e_usage_trend_other"; // second project used to prove usage trend scope isolation
const READY_TIMEOUT_MS = 25_000;
const NODE_LAST_SEEN = 1_780_542_000; // ~2026-06-04T03:00Z, epoch seconds

// Secret shapes that must never appear in any response body.
const SECRET_RES = [
  /xox[baprs]-[A-Za-z0-9-]{6,}/,
  /xapp-[A-Za-z0-9-]{6,}/,
  /\bsk-[A-Za-z0-9_-]{12,}/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/,
  /\b[0-9a-f]{40,}\b/,
];

const results = [];
function check(label, ok, detail = "") {
  const pass = Boolean(ok);
  results.push({ label, ok: pass, detail });
  console.log(`  ${pass ? "✓" : "✗"} ${label}${!pass && detail ? ` (${detail})` : ""}`);
}
function eq(label, actual, expected) {
  check(label, actual === expected, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
function hasSecret(value) {
  const s = JSON.stringify(value ?? null);
  return SECRET_RES.some((re) => re.test(s));
}
function isTaggedMetric(value) {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    "value" in value &&
    typeof value.source === "string" &&
    typeof value.confidence === "string"
  );
}
function b64Url(bytes) {
  return Buffer.from(bytes).toString("base64").replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}
function teamSecretHash(secret) {
  const salt = Buffer.alloc(16, 0x31);
  const digest = pbkdf2Sync(secret, salt, 200_000, 32, "sha256");
  return `pbkdf2_sha256$200000$${b64Url(salt)}$${b64Url(digest)}`;
}
function stableJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
    .join(",")}}`;
}
function summaryKeyId(key) {
  return createHash("sha256").update(key, "utf8").digest("hex").slice(0, 16);
}
function summarySignature(key, payload) {
  return `sha256:${createHmac("sha256", key).update(stableJson(payload), "utf8").digest("hex")}`;
}
function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}
function writeRegistry(session, nodes) {
  const dir = path.join(groveHome, session);
  mkdirSync(dir, { recursive: true });
  const regPath = path.join(dir, "registry.json");
  writeFileSync(regPath, JSON.stringify({ workspace: `/tmp/${session}`, nodes }, null, 2));
  chmodSync(regPath, 0o444);
}
function writeTeamViewer(session, { name, secret }) {
  writeTeamMember(session, { name, secret, role: "viewer", id: "viewer-1" });
}
function writeTeamMember(session, { name, secret, role, id = `${role}-1` }) {
  writeTeamMembers(session, [{ name, secret, role, id }]);
}
function writeTeamMembers(session, members) {
  const dir = path.join(groveHome, session);
  mkdirSync(dir, { recursive: true });
  const membersPath = path.join(dir, "members.json");
  writeFileSync(
    membersPath,
    JSON.stringify(
      {
        members: members.map((member) => ({
          id: member.id,
          name: member.name,
          role: member.role,
          enabled: member.enabled ?? true,
          secret_hash: teamSecretHash(member.secret),
        })),
      },
      null,
      2,
    ),
  );
  chmodSync(membersPath, 0o600);
}
function runBridgePython(lines, args) {
  const result = spawnSync(python, ["-c", lines.join("\n"), ...args], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(`bridge python failed:\n${result.stderr || result.stdout}`);
  }
  return result.stdout.trim();
}
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

let baseUrl = "";
async function req(method, pathname, { token, project, body, origin } = {}) {
  const headers = {};
  if (token) headers[SESSION_HEADER] = token;
  if (project !== undefined) headers[PROJECT_HEADER] = project;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  // Real browsers send Origin; default to the same (loopback) origin so
  // state-change POSTs pass _require_allowed_origin. Pass `origin: false` to omit
  // it, or a foreign string to exercise the cross-origin rejection (403).
  if (origin !== false) headers["Origin"] = origin ?? baseUrl;
  const resp = await fetch(baseUrl + pathname, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await resp.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status: resp.status, json, text, headers: resp.headers };
}

async function reqAt(base, method, pathname, { token, project, cookie, csrf, body, origin } = {}) {
  const headers = {};
  if (token) headers[SESSION_HEADER] = token;
  if (project !== undefined) headers[PROJECT_HEADER] = project;
  if (cookie) headers.Cookie = cookie;
  if (csrf) headers["X-Grove-CSRF"] = csrf;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (origin !== false) headers["Origin"] = origin ?? base;
  const resp = await fetch(base + pathname, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await resp.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status: resp.status, json, text, headers: resp.headers };
}

function rawHttpAt(base, method, pathname, { host, cookie, csrf, body, origin } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(base);
    const payload = body === undefined ? "" : JSON.stringify(body);
    const headers = [
      `${method} ${pathname} HTTP/1.1`,
      `Host: ${host ?? url.host}`,
      "Connection: close",
    ];
    if (origin !== undefined) headers.push(`Origin: ${origin}`);
    if (cookie) headers.push(`Cookie: ${cookie}`);
    if (csrf) headers.push(`X-Grove-CSRF: ${csrf}`);
    if (body !== undefined) {
      headers.push("Content-Type: application/json");
      headers.push(`Content-Length: ${Buffer.byteLength(payload)}`);
    }
    const socket = createConnection({ host: url.hostname, port: Number(url.port) }, () => {
      socket.write(`${headers.join("\r\n")}\r\n\r\n${payload}`);
    });
    let raw = "";
    socket.setTimeout(5000);
    socket.on("data", (chunk) => {
      raw += chunk.toString("utf8");
    });
    socket.on("timeout", () => {
      socket.destroy(new Error("raw http timeout"));
    });
    socket.on("error", reject);
    socket.on("end", () => {
      const status = Number(raw.match(/^HTTP\/1\.[01]\s+(\d+)/)?.[1] || 0);
      const text = raw.slice(raw.indexOf("\r\n\r\n") + 4);
      resolve({ status, text, raw });
    });
  });
}

// Resolve open-vs-rejected for a websocket upgrade. A valid ticket -> 'open';
// a denied ticket (server closes before accept) -> 'error'/'close', never open.
function wsProbe(wsUrl, timeoutMs = 4000) {
  return new Promise((resolve) => {
    let settled = false;
    const ws = new WebSocket(wsUrl);
    const done = (r) => {
      if (settled) return;
      settled = true;
      try {
        ws.close();
      } catch {
        /* ignore */
      }
      resolve(r);
    };
    ws.addEventListener("open", () => done({ opened: true, code: null }));
    ws.addEventListener("error", () => done({ opened: false, code: null }));
    ws.addEventListener("close", (e) => done({ opened: false, code: e.code }));
    setTimeout(() => done({ opened: false, code: "timeout" }), timeoutMs);
  });
}

const tmp = mkdtempSync(path.join(tmpdir(), "grove-api-e2e-"));
const groveHome = path.join(tmp, "grove_home");
const homeDir = path.join(tmp, "home");
const distDir = path.join(tmp, "dist");
const dbPath = path.join(tmp, "board.db");
let child = null;
let exited = false;
let serverLog = "";
let teamChild = null;
let teamExited = true;
let teamServerLog = "";
let teamBaseUrl = "";
let summaryChild = null;
let summaryExited = true;
let summaryServerLog = "";
let summaryBaseUrl = "";
let handoffChild = null;
let handoffExited = true;
let handoffServerLog = "";
let handoffBaseUrl = "";
let sharedChild = null;
let sharedExited = true;
let sharedServerLog = "";
let sharedBaseUrl = "";

function setAutopickupGlobal(board, { enabled, killSwitch }) {
  const boolArg = (value) => (value === undefined ? "none" : value ? "true" : "false");
  runBridgePython(
    [
      "import sys",
      "from pathlib import Path",
      "from grove_bridge.store import SQLiteBoardStore",
      "def value(raw): return None if raw == 'none' else raw == 'true'",
      "SQLiteBoardStore(Path(sys.argv[1])).set_autopickup_global(board=sys.argv[2], enabled=value(sys.argv[3]), kill_switch=value(sys.argv[4]))",
    ],
    [dbPath, board, boolArg(enabled), boolArg(killSwitch)],
  );
}

function seedGuardedExecutionTask({ database = dbPath, board, title, node }) {
  const out = runBridgePython(
    [
      "import json, sys",
      "from pathlib import Path",
      "from grove_bridge.store import SQLiteBoardStore",
      "store = SQLiteBoardStore(Path(sys.argv[1]))",
      "task = store.create_task(board=sys.argv[2], title=sys.argv[3], body=None, assignee=sys.argv[4])",
      "claim = store.claim_next(board=sys.argv[2], assignee=sys.argv[4], node_id=sys.argv[4], ttl_seconds=300, task_id=task.id)",
      "if claim is None: raise SystemExit('claim failed')",
      "execution = store.begin_guarded_execution(board=sys.argv[2], task_id=task.id, run_id=claim.run_id, node=sys.argv[4])",
      "print(json.dumps({'task_id': task.id, 'run_id': claim.run_id, 'state': execution.get('state')}))",
    ],
    [database, board, title, node],
  );
  return JSON.parse(out);
}

function setExecutionGlobal({ database = dbPath, board, enabled, killSwitch, boardEnabled, boardKillSwitch }) {
  const boolArg = (value) => (value === undefined ? "none" : value ? "true" : "false");
  runBridgePython(
    [
      "import sys",
      "from pathlib import Path",
      "from grove_bridge.store import SQLiteBoardStore",
      "def value(raw): return None if raw == 'none' else raw == 'true'",
      "SQLiteBoardStore(Path(sys.argv[1])).set_execution_global(board=sys.argv[2], enabled=value(sys.argv[3]), kill_switch=value(sys.argv[4]), board_enabled=value(sys.argv[5]), board_kill_switch=value(sys.argv[6]))",
    ],
    [
      database,
      board,
      boolArg(enabled),
      boolArg(killSwitch),
      boolArg(boardEnabled),
      boolArg(boardKillSwitch),
    ],
  );
}

function tryMarkExecutionExecuting({ database = dbPath, board, taskId, runId, node }) {
  const out = runBridgePython(
    [
      "import json, sys",
      "from pathlib import Path",
      "from grove_bridge.store import SQLiteBoardStore",
      "ok = SQLiteBoardStore(Path(sys.argv[1])).try_mark_execution_executing(board=sys.argv[2], task_id=sys.argv[3], run_id=sys.argv[4], node=sys.argv[5])",
      "print(json.dumps({'ok': ok}))",
    ],
    [database, board, taskId, runId, node],
  );
  return JSON.parse(out).ok === true;
}

function completeUsageRun({ database = dbPath, board, node, metadata, startedAt }) {
  runBridgePython(
    [
      "import json, sqlite3, sys",
      "from pathlib import Path",
      "from grove_bridge.store import SQLiteBoardStore",
      "store = SQLiteBoardStore(Path(sys.argv[1]))",
      "metadata = json.loads(sys.argv[4])",
      "started_at = int(sys.argv[5])",
      "task = store.create_task(board=sys.argv[2], title=f'{sys.argv[3]} usage', body=None, assignee=sys.argv[3])",
      "claim = store.claim_next(board=sys.argv[2], assignee=sys.argv[3], node_id=sys.argv[3], ttl_seconds=30)",
      "if claim is None: raise SystemExit('claim failed')",
      "ok = store.complete(board=sys.argv[2], task_id=task.id, run_id=claim.run_id, claim_lock=claim.claim_lock, result='done', summary='done', metadata=metadata)",
      "if not ok: raise SystemExit('complete failed')",
      "with sqlite3.connect(sys.argv[1]) as conn:",
      "    conn.execute('UPDATE runs SET started_at = ?, ended_at = ? WHERE id = ?', (started_at, started_at + 60, claim.run_id))",
    ],
    [database, board, node, JSON.stringify(metadata), String(startedAt)],
  );
}

function createTaskWithMetadata({ database = dbPath, board, title, body, assignee, priority = 0, metadata = {}, status = "ready" }) {
  const out = runBridgePython(
    [
      "import json, sys",
      "from pathlib import Path",
      "from grove_bridge.store import SQLiteBoardStore",
      "body = None if sys.argv[4] == '__NONE__' else sys.argv[4]",
      "assignee = None if sys.argv[5] == '__NONE__' else sys.argv[5]",
      "task = SQLiteBoardStore(Path(sys.argv[1])).create_task(board=sys.argv[2], title=sys.argv[3], body=body, assignee=assignee, status=sys.argv[8], priority=int(sys.argv[6]), metadata=json.loads(sys.argv[7]))",
      "print(json.dumps({'id': task.id}))",
    ],
    [
      database,
      board,
      title,
      body === null || body === undefined ? "__NONE__" : body,
      assignee === null || assignee === undefined ? "__NONE__" : assignee,
      String(priority),
      JSON.stringify(metadata),
      status,
    ],
  );
  return JSON.parse(out).id;
}

function seedRunningTask({ database = dbPath, board, title, node, createdBy }) {
  const out = runBridgePython(
    [
      "import json, sys",
      "from pathlib import Path",
      "from grove_bridge.store import SQLiteBoardStore",
      "store = SQLiteBoardStore(Path(sys.argv[1]))",
      "task = store.create_task(board=sys.argv[2], title=sys.argv[3], body=None, assignee=sys.argv[4], created_by=sys.argv[5])",
      "claim = store.claim_next(board=sys.argv[2], assignee=sys.argv[4], node_id=sys.argv[4], ttl_seconds=300, task_id=task.id)",
      "if claim is None: raise SystemExit('claim failed')",
      "print(json.dumps({'task_id': claim.task.id, 'run_id': claim.run_id, 'status': claim.task.status}))",
    ],
    [database, board, title, node, createdBy],
  );
  return JSON.parse(out);
}

function seedRoutingBlockedTask({ database = dbPath, board, secret, email, privatePath }) {
  const out = runBridgePython(
    [
      "import json, sys",
      "from pathlib import Path",
      "from grove_bridge.store import SQLiteBoardStore",
      "store = SQLiteBoardStore(Path(sys.argv[1]))",
      "task = store.create_task(board=sys.argv[2], title=f'Routing anomaly for {sys.argv[4]} in {sys.argv[5]} {sys.argv[3]}', body=f'Escalate without leaking {sys.argv[3]} {sys.argv[5]}', assignee='maker', status='blocked', metadata={'notification_event': 'anomaly', 'severity': 'high', 'note': f'{sys.argv[4]} {sys.argv[5]} {sys.argv[3]}'})",
      "print(json.dumps({'task_id': task.id, 'status': task.status}))",
    ],
    [database, board, secret, email, privatePath],
  );
  return JSON.parse(out);
}

function pollNotificationRouting({ database = dbPath, board, now }) {
  const out = runBridgePython(
    [
      "import json, sys",
      "from pathlib import Path",
      "from grove_bridge.notification_rules import NotificationRuleRunner, notification_routing_config_from_mapping",
      "from grove_bridge.store import SQLiteBoardStore",
      "class RecordingNotifier:",
      "    enabled = True",
      "    channel_kind = 'inbox'",
      "    room_id = 'legacy'",
      "    def __init__(self): self.calls = []",
      "    def notify_blocked(self, *, task, sub):",
      "        self.calls.append({'task_id': task.id, 'title': task.title, 'body': task.body, 'metadata': task.metadata, 'channel_kind': sub.channel_kind, 'room_id': sub.room_id, 'thread_id': sub.thread_id})",
      "store = SQLiteBoardStore(Path(sys.argv[1]))",
      "board = sys.argv[2]",
      "now = None if sys.argv[3] == '__NONE__' else int(sys.argv[3])",
      "routing = notification_routing_config_from_mapping(store.notification_routing_state(board=board))",
      "notifier = RecordingNotifier()",
      "sent = NotificationRuleRunner(store=store, notifier=notifier).poll_board(board, routing=routing, now=now)",
      "subs = []",
      "for task in store.list_tasks(board=board):",
      "    for sub in store.list_notify_subs(board=board, task_id=task.id):",
      "        subs.append({'task_id': task.id, 'channel_kind': sub.channel_kind, 'room_id': sub.room_id, 'thread_id': sub.thread_id})",
      "print(json.dumps({'sent': sent, 'calls': notifier.calls, 'subs': subs}))",
    ],
    [database, board, now === undefined || now === null ? "__NONE__" : String(now)],
  );
  return JSON.parse(out);
}

function seedRetroAnalyticsData({ database = dbPath, board, secret, email, privatePath, rawPhrase }) {
  const out = runBridgePython(
    [
      "import json, sqlite3, sys",
      "from pathlib import Path",
      "from grove_bridge.store import SQLiteBoardStore",
      "store = SQLiteBoardStore(Path(sys.argv[1]))",
      "board = sys.argv[2]",
      "secret = sys.argv[3]",
      "email = sys.argv[4]",
      "private_path = sys.argv[5]",
      "raw_phrase = sys.argv[6]",
      "retro = store.create_task(board=board, title='retro private source', body=f'{raw_phrase} {secret} {email} {private_path}', assignee='maker', status='done', metadata={'self_retro': True, 'private_path': private_path})",
      "store.add_comment(board=board, task_id=retro.id, author='retro:maker', body=f'tests were blocked by scope and tooling. {raw_phrase} {secret} {email} {private_path}', metadata={'kind': 'retro', 'node': 'maker'})",
      "blocked = store.create_task(board=board, title='retro blocked task', body=f'blocked private body {secret}', assignee='maker', status='blocked')",
      "run_task = store.create_task(board=board, title='retro completed run', body=None, assignee='agy-node')",
      "claim = store.claim_next(board=board, assignee='agy-node', node_id='agy-node', ttl_seconds=30, task_id=run_task.id)",
      "if claim is None: raise SystemExit('claim failed')",
      "metadata = {'node': 'agy-node', 'total_tokens': 13, 'transcript_path': f'{private_path}/retro.jsonl', 'email': email, 'secret_note': secret}",
      "if not store.complete(board=board, task_id=run_task.id, run_id=claim.run_id, claim_lock=claim.claim_lock, result='done', summary='retro complete', metadata=metadata): raise SystemExit('complete failed')",
      "with sqlite3.connect(sys.argv[1]) as conn:",
      "    conn.execute('UPDATE runs SET started_at = ?, ended_at = ? WHERE id = ?', (1704240000, 1704245400, claim.run_id))",
      "print(json.dumps({'retro_task_id': retro.id, 'blocked_task_id': blocked.id, 'run_task_id': run_task.id}))",
    ],
    [database, board, secret, email, privatePath, rawPhrase],
  );
  return JSON.parse(out);
}

function scaffold() {
  mkdirSync(homeDir, { recursive: true });
  mkdirSync(distDir, { recursive: true });
  // Minimal dist so `/` returns 200 and the token can be scraped from <head>.
  writeFileSync(
    path.join(distDir, "index.html"),
    "<!doctype html><html><head></head><body><div id=app></div></body></html>\n",
  );
  writeFileSync(path.join(distDir, "app.js"), "window.__e2e_app__ = true;\n");
  // Read-only registries: two sessions, two nodes each (node_count == 2).
  for (const name of [ALPHA, BETA]) {
    const dir = path.join(groveHome, name);
    mkdirSync(dir, { recursive: true });
    const registry = {
      workspace: `/tmp/${name}`,
      nodes: {
        lead: {
          name: "lead",
          agent: "claude",
          tmux_pane: `${name}:1.0`,
          session_id: "s1",
          status: "running",
          role: "lead",
          // Heartbeat ts so /api/status?detail=1 returns last_seen as an int.
          last_seen: NODE_LAST_SEEN,
        },
        worker: {
          name: "worker",
          agent: "codex",
          tmux_pane: `${name}:1.1`,
          session_id: "s2",
          status: "idle",
          parent: "lead",
          last_seen: NODE_LAST_SEEN,
        },
      },
    };
    const regPath = path.join(dir, "registry.json");
    writeFileSync(regPath, JSON.stringify(registry, null, 2));
    chmodSync(regPath, 0o444); // read-only registry input
  }
}

async function startServer() {
  const port = await freePort();
  baseUrl = `http://127.0.0.1:${port}`;
  const env = { ...process.env, GROVE_HOME: groveHome, HOME: homeDir, GROVE_VIEWER_SESSION: ALPHA };
  // Keep auth-status hermetic: no provider keys leak in from the parent env.
  for (const k of [
    "ANTHROPIC_API_KEY",
    "OPENAI_API_KEY",
    "GEMINI_API_KEY",
    "ANTIGRAVITY_API_KEY",
    "CLOUDFLARE_API_TOKEN",
    "CODEX_HOME",
  ]) {
    delete env[k];
  }
  child = spawn(
    python,
    [
      "-m",
      "grove_bridge.web_app",
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "--dist-dir",
      distDir,
      "--board-db-path",
      dbPath,
      "--session",
      ALPHA,
    ],
    { cwd: repoRoot, env, stdio: ["ignore", "pipe", "pipe"] },
  );
  child.stdout.on("data", (d) => (serverLog += d));
  child.stderr.on("data", (d) => (serverLog += d));
  child.on("exit", () => (exited = true));

  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (exited) throw new Error(`server exited before ready:\n${serverLog}`);
    try {
      // /api/health is unauthenticated (auth-gate); /api/status now needs a token.
      const r = await fetch(baseUrl + "/api/health");
      await r.text();
      if (r.status === 200) return port;
    } catch {
      /* not up yet */
    }
    await sleep(150);
  }
  throw new Error(`server not ready within ${READY_TIMEOUT_MS}ms:\n${serverLog}`);
}

async function startTeamServer(session, teamDbPath) {
  const port = await freePort();
  teamBaseUrl = `http://127.0.0.1:${port}`;
  teamServerLog = "";
  teamExited = false;
  const env = { ...process.env, GROVE_HOME: groveHome, HOME: homeDir, GROVE_VIEWER_SESSION: session };
  teamChild = spawn(
    python,
    [
      "-m",
      "grove_bridge.web_app",
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "--dist-dir",
      distDir,
      "--board-db-path",
      teamDbPath,
      "--session",
      session,
      "--team-auth",
    ],
    { cwd: repoRoot, env, stdio: ["ignore", "pipe", "pipe"] },
  );
  teamChild.stdout.on("data", (d) => (teamServerLog += d));
  teamChild.stderr.on("data", (d) => (teamServerLog += d));
  teamChild.on("exit", () => (teamExited = true));

  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (teamExited) throw new Error(`team server exited before ready:\n${teamServerLog}`);
    try {
      const r = await fetch(teamBaseUrl + "/api/health");
      await r.text();
      if (r.status === 200) return port;
    } catch {
      /* not up yet */
    }
    await sleep(150);
  }
  throw new Error(`team server not ready within ${READY_TIMEOUT_MS}ms:\n${teamServerLog}`);
}

async function startSummaryServer({ session, freshnessSeconds = 60, trustedKeysPath } = {}) {
  const port = await freePort();
  summaryBaseUrl = `http://127.0.0.1:${port}`;
  summaryServerLog = "";
  summaryExited = false;
  const env = { ...process.env, GROVE_HOME: groveHome, HOME: homeDir, GROVE_VIEWER_SESSION: session };
  const args = [
    "-m",
    "grove_bridge.web_app",
    "--host",
    "127.0.0.1",
    "--port",
    String(port),
    "--dist-dir",
    distDir,
    "--board-db-path",
    dbPath,
    "--session",
    session,
    "--enable-summary-export",
    "--summary-freshness-seconds",
    String(freshnessSeconds),
  ];
  if (trustedKeysPath) args.push("--summary-trusted-keys", trustedKeysPath);
  summaryChild = spawn(python, args, { cwd: repoRoot, env, stdio: ["ignore", "pipe", "pipe"] });
  summaryChild.stdout.on("data", (d) => (summaryServerLog += d));
  summaryChild.stderr.on("data", (d) => (summaryServerLog += d));
  summaryChild.on("exit", () => (summaryExited = true));

  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (summaryExited) throw new Error(`summary server exited before ready:\n${summaryServerLog}`);
    try {
      const r = await fetch(summaryBaseUrl + "/api/health");
      await r.text();
      if (r.status === 200) return port;
    } catch {
      /* not up yet */
    }
    await sleep(150);
  }
  throw new Error(`summary server not ready within ${READY_TIMEOUT_MS}ms:\n${summaryServerLog}`);
}

async function startHandoffServer({ session, ttlSeconds = 60, trustedKeysPath } = {}) {
  const port = await freePort();
  handoffBaseUrl = `http://127.0.0.1:${port}`;
  handoffServerLog = "";
  handoffExited = false;
  const env = { ...process.env, GROVE_HOME: groveHome, HOME: homeDir, GROVE_VIEWER_SESSION: session };
  const args = [
    "-m",
    "grove_bridge.web_app",
    "--host",
    "127.0.0.1",
    "--port",
    String(port),
    "--dist-dir",
    distDir,
    "--board-db-path",
    dbPath,
    "--session",
    session,
    "--enable-handoff",
    "--handoff-ttl-seconds",
    String(ttlSeconds),
  ];
  if (trustedKeysPath) args.push("--summary-trusted-keys", trustedKeysPath);
  handoffChild = spawn(python, args, { cwd: repoRoot, env, stdio: ["ignore", "pipe", "pipe"] });
  handoffChild.stdout.on("data", (d) => (handoffServerLog += d));
  handoffChild.stderr.on("data", (d) => (handoffServerLog += d));
  handoffChild.on("exit", () => (handoffExited = true));

  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (handoffExited) throw new Error(`handoff server exited before ready:\n${handoffServerLog}`);
    try {
      const r = await fetch(handoffBaseUrl + "/api/health");
      await r.text();
      if (r.status === 200) return port;
    } catch {
      /* not up yet */
    }
    await sleep(150);
  }
  throw new Error(`handoff server not ready within ${READY_TIMEOUT_MS}ms:\n${handoffServerLog}`);
}

async function startSharedServer({
  session,
  joinRole = "viewer",
  joinTtlSeconds,
  host = "127.0.0.1",
  allowHosts = [],
  enableQuotas = false,
  enableRetroAnalytics = false,
  enableUsageTrend = false,
} = {}) {
  const port = await freePort();
  sharedBaseUrl = `http://127.0.0.1:${port}`;
  sharedServerLog = "";
  sharedExited = false;
  const env = { ...process.env, GROVE_HOME: groveHome, HOME: homeDir, GROVE_VIEWER_SESSION: session };
  let args;
  if (joinTtlSeconds === undefined) {
    args = [
      "-m",
      "grove_bridge.web_app",
      "--host",
      host,
      "--port",
      String(port),
      "--dist-dir",
      distDir,
      "--board-db-path",
      dbPath,
      "--session",
      session,
      "--shared-access",
      "--shared-join-role",
      joinRole,
    ];
    if (enableQuotas) args.push("--enable-quotas");
    if (enableRetroAnalytics) args.push("--enable-retro-analytics");
    if (enableUsageTrend) args.push("--enable-usage-trend");
    for (const allowed of allowHosts) args.push("--allow-host", allowed);
  } else {
    args = [
      "-c",
      [
        "import os, sys",
        "from pathlib import Path",
        "import uvicorn",
        "from grove_bridge.team_auth import TeamJoinCodeStore",
        "from grove_bridge.web_app import WebAppConfig, create_app",
        "allow_hosts = tuple(item for item in sys.argv[6].split(',') if item)",
        "config = WebAppConfig(dist_dir=Path(sys.argv[1]), board_db_path=Path(sys.argv[2]), grove_home=Path(os.environ['GROVE_HOME']), registry_session=sys.argv[3], host=sys.argv[4], port=int(sys.argv[5]), allowed_hosts=allow_hosts, shared_access=True, shared_join_role=sys.argv[7], quota_enabled=(sys.argv[9] == 'true'))",
        "app = create_app(config=config)",
        "app.state.team_join_code_store = TeamJoinCodeStore(ttl_seconds=int(sys.argv[8]))",
        "uvicorn.run(app, host=config.host, port=config.port)",
      ].join("\n"),
      distDir,
      dbPath,
      session,
      host,
      String(port),
      allowHosts.join(","),
      joinRole,
      String(joinTtlSeconds),
      enableQuotas ? "true" : "false",
    ];
  }
  sharedChild = spawn(python, args, { cwd: repoRoot, env, stdio: ["ignore", "pipe", "pipe"] });
  sharedChild.stdout.on("data", (d) => (sharedServerLog += d));
  sharedChild.stderr.on("data", (d) => (sharedServerLog += d));
  sharedChild.on("exit", () => (sharedExited = true));

  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (sharedExited) throw new Error(`shared server exited before ready:\n${sharedServerLog}`);
    try {
      const r = await fetch(sharedBaseUrl + "/api/health");
      await r.text();
      if (r.status === 200) return port;
    } catch {
      /* not up yet */
    }
    await sleep(150);
  }
  throw new Error(`shared server not ready within ${READY_TIMEOUT_MS}ms:\n${sharedServerLog}`);
}

async function stopTeamServer() {
  try {
    if (teamChild && !teamExited) {
      teamChild.kill("SIGTERM");
      const grace = Date.now() + 5000;
      while (!teamExited && Date.now() < grace) await sleep(50);
      if (!teamExited) teamChild.kill("SIGKILL");
    }
  } catch {
    /* ignore */
  } finally {
    teamChild = null;
    teamExited = true;
  }
}

async function stopSummaryServer() {
  try {
    if (summaryChild && !summaryExited) {
      summaryChild.kill("SIGTERM");
      const grace = Date.now() + 5000;
      while (!summaryExited && Date.now() < grace) await sleep(50);
      if (!summaryExited) summaryChild.kill("SIGKILL");
    }
  } catch {
    /* ignore */
  } finally {
    summaryChild = null;
    summaryExited = true;
  }
}

async function stopHandoffServer() {
  try {
    if (handoffChild && !handoffExited) {
      handoffChild.kill("SIGTERM");
      const grace = Date.now() + 5000;
      while (!handoffExited && Date.now() < grace) await sleep(50);
      if (!handoffExited) handoffChild.kill("SIGKILL");
    }
  } catch {
    /* ignore */
  } finally {
    handoffChild = null;
    handoffExited = true;
  }
}

async function stopSharedServer() {
  try {
    if (sharedChild && !sharedExited) {
      sharedChild.kill("SIGTERM");
      const grace = Date.now() + 5000;
      while (!sharedExited && Date.now() < grace) await sleep(50);
      if (!sharedExited) sharedChild.kill("SIGKILL");
    }
  } catch {
    /* ignore */
  } finally {
    sharedChild = null;
    sharedExited = true;
  }
}

async function teardown() {
  await stopSharedServer();
  await stopHandoffServer();
  await stopSummaryServer();
  await stopTeamServer();
  try {
    if (child && !exited) {
      child.kill("SIGTERM");
      const grace = Date.now() + 5000;
      while (!exited && Date.now() < grace) await sleep(50);
      if (!exited) child.kill("SIGKILL");
    }
  } catch {
    /* ignore */
  }
  try {
    rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

async function run() {
  scaffold();
  const port = await startServer();

  // --- index + token bootstrap ---
  const idx = await req("GET", "/");
  eq("index served (200)", idx.status, 200);
  const m = idx.text.match(/window\.__GROVE_SESSION_TOKEN__ = "([^"]+)"/);
  check("index injects session token", Boolean(m));
  check("index injects auth_required=true", /window\.__GROVE_AUTH_REQUIRED__ = true/.test(idx.text));
  const token = m ? m[1] : "";
  const asset = await req("GET", "/app.js");
  check(
    "static asset served from dist (/app.js)",
    asset.status === 200 && asset.text.includes("__e2e_app__"),
    `status ${asset.status}`,
  );

  // --- /api/health: unauthenticated liveness, no project/session leak ---
  const health = await req("GET", "/api/health");
  eq("health 200 without token", health.status, 200);
  check("health returns ok:true", Boolean(health.json) && health.json.ok === true);
  check(
    "health exposes no project/session/workspace/token info",
    !/project|session|workspace|token/i.test(health.text),
    health.text.trim(),
  );

  // --- /api/status: now token-gated (auth-gate) ---
  eq("status 401 without token", (await req("GET", "/api/status")).status, 401);
  const statusOk = await req("GET", "/api/status", { token });
  eq("status 200 with token", statusOk.status, 200);
  eq("status reports default project (alpha)", statusOk.json && statusOk.json.project, ALPHA);

  // --- token gating ---
  eq("auth-status 401 without token", (await req("GET", "/api/auth-status")).status, 401);
  eq("projects 401 without token", (await req("GET", "/api/projects")).status, 401);
  eq("ws-ticket 401 without token", (await req("POST", "/api/ws-ticket")).status, 401);

  // --- auth-status: shape + no secrets ---
  const as = await req("GET", "/api/auth-status", { token });
  eq("auth-status 200 with token", as.status, 200);
  const tools = Array.isArray(as.json) ? as.json : [];
  eq("auth-status returns 5 tools", tools.length, 5);
  const toolNames = new Set(tools.map((t) => t && t.tool));
  check(
    "auth-status covers codex/claude/agy/gh/cf",
    ["codex", "claude", "agy", "gh", "cf"].every((t) => toolNames.has(t)),
    [...toolNames].join(","),
  );
  check(
    "auth-status items expose {tool,label,authed,detail,login_hint}",
    tools.every(
      (t) =>
        t &&
        typeof t.tool === "string" &&
        typeof t.label === "string" &&
        typeof t.authed === "boolean" &&
        typeof t.detail === "string" &&
        typeof t.login_hint === "string",
    ),
  );
  check("auth-status leaks no secrets", !hasSecret(as.json));

  // --- projects enumeration ---
  const pj = await req("GET", "/api/projects", { token });
  eq("projects 200 with token", pj.status, 200);
  const projects = Array.isArray(pj.json) ? pj.json : [];
  const names = projects.map((p) => p.name).sort();
  check(
    "projects enumerates registry sessions [alpha,beta]",
    JSON.stringify(names) === JSON.stringify([ALPHA, BETA].sort()),
    names.join(","),
  );
  check(
    "projects items expose {name,workspace,node_count,status}",
    projects.every(
      (p) =>
        typeof p.name === "string" &&
        "workspace" in p &&
        typeof p.node_count === "number" &&
        typeof p.status === "string",
    ),
  );
  const alpha = projects.find((p) => p.name === ALPHA);
  eq("projects node_count reflects registry (2)", alpha && alpha.node_count, 2);
  check(
    "projects status is running|stopped",
    Boolean(alpha) && ["running", "stopped"].includes(alpha.status),
    alpha && alpha.status,
  );

  // --- project scoping ---
  eq(
    "seed: POST /api/boards/main/tasks 200",
    (await req("POST", "/api/boards/main/tasks", { token, body: { title: "e2e main task" } })).status,
    200,
  );
  eq(
    "seed: POST /api/boards/alpha/tasks 200",
    (await req("POST", `/api/boards/${ALPHA}/tasks`, { token, body: { title: "e2e scoped task" } }))
      .status,
    200,
  );
  const allBoards = await req("GET", "/api/boards", { token });
  const allSlugs = (allBoards.json || []).map((b) => b.id);
  // v1.27 "1:1:1 board model" (commit 930c59d): board ids "main"/"default" alias
  // to the project's session board rather than creating a separate board, so an
  // unscoped POST to /api/boards/main/tasks lands on the session board.
  check(
    "unscoped /api/boards: session board only; 'main' aliases to it (v1.27 1:1:1 model)",
    allSlugs.includes(ALPHA) && !allSlugs.includes("main"),
    allSlugs.join(","),
  );
  const scoped = await req("GET", "/api/boards", { token, project: ALPHA });
  const scopedSlugs = (scoped.json || []).map((b) => b.id);
  check(
    "scoped /api/boards (alpha) shows only the alpha board",
    scopedSlugs.length === 1 && scopedSlugs[0] === ALPHA,
    scopedSlugs.join(","),
  );
  check("scoped /api/boards hides 'main'", !scopedSlugs.includes("main"));
  const betaBoards = await req("GET", "/api/boards", { token, project: BETA });
  eq("scoped /api/boards (beta, no tasks) returns []", (betaBoards.json || []).length, 0);
  eq(
    "invalid project header -> 400",
    (await req("GET", "/api/status", { token, project: "../etc" })).status,
    400,
  );
  eq(
    "unknown project header -> 404",
    (await req("GET", "/api/status", { token, project: "ghost_proj" })).status,
    404,
  );
  const scopedTasks = await req("GET", `/api/boards/${ALPHA}/tasks`, { token, project: ALPHA });
  eq("scoped task list 200", scopedTasks.status, 200);
  check(
    "scoped task list returns the seeded task",
    (scopedTasks.json || []).some((t) => t.title === "e2e scoped task"),
  );
  eq(
    "disallowed board under scope -> 404",
    (await req("GET", `/api/boards/${BETA}/tasks`, { token, project: ALPHA })).status,
    404,
  );
  const aliasTasks = await req("GET", "/api/boards/main/tasks", { token, project: ALPHA });
  eq("'main' aliases to the scoped board (200)", aliasTasks.status, 200);
  check(
    "'main' alias returns the scoped board's tasks",
    (aliasTasks.json || []).some((t) => t.title === "e2e scoped task"),
  );

  // --- /api/plan: read-only real-server planner contract + project isolation ---
  const planPath = (role, taskId) =>
    `/api/plan?${new URLSearchParams({ role, task_id: taskId }).toString()}`;
  const planAlphaSeed = await req("POST", `/api/boards/${ALPHA}/tasks`, {
    token,
    project: ALPHA,
    body: { title: "e2e plan alpha", body: "route to the codex worker", assignee: "worker" },
  });
  eq("seed: plan alpha task 200", planAlphaSeed.status, 200);
  const alphaPlanTaskId = planAlphaSeed.json && planAlphaSeed.json.id;
  check("seed: plan alpha task returns id", typeof alphaPlanTaskId === "string" && alphaPlanTaskId.length > 0);

  const planBetaSeed = await req("POST", `/api/boards/${BETA}/tasks`, {
    token,
    project: BETA,
    body: { title: "e2e plan beta", body: "must not leak into alpha" },
  });
  eq("seed: plan beta task 200", planBetaSeed.status, 200);
  const betaPlanTaskId = planBetaSeed.json && planBetaSeed.json.id;
  check("seed: plan beta task returns id", typeof betaPlanTaskId === "string" && betaPlanTaskId.length > 0);

  eq("plan 401 without token", (await req("GET", planPath("codex worker", alphaPlanTaskId))).status, 401);
  eq(
    "plan 401 with wrong token",
    (await req("GET", planPath("codex worker", alphaPlanTaskId), { token: "wrong-token" })).status,
    401,
  );
  const plan = await req("GET", planPath("codex worker", alphaPlanTaskId), { token, project: ALPHA });
  eq("plan 200 with token", plan.status, 200);
  eq("plan project == alpha", plan.json && plan.json.project, ALPHA);
  eq("plan task id echoes requested task", plan.json && plan.json.task && plan.json.task.id, alphaPlanTaskId);
  eq("plan read_only true", plan.json && plan.json.read_only, true);
  check("plan generated_at is tagged metric", isTaggedMetric(plan.json && plan.json.generated_at));
  const candidates = plan.json && Array.isArray(plan.json.candidates) ? plan.json.candidates : [];
  check("plan candidates is ranked array with alpha nodes", candidates.length === 2, candidates.length);
  check(
    "plan ranks are 1..N in array order",
    candidates.every((candidate, index) => candidate.rank && candidate.rank.value === index + 1),
    candidates.map((candidate) => candidate.rank && candidate.rank.value).join(","),
  );
  check(
    "plan score values are sorted descending",
    candidates.every((candidate, index, array) => {
      if (index === 0) return true;
      return candidate.score.value <= array[index - 1].score.value;
    }),
    candidates.map((candidate) => candidate.score && candidate.score.value).join(","),
  );
  check("plan top candidate is the codex worker", candidates[0] && candidates[0].node === "worker", candidates[0] && candidates[0].node);
  check(
    "plan score elements carry {source,confidence}",
    candidates.every((candidate) => {
      const breakdown = candidate.score_breakdown;
      return (
        isTaggedMetric(candidate.rank) &&
        isTaggedMetric(candidate.score) &&
        breakdown &&
        typeof breakdown === "object" &&
        !Array.isArray(breakdown) &&
        Object.values(breakdown).every(isTaggedMetric)
      );
    }),
  );
  check(
    "plan signal metrics carry {source,confidence}",
    candidates.every((candidate) => {
      const signals = candidate.signals;
      const costBasis = signals && signals.cost_basis;
      return (
        signals &&
        typeof signals === "object" &&
        isTaggedMetric(signals.running_tasks) &&
        isTaggedMetric(signals.blocked_tasks) &&
        costBasis &&
        typeof costBasis === "object" &&
        Object.values(costBasis).every(isTaggedMetric)
      );
    }),
  );

  const redactRole = "codex /tmp/e2e-secret sk-test-1234567890abcdef012345";
  const redactedPlan = await req("GET", planPath(redactRole, alphaPlanTaskId), { token, project: ALPHA });
  eq("plan redaction request 200", redactedPlan.status, 200);
  const roleTerms = (redactedPlan.json && redactedPlan.json.requirements && redactedPlan.json.requirements.role_terms) || [];
  check("plan requirements role_terms is an array", Array.isArray(roleTerms));
  check("plan requirements redacts path to placeholder", roleTerms.includes("path"), roleTerms.join(","));
  check("plan requirements redacts secret to placeholder", roleTerms.includes("redacted"), roleTerms.join(","));
  check(
    "plan requirements leak no secret/path terms",
    !hasSecret(redactedPlan.json) &&
      !redactedPlan.text.includes("/tmp/e2e-secret") &&
      !roleTerms.some((term) => ["tmp", "e2e", "secret", "sk", "test", "1234567890abcdef012345"].includes(term)),
    roleTerms.join(","),
  );

  eq(
    "plan rejects alpha task_id under beta project (scope isolation)",
    (await req("GET", planPath("codex worker", alphaPlanTaskId), { token, project: BETA })).status,
    404,
  );
  eq(
    "plan rejects beta task_id under alpha project (scope isolation)",
    (await req("GET", planPath("codex worker", betaPlanTaskId), { token, project: ALPHA })).status,
    404,
  );
  eq(
    "plan missing task_id -> 404",
    (await req("GET", planPath("codex worker", "task_missing_e2e"), { token, project: ALPHA })).status,
    404,
  );

  const emptyDir = path.join(groveHome, EMPTY);
  mkdirSync(emptyDir, { recursive: true });
  const emptyRegistryPath = path.join(emptyDir, "registry.json");
  writeFileSync(
    emptyRegistryPath,
    JSON.stringify({ workspace: `/tmp/${EMPTY}`, nodes: {} }, null, 2),
  );
  chmodSync(emptyRegistryPath, 0o444);
  const emptySeed = await req("POST", `/api/boards/${EMPTY}/tasks`, {
    token,
    project: EMPTY,
    body: { title: "e2e empty-registry plan task" },
  });
  eq("seed: empty-registry plan task 200", emptySeed.status, 200);
  const emptyPlan = await req("GET", planPath("codex worker", emptySeed.json && emptySeed.json.id), {
    token,
    project: EMPTY,
  });
  eq("plan empty registry project 200", emptyPlan.status, 200);
  check(
    "plan empty registry returns candidates:[] gracefully",
    Boolean(emptyPlan.json) && Array.isArray(emptyPlan.json.candidates) && emptyPlan.json.candidates.length === 0,
  );

  // --- /api/nodes/{node}/autopickup: real-server toggle + auth/scope gates ---
  const autopickupPath = (node) => `/api/nodes/${encodeURIComponent(node)}/autopickup`;
  writeRegistry(SCOPE, {
    other: {
      name: "other",
      agent: "codex",
      tmux_pane: `${SCOPE}:1.0`,
      session_id: "scope-session",
      status: "idle",
    },
  });

  eq("autopickup GET 401 without token", (await req("GET", autopickupPath("worker"))).status, 401);
  eq(
    "autopickup GET 401 with wrong token",
    (await req("GET", autopickupPath("worker"), { token: "wrong-token" })).status,
    401,
  );
  eq(
    "autopickup POST 401 with wrong token",
    (await req("POST", autopickupPath("worker"), { token: "wrong-token", body: { enabled: true } })).status,
    401,
  );
  const autopickupInitial = await req("GET", autopickupPath("worker"), { token, project: ALPHA });
  eq("autopickup GET 200 with token", autopickupInitial.status, 200);
  eq("autopickup payload project == alpha", autopickupInitial.json && autopickupInitial.json.project, ALPHA);
  eq("autopickup payload node == worker", autopickupInitial.json && autopickupInitial.json.node, "worker");
  eq("autopickup initially disabled", autopickupInitial.json && autopickupInitial.json.enabled, false);
  eq("autopickup initially unconfigured", autopickupInitial.json && autopickupInitial.json.configured, false);
  eq("autopickup global gate initially enabled", autopickupInitial.json && autopickupInitial.json.global_enabled, true);
  eq("autopickup global kill-switch initially off", autopickupInitial.json && autopickupInitial.json.global_kill_switch, false);

  const autopickupEnabled = await req("POST", autopickupPath("worker"), {
    token,
    project: ALPHA,
    body: { enabled: true },
  });
  eq("autopickup POST enabled:true -> 200", autopickupEnabled.status, 200);
  eq("autopickup POST enabled:true reflected", autopickupEnabled.json && autopickupEnabled.json.enabled, true);
  eq("autopickup POST enabled:true configured", autopickupEnabled.json && autopickupEnabled.json.configured, true);
  const autopickupEnabledRead = await req("GET", autopickupPath("worker"), { token, project: ALPHA });
  eq("autopickup GET after enable returns enabled:true", autopickupEnabledRead.json && autopickupEnabledRead.json.enabled, true);
  const autopickupDisabled = await req("POST", autopickupPath("worker"), {
    token,
    project: ALPHA,
    body: { enabled: false },
  });
  eq("autopickup POST enabled:false -> 200", autopickupDisabled.status, 200);
  eq("autopickup POST enabled:false reflected", autopickupDisabled.json && autopickupDisabled.json.enabled, false);
  const autopickupDisabledRead = await req("GET", autopickupPath("worker"), { token, project: ALPHA });
  eq("autopickup GET after disable returns enabled:false", autopickupDisabledRead.json && autopickupDisabledRead.json.enabled, false);

  setAutopickupGlobal(ALPHA, { enabled: false, killSwitch: false });
  const globalOff = await req("POST", autopickupPath("worker"), {
    token,
    project: ALPHA,
    body: { enabled: true },
  });
  eq("autopickup POST enable with global gate off -> 409", globalOff.status, 409);
  check("autopickup global-off rejection mentions global gate", /global/i.test(globalOff.text), globalOff.text);
  setAutopickupGlobal(ALPHA, { enabled: true, killSwitch: true });
  const killSwitchOn = await req("POST", autopickupPath("worker"), {
    token,
    project: ALPHA,
    body: { enabled: true },
  });
  eq("autopickup POST enable with kill-switch on -> 409", killSwitchOn.status, 409);
  check("autopickup kill-switch rejection mentions global gate", /global/i.test(killSwitchOn.text), killSwitchOn.text);
  setAutopickupGlobal(ALPHA, { enabled: true, killSwitch: false });

  const scopedGet = await req("GET", autopickupPath("worker"), { token, project: SCOPE });
  check("autopickup GET rejects node outside project scope", [400, 404].includes(scopedGet.status), scopedGet.status);
  const scopedPost = await req("POST", autopickupPath("worker"), {
    token,
    project: SCOPE,
    body: { enabled: false },
  });
  check("autopickup POST rejects node outside project scope", [400, 404].includes(scopedPost.status), scopedPost.status);
  const badNode = "@sk-test-1234567890abcdef012345";
  const badNodeResp = await req("GET", autopickupPath(badNode), { token, project: ALPHA });
  eq("autopickup invalid node name -> 400", badNodeResp.status, 400);
  check(
    "autopickup rejection responses leak no secrets or paths",
    !hasSecret([globalOff.json, killSwitchOn.json, scopedGet.json, scopedPost.json, badNodeResp.json]) &&
      ![globalOff.text, killSwitchOn.text, scopedGet.text, scopedPost.text, badNodeResp.text].some(
        (text) => text.includes(badNode) || text.includes("/tmp/") || text.includes(groveHome) || text.includes(dbPath),
      ),
  );

  // --- execution gates: global/node toggles, guarded task approval, abort ---
  const executionNodePath = (node) => `/api/nodes/${encodeURIComponent(node)}/execution`;
  const taskExecutionPath = (taskId) => `/api/tasks/${encodeURIComponent(taskId)}/execution`;
  const taskApprovePath = (taskId) => `/api/tasks/${encodeURIComponent(taskId)}/approve`;
  const taskAbortPath = (taskId) => `/api/tasks/${encodeURIComponent(taskId)}/abort`;
  const guardedExecution = seedGuardedExecutionTask({
    board: ALPHA,
    title: "e2e guarded execution",
    node: "worker",
  });
  eq("seed: guarded execution task state approval-pending", guardedExecution.state, "approval-pending");

  eq("execution gate GET 401 without token", (await req("GET", "/api/execution")).status, 401);
  eq(
    "execution gate GET 401 with wrong token",
    (await req("GET", "/api/execution", { token: "wrong-token" })).status,
    401,
  );
  const executionGateInitial = await req("GET", "/api/execution", { token, project: ALPHA });
  eq("execution gate GET 200 with token", executionGateInitial.status, 200);
  eq("execution gate payload project == alpha", executionGateInitial.json && executionGateInitial.json.project, ALPHA);
  check(
    "execution gate payload exposes boolean gate fields",
    Boolean(executionGateInitial.json) &&
      ["enabled", "kill_switch", "board_enabled", "board_kill_switch"].every(
        (key) => typeof executionGateInitial.json[key] === "boolean",
      ),
  );
  eq("execution gate initially disabled", executionGateInitial.json && executionGateInitial.json.enabled, false);
  eq("execution gate initial kill-switch off", executionGateInitial.json && executionGateInitial.json.kill_switch, false);
  eq("execution gate initial board enabled", executionGateInitial.json && executionGateInitial.json.board_enabled, true);

  eq("node execution GET 401 without token", (await req("GET", executionNodePath("worker"))).status, 401);
  eq(
    "node execution POST 401 with wrong token",
    (await req("POST", executionNodePath("worker"), { token: "wrong-token", body: { enabled: true } })).status,
    401,
  );
  const nodeExecutionInitial = await req("GET", executionNodePath("worker"), { token, project: ALPHA });
  eq("node execution GET 200 with token", nodeExecutionInitial.status, 200);
  eq("node execution payload project == alpha", nodeExecutionInitial.json && nodeExecutionInitial.json.project, ALPHA);
  eq("node execution payload node == worker", nodeExecutionInitial.json && nodeExecutionInitial.json.node, "worker");
  eq("node execution initially disabled", nodeExecutionInitial.json && nodeExecutionInitial.json.enabled, false);
  eq("node execution initially unconfigured", nodeExecutionInitial.json && nodeExecutionInitial.json.configured, false);
  eq("node execution sees global disabled", nodeExecutionInitial.json && nodeExecutionInitial.json.global_enabled, false);
  eq("node execution sees board enabled", nodeExecutionInitial.json && nodeExecutionInitial.json.board_enabled, true);

  eq(
    "task execution GET 401 without token",
    (await req("GET", taskExecutionPath(guardedExecution.task_id))).status,
    401,
  );
  const taskExecutionInitial = await req("GET", taskExecutionPath(guardedExecution.task_id), {
    token,
    project: ALPHA,
  });
  eq("task execution GET 200 with token", taskExecutionInitial.status, 200);
  eq("task execution state is approval-pending", taskExecutionInitial.json && taskExecutionInitial.json.state, "approval-pending");
  eq("task execution approved false before approval", taskExecutionInitial.json && taskExecutionInitial.json.approved, false);
  eq("task execution node == worker", taskExecutionInitial.json && taskExecutionInitial.json.node, "worker");
  check(
    "task execution gate blocks before global/node enabled",
    Boolean(taskExecutionInitial.json) &&
      taskExecutionInitial.json.gate &&
      taskExecutionInitial.json.gate.allowed === false &&
      taskExecutionInitial.json.gate.blocked_by.includes("global-disabled") &&
      taskExecutionInitial.json.gate.blocked_by.includes("node-disabled"),
    taskExecutionInitial.text,
  );
  check(
    "task execution is not executing before approval",
    taskExecutionInitial.json && taskExecutionInitial.json.execution && taskExecutionInitial.json.execution.state !== "executing",
  );
  check(
    "store dispatch refuses executing without approval",
    tryMarkExecutionExecuting({
      board: ALPHA,
      taskId: guardedExecution.task_id,
      runId: guardedExecution.run_id,
      node: "worker",
    }) === false,
  );
  const approveBeforeGate = await req("POST", taskApprovePath(guardedExecution.task_id), { token, project: ALPHA });
  eq("task approve blocked while gate disabled -> 409", approveBeforeGate.status, 409);
  const pendingAfterBlockedApprove = await req("GET", taskExecutionPath(guardedExecution.task_id), {
    token,
    project: ALPHA,
  });
  eq(
    "task remains approval-pending after blocked approve",
    pendingAfterBlockedApprove.json && pendingAfterBlockedApprove.json.state,
    "approval-pending",
  );

  const executionGateEnabled = await req("POST", "/api/execution", {
    token,
    project: ALPHA,
    body: { enabled: true },
  });
  eq("execution gate POST enabled:true -> 200", executionGateEnabled.status, 200);
  eq("execution gate POST enabled:true reflected", executionGateEnabled.json && executionGateEnabled.json.enabled, true);
  const executionNodeEnabled = await req("POST", executionNodePath("worker"), {
    token,
    project: ALPHA,
    body: { enabled: true },
  });
  eq("node execution POST enabled:true -> 200", executionNodeEnabled.status, 200);
  eq("node execution POST enabled:true reflected", executionNodeEnabled.json && executionNodeEnabled.json.enabled, true);
  eq("node execution POST enabled:true configured", executionNodeEnabled.json && executionNodeEnabled.json.configured, true);
  const executionNodeEnabledRead = await req("GET", executionNodePath("worker"), { token, project: ALPHA });
  eq("node execution GET after enable returns enabled:true", executionNodeEnabledRead.json && executionNodeEnabledRead.json.enabled, true);
  const executionNodeDisabled = await req("POST", executionNodePath("worker"), {
    token,
    project: ALPHA,
    body: { enabled: false },
  });
  eq("node execution POST enabled:false -> 200", executionNodeDisabled.status, 200);
  eq("node execution POST enabled:false reflected", executionNodeDisabled.json && executionNodeDisabled.json.enabled, false);
  const executionNodeDisabledRead = await req("GET", executionNodePath("worker"), { token, project: ALPHA });
  eq("node execution GET after disable returns enabled:false", executionNodeDisabledRead.json && executionNodeDisabledRead.json.enabled, false);
  eq(
    "node execution re-enable for approval path -> 200",
    (await req("POST", executionNodePath("worker"), { token, project: ALPHA, body: { enabled: true } })).status,
    200,
  );

  eq(
    "execution gate POST enabled:false -> 200",
    (await req("POST", "/api/execution", { token, project: ALPHA, body: { enabled: false } })).status,
    200,
  );
  const nodeEnableGlobalOff = await req("POST", executionNodePath("worker"), {
    token,
    project: ALPHA,
    body: { enabled: true },
  });
  eq("node execution POST enable with global gate off -> 409", nodeEnableGlobalOff.status, 409);
  check("node execution global-off rejection mentions gate", /gate|global|execution/i.test(nodeEnableGlobalOff.text), nodeEnableGlobalOff.text);
  eq(
    "execution gate POST kill_switch:true -> 200",
    (await req("POST", "/api/execution", {
      token,
      project: ALPHA,
      body: { enabled: true, kill_switch: true },
    })).status,
    200,
  );
  const nodeEnableKillSwitch = await req("POST", executionNodePath("worker"), {
    token,
    project: ALPHA,
    body: { enabled: true },
  });
  eq("node execution POST enable with kill-switch on -> 409", nodeEnableKillSwitch.status, 409);
  check("node execution kill-switch rejection mentions gate", /gate|kill|execution/i.test(nodeEnableKillSwitch.text), nodeEnableKillSwitch.text);
  eq(
    "execution gate reset enabled true kill-switch false -> 200",
    (await req("POST", "/api/execution", {
      token,
      project: ALPHA,
      body: { enabled: true, kill_switch: false },
    })).status,
    200,
  );
  eq(
    "node execution enabled for approval after reset -> 200",
    (await req("POST", executionNodePath("worker"), { token, project: ALPHA, body: { enabled: true } })).status,
    200,
  );
  const executionGateAllowed = await req("GET", taskExecutionPath(guardedExecution.task_id), {
    token,
    project: ALPHA,
  });
  eq("task execution gate allowed after global+node enable", executionGateAllowed.json && executionGateAllowed.json.gate.allowed, true);
  const approvedExecution = await req("POST", taskApprovePath(guardedExecution.task_id), { token, project: ALPHA });
  eq("task approve when approval-pending and gate allowed -> 200", approvedExecution.status, 200);
  eq("task approve returns state approved", approvedExecution.json && approvedExecution.json.state, "approved");
  eq("task approve returns approved:true", approvedExecution.json && approvedExecution.json.approved, true);
  const approvedRead = await req("GET", taskExecutionPath(guardedExecution.task_id), { token, project: ALPHA });
  eq("task execution remains approved after approve endpoint", approvedRead.json && approvedRead.json.state, "approved");
  check(
    "task execution does not auto-enter executing after approval",
    approvedRead.json && approvedRead.json.execution && approvedRead.json.execution.state !== "executing",
  );
  const plainExecutionSeed = await req("POST", `/api/boards/${ALPHA}/tasks`, {
    token,
    project: ALPHA,
    body: { title: "e2e plain execution task", assignee: "worker" },
  });
  eq("seed: plain execution task 200", plainExecutionSeed.status, 200);
  const plainApprove = await req("POST", taskApprovePath(plainExecutionSeed.json && plainExecutionSeed.json.id), {
    token,
    project: ALPHA,
  });
  eq("task approve rejects non approval-pending task -> 409", plainApprove.status, 409);
  const abortedExecution = await req("POST", taskAbortPath(guardedExecution.task_id), {
    token,
    project: ALPHA,
    body: { reason: "operator stop /tmp/e2e-execution-secret sk-test-1234567890abcdef012345" },
  });
  eq("task abort approved execution -> 200", abortedExecution.status, 200);
  eq("task abort returns terminal abort state", abortedExecution.json && abortedExecution.json.state, "abort");
  check(
    "task abort reason is redacted",
    !abortedExecution.text.includes("/tmp/e2e-execution-secret") && !hasSecret(abortedExecution.json),
  );
  eq(
    "task abort already-terminal execution -> 409",
    (await req("POST", taskAbortPath(guardedExecution.task_id), {
      token,
      project: ALPHA,
      body: { reason: "second stop" },
    })).status,
    409,
  );

  const wrongProjectExecutionNode = await req("POST", executionNodePath("worker"), {
    token,
    project: SCOPE,
    body: { enabled: true },
  });
  check(
    "node execution rejects node outside project scope",
    [400, 404].includes(wrongProjectExecutionNode.status),
    wrongProjectExecutionNode.status,
  );
  const wrongProjectTaskStatus = await req("GET", taskExecutionPath(guardedExecution.task_id), {
    token,
    project: SCOPE,
  });
  eq("task execution status rejects task outside project scope", wrongProjectTaskStatus.status, 404);
  const wrongProjectApprove = await req("POST", taskApprovePath(guardedExecution.task_id), {
    token,
    project: SCOPE,
  });
  eq("task approve rejects task outside project scope", wrongProjectApprove.status, 404);
  const badExecutionNode = "@sk-test-1234567890abcdef012345";
  const badExecutionNodeResp = await req("POST", executionNodePath(badExecutionNode), {
    token,
    project: ALPHA,
    body: { enabled: true },
  });
  eq("node execution invalid node name -> 400", badExecutionNodeResp.status, 400);
  check(
    "execution rejection responses leak no secrets or paths",
    !hasSecret([
      approveBeforeGate.json,
      nodeEnableGlobalOff.json,
      nodeEnableKillSwitch.json,
      plainApprove.json,
      wrongProjectExecutionNode.json,
      wrongProjectTaskStatus.json,
      wrongProjectApprove.json,
      badExecutionNodeResp.json,
    ]) &&
      ![
        approveBeforeGate.text,
        nodeEnableGlobalOff.text,
        nodeEnableKillSwitch.text,
        plainApprove.text,
        wrongProjectExecutionNode.text,
        wrongProjectTaskStatus.text,
        wrongProjectApprove.text,
        badExecutionNodeResp.text,
      ].some(
        (text) =>
          text.includes(badExecutionNode) ||
          text.includes("/tmp/") ||
          text.includes(groveHome) ||
          text.includes(dbPath),
      ),
  );

  writeRegistry(TEAM, {
    worker: {
      name: "worker",
      agent: "codex",
      tmux_pane: `${TEAM}:1.0`,
      session_id: "team-session",
      status: "idle",
    },
  });
  writeTeamViewer(TEAM, { name: "viewer", secret: "viewer-secret" });
  const teamDbPath = path.join(tmp, "team-board.db");
  const teamExecution = seedGuardedExecutionTask({
    database: teamDbPath,
    board: TEAM,
    title: "team viewer execution",
    node: "worker",
  });
  setExecutionGlobal({ database: teamDbPath, board: TEAM, enabled: true });
  await startTeamServer(TEAM, teamDbPath);
  try {
    const viewerLogin = await reqAt(teamBaseUrl, "POST", "/api/login", {
      body: { name: "viewer", secret: "viewer-secret" },
    });
    eq("autopickup team viewer login 200", viewerLogin.status, 200);
    const viewerCookie = String(viewerLogin.headers.get("set-cookie") || "").split(";")[0];
    const viewerCsrf = viewerLogin.json && viewerLogin.json.csrf;
    check(
      "autopickup team viewer has cookie+csrf",
      viewerCookie.startsWith("grove_team_session=") && typeof viewerCsrf === "string" && viewerCsrf.length > 0,
    );
    const viewerPost = await reqAt(teamBaseUrl, "POST", autopickupPath("worker"), {
      cookie: viewerCookie,
      csrf: viewerCsrf,
      body: { enabled: true },
    });
    eq("autopickup team viewer POST denied", viewerPost.status, 403);
    check("autopickup team viewer denial leaks no secrets", !hasSecret(viewerPost.json));
    const viewerExecutionGate = await reqAt(teamBaseUrl, "POST", "/api/execution", {
      cookie: viewerCookie,
      csrf: viewerCsrf,
      body: { enabled: true },
    });
    eq("execution team viewer gate POST denied", viewerExecutionGate.status, 403);
    const viewerExecutionNode = await reqAt(teamBaseUrl, "POST", executionNodePath("worker"), {
      cookie: viewerCookie,
      csrf: viewerCsrf,
      body: { enabled: true },
    });
    eq("execution team viewer node POST denied", viewerExecutionNode.status, 403);
    const viewerExecutionApprove = await reqAt(teamBaseUrl, "POST", taskApprovePath(teamExecution.task_id), {
      cookie: viewerCookie,
      csrf: viewerCsrf,
    });
    eq("execution team viewer approve POST denied", viewerExecutionApprove.status, 403);
    const viewerExecutionAbort = await reqAt(teamBaseUrl, "POST", taskAbortPath(teamExecution.task_id), {
      cookie: viewerCookie,
      csrf: viewerCsrf,
      body: { reason: "viewer stop" },
    });
    eq("execution team viewer abort POST denied", viewerExecutionAbort.status, 403);
    check(
      "execution team viewer denials leak no secrets",
      !hasSecret([
        viewerExecutionGate.json,
        viewerExecutionNode.json,
        viewerExecutionApprove.json,
        viewerExecutionAbort.json,
      ]),
    );
  } finally {
    await stopTeamServer();
  }

  // --- slack status ---
  const slack = await req("GET", "/api/slack/config/status", { token });
  eq("slack status 200", slack.status, 200);
  eq("slack status == not_configured", slack.json && slack.json.status, "not_configured");
  check(
    "slack status tokens empty when unconfigured",
    Boolean(slack.json) && slack.json.tokens && Object.keys(slack.json.tokens).length === 0,
  );
  check(
    "slack status keys present {status,last_event_at,last_error,tokens}",
    Boolean(slack.json) &&
      ["status", "last_event_at", "last_error", "tokens"].every((k) => k in slack.json),
  );
  eq("slack status last_event_at null", slack.json && slack.json.last_event_at, null);
  check("slack status leaks no secrets", !hasSecret(slack.json));
  eq(
    "slack status 401 without token",
    (await req("GET", "/api/slack/config/status")).status,
    401,
  );

  // --- ws-ticket issuance: POST body {kind, pane_id} -> project+kind+pane bind ---
  const WORKER_PANE = `${ALPHA}:1.1`; // worker node pane — exposed/allowed
  const LEAD_PANE = `${ALPHA}:1.0`; // also exposed; used for the pane-mismatch case
  const t1 = await req("POST", "/api/ws-ticket", { token, body: { kind: "board" } });
  eq("ws-ticket 200 (board)", t1.status, 200);
  check(
    "ws-ticket returns a non-empty ticket",
    Boolean(t1.json) && typeof t1.json.ticket === "string" && t1.json.ticket.length > 0,
  );
  eq("ws-ticket ttl_seconds == 30", t1.json && t1.json.ttl_seconds, 30);
  eq("ws-ticket default project == session (alpha)", t1.json && t1.json.project, ALPHA);
  eq("ws-ticket echoes kind=board", t1.json && t1.json.kind, "board");
  eq("ws-ticket board pane_id is null", t1.json && t1.json.pane_id, null);
  const t2 = await req("POST", "/api/ws-ticket", { token, project: BETA, body: { kind: "board" } });
  eq("ws-ticket binds project from header (beta)", t2.json && t2.json.project, BETA);
  const tt = await req("POST", "/api/ws-ticket", { token, body: { kind: "terminal", pane_id: WORKER_PANE } });
  eq("ws-ticket 200 (terminal)", tt.status, 200);
  eq("ws-ticket echoes kind=terminal", tt.json && tt.json.kind, "terminal");
  eq("ws-ticket echoes pane_id", tt.json && tt.json.pane_id, WORKER_PANE);
  eq(
    "ws-ticket terminal without pane_id -> 400",
    (await req("POST", "/api/ws-ticket", { token, body: { kind: "terminal" } })).status,
    400,
  );

  // --- Origin (CSRF) on a state-change POST ---
  eq(
    "ws-ticket with foreign Origin -> 403",
    (await req("POST", "/api/ws-ticket", { token, body: { kind: "board" }, origin: "http://evil.example" }))
      .status,
    403,
  );

  // --- ws-ticket kind/pane binding enforced over real WS upgrades ---
  const wsBase = `ws://127.0.0.1:${port}`;
  const issue = async (kind, pane_id) => {
    const r = await req("POST", "/api/ws-ticket", {
      token,
      project: ALPHA,
      body: pane_id ? { kind, pane_id } : { kind },
    });
    return (r.json && r.json.ticket) || "";
  };
  const termUrl = (ticket, pane) =>
    `${wsBase}/ws/terminal?ticket=${encodeURIComponent(ticket)}&pane_id=${encodeURIComponent(pane)}`;
  const boardUrl = (ticket) => `${wsBase}/ws/board?ticket=${encodeURIComponent(ticket)}&cursor=0`;

  const posTerm = await wsProbe(termUrl(await issue("terminal", WORKER_PANE), WORKER_PANE));
  check("ws/terminal accepts a matching terminal ticket+pane", posTerm.opened === true, `code ${posTerm.code}`);
  const boardOnTerm = await wsProbe(termUrl(await issue("board"), WORKER_PANE));
  check("ws/terminal rejects a board ticket (kind mismatch)", boardOnTerm.opened === false, `code ${boardOnTerm.code}`);
  const termOnBoard = await wsProbe(boardUrl(await issue("terminal", WORKER_PANE)));
  check("ws/board rejects a terminal ticket (kind mismatch)", termOnBoard.opened === false, `code ${termOnBoard.code}`);
  const paneMismatch = await wsProbe(termUrl(await issue("terminal", WORKER_PANE), LEAD_PANE));
  check("ws/terminal rejects a pane-mismatched ticket", paneMismatch.opened === false, `code ${paneMismatch.code}`);

  // --- board ws single-use + bogus ticket ---
  const ticket = await issue("board");
  const first = await wsProbe(boardUrl(ticket));
  check("ws/board opens with a fresh board ticket", first.opened === true, `code ${first.code}`);
  const second = await wsProbe(boardUrl(ticket));
  check("ws/board rejects a reused ticket (single-use)", second.opened === false, `code ${second.code}`);
  const bogus = await wsProbe(boardUrl("not-a-real-ticket"));
  check("ws/board rejects a bogus ticket", bogus.opened === false, `code ${bogus.code}`);

  // === v1.5 — new-endpoint coverage (systematic mock-drift guard) ============
  // These assert the REAL backend shapes the FE consumes (api.ts). v1.4 shipped
  // a drift bug where the mock matched FE assumptions but the real server did
  // not (events vs items, number vs string confidence, agents[] vs by_agent{}).
  // Covering them here means the same class of drift fails in CI, not prod.

  // --- /api/audit: object actor/target, numeric next_cursor, filters+paging ---
  eq("audit 401 without token", (await req("GET", "/api/audit")).status, 401);

  // Graceful empty board (BETA has no events): items:[] + numeric cursor.
  const emptyAudit = await req("GET", "/api/audit", { token, project: BETA });
  eq("audit 200 on empty board", emptyAudit.status, 200);
  check(
    "audit empty board returns items:[] (graceful)",
    Boolean(emptyAudit.json) && Array.isArray(emptyAudit.json.items) && emptyAudit.json.items.length === 0,
  );
  check(
    "audit empty board next_cursor is a number",
    Boolean(emptyAudit.json) && typeof emptyAudit.json.next_cursor === "number",
  );

  // Seed two audit.task.assign events on the ALPHA board (POST task w/ assignee).
  eq(
    "seed: assign task -> worker (200)",
    (await req("POST", `/api/boards/${ALPHA}/tasks`, {
      token,
      project: ALPHA,
      body: { title: "e2e assign A", assignee: "worker" },
    })).status,
    200,
  );
  eq(
    "seed: assign task -> lead (200)",
    (await req("POST", `/api/boards/${ALPHA}/tasks`, {
      token,
      project: ALPHA,
      body: { title: "e2e assign B", assignee: "lead" },
    })).status,
    200,
  );

  const audit = await req("GET", "/api/audit", { token, project: ALPHA });
  eq("audit 200 with token", audit.status, 200);
  const items = audit.json && Array.isArray(audit.json.items) ? audit.json.items : null;
  check("audit returns items[] (>=2 seeded)", Array.isArray(items) && items.length >= 2, items && items.length);
  check("audit next_cursor is a number", Boolean(audit.json) && typeof audit.json.next_cursor === "number");
  const ev = (items || []).find((e) => e.action === "assign") || (items || [])[0];
  check(
    "audit event actor is an OBJECT {kind,id} (not a string)",
    Boolean(ev) &&
      ev.actor &&
      typeof ev.actor === "object" &&
      !Array.isArray(ev.actor) &&
      typeof ev.actor.kind === "string" &&
      typeof ev.actor.id === "string",
    ev && JSON.stringify(ev.actor),
  );
  check("audit event action is a string", Boolean(ev) && typeof ev.action === "string");
  check(
    "audit event target is an OBJECT (with .node for assign)",
    Boolean(ev) && ev.target && typeof ev.target === "object" && !Array.isArray(ev.target),
    ev && JSON.stringify(ev.target),
  );
  check("audit event ts is a number", Boolean(ev) && typeof ev.ts === "number", ev && JSON.stringify(ev.ts));
  check(
    "audit assign event carries target.node = assignee",
    (items || []).some((e) => e.action === "assign" && e.target && (e.target.node === "worker" || e.target.node === "lead")),
  );
  check("audit leaks no secrets", !hasSecret(audit.json));

  // action filter (exact match in store).
  const assignOnly = await req("GET", "/api/audit?action=assign", { token, project: ALPHA });
  const assignItems = (assignOnly.json && assignOnly.json.items) || [];
  check(
    "audit ?action=assign returns only assign events",
    assignItems.length >= 2 && assignItems.every((e) => e.action === "assign"),
    assignItems.map((e) => e.action).join(","),
  );
  const unknownAction = await req("GET", "/api/audit?action=__nope__", { token, project: ALPHA });
  check(
    "audit ?action=<unknown> returns empty items",
    Array.isArray(unknownAction.json && unknownAction.json.items) && unknownAction.json.items.length === 0,
  );

  // node filter (actor.id / target.node / from_node / to_node).
  const byWorker = await req("GET", "/api/audit?node=worker", { token, project: ALPHA });
  const workerItems = (byWorker.json && byWorker.json.items) || [];
  check(
    "audit ?node=worker matches the worker-targeted assign",
    workerItems.length >= 1 &&
      workerItems.every(
        (e) =>
          e.actor.id === "worker" ||
          (e.target && e.target.node === "worker") ||
          e.from_node === "worker" ||
          e.to_node === "worker",
      ),
    workerItems.length,
  );

  // cursor paging: limit=1 advances strictly without repeating.
  const page1 = await req("GET", "/api/audit?action=assign&limit=1", { token, project: ALPHA });
  const p1 = (page1.json && page1.json.items) || [];
  check("audit paging page1 (limit=1) returns 1 item", p1.length === 1, p1.length);
  const c1 = page1.json && page1.json.next_cursor;
  const page2 = await req("GET", `/api/audit?action=assign&limit=1&cursor=${c1}`, { token, project: ALPHA });
  const p2 = (page2.json && page2.json.items) || [];
  check("audit paging page2 (cursor) returns the next item", p2.length === 1, p2.length);
  check(
    "audit paging advances strictly (page2.cursor > page1.cursor, no repeat)",
    p1.length === 1 && p2.length === 1 && typeof p1[0].cursor === "number" && p2[0].cursor > p1[0].cursor,
    `${p1[0] && p1[0].cursor} -> ${p2[0] && p2[0].cursor}`,
  );

  // --- /api/status?detail=1: node_details[], confidence is a STRING ---
  const noDetail = await req("GET", "/api/status", { token, project: ALPHA });
  check(
    "status (no detail) omits node_details",
    Boolean(noDetail.json) && !("node_details" in noDetail.json),
  );
  check(
    "status nodes summary has {total,running} ints",
    Boolean(noDetail.json) &&
      noDetail.json.nodes &&
      typeof noDetail.json.nodes.total === "number" &&
      typeof noDetail.json.nodes.running === "number",
  );
  const detail = await req("GET", "/api/status?detail=1", { token, project: ALPHA });
  eq("status?detail=1 200", detail.status, 200);
  const nd = detail.json && Array.isArray(detail.json.node_details) ? detail.json.node_details : null;
  check("status?detail=1 returns node_details[]", Array.isArray(nd) && nd.length >= 1, nd && nd.length);
  const row = (nd || []).find((r) => r.name === "worker") || (nd || [])[0];
  check("node_detail has name+status strings", Boolean(row) && typeof row.name === "string" && typeof row.status === "string");
  check(
    "node_detail confidence is a STRING (the v1.4 drift bug: FE treated it as number)",
    Boolean(row) && typeof row.confidence === "string",
    row && JSON.stringify(row.confidence),
  );
  check(
    "node_detail confidence in {explicit,inferred}",
    Boolean(row) && ["explicit", "inferred"].includes(row.confidence),
    row && row.confidence,
  );
  check("node_detail source is a string", Boolean(row) && typeof row.source === "string", row && row.source);
  check("node_detail status_reason is a string", Boolean(row) && typeof row.status_reason === "string");
  check(
    "node_detail last_seen is int-or-null (epoch seconds)",
    Boolean(row) && (typeof row.last_seen === "number" || row.last_seen === null),
    row && JSON.stringify(row.last_seen),
  );
  check(
    "node_detail worker last_seen is the seeded int",
    Boolean(row) && typeof row.last_seen === "number" && row.last_seen === NODE_LAST_SEEN,
    row && JSON.stringify(row.last_seen),
  );
  check("status?detail=1 leaks no secrets", !hasSecret(detail.json));

  // --- /api/usage: node/day rollups, agy unknowns, project scope ---
  const usageSecret = "xoxb-" + "a".repeat(44);
  writeRegistry(USAGE, {
    maker: { name: "maker", agent: "codex", tmux_pane: `${USAGE}:1.0`, status: "idle" },
    reviewer: { name: "reviewer", agent: "claude", tmux_pane: `${USAGE}:1.1`, status: "idle" },
    "agy-node": { name: "agy-node", agent: "agy", tmux_pane: `${USAGE}:1.2`, status: "idle" },
  });
  writeRegistry(USAGE_EMPTY, {
    "empty-worker": { name: "empty-worker", agent: "codex", tmux_pane: `${USAGE_EMPTY}:1.0`, status: "idle" },
  });
  completeUsageRun({
    board: USAGE,
    node: "maker",
    metadata: {
      node: "maker",
      input_tokens: 10,
      output_tokens: 5,
      total_tokens: 15,
      cost_usd: 0.12,
      transcript_path: `/Users/chopin/private/${usageSecret}.jsonl`,
    },
    startedAt: 1_704_067_200,
  });
  completeUsageRun({
    board: USAGE,
    node: "maker",
    metadata: { node: "maker", input_tokens: 2, output_tokens: 5, total_tokens: 7, cost_usd: 0.02 },
    startedAt: 1_704_067_260,
  });
  completeUsageRun({
    board: USAGE,
    node: "reviewer",
    metadata: { node: "reviewer", total_tokens: 30 },
    startedAt: 1_704_153_600,
  });
  completeUsageRun({
    board: USAGE,
    node: "agy-node",
    metadata: { node: "agy-node", total_tokens: 44 },
    startedAt: 1_704_153_660,
  });

  eq("usage 401 without token", (await req("GET", "/api/usage?window=all")).status, 401);
  eq(
    "usage 401 with wrong token",
    (await req("GET", "/api/usage?window=all", { token: "wrong-token" })).status,
    401,
  );
  const usage = await req("GET", `/api/usage?window=all&project=${encodeURIComponent(USAGE)}`, { token });
  eq("usage 200 with token", usage.status, 200);
  eq("usage project == usage project", usage.json && usage.json.project, USAGE);
  eq("usage window name == all", usage.json && usage.json.window && usage.json.window.name, "all");
  check("usage generated_at is tagged metric", isTaggedMetric(usage.json && usage.json.generated_at));
  check("usage filters expose node/agent", Boolean(usage.json) && usage.json.filters && "node" in usage.json.filters && "agent" in usage.json.filters);
  const usageTotals = usage.json && usage.json.totals;
  check(
    "usage totals has run/token/cost metrics",
    Boolean(usageTotals) &&
      isTaggedMetric(usageTotals.runs) &&
      isTaggedMetric(usageTotals.input_tokens) &&
      isTaggedMetric(usageTotals.output_tokens) &&
      isTaggedMetric(usageTotals.total_tokens) &&
      isTaggedMetric(usageTotals.cost_usd_estimate),
  );
  eq("usage totals runs == 4", usageTotals && usageTotals.runs && usageTotals.runs.value, 4);
  eq("usage totals total_tokens == 96", usageTotals && usageTotals.total_tokens && usageTotals.total_tokens.value, 96);
  eq("usage totals confidence explicit", usageTotals && usageTotals.confidence, "explicit");
  const usageNodes = usage.json && Array.isArray(usage.json.nodes) ? usage.json.nodes : [];
  check("usage nodes roll up by node", usageNodes.length === 3, usageNodes.map((node) => node.node).join(","));
  const usageNodeByName = Object.fromEntries(usageNodes.map((node) => [node.node, node]));
  const makerUsage = usageNodeByName.maker;
  eq("usage maker runs == 2", makerUsage && makerUsage.totals && makerUsage.totals.runs.value, 2);
  eq("usage maker input_tokens == 12", makerUsage && makerUsage.totals && makerUsage.totals.input_tokens.value, 12);
  eq("usage maker cost_usd_estimate == 0.14", makerUsage && makerUsage.totals && makerUsage.totals.cost_usd_estimate.value, 0.14);
  check("usage maker includes per-day rollup", Boolean(makerUsage) && Array.isArray(makerUsage.days) && makerUsage.days.length === 1);
  const reviewerUsage = usageNodeByName.reviewer;
  eq("usage reviewer agent == claude", reviewerUsage && reviewerUsage.agent, "claude");
  eq("usage reviewer total_tokens == 30", reviewerUsage && reviewerUsage.totals && reviewerUsage.totals.total_tokens.value, 30);
  const agyUsage = usageNodeByName["agy-node"];
  eq("usage agy node agent == agy", agyUsage && agyUsage.agent, "agy");
  eq("usage agy total_tokens preserved", agyUsage && agyUsage.totals && agyUsage.totals.total_tokens.value, 44);
  eq("usage agy cost is unknown/null", agyUsage && agyUsage.totals && agyUsage.totals.cost_usd_estimate.value, null);
  eq("usage agy cost confidence unknown", agyUsage && agyUsage.totals && agyUsage.totals.cost_usd_estimate.confidence, "unknown");
  eq("usage agy cost status unknown", agyUsage && agyUsage.totals && agyUsage.totals.cost_usd_estimate.status, "unknown");
  eq("usage agy credit_remaining unknown/null", agyUsage && agyUsage.credit_remaining && agyUsage.credit_remaining.value, null);
  eq("usage agy credit_status unknown", agyUsage && agyUsage.credit_status, "unknown");
  check(
    "usage agy warns credit unknown without estimating",
    Boolean(agyUsage) &&
      Array.isArray(agyUsage.warnings) &&
      agyUsage.warnings.some((warning) => /agy credit is unknown/i.test(warning)),
    agyUsage && JSON.stringify(agyUsage.warnings),
  );
  const usageDays = usage.json && Array.isArray(usage.json.days) ? usage.json.days : [];
  check("usage days roll up by day", usageDays.length === 2, usageDays.map((day) => day.day).join(","));
  const usageDayByDate = Object.fromEntries(usageDays.map((day) => [day.day, day]));
  eq("usage 2024-01-01 runs == 2", usageDayByDate["2024-01-01"] && usageDayByDate["2024-01-01"].totals.runs.value, 2);
  eq("usage 2024-01-01 total_tokens == 22", usageDayByDate["2024-01-01"] && usageDayByDate["2024-01-01"].totals.total_tokens.value, 22);
  eq("usage 2024-01-02 runs == 2", usageDayByDate["2024-01-02"] && usageDayByDate["2024-01-02"].totals.runs.value, 2);
  check(
    "usage 2024-01-02 nodes are reviewer+agy",
    Boolean(usageDayByDate["2024-01-02"]) &&
      JSON.stringify(usageDayByDate["2024-01-02"].nodes.map((node) => node.node).sort()) ===
        JSON.stringify(["agy-node", "reviewer"]),
    usageDayByDate["2024-01-02"] && usageDayByDate["2024-01-02"].nodes.map((node) => node.node).join(","),
  );
  check(
    "usage limitations document explicit metadata and agy unknown",
    Boolean(usage.json) &&
      Array.isArray(usage.json.limitations) &&
      usage.json.limitations.some((item) => /explicit run metadata/i.test(item)) &&
      usage.json.limitations.some((item) => /agy credit is unknown/i.test(item)),
  );
  check(
    "usage leaks no secrets or filesystem paths",
    !hasSecret(usage.json) &&
      !usage.text.includes(usageSecret) &&
      !usage.text.includes("/Users/chopin/private") &&
      !usage.text.includes(groveHome) &&
      !/registry\.json/.test(usage.text),
  );
  const usageEmpty = await req("GET", `/api/usage?window=all&project=${encodeURIComponent(USAGE_EMPTY)}`, { token });
  eq("usage empty project 200", usageEmpty.status, 200);
  eq("usage empty project name", usageEmpty.json && usageEmpty.json.project, USAGE_EMPTY);
  eq("usage empty totals runs == 0", usageEmpty.json && usageEmpty.json.totals && usageEmpty.json.totals.runs.value, 0);
  check("usage empty nodes:[]", Boolean(usageEmpty.json) && Array.isArray(usageEmpty.json.nodes) && usageEmpty.json.nodes.length === 0);
  check("usage empty days:[]", Boolean(usageEmpty.json) && Array.isArray(usageEmpty.json.days) && usageEmpty.json.days.length === 0);
  check(
    "usage empty data is graceful with limitation",
    Boolean(usageEmpty.json) &&
      Array.isArray(usageEmpty.json.limitations) &&
      usageEmpty.json.limitations.some((item) => /no runs matched/i.test(item)),
  );
  check(
    "usage project scope does not leak other project node/token values",
    !JSON.stringify([usageEmpty.json && usageEmpty.json.nodes, usageEmpty.json && usageEmpty.json.days]).includes("maker") &&
      usageEmpty.json &&
      usageEmpty.json.totals &&
      usageEmpty.json.totals.total_tokens &&
      usageEmpty.json.totals.total_tokens.value !== 96,
    usageEmpty.text,
  );
  const usageEmptyByHeader = await req("GET", "/api/usage?window=all", { token, project: USAGE_EMPTY });
  eq("usage header project scope returns empty project", usageEmptyByHeader.json && usageEmptyByHeader.json.project, USAGE_EMPTY);
  eq("usage path traversal project -> 400", (await req("GET", `/api/usage?project=${encodeURIComponent(`../${USAGE}`)}`, { token })).status, 400);
  eq("usage missing project -> 404", (await req("GET", "/api/usage?project=qae2e_missing_usage", { token })).status, 404);
  eq("usage invalid window -> 400", (await req("GET", `/api/usage?window=forever&project=${encodeURIComponent(USAGE)}`, { token })).status, 400);

  // --- /api/summary + /api/aggregate: signed counts-only export, trust gates ---
  const summarySecret = "xoxb-" + "b".repeat(44);
  const summaryAgentSecret = "xapp-" + "c".repeat(20);
  const summaryPrivatePath = `/Users/chopin/private/${summarySecret}`;
  writeRegistry(SUMMARY, {
    "odd-node": {
      name: "odd-node",
      agent: summaryAgentSecret,
      tmux_pane: `${SUMMARY}:1.0`,
      session_id: "summary-session",
      status: summaryPrivatePath,
      transcript_path: `${summaryPrivatePath}.jsonl`,
    },
  });
  const summaryReadySeed = await req("POST", `/api/boards/${SUMMARY}/tasks`, {
    token,
    project: SUMMARY,
    body: {
      title: `summary ready leak probe ${summarySecret}`,
      body: `body must not export ${summaryPrivatePath}`,
      assignee: "odd-node",
      status: "ready",
    },
  });
  eq("seed: summary ready task 200", summaryReadySeed.status, 200);
  // v1.28: HTTP create now validates status (_manual_task_status -> 400 on an
  // out-of-allowlist value). The summary "other" bucket must still classify
  // store-level/legacy arbitrary statuses, so inject this one through the store
  // directly (the path-valued status + secret assignee/body stay as the
  // redaction probes the summary allowlist must scrub).
  const summaryOtherTaskId = createTaskWithMetadata({
    board: SUMMARY,
    title: "summary other status",
    body: `transcript ${summaryPrivatePath}/turn.jsonl must not export`,
    assignee: summaryAgentSecret,
    status: summaryPrivatePath,
  });
  check(
    "seed: summary other-status task (store-injected; HTTP create rejects invalid status)",
    typeof summaryOtherTaskId === "string" && summaryOtherTaskId.length > 0,
    summaryOtherTaskId,
  );
  const defaultOffSummary = await req("GET", `/api/summary?project=${encodeURIComponent(SUMMARY)}`, { token });
  check("summary default-off rejects when export is disabled", [403, 404].includes(defaultOffSummary.status), defaultOffSummary.status);

  await startSummaryServer({ session: SUMMARY, freshnessSeconds: 60 });
  try {
    const summaryIndex = await reqAt(summaryBaseUrl, "GET", "/");
    eq("summary server index served (200)", summaryIndex.status, 200);
    const summaryMatch = summaryIndex.text.match(/window\.__GROVE_SESSION_TOKEN__ = "([^"]+)"/);
    check("summary server injects session token", Boolean(summaryMatch));
    const summaryToken = summaryMatch ? summaryMatch[1] : "";
    eq("summary 401 without token", (await reqAt(summaryBaseUrl, "GET", "/api/summary")).status, 401);
    eq(
      "summary 401 with wrong token",
      (await reqAt(summaryBaseUrl, "GET", "/api/summary", { token: "wrong-token" })).status,
      401,
    );
    const summary = await reqAt(summaryBaseUrl, "GET", "/api/summary", { token: summaryToken });
    eq("summary 200 when export enabled", summary.status, 200);
    eq("summary algorithm hmac-sha256", summary.json && summary.json.algorithm, "hmac-sha256");
    check("summary includes key_id only id shape", typeof (summary.json && summary.json.key_id) === "string" && summary.json.key_id.length === 16);
    check("summary includes sha256 signature", /^sha256:[0-9a-f]{64}$/.test((summary.json && summary.json.signature) || ""));
    const summaryPayload = summary.json && summary.json.payload;
    eq("summary payload schema", summaryPayload && summaryPayload.schema, "grove.summary.v1");
    eq("summary payload project == summary project", summaryPayload && summaryPayload.project, SUMMARY);
    check("summary payload generated_at is epoch int", Number.isInteger(summaryPayload && summaryPayload.generated_at));
    const summaryCounts = summaryPayload && summaryPayload.summary;
    eq("summary boards total == 1", summaryCounts && summaryCounts.boards && summaryCounts.boards.total, 1);
    eq("summary tasks total == 2", summaryCounts && summaryCounts.tasks && summaryCounts.tasks.total, 2);
    eq("summary task ready bucket == 1", summaryCounts && summaryCounts.tasks && summaryCounts.tasks.by_status.ready, 1);
    eq("summary arbitrary task status buckets as other", summaryCounts && summaryCounts.tasks && summaryCounts.tasks.by_status.other, 1);
    eq("summary nodes total == 1", summaryCounts && summaryCounts.nodes && summaryCounts.nodes.total, 1);
    eq("summary arbitrary node status buckets as other", summaryCounts && summaryCounts.nodes && summaryCounts.nodes.by_status.other, 1);
    eq("summary arbitrary node agent buckets as other", summaryCounts && summaryCounts.nodes && summaryCounts.nodes.by_agent.other, 1);
    check(
      "summary response is counts-only allowlist",
      Boolean(summaryCounts) &&
        !summary.text.includes(summarySecret) &&
        !summary.text.includes(summaryAgentSecret) &&
        !summary.text.includes(summaryPrivatePath) &&
        !summary.text.includes("body must not export") &&
        !summary.text.includes("transcript") &&
        !summary.text.includes("odd-node") &&
        !summary.text.includes("assignee") &&
        !summary.text.includes("title"),
      summary.text.slice(0, 200),
    );
    const summaryKey = readFileSync(path.join(groveHome, SUMMARY, "summary-signing-key"), "utf8").trim();
    eq("summary key_id matches local signing key", summary.json && summary.json.key_id, summaryKeyId(summaryKey));
    check(
      "summary response exposes key_id but not signing key",
      summary.text.includes(summary.json.key_id) && !summary.text.includes(summaryKey) && !summary.text.includes("summary-signing-key"),
    );
    eq(
      "summary path traversal project -> 400",
      (await reqAt(summaryBaseUrl, "GET", `/api/summary?project=${encodeURIComponent(`../${SUMMARY}`)}`, { token: summaryToken })).status,
      400,
    );
    eq(
      "summary missing project -> 404",
      (await reqAt(summaryBaseUrl, "GET", "/api/summary?project=qae2e_missing_summary", { token: summaryToken })).status,
      404,
    );

    eq("aggregate 401 without token", (await reqAt(summaryBaseUrl, "POST", "/api/aggregate", { body: { summaries: [] } })).status, 401);
    eq(
      "aggregate 401 with wrong token",
      (await reqAt(summaryBaseUrl, "POST", "/api/aggregate", { token: "wrong-token", body: { summaries: [] } })).status,
      401,
    );
    const trustedAggregate = await reqAt(summaryBaseUrl, "POST", "/api/aggregate", {
      token: summaryToken,
      body: { summaries: [summary.json] },
    });
    eq("aggregate trusted summary 200", trustedAggregate.status, 200);
    check("aggregate generated_at is tagged metric", isTaggedMetric(trustedAggregate.json && trustedAggregate.json.generated_at));
    eq("aggregate trusted count == 1", trustedAggregate.json && trustedAggregate.json.trust && trustedAggregate.json.trust.trusted, 1);
    eq("aggregate untrusted count == 0", trustedAggregate.json && trustedAggregate.json.trust && trustedAggregate.json.trust.untrusted, 0);
    eq("aggregate combined sources == 1", trustedAggregate.json && trustedAggregate.json.combined && trustedAggregate.json.combined.sources, 1);
    check(
      "aggregate combined includes summary project only",
      JSON.stringify((trustedAggregate.json && trustedAggregate.json.combined && trustedAggregate.json.combined.projects) || []) ===
        JSON.stringify([SUMMARY]),
    );
    eq("aggregate combined task total == 2", trustedAggregate.json && trustedAggregate.json.combined && trustedAggregate.json.combined.tasks.total, 2);

    const tamperedSummary = cloneJson(summary.json);
    tamperedSummary.payload.summary.tasks.total = 999;
    const unknownKeySummary = cloneJson(summary.json);
    unknownKeySummary.key_id = "unknown-key-id";
    const now = Math.floor(Date.now() / 1000);
    const staleSummary = cloneJson(summary.json);
    staleSummary.payload.generated_at = now - 120;
    staleSummary.signature = summarySignature(summaryKey, staleSummary.payload);
    const futureSummary = cloneJson(summary.json);
    futureSummary.payload.generated_at = now + 120;
    futureSummary.signature = summarySignature(summaryKey, futureSummary.payload);
    const aggregateMixed = await reqAt(summaryBaseUrl, "POST", "/api/aggregate", {
      token: summaryToken,
      body: { summaries: [summary.json, tamperedSummary, unknownKeySummary, staleSummary, futureSummary] },
    });
    eq("aggregate mixed summaries 200", aggregateMixed.status, 200);
    eq("aggregate mixed trusted count includes fresh+stale", aggregateMixed.json && aggregateMixed.json.trust && aggregateMixed.json.trust.trusted, 2);
    eq("aggregate mixed untrusted count == tampered+unknown+future", aggregateMixed.json && aggregateMixed.json.trust && aggregateMixed.json.trust.untrusted, 3);
    eq("aggregate mixed stale count == 1", aggregateMixed.json && aggregateMixed.json.trust && aggregateMixed.json.trust.stale, 1);
    const aggregateItems = (aggregateMixed.json && aggregateMixed.json.summaries) || [];
    eq("aggregate trusted summary marked fresh", aggregateItems[0] && aggregateItems[0].freshness, "fresh");
    check("aggregate tampered signature is untrusted", aggregateItems[1] && aggregateItems[1].trust === "untrusted" && /signature/i.test(aggregateItems[1].reason));
    check("aggregate unknown key_id is untrusted", aggregateItems[2] && aggregateItems[2].trust === "untrusted" && /unknown/i.test(aggregateItems[2].reason));
    check("aggregate stale signed summary is excluded", aggregateItems[3] && aggregateItems[3].trust === "trusted" && aggregateItems[3].freshness === "stale");
    check("aggregate future timestamp is untrusted", aggregateItems[4] && aggregateItems[4].trust === "untrusted" && /timestamp/i.test(aggregateItems[4].reason));
    eq("aggregate mixed combined excludes stale/untrusted sources", aggregateMixed.json && aggregateMixed.json.combined && aggregateMixed.json.combined.sources, 1);
    eq("aggregate mixed combined excludes tampered totals", aggregateMixed.json && aggregateMixed.json.combined && aggregateMixed.json.combined.tasks.total, 2);
    check(
      "aggregate responses leak no key/secret/path/task body",
      !hasSecret(trustedAggregate.json) &&
        !hasSecret(aggregateMixed.json) &&
        !trustedAggregate.text.includes(summaryKey) &&
        !aggregateMixed.text.includes(summaryKey) &&
        !aggregateMixed.text.includes(summarySecret) &&
        !aggregateMixed.text.includes(summaryAgentSecret) &&
        !aggregateMixed.text.includes(summaryPrivatePath) &&
        !aggregateMixed.text.includes("body must not export") &&
        !aggregateMixed.text.includes("summary-signing-key"),
    );
    const aggregateWrongProject = await reqAt(summaryBaseUrl, "POST", `/api/aggregate?project=${encodeURIComponent(ALPHA)}`, {
      token: summaryToken,
      body: { summaries: [summary.json] },
    });
    eq("aggregate other project scope returns 200 read-only", aggregateWrongProject.status, 200);
    eq(
      "aggregate other project treats summary key as untrusted",
      aggregateWrongProject.json && aggregateWrongProject.json.trust && aggregateWrongProject.json.trust.untrusted,
      1,
    );
    eq(
      "aggregate other project excludes foreign summary from combined",
      aggregateWrongProject.json && aggregateWrongProject.json.combined && aggregateWrongProject.json.combined.sources,
      0,
    );
    eq(
      "aggregate missing project -> 404",
      (await reqAt(summaryBaseUrl, "POST", "/api/aggregate?project=qae2e_missing_summary", {
        token: summaryToken,
        body: { summaries: [summary.json] },
      })).status,
      404,
    );
  } finally {
    await stopSummaryServer();
  }

  // --- /api/handoff/export + /api/handoff/accept: signed handoff, trusted local receive ---
  const handoffSecret = "xoxb-" + "d".repeat(44);
  const handoffEmail = "handoff.owner@example.test";
  const handoffPrivatePath = `/Users/chopin/private/${handoffSecret}`;
  writeRegistry(HANDOFF_SOURCE, {
    sender: { name: "sender", agent: "codex", tmux_pane: `${HANDOFF_SOURCE}:1.0`, status: "idle" },
  });
  writeRegistry(HANDOFF_RECEIVER, {
    receiver: { name: "receiver", agent: "claude", tmux_pane: `${HANDOFF_RECEIVER}:1.0`, status: "idle" },
  });
  const handoffSourceTaskId = createTaskWithMetadata({
    board: HANDOFF_SOURCE,
    title: `handoff export ${handoffSecret} ${handoffEmail}`,
    body: `Ship from ${handoffPrivatePath}; transcript ${handoffPrivatePath}/turn.jsonl; contact ${handoffEmail}.`,
    assignee: "sender",
    priority: 42,
    metadata: {
      labels: ["handoff-safe", handoffSecret, handoffPrivatePath, handoffEmail],
      transcript_path: `${handoffPrivatePath}/transcript.jsonl`,
      owner_email: handoffEmail,
    },
  });
  check("seed: handoff source task returns id", typeof handoffSourceTaskId === "string" && handoffSourceTaskId.length > 0);
  const defaultOffHandoffExport = await req("POST", "/api/handoff/export", {
    token,
    project: HANDOFF_SOURCE,
    body: { task_id: handoffSourceTaskId },
  });
  check("handoff export default-off rejects when disabled", [403, 404].includes(defaultOffHandoffExport.status), defaultOffHandoffExport.status);
  const defaultOffHandoffAccept = await req("POST", "/api/handoff/accept", {
    token,
    project: HANDOFF_RECEIVER,
    body: { package: {} },
  });
  check("handoff accept default-off rejects when disabled", [403, 404].includes(defaultOffHandoffAccept.status), defaultOffHandoffAccept.status);

  await startHandoffServer({ session: HANDOFF_SOURCE, ttlSeconds: 60 });
  let handoffPackage;
  let handoffSourceKey;
  try {
    const handoffSourceIndex = await reqAt(handoffBaseUrl, "GET", "/");
    eq("handoff source index served (200)", handoffSourceIndex.status, 200);
    const handoffSourceMatch = handoffSourceIndex.text.match(/window\.__GROVE_SESSION_TOKEN__ = "([^"]+)"/);
    check("handoff source injects session token", Boolean(handoffSourceMatch));
    const handoffSourceToken = handoffSourceMatch ? handoffSourceMatch[1] : "";
    const handoffExportPath = `/api/handoff/export?task_id=${encodeURIComponent(handoffSourceTaskId)}`;
    eq("handoff export GET 401 without token", (await reqAt(handoffBaseUrl, "GET", handoffExportPath)).status, 401);
    eq(
      "handoff export POST 401 with wrong token",
      (await reqAt(handoffBaseUrl, "POST", "/api/handoff/export", {
        token: "wrong-token",
        body: { task_id: handoffSourceTaskId },
      })).status,
      401,
    );
    const handoffWrongProject = await reqAt(handoffBaseUrl, "POST", "/api/handoff/export", {
      token: handoffSourceToken,
      project: HANDOFF_RECEIVER,
      body: { task_id: handoffSourceTaskId },
    });
    eq("handoff export rejects task outside project scope", handoffWrongProject.status, 404);
    eq(
      "handoff export path traversal project -> 400",
      (await reqAt(handoffBaseUrl, "POST", `/api/handoff/export?project=${encodeURIComponent(`../${HANDOFF_SOURCE}`)}`, {
        token: handoffSourceToken,
        body: { task_id: handoffSourceTaskId },
      })).status,
      400,
    );
    const handoffExport = await reqAt(handoffBaseUrl, "POST", "/api/handoff/export", {
      token: handoffSourceToken,
      body: { task_id: handoffSourceTaskId },
    });
    eq("handoff export 200 when enabled", handoffExport.status, 200);
    handoffPackage = handoffExport.json;
    eq("handoff export algorithm hmac-sha256", handoffPackage && handoffPackage.algorithm, "hmac-sha256");
    check("handoff export includes key_id shape", typeof (handoffPackage && handoffPackage.key_id) === "string" && handoffPackage.key_id.length === 16);
    check("handoff export includes sha256 signature", /^sha256:[0-9a-f]{64}$/.test((handoffPackage && handoffPackage.signature) || ""));
    const handoffPayload = handoffPackage && handoffPackage.payload;
    eq("handoff payload schema", handoffPayload && handoffPayload.schema, "grove.handoff.v1");
    check("handoff payload id has handoff_ prefix", /^handoff_[A-Za-z0-9_-]{16,}$/.test((handoffPayload && handoffPayload.handoff_id) || ""));
    eq("handoff payload source project", handoffPayload && handoffPayload.source_project, HANDOFF_SOURCE);
    check("handoff payload generated/expires are epoch ints", Number.isInteger(handoffPayload && handoffPayload.generated_at) && Number.isInteger(handoffPayload && handoffPayload.expires_at));
    check("handoff payload expires after generated", handoffPayload && handoffPayload.expires_at > handoffPayload.generated_at);
    const handoffTask = handoffPayload && handoffPayload.task;
    check(
      "handoff task payload is allowlisted fields only",
      JSON.stringify(Object.keys(handoffTask || {}).sort()) === JSON.stringify(["body", "labels", "priority", "title"]),
      JSON.stringify(handoffTask),
    );
    eq("handoff task priority preserved/clamped", handoffTask && handoffTask.priority, 42);
    check("handoff task labels array includes safe label", Array.isArray(handoffTask && handoffTask.labels) && handoffTask.labels.includes("handoff-safe"));
    check(
      "handoff export redacts secret/pii/path/transcript",
      !handoffExport.text.includes(handoffSecret) &&
        !handoffExport.text.includes(handoffEmail) &&
        !handoffExport.text.includes(handoffPrivatePath) &&
        !handoffExport.text.includes("transcript_path") &&
        !handoffExport.text.includes("turn.jsonl") &&
        !handoffExport.text.includes("owner_email") &&
        !handoffExport.text.includes("assignee") &&
        !handoffExport.text.includes("status") &&
        !handoffExport.text.includes("workspace"),
      handoffExport.text.slice(0, 200),
    );
    handoffSourceKey = readFileSync(path.join(groveHome, HANDOFF_SOURCE, "summary-signing-key"), "utf8").trim();
    eq("handoff key_id matches source signing key", handoffPackage && handoffPackage.key_id, summaryKeyId(handoffSourceKey));
    check(
      "handoff export exposes key_id but not signing key",
      handoffExport.text.includes(handoffPackage.key_id) &&
        !handoffExport.text.includes(handoffSourceKey) &&
        !handoffExport.text.includes("summary-signing-key"),
    );
  } finally {
    await stopHandoffServer();
  }

  const handoffTrustedKeysPath = path.join(tmp, "handoff-trusted-keys.json");
  writeFileSync(
    handoffTrustedKeysPath,
    JSON.stringify({ keys: { [summaryKeyId(handoffSourceKey)]: handoffSourceKey } }, null, 2),
  );
  chmodSync(handoffTrustedKeysPath, 0o600);
  await startHandoffServer({ session: HANDOFF_RECEIVER, ttlSeconds: 60, trustedKeysPath: handoffTrustedKeysPath });
  try {
    const handoffReceiverIndex = await reqAt(handoffBaseUrl, "GET", "/");
    eq("handoff receiver index served (200)", handoffReceiverIndex.status, 200);
    const handoffReceiverMatch = handoffReceiverIndex.text.match(/window\.__GROVE_SESSION_TOKEN__ = "([^"]+)"/);
    check("handoff receiver injects session token", Boolean(handoffReceiverMatch));
    const handoffReceiverToken = handoffReceiverMatch ? handoffReceiverMatch[1] : "";
    const receiverTasksBefore = await reqAt(handoffBaseUrl, "GET", `/api/boards/${HANDOFF_RECEIVER}/tasks`, {
      token: handoffReceiverToken,
      project: HANDOFF_RECEIVER,
    });
    eq("handoff receiver tasks before accept 200", receiverTasksBefore.status, 200);
    eq("handoff export alone creates zero receiver tasks", (receiverTasksBefore.json || []).length, 0);

    eq(
      "handoff accept 401 without token",
      (await reqAt(handoffBaseUrl, "POST", "/api/handoff/accept", { body: { package: handoffPackage } })).status,
      401,
    );
    eq(
      "handoff accept 401 with wrong token",
      (await reqAt(handoffBaseUrl, "POST", "/api/handoff/accept", {
        token: "wrong-token",
        body: { package: handoffPackage },
      })).status,
      401,
    );

    const tamperedHandoff = cloneJson(handoffPackage);
    tamperedHandoff.payload.task.title = "tampered title";
    const tamperedAccept = await reqAt(handoffBaseUrl, "POST", "/api/handoff/accept", {
      token: handoffReceiverToken,
      body: { package: tamperedHandoff },
    });
    eq("handoff accept rejects tampered signature", tamperedAccept.status, 403);
    check("handoff tampered rejection mentions signature", /signature/i.test(tamperedAccept.text), tamperedAccept.text);
    const unknownHandoff = cloneJson(handoffPackage);
    unknownHandoff.key_id = "unknown-key-id";
    const unknownAccept = await reqAt(handoffBaseUrl, "POST", "/api/handoff/accept", {
      token: handoffReceiverToken,
      body: { package: unknownHandoff },
    });
    eq("handoff accept rejects unknown key_id", unknownAccept.status, 403);
    check("handoff unknown-key rejection mentions unknown", /unknown/i.test(unknownAccept.text), unknownAccept.text);
    const receiverTasksAfterRejected = await reqAt(handoffBaseUrl, "GET", `/api/boards/${HANDOFF_RECEIVER}/tasks`, {
      token: handoffReceiverToken,
      project: HANDOFF_RECEIVER,
    });
    eq("handoff rejected packages create zero receiver tasks", (receiverTasksAfterRejected.json || []).length, 0);

    const acceptedHandoff = await reqAt(handoffBaseUrl, "POST", "/api/handoff/accept", {
      token: handoffReceiverToken,
      body: { package: handoffPackage },
    });
    eq("handoff accept trusted package 200", acceptedHandoff.status, 200);
    eq("handoff accept returns status created", acceptedHandoff.json && acceptedHandoff.json.status, "created");
    eq("handoff accept created true", acceptedHandoff.json && acceptedHandoff.json.created, true);
    eq("handoff accept handoff_id echoed", acceptedHandoff.json && acceptedHandoff.json.handoff_id, handoffPackage.payload.handoff_id);
    eq("handoff accept creates ready task", acceptedHandoff.json && acceptedHandoff.json.task && acceptedHandoff.json.task.status, "ready");
    check(
      "handoff accept creates unassigned local task",
      Boolean(acceptedHandoff.json && acceptedHandoff.json.task) && !("assignee" in acceptedHandoff.json.task),
      JSON.stringify(acceptedHandoff.json && acceptedHandoff.json.task),
    );
    check(
      "handoff accept limitations forbid remote execution",
      Boolean(acceptedHandoff.json) &&
        Array.isArray(acceptedHandoff.json.limitations) &&
        acceptedHandoff.json.limitations.some((item) => /never dispatches or executes/i.test(item)),
    );
    check(
      "handoff accept response redacts key/secret/pii/path",
      !hasSecret(acceptedHandoff.json) &&
        !acceptedHandoff.text.includes(handoffSourceKey) &&
        !acceptedHandoff.text.includes(handoffSecret) &&
        !acceptedHandoff.text.includes(handoffEmail) &&
        !acceptedHandoff.text.includes(handoffPrivatePath) &&
        !acceptedHandoff.text.includes("summary-signing-key"),
    );
    const receiverTasksAfterAccept = await reqAt(handoffBaseUrl, "GET", `/api/boards/${HANDOFF_RECEIVER}/tasks`, {
      token: handoffReceiverToken,
      project: HANDOFF_RECEIVER,
    });
    eq("handoff accept creates exactly one receiver task", (receiverTasksAfterAccept.json || []).length, 1);

    const duplicateAccept = await reqAt(handoffBaseUrl, "POST", "/api/handoff/accept", {
      token: handoffReceiverToken,
      body: { package: handoffPackage },
    });
    eq("handoff reaccept same id 200", duplicateAccept.status, 200);
    eq("handoff reaccept returns existing", duplicateAccept.json && duplicateAccept.json.status, "existing");
    eq("handoff reaccept created false", duplicateAccept.json && duplicateAccept.json.created, false);
    eq("handoff reaccept returns same local task id", duplicateAccept.json && duplicateAccept.json.task && duplicateAccept.json.task.id, acceptedHandoff.json && acceptedHandoff.json.task && acceptedHandoff.json.task.id);
    const receiverTasksAfterDuplicate = await reqAt(handoffBaseUrl, "GET", `/api/boards/${HANDOFF_RECEIVER}/tasks`, {
      token: handoffReceiverToken,
      project: HANDOFF_RECEIVER,
    });
    eq("handoff reaccept creates zero duplicate tasks", (receiverTasksAfterDuplicate.json || []).length, 1);

    const now = Math.floor(Date.now() / 1000);
    const staleHandoff = cloneJson(handoffPackage);
    staleHandoff.payload.handoff_id = "handoff_staleReceiverTtl0001";
    staleHandoff.payload.generated_at = now - 120;
    staleHandoff.payload.expires_at = now + 120;
    staleHandoff.signature = summarySignature(handoffSourceKey, staleHandoff.payload);
    const staleAccept = await reqAt(handoffBaseUrl, "POST", "/api/handoff/accept", {
      token: handoffReceiverToken,
      body: { package: staleHandoff },
    });
    eq("handoff accept rejects receiver-ttl expired package", staleAccept.status, 410);
    check("handoff stale rejection mentions expired", /expired/i.test(staleAccept.text), staleAccept.text);
    const futureHandoff = cloneJson(handoffPackage);
    futureHandoff.payload.handoff_id = "handoff_futureTimestamp0001";
    futureHandoff.payload.generated_at = now + 120;
    futureHandoff.payload.expires_at = now + 240;
    futureHandoff.signature = summarySignature(handoffSourceKey, futureHandoff.payload);
    const futureAccept = await reqAt(handoffBaseUrl, "POST", "/api/handoff/accept", {
      token: handoffReceiverToken,
      body: { package: futureHandoff },
    });
    eq("handoff accept rejects future timestamp", futureAccept.status, 403);
    check("handoff future rejection mentions timestamp", /timestamp/i.test(futureAccept.text), futureAccept.text);
    eq(
      "handoff accept path traversal project -> 400",
      (await reqAt(handoffBaseUrl, "POST", `/api/handoff/accept?project=${encodeURIComponent(`../${HANDOFF_RECEIVER}`)}`, {
        token: handoffReceiverToken,
        body: { package: handoffPackage },
      })).status,
      400,
    );
    eq(
      "handoff accept missing project -> 404",
      (await reqAt(handoffBaseUrl, "POST", "/api/handoff/accept?project=qae2e_missing_handoff", {
        token: handoffReceiverToken,
        body: { package: handoffPackage },
      })).status,
      404,
    );
    check(
      "handoff rejection responses leak no key/secret/path",
      !hasSecret([tamperedAccept.json, unknownAccept.json, staleAccept.json, futureAccept.json]) &&
        ![tamperedAccept.text, unknownAccept.text, staleAccept.text, futureAccept.text].some(
          (text) =>
            text.includes(handoffSourceKey) ||
            text.includes(handoffSecret) ||
            text.includes(handoffPrivatePath) ||
            text.includes(handoffEmail) ||
            text.includes("summary-signing-key"),
        ),
    );
  } finally {
    await stopHandoffServer();
  }

  // --- /api/share + /api/join: shared-access gate, one-time join, viewer read-only ---
  const shareOperatorSecret = "operator-secret";
  writeRegistry(SHARE, {
    owner: { name: "owner", agent: "codex", tmux_pane: `${SHARE}:1.0`, status: "idle" },
    receiver: { name: "receiver", agent: "claude", tmux_pane: `${SHARE}:1.1`, status: "idle" },
  });
  writeTeamMember(SHARE, { name: "owner", secret: shareOperatorSecret, role: "operator", id: "operator-1" });

  const meSingleOperator = await req("GET", "/api/me");
  eq("shared-access off keeps single-operator local-token auth mode", meSingleOperator.json && meSingleOperator.json.auth_mode, "local-token");
  eq(
    "shared-access off makes join unavailable",
    (await req("POST", "/api/join", { body: { code: "join-disabled", name: "nobody" } })).status,
    404,
  );

  const guardPort = await freePort();
  const sharedGuard = spawnSync(
    python,
    [
      "-m",
      "grove_bridge.web_app",
      "--host",
      "0.0.0.0",
      "--port",
      String(guardPort),
      "--dist-dir",
      distDir,
      "--board-db-path",
      path.join(tmp, "shared-guard.db"),
      "--session",
      SHARE,
      "--shared-access",
    ],
    {
      cwd: repoRoot,
      env: { ...process.env, GROVE_HOME: groveHome, HOME: homeDir, GROVE_VIEWER_SESSION: SHARE },
      encoding: "utf8",
      timeout: 5000,
    },
  );
  check(
    "shared-access non-loopback bind requires --allow-host",
    sharedGuard.status !== 0 && /allow-host/i.test(`${sharedGuard.stderr}\n${sharedGuard.stdout}`),
    `${sharedGuard.status} ${sharedGuard.stderr || sharedGuard.stdout}`,
  );

  await startSharedServer({ session: SHARE, joinRole: "viewer" });
  try {
    const sharedIndex = await reqAt(sharedBaseUrl, "GET", "/");
    eq("shared server index served (200)", sharedIndex.status, 200);
    check("shared server does not inject local session token", !/window\.__GROVE_SESSION_TOKEN__/.test(sharedIndex.text));
    eq("shared /api/me 401 without session", (await reqAt(sharedBaseUrl, "GET", "/api/me")).status, 401);
    const ownerLogin = await reqAt(sharedBaseUrl, "POST", "/api/login", {
      body: { name: "owner", secret: shareOperatorSecret },
    });
    eq("shared operator login 200", ownerLogin.status, 200);
    eq("shared operator role == operator", ownerLogin.json && ownerLogin.json.member && ownerLogin.json.member.role, "operator");
    const ownerCookie = String(ownerLogin.headers.get("set-cookie") || "").split(";")[0];
    const ownerCsrf = ownerLogin.json && ownerLogin.json.csrf;
    check(
      "shared operator login returns cookie+csrf",
      ownerCookie.startsWith("grove_team_session=") && typeof ownerCsrf === "string" && ownerCsrf.length > 0,
    );

    eq("share GET -> 405", (await reqAt(sharedBaseUrl, "GET", "/api/share", { cookie: ownerCookie })).status, 405);
    eq("share POST 401 unauthenticated", (await reqAt(sharedBaseUrl, "POST", "/api/share")).status, 401);
    eq(
      "share POST requires CSRF for operator",
      (await reqAt(sharedBaseUrl, "POST", "/api/share", { cookie: ownerCookie })).status,
      403,
    );
    eq(
      "share POST rejects foreign Origin",
      (await reqAt(sharedBaseUrl, "POST", "/api/share", {
        cookie: ownerCookie,
        csrf: ownerCsrf,
        origin: "http://evil.example",
      })).status,
      403,
    );
    const hostSpoof = await rawHttpAt(sharedBaseUrl, "POST", "/api/share", {
      host: "evil.example",
      origin: sharedBaseUrl,
      cookie: ownerCookie,
      csrf: ownerCsrf,
    });
    eq("share POST rejects spoofed Host", hostSpoof.status, 403);

    const share = await reqAt(sharedBaseUrl, "POST", "/api/share", {
      cookie: ownerCookie,
      csrf: ownerCsrf,
    });
    eq("share POST operator 200", share.status, 200);
    const joinCode = share.json && share.json.code;
    const joinCodeText = typeof joinCode === "string" ? joinCode : "__missing_join_code__";
    check("share returns one-time join code", typeof joinCode === "string" && joinCode.length >= 16);
    eq("share grants configured viewer role", share.json && share.json.role, "viewer");
    check("share returns URL containing join code", typeof (share.json && share.json.url) === "string" && share.json.url.includes(`join=${joinCodeText}`));
    check("share expires_at is epoch int", Number.isInteger(share.json && share.json.expires_at));
    eq("share exposes code only in code field and URL", share.text.split(joinCodeText).length - 1, 2);
    check(
      "share response leaks no member/session secrets",
      !share.text.includes(shareOperatorSecret) &&
        !share.text.includes(ownerCookie.split("=")[1]) &&
        !share.text.includes(ownerCsrf) &&
        !share.text.includes("secret_hash"),
    );

    eq(
      "join rejects foreign Origin before consuming code",
      (await reqAt(sharedBaseUrl, "POST", "/api/join", {
        origin: "http://evil.example",
        body: { code: joinCodeText, name: "viewer-bad-origin" },
      })).status,
      403,
    );
    const joined = await reqAt(sharedBaseUrl, "POST", "/api/join", {
      body: { code: joinCodeText, name: "viewer-e2e" },
    });
    eq("join valid code 200", joined.status, 200);
    eq("join returns team-cookie auth mode", joined.json && joined.json.auth_mode, "team-cookie");
    eq("join creates viewer member", joined.json && joined.json.member && joined.json.member.role, "viewer");
    eq("join member name echoed", joined.json && joined.json.member && joined.json.member.name, "viewer-e2e");
    const viewerCookie = String(joined.headers.get("set-cookie") || "").split(";")[0];
    const viewerCsrf = joined.json && joined.json.csrf;
    check(
      "join returns viewer cookie+csrf",
      viewerCookie.startsWith("grove_team_session=") && typeof viewerCsrf === "string" && viewerCsrf.length > 0,
    );
    check(
      "join response does not echo join code or secrets",
      !joined.text.includes(joinCodeText) &&
        !joined.text.includes(shareOperatorSecret) &&
        !joined.text.includes("secret_hash") &&
        !joined.text.includes(viewerCookie.split("=")[1]),
    );
    const reusedJoin = await reqAt(sharedBaseUrl, "POST", "/api/join", {
      body: { code: joinCodeText, name: "viewer-reuse" },
    });
    eq("join code is one-time; reuse rejected", reusedJoin.status, 403);
    const invalidJoin = await reqAt(sharedBaseUrl, "POST", "/api/join", {
      body: { code: "not-a-real-join-code", name: "viewer-invalid" },
    });
    eq("join rejects invalid code", invalidJoin.status, 403);
    const rateStatuses = [];
    for (let i = 0; i < 6; i += 1) {
      const r = await reqAt(sharedBaseUrl, "POST", "/api/join", {
        body: { code: `bad-code-${i}`, name: `viewer-rate-${i}` },
      });
      rateStatuses.push(r.status);
      if (r.status === 429) break;
    }
    check("join repeated invalid attempts trigger 429", rateStatuses.includes(429), rateStatuses.join(","));
    check(
      "join failure responses do not echo code secrets",
      ![reusedJoin.text, invalidJoin.text].some((text) => text.includes(joinCodeText) || text.includes(shareOperatorSecret)),
    );

    const viewerBoards = await reqAt(sharedBaseUrl, "GET", "/api/boards", {
      cookie: viewerCookie,
      project: SHARE,
    });
    eq("joined viewer can read boards", viewerBoards.status, 200);
    const viewerShare = await reqAt(sharedBaseUrl, "POST", "/api/share", {
      cookie: viewerCookie,
      csrf: viewerCsrf,
    });
    eq("joined viewer cannot share", viewerShare.status, 403);
    eq(
      "joined viewer cannot create project",
      (await reqAt(sharedBaseUrl, "POST", "/api/projects", {
        cookie: viewerCookie,
        csrf: viewerCsrf,
        body: { name: "viewer-created-project" },
      })).status,
      403,
    );
    eq(
      "joined viewer cannot create task",
      (await reqAt(sharedBaseUrl, "POST", `/api/boards/${SHARE}/tasks`, {
        cookie: viewerCookie,
        csrf: viewerCsrf,
        project: SHARE,
        body: { title: "viewer task denied" },
      })).status,
      403,
    );
    eq(
      "joined viewer cannot approve execution",
      (await reqAt(sharedBaseUrl, "POST", "/api/tasks/task_missing_share/approve", {
        cookie: viewerCookie,
        csrf: viewerCsrf,
        project: SHARE,
      })).status,
      403,
    );
    eq(
      "joined viewer cannot mutate execution gate",
      (await reqAt(sharedBaseUrl, "POST", "/api/execution", {
        cookie: viewerCookie,
        csrf: viewerCsrf,
        project: SHARE,
        body: { enabled: true },
      })).status,
      403,
    );

    const ownerTask = await reqAt(sharedBaseUrl, "POST", `/api/boards/${SHARE}/tasks`, {
      cookie: ownerCookie,
      csrf: ownerCsrf,
      project: SHARE,
      body: { title: "shared operator assign", assignee: "receiver" },
    });
    eq("shared operator can create task", ownerTask.status, 200);
    const sharedAudit = await reqAt(sharedBaseUrl, "GET", "/api/audit?action=assign", {
      cookie: ownerCookie,
      project: SHARE,
    });
    eq("shared operator can read audit", sharedAudit.status, 200);
    const sharedAuditItems = (sharedAudit.json && sharedAudit.json.items) || [];
    const ownerAudit = sharedAuditItems.find((item) => item.summary === "shared operator assign");
    check(
      "shared audit actor is per-member operator",
      Boolean(ownerAudit) &&
        ownerAudit.actor &&
        ownerAudit.actor.kind === "member" &&
        ownerAudit.actor.login === "owner" &&
        ownerAudit.actor.role === "operator",
      ownerAudit && JSON.stringify(ownerAudit.actor),
    );
    check(
      "shared access denial/audit responses leak no secrets",
      !hasSecret([viewerShare.json, sharedAudit.json]) &&
        ![viewerShare.text, sharedAudit.text].some(
          (text) =>
            text.includes(shareOperatorSecret) ||
            text.includes(joinCodeText) ||
            text.includes(ownerCookie.split("=")[1]) ||
            text.includes(viewerCookie.split("=")[1]) ||
            text.includes("secret_hash"),
        ),
    );
  } finally {
    await stopSharedServer();
  }

  await startSharedServer({ session: SHARE, joinRole: "viewer", joinTtlSeconds: 1 });
  try {
    const ownerLogin = await reqAt(sharedBaseUrl, "POST", "/api/login", {
      body: { name: "owner", secret: shareOperatorSecret },
    });
    eq("shared short-ttl operator login 200", ownerLogin.status, 200);
    const ownerCookie = String(ownerLogin.headers.get("set-cookie") || "").split(";")[0];
    const ownerCsrf = ownerLogin.json && ownerLogin.json.csrf;
    const shortShare = await reqAt(sharedBaseUrl, "POST", "/api/share", {
      cookie: ownerCookie,
      csrf: ownerCsrf,
    });
    eq("shared short-ttl share 200", shortShare.status, 200);
    await sleep(1500);
    const expiredJoin = await reqAt(sharedBaseUrl, "POST", "/api/join", {
      body: { code: shortShare.json && shortShare.json.code, name: "viewer-expired" },
    });
    eq("join expired code -> 410", expiredJoin.status, 410);
    check("expired join response does not echo code", !expiredJoin.text.includes(shortShare.json && shortShare.json.code));
  } finally {
    await stopSharedServer();
  }

  // --- /api/notifications/routing: config persistence, dry-run default, bounded escalation ---
  const routingOperatorSecret = "routing-operator-secret";
  const routingViewerSecret = "routing-viewer-secret";
  const routingSecret = "xoxb-" + "7".repeat(44);
  const routingEmail = "routing.owner@example.test";
  const routingPrivatePath = `/Users/chopin/private/${routingSecret}`;
  writeRegistry(ROUTING, {
    maker: { name: "maker", agent: "codex", tmux_pane: `${ROUTING}:1.0`, status: "idle", role: "maker" },
    reviewer: { name: "reviewer", agent: "claude", tmux_pane: `${ROUTING}:1.1`, status: "idle", role: "reviewer" },
  });
  writeRegistry(ROUTING_OTHER, {
    "routing-other": { name: "routing-other", agent: "codex", tmux_pane: `${ROUTING_OTHER}:1.0`, status: "idle", role: "maker" },
  });
  writeTeamMembers(ROUTING, [
    { id: "routing-operator-1", name: "routing-operator", role: "operator", secret: routingOperatorSecret },
    { id: "routing-viewer-1", name: "routing-viewer", role: "viewer", secret: routingViewerSecret },
  ]);
  const routingTask = seedRoutingBlockedTask({
    board: ROUTING,
    secret: routingSecret,
    email: routingEmail,
    privatePath: routingPrivatePath,
  });
  eq("seed: routing blocked task status", routingTask.status, "blocked");

  await startSharedServer({ session: ROUTING, joinRole: "viewer" });
  try {
    eq("routing GET 401 without session", (await reqAt(sharedBaseUrl, "GET", "/api/notifications/routing")).status, 401);
    eq(
      "routing POST 401 without session",
      (await reqAt(sharedBaseUrl, "POST", "/api/notifications/routing", {
        body: { enabled: true, rules: [] },
      })).status,
      401,
    );
    const routingOperatorLogin = await reqAt(sharedBaseUrl, "POST", "/api/login", {
      body: { name: "routing-operator", secret: routingOperatorSecret },
    });
    eq("routing operator login 200", routingOperatorLogin.status, 200);
    const routingOperatorCookie = String(routingOperatorLogin.headers.get("set-cookie") || "").split(";")[0];
    const routingOperatorCsrf = routingOperatorLogin.json && routingOperatorLogin.json.csrf;
    const routingViewerLogin = await reqAt(sharedBaseUrl, "POST", "/api/login", {
      body: { name: "routing-viewer", secret: routingViewerSecret },
    });
    eq("routing viewer login 200", routingViewerLogin.status, 200);
    const routingViewerCookie = String(routingViewerLogin.headers.get("set-cookie") || "").split(";")[0];
    const routingViewerCsrf = routingViewerLogin.json && routingViewerLogin.json.csrf;

    const routingInitial = await reqAt(sharedBaseUrl, "GET", "/api/notifications/routing", {
      cookie: routingOperatorCookie,
      project: ROUTING,
    });
    eq("routing GET operator 200", routingInitial.status, 200);
    eq("routing initial project", routingInitial.json && routingInitial.json.project, ROUTING);
    eq("routing initial configured false", routingInitial.json && routingInitial.json.routing && routingInitial.json.routing.configured, false);
    eq("routing initial enabled false", routingInitial.json && routingInitial.json.routing && routingInitial.json.routing.enabled, false);
    eq("routing initial dry_run true", routingInitial.json && routingInitial.json.routing && routingInitial.json.routing.dry_run, true);
    check(
      "routing initial rules empty",
      Boolean(routingInitial.json) &&
        routingInitial.json.routing &&
        Array.isArray(routingInitial.json.routing.rules) &&
        routingInitial.json.routing.rules.length === 0,
    );
    const dryRunPayload = {
      enabled: true,
      rules: [
        {
          name: "anomaly-high",
          event_type: "anomaly",
          node: "maker",
          severity: "high",
          target: { channel_kind: "inbox", room_id: "ops-route" },
          escalate_after_seconds: 0,
          escalation_targets: [
            { channel_kind: "inbox", room_id: "lead-route" },
            { channel_kind: "inbox", room_id: "director-route" },
          ],
          max_escalations: 5,
        },
      ],
    };
    eq(
      "routing POST operator requires CSRF",
      (await reqAt(sharedBaseUrl, "POST", "/api/notifications/routing", {
        cookie: routingOperatorCookie,
        project: ROUTING,
        body: dryRunPayload,
      })).status,
      403,
    );
    eq(
      "routing POST rejects foreign Origin",
      (await reqAt(sharedBaseUrl, "POST", "/api/notifications/routing", {
        cookie: routingOperatorCookie,
        csrf: routingOperatorCsrf,
        origin: "http://evil.example",
        project: ROUTING,
        body: dryRunPayload,
      })).status,
      403,
    );
    eq(
      "routing POST viewer denied",
      (await reqAt(sharedBaseUrl, "POST", "/api/notifications/routing", {
        cookie: routingViewerCookie,
        csrf: routingViewerCsrf,
        project: ROUTING,
        body: dryRunPayload,
      })).status,
      403,
    );
    const routingDryRunSave = await reqAt(sharedBaseUrl, "POST", "/api/notifications/routing", {
      cookie: routingOperatorCookie,
      csrf: routingOperatorCsrf,
      project: ROUTING,
      body: dryRunPayload,
    });
    eq("routing POST dry-run config 200", routingDryRunSave.status, 200);
    eq("routing saved project", routingDryRunSave.json && routingDryRunSave.json.project, ROUTING);
    eq("routing saved configured true", routingDryRunSave.json && routingDryRunSave.json.routing && routingDryRunSave.json.routing.configured, true);
    eq("routing saved enabled true", routingDryRunSave.json && routingDryRunSave.json.routing && routingDryRunSave.json.routing.enabled, true);
    eq("routing saved dry_run defaults true", routingDryRunSave.json && routingDryRunSave.json.routing && routingDryRunSave.json.routing.dry_run, true);
    const dryRunRule = routingDryRunSave.json && routingDryRunSave.json.routing && routingDryRunSave.json.routing.rules[0];
    eq("routing saved event_type anomaly", dryRunRule && dryRunRule.event_type, "anomaly");
    eq("routing saved node condition maker", dryRunRule && dryRunRule.node, "maker");
    eq("routing saved severity lowercase", dryRunRule && dryRunRule.severity, "high");
    eq("routing max_escalations bounded to target count", dryRunRule && dryRunRule.max_escalations, 2);
    check(
      "routing saved escalation target order",
      Boolean(dryRunRule) &&
        Array.isArray(dryRunRule.escalation_targets) &&
        dryRunRule.escalation_targets.map((target) => target.room_id).join(",") === "lead-route,director-route",
      dryRunRule && JSON.stringify(dryRunRule.escalation_targets),
    );
    const routingDryPoll = pollNotificationRouting({ board: ROUTING, now: Math.floor(Date.now() / 1000) + 60 });
    eq("routing dry-run sends zero notifications", routingDryPoll.sent, 0);
    check("routing dry-run creates zero notify_subs", Array.isArray(routingDryPoll.subs) && routingDryPoll.subs.length === 0, JSON.stringify(routingDryPoll.subs));

    const routingLivePayload = {
      enabled: true,
      dry_run: false,
      rules: [
        {
          name: "wrong-event",
          event_type: "blocked",
          node: "maker",
          severity: "low",
          target: { channel_kind: "inbox", room_id: "wrong-route" },
        },
        dryRunPayload.rules[0],
      ],
    };
    const routingLiveSave = await reqAt(sharedBaseUrl, "POST", "/api/notifications/routing", {
      cookie: routingOperatorCookie,
      csrf: routingOperatorCsrf,
      project: ROUTING,
      body: routingLivePayload,
    });
    eq("routing POST live config 200", routingLiveSave.status, 200);
    eq("routing live dry_run false", routingLiveSave.json && routingLiveSave.json.routing && routingLiveSave.json.routing.dry_run, false);
    check(
      "routing live saves conditional rule set",
      Boolean(routingLiveSave.json) &&
        routingLiveSave.json.routing &&
        routingLiveSave.json.routing.rules.length === 2 &&
        routingLiveSave.json.routing.rules[0].target.room_id === "wrong-route" &&
        routingLiveSave.json.routing.rules[1].target.room_id === "ops-route",
      routingLiveSave.text,
    );
    const routingAfterSave = await reqAt(sharedBaseUrl, "GET", "/api/notifications/routing", {
      cookie: routingOperatorCookie,
      project: ROUTING,
    });
    eq("routing GET after save 200", routingAfterSave.status, 200);
    check(
      "routing GET returns saved live config",
      Boolean(routingAfterSave.json) &&
        routingAfterSave.json.routing &&
        routingAfterSave.json.routing.dry_run === false &&
        routingAfterSave.json.routing.rules.map((rule) => rule.name).join(",") === "wrong-event,anomaly-high",
      routingAfterSave.text,
    );
    const routingNow = Math.floor(Date.now() / 1000) + 60;
    const routingPoll1 = pollNotificationRouting({ board: ROUTING, now: routingNow });
    const routingPoll2 = pollNotificationRouting({ board: ROUTING, now: routingNow + 60 });
    const routingPoll3 = pollNotificationRouting({ board: ROUTING, now: routingNow + 120 });
    const routingRooms = [...routingPoll1.calls, ...routingPoll2.calls, ...routingPoll3.calls].map((call) => call.room_id);
    check("routing condition skips nonmatching rule", !routingRooms.includes("wrong-route"), routingRooms.join(","));
    check(
      "routing sends primary plus bounded escalations",
      routingRooms.join(",") === "ops-route,lead-route,director-route",
      routingRooms.join(","),
    );
    eq("routing bounded poll3 sends zero", routingPoll3.sent, 0);
    check(
      "routing notify_subs do not exceed primary+max_escalations",
      routingPoll3.subs.length === 3 &&
        routingPoll3.subs.every((sub) => ["ops-route", "lead-route", "director-route"].includes(sub.room_id)),
      JSON.stringify(routingPoll3.subs),
    );
    check(
      "routing notifier redacts task secret/pii/path",
      !JSON.stringify([routingPoll1.calls, routingPoll2.calls]).includes(routingSecret) &&
        !JSON.stringify([routingPoll1.calls, routingPoll2.calls]).includes(routingEmail) &&
        !JSON.stringify([routingPoll1.calls, routingPoll2.calls]).includes(routingPrivatePath),
      JSON.stringify([routingPoll1.calls, routingPoll2.calls]),
    );
    const routingAudit = await reqAt(sharedBaseUrl, "GET", "/api/audit?action=notification-routing-config", {
      cookie: routingOperatorCookie,
      project: ROUTING,
    });
    eq("routing audit read 200", routingAudit.status, 200);
    const routingAuditItems = (routingAudit.json && routingAudit.json.items) || [];
    const routingAuditEvent = routingAuditItems.find((item) => item.target && item.target.id === ROUTING);
    check(
      "routing audit records operator actor and target",
      Boolean(routingAuditEvent) &&
        routingAuditEvent.actor &&
        routingAuditEvent.actor.kind === "member" &&
        routingAuditEvent.actor.login === "routing-operator" &&
        routingAuditEvent.target &&
        routingAuditEvent.target.type === "notification_routing",
      routingAuditEvent && JSON.stringify(routingAuditEvent),
    );

    const routingOtherBefore = await reqAt(sharedBaseUrl, "GET", "/api/notifications/routing", {
      cookie: routingOperatorCookie,
      project: ROUTING_OTHER,
    });
    eq("routing other project GET 200", routingOtherBefore.status, 200);
    eq("routing other project name", routingOtherBefore.json && routingOtherBefore.json.project, ROUTING_OTHER);
    eq("routing other project initially unconfigured", routingOtherBefore.json && routingOtherBefore.json.routing && routingOtherBefore.json.routing.configured, false);
    check("routing other project does not leak primary config", !routingOtherBefore.text.includes("ops-route") && !routingOtherBefore.text.includes("anomaly-high"), routingOtherBefore.text);
    const routingOtherSave = await reqAt(sharedBaseUrl, "POST", "/api/notifications/routing", {
      cookie: routingOperatorCookie,
      csrf: routingOperatorCsrf,
      project: ROUTING_OTHER,
      body: {
        enabled: true,
        dry_run: true,
        rules: [
          {
            name: "other-route",
            event_type: "blocked",
            target: { channel_kind: "inbox", room_id: "other-room" },
          },
        ],
      },
    });
    eq("routing other project POST 200", routingOtherSave.status, 200);
    eq("routing other project POST scoped name", routingOtherSave.json && routingOtherSave.json.project, ROUTING_OTHER);
    const routingPrimaryAfterOther = await reqAt(sharedBaseUrl, "GET", "/api/notifications/routing", {
      cookie: routingOperatorCookie,
      project: ROUTING,
    });
    check(
      "routing primary project unchanged after other POST",
      Boolean(routingPrimaryAfterOther.json) &&
        routingPrimaryAfterOther.json.routing &&
        routingPrimaryAfterOther.json.routing.rules.some((rule) => rule.name === "anomaly-high") &&
        !routingPrimaryAfterOther.text.includes("other-route"),
      routingPrimaryAfterOther.text,
    );
    eq(
      "routing path traversal project -> 400",
      (await reqAt(sharedBaseUrl, "GET", "/api/notifications/routing", {
        cookie: routingOperatorCookie,
        project: `../${ROUTING}`,
      })).status,
      400,
    );
    eq(
      "routing missing project -> 404",
      (await reqAt(sharedBaseUrl, "GET", "/api/notifications/routing", {
        cookie: routingOperatorCookie,
        project: "qae2e_missing_routing",
      })).status,
      404,
    );
    const routingInvalid = await reqAt(sharedBaseUrl, "POST", "/api/notifications/routing", {
      cookie: routingOperatorCookie,
      csrf: routingOperatorCsrf,
      project: ROUTING,
      body: {
        enabled: true,
        rules: [
          {
            name: "bad-route",
            event_type: "blocked",
            target: { channel_kind: "inbox", room_id: `${routingPrivatePath}/${routingSecret}` },
          },
        ],
      },
    });
    eq("routing invalid target rejected", routingInvalid.status, 400);
    check(
      "routing responses leak no secret/pii/path",
      !hasSecret([routingDryRunSave.json, routingLiveSave.json, routingAfterSave.json, routingAudit.json, routingInvalid.json]) &&
        ![routingDryRunSave.text, routingLiveSave.text, routingAfterSave.text, routingAudit.text, routingInvalid.text].some(
          (text) => text.includes(routingSecret) || text.includes(routingEmail) || text.includes(routingPrivatePath),
        ),
    );
  } finally {
    await stopSharedServer();
  }

  // --- /api/ledger + /api/quota: member rollups, soft quota, host pressure ---
  const ledgerOwnerId = "operator-ledger-1";
  const ledgerViewerId = "viewer-ledger-1";
  const ledgerOtherId = "other-ledger-1";
  const ledgerOwnerSecret = "ledger-owner-secret";
  const ledgerViewerSecret = "ledger-viewer-secret";
  const ledgerSecret = "xoxb-" + "e".repeat(44);
  const ledgerEmail = "ledger.owner@example.test";
  const ledgerPrivatePath = `/Users/chopin/private/${ledgerSecret}`;
  writeRegistry(LEDGER, {
    owner: { name: "owner", agent: "codex", tmux_pane: `${LEDGER}:1.0`, status: "idle" },
    "agy-node": { name: "agy-node", agent: "agy", tmux_pane: `${LEDGER}:1.1`, status: "idle" },
    other: { name: "other", agent: "claude", tmux_pane: `${LEDGER}:1.2`, status: "idle" },
  });
  writeTeamMembers(LEDGER, [
    { id: ledgerOwnerId, name: "owner-ledger", role: "operator", secret: ledgerOwnerSecret },
    { id: ledgerViewerId, name: "viewer-ledger", role: "viewer", secret: ledgerViewerSecret },
    { id: ledgerOtherId, name: "other-ledger", role: "operator", secret: "ledger-other-secret" },
  ]);
  completeUsageRun({
    board: LEDGER,
    node: "owner",
    metadata: {
      member_id: ledgerOwnerId,
      input_tokens: 10,
      output_tokens: 15,
      total_tokens: 25,
      cost_usd: 0.25,
      transcript_path: `${ledgerPrivatePath}/owner.jsonl`,
      owner_email: ledgerEmail,
    },
    startedAt: 1_704_240_000,
  });
  completeUsageRun({
    board: LEDGER,
    node: "agy-node",
    metadata: {
      member_id: ledgerViewerId,
      total_tokens: 20,
      transcript_path: `${ledgerPrivatePath}/viewer.jsonl`,
    },
    startedAt: 1_704_240_060,
  });
  completeUsageRun({
    board: LEDGER,
    node: "other",
    metadata: {
      member_id: ledgerOtherId,
      total_tokens: 40,
      cost_usd: 0.4,
      secret_note: ledgerSecret,
    },
    startedAt: 1_704_240_120,
  });
  const runningLedgerTask = seedRunningTask({
    board: LEDGER,
    title: "ledger running soft-throttle survivor",
    node: "agy-node",
    createdBy: ledgerViewerId,
  });
  eq("seed: ledger running task status running", runningLedgerTask.status, "running");
  eq(
    "quota disabled without --enable-quotas -> 404",
    (await req("POST", "/api/quota", {
      token,
      body: { member_id: ledgerOwnerId, enabled: true, soft_run_limit: 1 },
    })).status,
    404,
  );

  await startSharedServer({ session: LEDGER, joinRole: "viewer", enableQuotas: true });
  try {
    eq("ledger 401 without session", (await reqAt(sharedBaseUrl, "GET", "/api/ledger?window=all")).status, 401);
    const ledgerOwnerLogin = await reqAt(sharedBaseUrl, "POST", "/api/login", {
      body: { name: "owner-ledger", secret: ledgerOwnerSecret },
    });
    eq("ledger operator login 200", ledgerOwnerLogin.status, 200);
    const ledgerOwnerCookie = String(ledgerOwnerLogin.headers.get("set-cookie") || "").split(";")[0];
    const ledgerOwnerCsrf = ledgerOwnerLogin.json && ledgerOwnerLogin.json.csrf;
    const ledgerViewerLogin = await reqAt(sharedBaseUrl, "POST", "/api/login", {
      body: { name: "viewer-ledger", secret: ledgerViewerSecret },
    });
    eq("ledger viewer login 200", ledgerViewerLogin.status, 200);
    const ledgerViewerCookie = String(ledgerViewerLogin.headers.get("set-cookie") || "").split(";")[0];
    const ledgerViewerCsrf = ledgerViewerLogin.json && ledgerViewerLogin.json.csrf;

    const ledgerAll = await reqAt(sharedBaseUrl, "GET", "/api/ledger?window=all", {
      cookie: ledgerOwnerCookie,
      project: LEDGER,
    });
    eq("ledger operator GET 200", ledgerAll.status, 200);
    eq("ledger project == ledger", ledgerAll.json && ledgerAll.json.project, LEDGER);
    eq("ledger operator scope all", ledgerAll.json && ledgerAll.json.scope, "all");
    eq("ledger quota_enabled true", ledgerAll.json && ledgerAll.json.quota_enabled, true);
    const ledgerMembers = ledgerAll.json && Array.isArray(ledgerAll.json.members) ? ledgerAll.json.members : [];
    check("ledger operator sees all member rollups", ledgerMembers.length === 3, ledgerMembers.map((item) => item.member && item.member.id).join(","));
    const ledgerByMember = Object.fromEntries(ledgerMembers.map((item) => [item.member && item.member.id, item]));
    eq("ledger owner runs == 1", ledgerByMember[ledgerOwnerId] && ledgerByMember[ledgerOwnerId].totals.runs.value, 1);
    eq("ledger owner total_tokens == 25", ledgerByMember[ledgerOwnerId] && ledgerByMember[ledgerOwnerId].totals.total_tokens.value, 25);
    eq("ledger owner cost == 0.25", ledgerByMember[ledgerOwnerId] && ledgerByMember[ledgerOwnerId].totals.cost_usd_estimate.value, 0.25);
    eq("ledger viewer runs include running task", ledgerByMember[ledgerViewerId] && ledgerByMember[ledgerViewerId].totals.runs.value, 2);
    eq("ledger viewer total_tokens == 20", ledgerByMember[ledgerViewerId] && ledgerByMember[ledgerViewerId].totals.total_tokens.value, 20);
    eq("ledger viewer agy cost is unknown/null", ledgerByMember[ledgerViewerId] && ledgerByMember[ledgerViewerId].totals.cost_usd_estimate.value, null);
    eq("ledger viewer agy cost confidence unknown", ledgerByMember[ledgerViewerId] && ledgerByMember[ledgerViewerId].totals.cost_usd_estimate.confidence, "unknown");
    check(
      "ledger viewer agy warning avoids cost invention",
      Boolean(ledgerByMember[ledgerViewerId]) &&
        Array.isArray(ledgerByMember[ledgerViewerId].warnings) &&
        ledgerByMember[ledgerViewerId].warnings.some((warning) => /agy credit is unknown/i.test(warning)),
      ledgerByMember[ledgerViewerId] && JSON.stringify(ledgerByMember[ledgerViewerId].warnings),
    );
    eq("ledger other member total_tokens == 40", ledgerByMember[ledgerOtherId] && ledgerByMember[ledgerOtherId].totals.total_tokens.value, 40);
    const hostPressure = ledgerAll.json && ledgerAll.json.host_pressure;
    check(
      "ledger host_pressure exposes read-only bounded fields",
      Boolean(hostPressure) &&
        ["running", "capacity", "ratio"].every((key) => isTaggedMetric(hostPressure[key])) &&
        Object.keys(hostPressure).every((key) => ["status", "running", "capacity", "ratio", "load_1m", "blocked_tasks"].includes(key)),
      hostPressure && JSON.stringify(hostPressure),
    );
    eq("ledger host_pressure running == 1", hostPressure && hostPressure.running && hostPressure.running.value, 1);
    eq("ledger host_pressure capacity == node count", hostPressure && hostPressure.capacity && hostPressure.capacity.value, 3);
    check(
      "ledger host_pressure leaks no PID/process/path",
      !/pid|process|command|cwd|\/Users|transcript/i.test(JSON.stringify(hostPressure || {})),
      JSON.stringify(hostPressure || {}),
    );
    check(
      "ledger response leaks no secrets/pii/paths",
      !hasSecret(ledgerAll.json) &&
        !ledgerAll.text.includes(ledgerSecret) &&
        !ledgerAll.text.includes(ledgerEmail) &&
        !ledgerAll.text.includes(ledgerPrivatePath) &&
        !ledgerAll.text.includes("transcript_path") &&
        !ledgerAll.text.includes("owner_email"),
    );

    const viewerLedger = await reqAt(sharedBaseUrl, "GET", "/api/ledger?window=all", {
      cookie: ledgerViewerCookie,
      project: LEDGER,
    });
    eq("ledger viewer GET 200", viewerLedger.status, 200);
    eq("ledger viewer scope self", viewerLedger.json && viewerLedger.json.scope, "self");
    const viewerLedgerMembers = viewerLedger.json && Array.isArray(viewerLedger.json.members) ? viewerLedger.json.members : [];
    check(
      "ledger viewer sees only self member",
      viewerLedgerMembers.length === 1 && viewerLedgerMembers[0].member && viewerLedgerMembers[0].member.id === ledgerViewerId,
      viewerLedgerMembers.map((item) => item.member && item.member.id).join(","),
    );
    check(
      "ledger viewer self response hides other members",
      !viewerLedgerMembers.some((item) => [ledgerOwnerId, ledgerOtherId].includes(item.member && item.member.id)) &&
        !viewerLedger.text.includes("owner-ledger") &&
        !viewerLedger.text.includes("other-ledger"),
      viewerLedger.text,
    );
    eq(
      "ledger viewer cannot request other member",
      (await reqAt(sharedBaseUrl, "GET", `/api/ledger?window=all&member=${encodeURIComponent(ledgerOwnerId)}`, {
        cookie: ledgerViewerCookie,
        project: LEDGER,
      })).status,
      403,
    );
    const viewerSelfByName = await reqAt(sharedBaseUrl, "GET", "/api/ledger?window=all&member=viewer-ledger", {
      cookie: ledgerViewerCookie,
      project: LEDGER,
    });
    eq("ledger viewer can request self by name", viewerSelfByName.status, 200);
    eq("ledger viewer self-by-name still scope self", viewerSelfByName.json && viewerSelfByName.json.scope, "self");

    const ledgerBeta = await reqAt(sharedBaseUrl, "GET", `/api/ledger?window=all&project=${encodeURIComponent(BETA)}`, {
      cookie: ledgerOwnerCookie,
    });
    eq("ledger other project scope 200", ledgerBeta.status, 200);
    eq("ledger other project name", ledgerBeta.json && ledgerBeta.json.project, BETA);
    eq("ledger other project has no ledger members", (ledgerBeta.json && ledgerBeta.json.members && ledgerBeta.json.members.length) || 0, 0);
    check("ledger other project leaks no ledger member ids", !ledgerBeta.text.includes(ledgerViewerId) && !ledgerBeta.text.includes(ledgerOtherId), ledgerBeta.text);
    eq(
      "ledger path traversal project -> 400",
      (await reqAt(sharedBaseUrl, "GET", `/api/ledger?window=all&project=${encodeURIComponent(`../${LEDGER}`)}`, {
        cookie: ledgerOwnerCookie,
      })).status,
      400,
    );
    eq(
      "ledger missing project -> 404",
      (await reqAt(sharedBaseUrl, "GET", "/api/ledger?window=all&project=qae2e_missing_ledger", {
        cookie: ledgerOwnerCookie,
      })).status,
      404,
    );

    eq(
      "quota POST 401 without session",
      (await reqAt(sharedBaseUrl, "POST", "/api/quota", {
        body: { member_id: ledgerViewerId, enabled: true, soft_run_limit: 1 },
      })).status,
      401,
    );
    eq(
      "quota POST viewer denied",
      (await reqAt(sharedBaseUrl, "POST", "/api/quota", {
        cookie: ledgerViewerCookie,
        csrf: ledgerViewerCsrf,
        project: LEDGER,
        body: { member_id: ledgerViewerId, enabled: true, soft_run_limit: 1 },
      })).status,
      403,
    );
    eq(
      "quota POST operator requires CSRF",
      (await reqAt(sharedBaseUrl, "POST", "/api/quota", {
        cookie: ledgerOwnerCookie,
        project: LEDGER,
        body: { member_id: ledgerViewerId, enabled: true, soft_run_limit: 1 },
      })).status,
      403,
    );
    eq(
      "quota POST rejects foreign Origin",
      (await reqAt(sharedBaseUrl, "POST", "/api/quota", {
        cookie: ledgerOwnerCookie,
        csrf: ledgerOwnerCsrf,
        origin: "http://evil.example",
        project: LEDGER,
        body: { member_id: ledgerViewerId, enabled: true, soft_run_limit: 1 },
      })).status,
      403,
    );
    const quotaSet = await reqAt(sharedBaseUrl, "POST", "/api/quota", {
      cookie: ledgerOwnerCookie,
      csrf: ledgerOwnerCsrf,
      project: LEDGER,
      body: {
        member_id: "viewer-ledger",
        enabled: true,
        soft_run_limit: 0,
        soft_token_limit: 1,
        soft_cost_usd: 0.01,
      },
    });
    eq("quota POST operator 200", quotaSet.status, 200);
    eq("quota response project == ledger", quotaSet.json && quotaSet.json.project, LEDGER);
    eq("quota response member resolved by name", quotaSet.json && quotaSet.json.member && quotaSet.json.member.id, ledgerViewerId);
    eq("quota response mode soft", quotaSet.json && quotaSet.json.quota && quotaSet.json.quota.mode, "soft");
    eq("quota response hard_kill false", quotaSet.json && quotaSet.json.quota && quotaSet.json.quota.hard_kill, false);
    eq("quota response soft_run_limit set", quotaSet.json && quotaSet.json.quota && quotaSet.json.quota.soft_run_limit, 0);
    eq("quota response soft_token_limit set", quotaSet.json && quotaSet.json.quota && quotaSet.json.quota.soft_token_limit, 1);

    const throttledLedger = await reqAt(sharedBaseUrl, "GET", `/api/ledger?window=all&member=${encodeURIComponent(ledgerViewerId)}`, {
      cookie: ledgerOwnerCookie,
      project: LEDGER,
    });
    eq("ledger after quota 200", throttledLedger.status, 200);
    const throttledMember = throttledLedger.json && throttledLedger.json.members && throttledLedger.json.members[0];
    eq("ledger quota status exceeded", throttledMember && throttledMember.quota && throttledMember.quota.status, "exceeded");
    eq("ledger quota hard_kill false", throttledMember && throttledMember.quota && throttledMember.quota.hard_kill, false);
    eq("ledger quota soft_throttle active", throttledMember && throttledMember.quota && throttledMember.quota.soft_throttle && throttledMember.quota.soft_throttle.active, true);
    eq("ledger quota soft_throttle hard_kill false", throttledMember && throttledMember.quota && throttledMember.quota.soft_throttle && throttledMember.quota.soft_throttle.hard_kill, false);
    check(
      "ledger quota exceeded reports runs/tokens soft reasons",
      Boolean(throttledMember) &&
        throttledMember.quota &&
        throttledMember.quota.soft_throttle &&
        ["runs", "tokens"].every((reason) => throttledMember.quota.soft_throttle.reasons.includes(reason)),
      throttledMember && JSON.stringify(throttledMember.quota),
    );
    check(
      "ledger quota warning says running tasks are not killed",
      Boolean(throttledMember) &&
        Array.isArray(throttledMember.warnings) &&
        throttledMember.warnings.some((warning) => /running tasks are not killed/i.test(warning)),
      throttledMember && JSON.stringify(throttledMember.warnings),
    );
    const runningTaskAfterQuota = await reqAt(sharedBaseUrl, "GET", `/api/tasks/${runningLedgerTask.task_id}`, {
      cookie: ledgerOwnerCookie,
      project: LEDGER,
    });
    eq("soft quota does not kill running task", runningTaskAfterQuota.json && runningTaskAfterQuota.json.status, "running");
    const runningRunsAfterQuota = await reqAt(sharedBaseUrl, "GET", `/api/tasks/${runningLedgerTask.task_id}/runs`, {
      cookie: ledgerOwnerCookie,
      project: LEDGER,
    });
    check(
      "soft quota leaves running run active",
      Array.isArray(runningRunsAfterQuota.json) && runningRunsAfterQuota.json.some((run) => run.status === "running"),
      JSON.stringify(runningRunsAfterQuota.json),
    );

    const quotaAudit = await reqAt(sharedBaseUrl, "GET", "/api/audit?action=quota-update", {
      cookie: ledgerOwnerCookie,
      project: LEDGER,
    });
    eq("quota audit read 200", quotaAudit.status, 200);
    const quotaAuditItems = (quotaAudit.json && quotaAudit.json.items) || [];
    const quotaAuditEvent = quotaAuditItems.find((item) => item.target && item.target.id === ledgerViewerId);
    check(
      "quota audit actor is per-member operator",
      Boolean(quotaAuditEvent) &&
        quotaAuditEvent.actor &&
        quotaAuditEvent.actor.kind === "member" &&
        quotaAuditEvent.actor.login === "owner-ledger" &&
        quotaAuditEvent.actor.role === "operator",
      quotaAuditEvent && JSON.stringify(quotaAuditEvent.actor),
    );
    check(
      "quota/ledger responses leak no token/member secrets",
      !hasSecret([quotaSet.json, throttledLedger.json, quotaAudit.json]) &&
        ![quotaSet.text, throttledLedger.text, quotaAudit.text].some(
          (text) =>
            text.includes(ledgerOwnerSecret) ||
            text.includes(ledgerViewerSecret) ||
            text.includes(ledgerSecret) ||
            text.includes(ledgerPrivatePath) ||
            text.includes(ledgerEmail) ||
            text.includes("secret_hash"),
        ),
    );
  } finally {
    await stopSharedServer();
  }

  // --- /api/retro/analytics: operator-only advisory analytics, privacy, low-confidence honesty ---
  const retroOperatorSecret = "retro-operator-secret";
  const retroViewerSecret = "retro-viewer-secret";
  const retroSecret = "xoxb-" + "f".repeat(44);
  const retroEmail = "retro.owner@example.test";
  const retroPrivatePath = `/Users/chopin/private/${retroSecret}`;
  const retroRawPhrase = "retro raw sentence must not leak";
  writeRegistry(RETRO, {
    maker: { name: "maker", agent: "codex", tmux_pane: `${RETRO}:1.0`, status: "idle", role: "maker" },
    "agy-node": { name: "agy-node", agent: "agy", tmux_pane: `${RETRO}:1.1`, status: "idle", role: "maker" },
  });
  writeRegistry(RETRO_OTHER, {
    "other-worker": { name: "other-worker", agent: "claude", tmux_pane: `${RETRO_OTHER}:1.0`, status: "idle", role: "maker" },
  });
  writeTeamMembers(RETRO, [
    { id: "retro-operator-1", name: "retro-operator", role: "operator", secret: retroOperatorSecret },
    { id: "retro-viewer-1", name: "retro-viewer", role: "viewer", secret: retroViewerSecret },
  ]);
  const retroSeed = seedRetroAnalyticsData({
    board: RETRO,
    secret: retroSecret,
    email: retroEmail,
    privatePath: retroPrivatePath,
    rawPhrase: retroRawPhrase,
  });
  check(
    "seed: retro analytics fixture creates task ids",
    Boolean(retroSeed.retro_task_id) && Boolean(retroSeed.blocked_task_id) && Boolean(retroSeed.run_task_id),
    JSON.stringify(retroSeed),
  );
  eq(
    "retro analytics default-off -> 404",
    (await req("GET", `/api/retro/analytics?window=all&project=${encodeURIComponent(RETRO)}`, { token })).status,
    404,
  );

  await startSharedServer({ session: RETRO, joinRole: "viewer", enableRetroAnalytics: true });
  try {
    eq("retro analytics 401 without session", (await reqAt(sharedBaseUrl, "GET", "/api/retro/analytics?window=all")).status, 401);
    const retroOperatorLogin = await reqAt(sharedBaseUrl, "POST", "/api/login", {
      body: { name: "retro-operator", secret: retroOperatorSecret },
    });
    eq("retro analytics operator login 200", retroOperatorLogin.status, 200);
    const retroOperatorCookie = String(retroOperatorLogin.headers.get("set-cookie") || "").split(";")[0];
    const retroViewerLogin = await reqAt(sharedBaseUrl, "POST", "/api/login", {
      body: { name: "retro-viewer", secret: retroViewerSecret },
    });
    eq("retro analytics viewer login 200", retroViewerLogin.status, 200);
    const retroViewerCookie = String(retroViewerLogin.headers.get("set-cookie") || "").split(";")[0];
    eq(
      "retro analytics viewer denied",
      (await reqAt(sharedBaseUrl, "GET", `/api/retro/analytics?window=all&project=${encodeURIComponent(RETRO)}`, {
        cookie: retroViewerCookie,
      })).status,
      403,
    );

    const beforeRetroTasks = await reqAt(sharedBaseUrl, "GET", `/api/boards/${RETRO}/tasks`, {
      cookie: retroOperatorCookie,
      project: RETRO,
    });
    eq("retro analytics task snapshot before read 200", beforeRetroTasks.status, 200);
    const beforeRetroTaskItems = Array.isArray(beforeRetroTasks.json) ? beforeRetroTasks.json : [];
    const retro = await reqAt(sharedBaseUrl, "GET", `/api/retro/analytics?window=all&project=${encodeURIComponent(RETRO)}`, {
      cookie: retroOperatorCookie,
    });
    eq("retro analytics operator 200 when enabled", retro.status, 200);
    eq("retro analytics project == retro", retro.json && retro.json.project, RETRO);
    eq("retro analytics mode advisory", retro.json && retro.json.mode, "advisory");
    check("retro analytics actions empty", Boolean(retro.json) && Array.isArray(retro.json.actions) && retro.json.actions.length === 0);
    check("retro analytics generated_at metric", isTaggedMetric(retro.json && retro.json.generated_at));
    eq("retro analytics window all", retro.json && retro.json.window && retro.json.window.name, "all");
    eq("retro analytics confidence low", retro.json && retro.json.confidence, "low");
    eq("retro analytics sample completed_runs == 1", retro.json && retro.json.sample && retro.json.sample.completed_runs.value, 1);
    eq("retro analytics sample retro_comments == 1", retro.json && retro.json.sample && retro.json.sample.retro_comments.value, 1);
    eq("retro analytics sample blocked_tasks == 1", retro.json && retro.json.sample && retro.json.sample.blocked_tasks.value, 1);
    check(
      "retro analytics limitations mention small sample",
      Boolean(retro.json) &&
        Array.isArray(retro.json.limitations) &&
        retro.json.limitations.some((item) => /small sample size/i.test(item)),
      retro.json && JSON.stringify(retro.json.limitations),
    );
    const retroThroughput = retro.json && Array.isArray(retro.json.throughput) ? retro.json.throughput : [];
    check(
      "retro analytics throughput has bucket+completed metric",
      retroThroughput.length === 1 &&
        typeof retroThroughput[0].bucket === "string" &&
        isTaggedMetric(retroThroughput[0].completed) &&
        retroThroughput[0].completed.value === 1 &&
        retroThroughput[0].completed.confidence === "low",
      JSON.stringify(retroThroughput),
    );
    const retroThemeAllowlist = new Set(["testing", "blocked", "scope", "review", "tooling"]);
    const retroThemes = retro.json && Array.isArray(retro.json.themes) ? retro.json.themes : [];
    const retroThemeNames = retroThemes.map((item) => item.theme);
    check(
      "retro analytics themes are allowlist categories only",
      retroThemes.length >= 1 &&
        retroThemes.every(
          (item) =>
            retroThemeAllowlist.has(item.theme) &&
            isTaggedMetric(item.count) &&
            Array.isArray(item.keywords) &&
            Object.keys(item).every((key) => ["theme", "count", "keywords"].includes(key)),
        ),
      JSON.stringify(retroThemes),
    );
    check(
      "retro analytics themes include deterministic category hits",
      ["testing", "blocked", "scope", "tooling"].every((theme) => retroThemeNames.includes(theme)),
      retroThemeNames.join(","),
    );
    const retroPatterns = retro.json && retro.json.patterns;
    check(
      "retro analytics patterns expose blocked+slow metrics",
      Boolean(retroPatterns) &&
        isTaggedMetric(retroPatterns.blocked && retroPatterns.blocked.current) &&
        retroPatterns.blocked.current.value === 1 &&
        Array.isArray(retroPatterns.blocked.by_assignee) &&
        isTaggedMetric(retroPatterns.blocked.blocked_runs) &&
        isTaggedMetric(retroPatterns.slow && retroPatterns.slow.count) &&
        retroPatterns.slow.count.value === 1 &&
        isTaggedMetric(retroPatterns.slow.average_duration_seconds),
      retroPatterns && JSON.stringify(retroPatterns),
    );
    const retroOutcomes = retro.json && retro.json.outcomes;
    const retroOutcomeNodes = retroOutcomes && Array.isArray(retroOutcomes.by_node) ? retroOutcomes.by_node : [];
    const retroAgyOutcome = retroOutcomeNodes.find((item) => item.node === "agy-node");
    check(
      "retro analytics outcomes expose node/role metrics",
      Boolean(retroOutcomes) &&
        Array.isArray(retroOutcomes.by_role) &&
        Boolean(retroAgyOutcome) &&
        retroAgyOutcome.agent === "agy" &&
        isTaggedMetric(retroAgyOutcome.completed) &&
        retroAgyOutcome.completed.value === 1,
      retroOutcomes && JSON.stringify(retroOutcomes),
    );
    const retroAgyCredit = retro.json && retro.json.cost_signals && retro.json.cost_signals.agy_credit;
    eq("retro analytics agy credit value unknown/null", retroAgyCredit && retroAgyCredit.value, null);
    eq("retro analytics agy credit confidence unknown", retroAgyCredit && retroAgyCredit.confidence, "unknown");
    eq("retro analytics agy credit status unknown", retroAgyCredit && retroAgyCredit.status, "unknown");
    check(
      "retro analytics limitations avoid agy cost invention",
      Boolean(retro.json) &&
        Array.isArray(retro.json.limitations) &&
        retro.json.limitations.some((item) => /no credit or cost values are invented/i.test(item)),
      retro.json && JSON.stringify(retro.json.limitations),
    );
    check(
      "retro analytics response leaks no raw text/secret/path/pii",
      !hasSecret(retro.json) &&
        !retro.text.includes(retroSecret) &&
        !retro.text.includes(retroEmail) &&
        !retro.text.includes(retroPrivatePath) &&
        !retro.text.includes(retroRawPhrase) &&
        !retro.text.includes("transcript_path") &&
        !retro.text.includes("private body"),
      retro.text.slice(0, 240),
    );
    const afterRetroTasks = await reqAt(sharedBaseUrl, "GET", `/api/boards/${RETRO}/tasks`, {
      cookie: retroOperatorCookie,
      project: RETRO,
    });
    const afterRetroTaskItems = Array.isArray(afterRetroTasks.json) ? afterRetroTasks.json : [];
    eq("retro analytics read leaves task count unchanged", afterRetroTaskItems.length, beforeRetroTaskItems.length);
    check(
      "retro analytics read does not change seeded task statuses",
      beforeRetroTaskItems.length === afterRetroTaskItems.length &&
        beforeRetroTaskItems.every((before) => {
          const after = afterRetroTaskItems.find((item) => item.id === before.id);
          return Boolean(after) && after.status === before.status;
        }),
      JSON.stringify(afterRetroTaskItems.map((item) => [item.id, item.status])),
    );

    const retroOther = await reqAt(sharedBaseUrl, "GET", `/api/retro/analytics?window=all&project=${encodeURIComponent(RETRO_OTHER)}`, {
      cookie: retroOperatorCookie,
    });
    eq("retro analytics other project 200", retroOther.status, 200);
    eq("retro analytics other project name", retroOther.json && retroOther.json.project, RETRO_OTHER);
    check(
      "retro analytics other project does not leak retro data",
      Boolean(retroOther.json) &&
        Array.isArray(retroOther.json.themes) &&
        retroOther.json.themes.length === 0 &&
        !retroOther.text.includes(retroSecret) &&
        !retroOther.text.includes(retroRawPhrase) &&
        !retroOther.text.includes("agy-node") &&
        !retroOther.text.includes("maker"),
      retroOther.text,
    );
    eq(
      "retro analytics path traversal project -> 400",
      (await reqAt(sharedBaseUrl, "GET", `/api/retro/analytics?window=all&project=${encodeURIComponent(`../${RETRO}`)}`, {
        cookie: retroOperatorCookie,
      })).status,
      400,
    );
    eq(
      "retro analytics missing project -> 404",
      (await reqAt(sharedBaseUrl, "GET", "/api/retro/analytics?window=all&project=qae2e_missing_retro", {
        cookie: retroOperatorCookie,
      })).status,
      404,
    );
  } finally {
    await stopSharedServer();
  }

  // --- /api/usage/trend: advisory trend/anomaly signals, agy cost scrub ---
  const trendOperatorSecret = "trend-operator-secret";
  const trendViewerSecret = "trend-viewer-secret";
  const trendSecret = "xoxb-" + "9".repeat(44);
  const trendEmail = "trend.owner@example.test";
  const trendPrivatePath = `/Users/chopin/private/${trendSecret}`;
  const trendAgyCostMarker = 999.99;
  const trendDay = 86_400;
  const trendBase = Math.floor(Date.now() / 1000) - 5 * trendDay;
  writeRegistry(USAGE_TREND, {
    "codex-trend": { name: "codex-trend", agent: "codex", tmux_pane: `${USAGE_TREND}:1.0`, status: "idle", role: "maker" },
    "claude-trend": { name: "claude-trend", agent: "claude", tmux_pane: `${USAGE_TREND}:1.1`, status: "idle", role: "reviewer" },
    "agy-trend": { name: "agy-trend", agent: "agy", tmux_pane: `${USAGE_TREND}:1.2`, status: "idle", role: "maker" },
  });
  writeRegistry(USAGE_TREND_OTHER, {
    "trend-other": { name: "trend-other", agent: "codex", tmux_pane: `${USAGE_TREND_OTHER}:1.0`, status: "idle", role: "maker" },
  });
  writeTeamMembers(USAGE_TREND, [
    { id: "trend-operator-1", name: "trend-operator", role: "operator", secret: trendOperatorSecret },
    { id: "trend-viewer-1", name: "trend-viewer", role: "viewer", secret: trendViewerSecret },
  ]);
  [
    [0, 100, 1.0],
    [1, 100, 1.0],
    [2, 100, 1.0],
    [3, 300, 3.0],
  ].forEach(([offset, tokens, cost]) =>
    completeUsageRun({
      board: USAGE_TREND,
      node: "codex-trend",
      metadata: { node: "codex-trend", total_tokens: tokens, cost_usd: cost },
      startedAt: trendBase + offset * trendDay,
    }),
  );
  [
    [1, 50, 0.2],
    [4, 80, 0.35],
  ].forEach(([offset, tokens, cost]) =>
    completeUsageRun({
      board: USAGE_TREND,
      node: "claude-trend",
      metadata: { node: "claude-trend", total_tokens: tokens, cost_usd: cost },
      startedAt: trendBase + offset * trendDay,
    }),
  );
  [
    [2, 25],
    [4, 30],
  ].forEach(([offset, tokens]) =>
    completeUsageRun({
      board: USAGE_TREND,
      node: "agy-trend",
      metadata: {
        node: "agy-trend",
        total_tokens: tokens,
        cost_usd: trendAgyCostMarker,
        transcript_path: `${trendPrivatePath}/agy.jsonl`,
        email: trendEmail,
        secret_note: trendSecret,
      },
      startedAt: trendBase + offset * trendDay,
    }),
  );
  eq(
    "usage trend default-off -> 404",
    (await req("GET", `/api/usage/trend?window=14d&project=${encodeURIComponent(USAGE_TREND)}`, { token })).status,
    404,
  );

  await startSharedServer({ session: USAGE_TREND, joinRole: "viewer", enableUsageTrend: true });
  try {
    eq("usage trend 401 without session", (await reqAt(sharedBaseUrl, "GET", "/api/usage/trend?window=14d")).status, 401);
    const trendOperatorLogin = await reqAt(sharedBaseUrl, "POST", "/api/login", {
      body: { name: "trend-operator", secret: trendOperatorSecret },
    });
    eq("usage trend operator login 200", trendOperatorLogin.status, 200);
    const trendOperatorCookie = String(trendOperatorLogin.headers.get("set-cookie") || "").split(";")[0];
    const trendViewerLogin = await reqAt(sharedBaseUrl, "POST", "/api/login", {
      body: { name: "trend-viewer", secret: trendViewerSecret },
    });
    eq("usage trend viewer login 200", trendViewerLogin.status, 200);
    const trendViewerCookie = String(trendViewerLogin.headers.get("set-cookie") || "").split(";")[0];
    eq(
      "usage trend viewer denied",
      (await reqAt(sharedBaseUrl, "GET", `/api/usage/trend?window=14d&project=${encodeURIComponent(USAGE_TREND)}`, {
        cookie: trendViewerCookie,
      })).status,
      403,
    );
    eq(
      "usage trend window 7d allowed",
      (await reqAt(sharedBaseUrl, "GET", `/api/usage/trend?window=7d&project=${encodeURIComponent(USAGE_TREND)}`, {
        cookie: trendOperatorCookie,
      })).status,
      200,
    );
    eq(
      "usage trend window 30d allowed",
      (await reqAt(sharedBaseUrl, "GET", `/api/usage/trend?window=30d&project=${encodeURIComponent(USAGE_TREND)}`, {
        cookie: trendOperatorCookie,
      })).status,
      200,
    );
    eq(
      "usage trend invalid window -> 400",
      (await reqAt(sharedBaseUrl, "GET", `/api/usage/trend?window=all&project=${encodeURIComponent(USAGE_TREND)}`, {
        cookie: trendOperatorCookie,
      })).status,
      400,
    );

    const beforeTrendTasks = await reqAt(sharedBaseUrl, "GET", `/api/boards/${USAGE_TREND}/tasks`, {
      cookie: trendOperatorCookie,
      project: USAGE_TREND,
    });
    eq("usage trend task snapshot before read 200", beforeTrendTasks.status, 200);
    const beforeTrendTaskItems = Array.isArray(beforeTrendTasks.json) ? beforeTrendTasks.json : [];
    const trend = await reqAt(sharedBaseUrl, "GET", `/api/usage/trend?window=14d&project=${encodeURIComponent(USAGE_TREND)}`, {
      cookie: trendOperatorCookie,
    });
    eq("usage trend operator 200 when enabled", trend.status, 200);
    eq("usage trend project == usage trend", trend.json && trend.json.project, USAGE_TREND);
    eq("usage trend mode advisory", trend.json && trend.json.mode, "advisory");
    check("usage trend actions empty", Boolean(trend.json) && Array.isArray(trend.json.actions) && trend.json.actions.length === 0);
    eq("usage trend enforcement not called", trend.json && trend.json.enforcement && trend.json.enforcement.called, false);
    check("usage trend generated_at metric", isTaggedMetric(trend.json && trend.json.generated_at));
    eq("usage trend window 14d", trend.json && trend.json.window && trend.json.window.name, "14d");
    eq("usage trend window days == 14", trend.json && trend.json.window && trend.json.window.days && trend.json.window.days.value, 14);
    const trendNodes = trend.json && Array.isArray(trend.json.nodes) ? trend.json.nodes : [];
    check("usage trend nodes include codex/claude/agy", trendNodes.length === 3, trendNodes.map((node) => node.node).join(","));
    const trendByNode = Object.fromEntries(trendNodes.map((node) => [node.node, node]));
    const codexTrend = trendByNode["codex-trend"];
    const claudeTrend = trendByNode["claude-trend"];
    const agyTrend = trendByNode["agy-trend"];
    eq("usage trend codex confidence medium", codexTrend && codexTrend.confidence, "medium");
    eq("usage trend codex latest tokens", codexTrend && codexTrend.trend && codexTrend.trend.total_tokens.latest.value, 300);
    eq("usage trend codex baseline tokens", codexTrend && codexTrend.trend && codexTrend.trend.total_tokens.baseline.value, 100);
    eq("usage trend codex token anomaly flagged", codexTrend && codexTrend.anomaly && codexTrend.anomaly.total_tokens.flagged, true);
    eq("usage trend codex anomaly reason spike", codexTrend && codexTrend.anomaly && codexTrend.anomaly.total_tokens.reason, "spike");
    eq("usage trend codex measured cost latest", codexTrend && codexTrend.trend && codexTrend.trend.cost_usd_estimate.latest.value, 3);
    eq("usage trend codex cost anomaly flagged", codexTrend && codexTrend.anomaly && codexTrend.anomaly.cost_usd_estimate.flagged, true);
    eq("usage trend codex forecast tokens", codexTrend && codexTrend.forecast && codexTrend.forecast.total_tokens_next_day.value, 500);
    check(
      "usage trend forecast labeled not prediction",
      [codexTrend, claudeTrend, agyTrend].every(
        (node) => node && node.forecast && /not a prediction/i.test(node.forecast.label || ""),
      ),
      JSON.stringify(trendNodes.map((node) => node.forecast && node.forecast.label)),
    );
    eq("usage trend claude confidence low", claudeTrend && claudeTrend.confidence, "low");
    eq("usage trend claude measured cost latest", claudeTrend && claudeTrend.trend && claudeTrend.trend.cost_usd_estimate.latest.value, 0.35);
    eq("usage trend claude thin-data anomaly low", claudeTrend && claudeTrend.anomaly && claudeTrend.anomaly.total_tokens.confidence, "low");
    check(
      "usage trend claude warns thin data",
      Boolean(claudeTrend) &&
        Array.isArray(claudeTrend.warnings) &&
        claudeTrend.warnings.some((warning) => /thin data/i.test(warning)),
      claudeTrend && JSON.stringify(claudeTrend.warnings),
    );
    eq("usage trend agy confidence low", agyTrend && agyTrend.confidence, "low");
    eq("usage trend agy token latest preserved", agyTrend && agyTrend.trend && agyTrend.trend.total_tokens.latest.value, 30);
    eq("usage trend agy cost trend unknown", agyTrend && agyTrend.trend && agyTrend.trend.cost_usd_estimate.value, null);
    eq("usage trend agy cost trend confidence unknown", agyTrend && agyTrend.trend && agyTrend.trend.cost_usd_estimate.confidence, "unknown");
    eq("usage trend agy cost anomaly excluded", agyTrend && agyTrend.anomaly && agyTrend.anomaly.cost_usd_estimate.reason, "excluded: agy cost is unknown");
    eq("usage trend agy cost forecast unknown", agyTrend && agyTrend.forecast && agyTrend.forecast.cost_usd_next_day.value, null);
    check(
      "usage trend agy days cost unknown despite 999.99 metadata",
      Boolean(agyTrend) &&
        Array.isArray(agyTrend.days) &&
        agyTrend.days.length === 2 &&
        agyTrend.days.every(
          (day) =>
            day.totals &&
            day.totals.cost_usd_estimate &&
            day.totals.cost_usd_estimate.value === null &&
            day.totals.cost_usd_estimate.confidence === "unknown" &&
            day.totals.cost_usd_estimate.status === "unknown",
        ),
      agyTrend && JSON.stringify(agyTrend.days),
    );
    check(
      "usage trend limitations document advisory+explicit+agy unknown",
      Boolean(trend.json) &&
        Array.isArray(trend.json.limitations) &&
        trend.json.limitations.some((item) => /advisory-only/i.test(item)) &&
        trend.json.limitations.some((item) => /explicit run metadata/i.test(item)) &&
        trend.json.limitations.some((item) => /forecast.*not a prediction/i.test(item)) &&
        trend.json.limitations.some((item) => /agy cost is unknown/i.test(item)),
      trend.json && JSON.stringify(trend.json.limitations),
    );
    check(
      "usage trend scrubs agy 999.99 cost and secrets",
      !hasSecret(trend.json) &&
        !trend.text.includes(String(trendAgyCostMarker)) &&
        !trend.text.includes(trendSecret) &&
        !trend.text.includes(trendEmail) &&
        !trend.text.includes(trendPrivatePath) &&
        !trend.text.includes("transcript_path") &&
        !trend.text.includes("secret_note"),
      trend.text.slice(0, 240),
    );
    const afterTrendTasks = await reqAt(sharedBaseUrl, "GET", `/api/boards/${USAGE_TREND}/tasks`, {
      cookie: trendOperatorCookie,
      project: USAGE_TREND,
    });
    const afterTrendTaskItems = Array.isArray(afterTrendTasks.json) ? afterTrendTasks.json : [];
    eq("usage trend read leaves task count unchanged", afterTrendTaskItems.length, beforeTrendTaskItems.length);
    check(
      "usage trend read does not change seeded task statuses",
      beforeTrendTaskItems.length === afterTrendTaskItems.length &&
        beforeTrendTaskItems.every((before) => {
          const after = afterTrendTaskItems.find((item) => item.id === before.id);
          return Boolean(after) && after.status === before.status;
        }),
      JSON.stringify(afterTrendTaskItems.map((item) => [item.id, item.status])),
    );
    const trendOther = await reqAt(sharedBaseUrl, "GET", `/api/usage/trend?window=14d&project=${encodeURIComponent(USAGE_TREND_OTHER)}`, {
      cookie: trendOperatorCookie,
    });
    eq("usage trend other project 200", trendOther.status, 200);
    eq("usage trend other project name", trendOther.json && trendOther.json.project, USAGE_TREND_OTHER);
    check(
      "usage trend other project does not leak trend data",
      Boolean(trendOther.json) &&
        Array.isArray(trendOther.json.nodes) &&
        trendOther.json.nodes.length === 0 &&
        !trendOther.text.includes("codex-trend") &&
        !trendOther.text.includes("agy-trend") &&
        !trendOther.text.includes(String(trendAgyCostMarker)) &&
        !trendOther.text.includes(trendSecret),
      trendOther.text,
    );
    eq(
      "usage trend path traversal project -> 400",
      (await reqAt(sharedBaseUrl, "GET", `/api/usage/trend?window=14d&project=${encodeURIComponent(`../${USAGE_TREND}`)}`, {
        cookie: trendOperatorCookie,
      })).status,
      400,
    );
    eq(
      "usage trend missing project -> 404",
      (await reqAt(sharedBaseUrl, "GET", "/api/usage/trend?window=14d&project=qae2e_missing_usage_trend", {
        cookie: trendOperatorCookie,
      })).status,
      404,
    );
  } finally {
    await stopSharedServer();
  }

  // --- /api/cost: by_agent{} + totals{}, token/path non-exposure ---
  eq("cost 401 without token", (await req("GET", "/api/cost")).status, 401);
  const cost = await req("GET", "/api/cost", { token, project: ALPHA });
  // Local dashboard-token mode is operator-equivalent -> 200. The viewer-403
  // path (_require_cost_access) only triggers under TEAM_COOKIE auth, which this
  // local-mode harness does not run.
  eq("cost 200 with token (local operator)", cost.status, 200);
  const byAgent = cost.json && cost.json.by_agent;
  check("cost by_agent is an OBJECT (not an array)", Boolean(byAgent) && typeof byAgent === "object" && !Array.isArray(byAgent));
  check(
    "cost by_agent covers codex/claude/agy",
    Boolean(byAgent) && ["codex", "claude", "agy"].every((a) => a in byAgent),
    byAgent && Object.keys(byAgent).join(","),
  );
  const isMetric = (m) =>
    Boolean(m) && typeof m === "object" && "value" in m && typeof m.source === "string" && typeof m.confidence === "string";
  const codexAgent = byAgent && byAgent.codex;
  check("cost by_agent.codex.total_tokens is a metric {value,source,confidence}", Boolean(codexAgent) && isMetric(codexAgent.total_tokens));
  check("cost by_agent.codex.cost_usd_estimate is a metric", Boolean(codexAgent) && isMetric(codexAgent.cost_usd_estimate));
  const agyAgent = byAgent && byAgent.agy;
  check("cost by_agent.agy.credit_remaining is a metric (may be unknown)", Boolean(agyAgent) && isMetric(agyAgent.credit_remaining));
  check("cost by_agent.agy.credit_status is a string", Boolean(agyAgent) && typeof agyAgent.credit_status === "string", agyAgent && agyAgent.credit_status);
  check("cost by_agent.agy.warnings is an array", Boolean(agyAgent) && Array.isArray(agyAgent.warnings));
  const totals = cost.json && cost.json.totals;
  check(
    "cost totals has total_tokens + cost_usd_estimate metrics",
    Boolean(totals) && isMetric(totals.total_tokens) && isMetric(totals.cost_usd_estimate),
  );
  check("cost leaks no secrets", !hasSecret(cost.json));
  check(
    "cost exposes no filesystem paths (no GROVE_HOME/workspace/registry leak)",
    !cost.text.includes(groveHome) && !cost.text.includes(`/tmp/${ALPHA}`) && !/registry\.json/.test(cost.text),
    cost.text.slice(0, 160),
  );

  // === task-only-comms pipeline: status transitions + ANSWER + durable comments
  // (pivot priority, previously uncovered: answer=0). Pure-HTTP against the real
  // server (LOCAL_TOKEN = operator). blocked -> ANSWER -> ready, comment persists.
  const taskPath = (id, sub = "") => `/api/tasks/${encodeURIComponent(id)}${sub}`;
  const ansSeed = await req("POST", `/api/boards/${ALPHA}/tasks`, {
    token,
    project: ALPHA,
    body: { title: "e2e answer-pipeline task", assignee: "worker" },
  });
  eq("answer: seed task 200", ansSeed.status, 200);
  const ansTaskId = (ansSeed.json && ansSeed.json.id) || "";
  check("answer: seed returns id", typeof ansTaskId === "string" && ansTaskId.length > 0, ansTaskId);

  // status transition: ready -> running (alias "in_progress"); persists + validates.
  const toRunning = await req("PATCH", taskPath(ansTaskId, "/status"), {
    token,
    project: ALPHA,
    body: { status: "in_progress" },
  });
  eq("answer: PATCH status in_progress 200", toRunning.status, 200);
  eq("answer: status alias in_progress -> running", toRunning.json && toRunning.json.status, "running");
  eq(
    "answer: PATCH invalid status -> 400 (v1.28 _manual_task_status)",
    (await req("PATCH", taskPath(ansTaskId, "/status"), { token, project: ALPHA, body: { status: "/etc/passwd" } })).status,
    400,
  );
  eq(
    "answer: PATCH status 401 without token",
    (await req("PATCH", taskPath(ansTaskId, "/status"), { project: ALPHA, body: { status: "ready" } })).status,
    401,
  );
  eq(
    "answer: PATCH status 403 foreign Origin (CSRF)",
    (await req("PATCH", taskPath(ansTaskId, "/status"), { token, project: ALPHA, body: { status: "ready" }, origin: "http://evil.example" })).status,
    403,
  );

  // ANSWER requires status==blocked: a non-blocked task -> 409.
  eq(
    "answer: POST answer on a non-blocked task -> 409",
    (await req("POST", taskPath(ansTaskId, "/answer"), { token, project: ALPHA, body: { text: "premature" } })).status,
    409,
  );
  const toBlocked = await req("PATCH", taskPath(ansTaskId, "/status"), { token, project: ALPHA, body: { status: "blocked" } });
  eq("answer: PATCH status blocked 200", toBlocked.status, 200);
  eq("answer: task is blocked", toBlocked.json && toBlocked.json.status, "blocked");
  const ANSWER_TEXT = "resolved: proceed with the worker route";
  const answered = await req("POST", taskPath(ansTaskId, "/answer"), { token, project: ALPHA, body: { text: ANSWER_TEXT } });
  eq("answer: POST answer on a blocked task 200", answered.status, 200);
  check("answer: response ok:true", Boolean(answered.json) && answered.json.ok === true);
  eq("answer: task transitions blocked -> ready", answered.json && answered.json.task && answered.json.task.status, "ready");
  check(
    "answer: response carries the answer comment",
    Boolean(answered.json) && answered.json.comment && answered.json.comment.body === ANSWER_TEXT,
    answered.json && answered.json.comment && answered.json.comment.body,
  );
  const afterComments = await req("GET", taskPath(ansTaskId, "/comments"), { token, project: ALPHA });
  eq("answer: GET comments 200", afterComments.status, 200);
  check(
    "answer: answer comment is durable in the comments list",
    Array.isArray(afterComments.json) && afterComments.json.some((c) => c.body === ANSWER_TEXT),
    afterComments.json && afterComments.json.length,
  );
  eq(
    "answer: re-answering a now-ready task -> 409",
    (await req("POST", taskPath(ansTaskId, "/answer"), { token, project: ALPHA, body: { text: "again" } })).status,
    409,
  );
  eq("answer: 401 without token", (await req("POST", taskPath(ansTaskId, "/answer"), { project: ALPHA, body: { text: "x" } })).status, 401);
  eq(
    "answer: 403 foreign Origin",
    (await req("POST", taskPath(ansTaskId, "/answer"), { token, project: ALPHA, body: { text: "x" }, origin: "http://evil.example" })).status,
    403,
  );
  eq("answer: nonexistent task -> 404", (await req("POST", taskPath("task_nope_zzz", "/answer"), { token, project: ALPHA, body: { text: "x" } })).status, 404);
  eq(
    "answer: cross-project task (alpha task under beta) -> 404 (scope isolation)",
    (await req("POST", taskPath(ansTaskId, "/answer"), { token, project: BETA, body: { text: "x" } })).status,
    404,
  );
  check("answer: pipeline leaks no secrets", !hasSecret(answered.json) && !hasSecret(afterComments.json));

  // durable comments + a bounded CONCURRENCY probe: parallel writes to one task
  // must all persist (no lost update). SQLite WAL serializes writers safely.
  const cSeed = await req("POST", `/api/boards/${ALPHA}/tasks`, { token, project: ALPHA, body: { title: "e2e concurrent-comments task" } });
  const cTaskId = (cSeed.json && cSeed.json.id) || "";
  eq("comments: direct POST 401 without token", (await req("POST", taskPath(cTaskId, "/comments"), { project: ALPHA, body: { author: "qa", body: "hi" } })).status, 401);
  eq(
    "comments: direct POST 403 foreign Origin",
    (await req("POST", taskPath(cTaskId, "/comments"), { token, project: ALPHA, body: { author: "qa", body: "hi" }, origin: "http://evil.example" })).status,
    403,
  );
  const N = 6;
  const parallelPosts = await Promise.all(
    Array.from({ length: N }, (_, i) =>
      req("POST", taskPath(cTaskId, "/comments"), { token, project: ALPHA, body: { author: "qa", body: `concurrent-${i}` } }),
    ),
  );
  check("comments: all parallel POSTs return 200", parallelPosts.every((r) => r.status === 200), parallelPosts.map((r) => r.status).join(","));
  const cList = await req("GET", taskPath(cTaskId, "/comments"), { token, project: ALPHA });
  const cBodies = new Set((cList.json || []).map((c) => c.body));
  check(
    "comments: every concurrent comment is durably persisted (no lost update)",
    cList.status === 200 && Array.from({ length: N }, (_, i) => `concurrent-${i}`).every((b) => cBodies.has(b)),
    (cList.json || []).length,
  );

  // ==========================================================================
  // Phase 2 stable expansion: previously-uncovered endpoints, asserted against
  // the real server's current contract. Pure-HTTP, LOCAL_TOKEN (= operator).
  // ==========================================================================

  // --- LOCAL_TOKEN auth context: /api/me, /api/csrf, team-only /api/login ----
  const me = await req("GET", "/api/me");
  eq("me 200 (local-token mode needs no auth)", me.status, 200);
  eq("me auth_mode == local-token", me.json && me.json.auth_mode, "local-token");
  eq("me member is null in local mode", me.json && me.json.member, null);
  const csrfInfo = await req("GET", "/api/csrf");
  eq("csrf 200 (local-token mode)", csrfInfo.status, 200);
  eq("csrf token is null in local mode", csrfInfo.json && csrfInfo.json.csrf, null);
  eq(
    "login -> 404 when team auth is disabled",
    (await req("POST", "/api/login", { token, body: { name: "x", secret: "y" } })).status,
    404,
  );
  check("me/csrf leak no secrets", !hasSecret(me.json) && !hasSecret(csrfInfo.json));

  // --- /api/presence (perfect-sync viewer presence) -------------------------
  eq("presence 401 without token", (await req("GET", "/api/presence")).status, 401);
  const presence = await req("GET", "/api/presence", { token, project: ALPHA });
  eq("presence 200 with token", presence.status, 200);
  eq("presence scoped to alpha", presence.json && presence.json.project, ALPHA);
  eq("presence auth_mode == local-token", presence.json && presence.json.auth_mode, "local-token");
  eq("presence anonymous_count == 1 (local mode)", presence.json && presence.json.anonymous_count, 1);
  check("presence viewers is a non-empty array", Array.isArray(presence.json && presence.json.viewers) && presence.json.viewers.length >= 1);
  check("presence active_window_seconds is an int", Number.isInteger(presence.json && presence.json.active_window_seconds));
  check("presence leaks no secrets", !hasSecret(presence.json));

  // --- /api/inbox ask-human queue + answer-clears-it journey ----------------
  eq("inbox 401 without token", (await req("GET", "/api/inbox")).status, 401);
  const inbox0 = await req("GET", "/api/inbox", { token, project: ALPHA });
  eq("inbox 200 with token", inbox0.status, 200);
  check("inbox items is an array", Array.isArray(inbox0.json && inbox0.json.items));
  check("inbox total is a number", typeof (inbox0.json && inbox0.json.total) === "number");
  eq("inbox advertises the answer endpoint", inbox0.json && inbox0.json.answer && inbox0.json.answer.endpoint, "/api/tasks/{task_id}/answer");
  eq("inbox answer method is POST", inbox0.json && inbox0.json.answer && inbox0.json.answer.method, "POST");
  const inboxSeed = await req("POST", `/api/boards/${ALPHA}/tasks`, { token, project: ALPHA, body: { title: "e2e ask-human task" } });
  const inboxTaskId = (inboxSeed.json && inboxSeed.json.id) || "";
  eq("inbox: PATCH task -> blocked 200", (await req("PATCH", taskPath(inboxTaskId, "/status"), { token, project: ALPHA, body: { status: "blocked" } })).status, 200);
  const inbox1 = await req("GET", "/api/inbox", { token, project: ALPHA });
  check("inbox: a blocked task surfaces in the ask-human queue", inbox1.text.includes(inboxTaskId), inbox1.json && inbox1.json.total);
  const inboxBeta = await req("GET", "/api/inbox", { token, project: BETA });
  check("inbox: blocked alpha task is absent from beta's inbox (scope isolation)", !inboxBeta.text.includes(inboxTaskId));
  eq("inbox: answer the blocked task 200", (await req("POST", taskPath(inboxTaskId, "/answer"), { token, project: ALPHA, body: { text: "go ahead" } })).status, 200);
  const inbox2 = await req("GET", "/api/inbox", { token, project: ALPHA });
  check("inbox: an answered task leaves the queue", !inbox2.text.includes(inboxTaskId));
  check("inbox leaks no secrets", !hasSecret(inbox1.json));
  const inboxPaged = await req("GET", "/api/inbox?limit=1", { token, project: ALPHA });
  check(
    "inbox ?limit=1 returns at most 1 item",
    Array.isArray(inboxPaged.json && inboxPaged.json.items) && inboxPaged.json.items.length <= 1,
    inboxPaged.json && inboxPaged.json.items && inboxPaged.json.items.length,
  );

  // --- /api/nodes/{node}/connect (read-only attach hints) -------------------
  const connectPath = (n) => `/api/nodes/${encodeURIComponent(n)}/connect`;
  eq("connect 401 without token", (await req("GET", connectPath("worker"))).status, 401);
  const connect = await req("GET", connectPath("worker"), { token, project: ALPHA });
  eq("connect worker 200", connect.status, 200);
  eq("connect echoes node name", connect.json && connect.json.node, "worker");
  eq("connect tmux_target is the worker pane", connect.json && connect.json.tmux_target, `${ALPHA}:1.1`);
  check(
    "connect exposes attach + select_pane commands",
    Boolean(connect.json) && connect.json.commands && typeof connect.json.commands.attach === "string" && typeof connect.json.commands.select_pane === "string",
  );
  eq("connect nonexistent node -> 404", (await req("GET", connectPath("ghost_node"), { token, project: ALPHA })).status, 404);
  check("connect leaks no GROVE_HOME path", Boolean(connect.text) && !connect.text.includes(groveHome));

  // --- /api/nodes/{node}/send (operator + Origin gating; never a real send) -
  const sendPath = (n) => `/api/nodes/${encodeURIComponent(n)}/send`;
  eq("send 401 without token", (await req("POST", sendPath("worker"), { project: ALPHA, body: { text: "hi" } })).status, 401);
  eq(
    "send 403 foreign Origin (CSRF)",
    (await req("POST", sendPath("worker"), { token, project: ALPHA, body: { text: "hi" }, origin: "http://evil.example" })).status,
    403,
  );
  const sendWorker = await req("POST", sendPath("worker"), { token, project: ALPHA, body: { text: "hi" } });
  check(
    "send never performs a real 200 send in-harness (feature-gated 404 or tmux-unavailable 502)",
    [404, 502].includes(sendWorker.status),
    sendWorker.status,
  );
  eq("send nonexistent node -> 404", (await req("POST", sendPath("ghost_node"), { token, project: ALPHA, body: { text: "hi" } })).status, 404);
  check("send error leaks no GROVE_HOME path", Boolean(sendWorker.text) && !sendWorker.text.includes(groveHome));

  // --- /api/master/chat (deterministic answer/preview classifier + redaction)
  const masterPath = "/api/master/chat";
  eq("master-chat 401 without token", (await req("POST", masterPath, { body: { message: "hello" } })).status, 401);
  eq("master-chat 422 on a blank message", (await req("POST", masterPath, { token, project: ALPHA, body: { message: "   " } })).status, 422);
  const mAnswer = await req("POST", masterPath, { token, project: ALPHA, body: { message: "What is your capability?" } });
  eq("master-chat capability question 200", mAnswer.status, 200);
  check(
    "master-chat response_type is one of answer|preview|denied",
    ["answer", "preview", "denied"].includes(mAnswer.json && mAnswer.json.response_type),
    mAnswer.json && mAnswer.json.response_type,
  );
  eq("master-chat capability -> answer mode", mAnswer.json && mAnswer.json.response_type, "answer");
  check("master-chat answer carries an answer body and needs no confirmation", Boolean(mAnswer.json) && mAnswer.json.answer && mAnswer.json.requires_confirmation === false);
  const mPreview = await req("POST", masterPath, { token, project: ALPHA, body: { message: "I want to report a bug: the board is broken" } });
  eq("master-chat feedback message 200", mPreview.status, 200);
  eq("master-chat feedback -> preview mode", mPreview.json && mPreview.json.response_type, "preview");
  check("master-chat preview requires confirmation", Boolean(mPreview.json) && mPreview.json.requires_confirmation === true);
  const mSecret = await req("POST", masterPath, { token, project: ALPHA, body: { message: "What is your capability? secret xoxb-deadbeefcafe1234567890" } });
  eq("master-chat secret-bearing message 200", mSecret.status, 200);
  // Assert the SPECIFIC injected secret is scrubbed (the broad hasSecret() scan
  // false-positives on the response's legitimate long-hex ids, so match the
  // secret directly — the real contract is "the user's secret never echoes").
  check(
    "master-chat redacts the injected slack secret from its response",
    !mSecret.text.includes("xoxb-deadbeefcafe1234567890") && !mSecret.text.includes("deadbeefcafe1234567890"),
    mSecret.text.slice(0, 300),
  );
}

console.log("grove-web API e2e\n");
let runError = null;
try {
  await run();
} catch (e) {
  runError = e;
} finally {
  await teardown();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) {
  console.log("FAILED:");
  for (const f of failed) console.log(`  ✗ ${f.label}${f.detail ? ` (${f.detail})` : ""}`);
}
if (runError) {
  console.error(`\nharness error: ${runError.message || runError}`);
  process.exit(2);
}
process.exit(failed.length ? 1 : 0);
