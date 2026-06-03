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
//
// Each check asserts the CORRECT contract. A failing check is a real defect to
// report as `# BUG(Pn)` — never relax the assertion to match a bug.
//
// Setup/teardown is self-contained: spawn -> wait-ready -> assert -> kill +
// remove the temp tree. Headless: `npm run e2e` (or `pnpm run e2e`) from web/.

import { spawn } from "node:child_process";
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
const READY_TIMEOUT_MS = 25_000;

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
async function req(method, pathname, { token, project, body } = {}) {
  const headers = {};
  if (token) headers[SESSION_HEADER] = token;
  if (project !== undefined) headers[PROJECT_HEADER] = project;
  if (body !== undefined) headers["Content-Type"] = "application/json";
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
  return { status: resp.status, json, text };
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
        },
        worker: {
          name: "worker",
          agent: "codex",
          tmux_pane: `${name}:1.1`,
          session_id: "s2",
          status: "idle",
          parent: "lead",
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
      const r = await fetch(baseUrl + "/api/status");
      await r.text();
      if (r.status === 200) return port;
    } catch {
      /* not up yet */
    }
    await sleep(150);
  }
  throw new Error(`server not ready within ${READY_TIMEOUT_MS}ms:\n${serverLog}`);
}

async function teardown() {
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
    (await req("GET", "/api/status", { project: "../etc" })).status,
    400,
  );
  eq(
    "unknown project header -> 404",
    (await req("GET", "/api/status", { project: "ghost_proj" })).status,
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

  // --- ws-ticket issuance + project binding ---
  const t1 = await req("POST", "/api/ws-ticket", { token });
  eq("ws-ticket 200", t1.status, 200);
  check(
    "ws-ticket returns a non-empty ticket",
    Boolean(t1.json) && typeof t1.json.ticket === "string" && t1.json.ticket.length > 0,
  );
  eq("ws-ticket ttl_seconds == 30", t1.json && t1.json.ttl_seconds, 30);
  eq("ws-ticket default project == session (alpha)", t1.json && t1.json.project, ALPHA);
  const t2 = await req("POST", "/api/ws-ticket", { token, project: BETA });
  eq("ws-ticket binds project from header (beta)", t2.json && t2.json.project, BETA);

  // --- ws-ticket single-use over a real websocket upgrade ---
  const issued = await req("POST", "/api/ws-ticket", { token, project: ALPHA });
  const ticket = (issued.json && issued.json.ticket) || "";
  const wsBase = `ws://127.0.0.1:${port}`;
  const first = await wsProbe(`${wsBase}/ws/board?ticket=${encodeURIComponent(ticket)}&cursor=0`);
  check("ws/board opens with a fresh ticket", first.opened === true, `code ${first.code}`);
  const second = await wsProbe(`${wsBase}/ws/board?ticket=${encodeURIComponent(ticket)}&cursor=0`);
  check("ws/board rejects a reused ticket (single-use)", second.opened === false, `code ${second.code}`);
  const bogus = await wsProbe(`${wsBase}/ws/board?ticket=not-a-real-ticket&cursor=0`);
  check("ws/board rejects a bogus ticket", bogus.opened === false, `code ${bogus.code}`);
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
