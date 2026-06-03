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
//
// Each check asserts the CORRECT contract. A failing check is a real defect to
// report as `# BUG(Pn)` — never relax the assertion to match a bug.
//
// Setup/teardown is self-contained: spawn -> wait-ready -> assert -> kill +
// remove the temp tree. Headless: `npm run e2e` (or `pnpm run e2e`) from web/.

import { spawn, spawnSync } from "node:child_process";
import { pbkdf2Sync } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

async function reqAt(base, method, pathname, { cookie, csrf, body, origin } = {}) {
  const headers = {};
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

function setAutopickupGlobal(board, { enabled, killSwitch }) {
  const boolArg = (value) => (value === undefined ? "none" : value ? "true" : "false");
  const code = [
    "import sys",
    "from pathlib import Path",
    "from grove_bridge.store import SQLiteBoardStore",
    "def value(raw): return None if raw == 'none' else raw == 'true'",
    "SQLiteBoardStore(Path(sys.argv[1])).set_autopickup_global(board=sys.argv[2], enabled=value(sys.argv[3]), kill_switch=value(sys.argv[4]))",
  ].join("\n");
  const result = spawnSync(
    python,
    ["-c", code, dbPath, board, boolArg(enabled), boolArg(killSwitch)],
    { cwd: repoRoot, encoding: "utf8" },
  );
  if (result.status !== 0) {
    throw new Error(`failed to set autopickup global gate:\n${result.stderr || result.stdout}`);
  }
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

async function teardown() {
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
