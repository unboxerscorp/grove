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
//
// Each check asserts the CORRECT contract. A failing check is a real defect to
// report as `# BUG(Pn)` — never relax the assertion to match a bug.
//
// Setup/teardown is self-contained: spawn -> wait-ready -> assert -> kill +
// remove the temp tree. Headless: `npm run e2e` (or `pnpm run e2e`) from web/.

import { spawn, spawnSync } from "node:child_process";
import { createHash, createHmac, pbkdf2Sync } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
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
  const dir = path.join(groveHome, session);
  mkdirSync(dir, { recursive: true });
  const membersPath = path.join(dir, "members.json");
  writeFileSync(
    membersPath,
    JSON.stringify(
      {
        members: [
          {
            id: "viewer-1",
            name,
            role: "viewer",
            enabled: true,
            secret_hash: teamSecretHash(secret),
          },
        ],
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

async function teardown() {
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
  check(
    "unscoped /api/boards lists all boards (main+alpha)",
    allSlugs.includes("main") && allSlugs.includes(ALPHA),
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
  check("usage project scope does not leak other project node/token values", !/maker|96|999/.test(usageEmpty.text), usageEmpty.text);
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
  const summaryOtherSeed = await req("POST", `/api/boards/${SUMMARY}/tasks`, {
    token,
    project: SUMMARY,
    body: {
      title: "summary other status",
      body: `transcript ${summaryPrivatePath}/turn.jsonl must not export`,
      assignee: summaryAgentSecret,
      status: summaryPrivatePath,
    },
  });
  eq("seed: summary other task 200", summaryOtherSeed.status, 200);
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
