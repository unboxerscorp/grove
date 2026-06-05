// Tier-1 isolation fixtures for the UI interaction harness.
//
// Boots a throwaway grove-web server (bridge venv) on an ephemeral port with a
// temp GROVE_HOME + throwaway board DB, serving the REAL built SPA (web/dist) so
// a browser drives the actual UI against a fully isolated backend. Seeds a board
// (tasks across columns) + a registry (input-capable nodes) per the consensus
// "temp port + throwaway board db + temp GROVE_HOME + fresh seed". Nothing here
// touches ~/.grove, dev10, or any live agent.
//
// Roles: operator runs on the loopback local-token (operator-equivalent). viewer
// /admin need TEAM_COOKIE sessions — scaffolded here, issued in a later round;
// the runner SKIPs them with an explicit reason (never a fake pass).

import { spawnSync, spawn } from "node:child_process";
import { pbkdf2Sync } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const repoRoot = path.resolve(here, "..", "..", ".."); // web/e2e/tier1 -> repo root
export const distDir = path.join(repoRoot, "web", "dist");
const python = path.join(repoRoot, "bridge", ".venv", "bin", "python");

export const TEAM_SESSION_COOKIE = "grove_team_session";

// Default fake team members (one per role) used for the Tier-1 role matrix.
export const TEAM_MEMBERS = [
  { id: "viewer-1", name: "viewer", secret: "viewer-secret-uie2e", role: "viewer" },
  { id: "operator-1", name: "operator", secret: "operator-secret-uie2e", role: "operator" },
  { id: "admin-1", name: "admin", secret: "admin-secret-uie2e", role: "admin" },
];

function b64Url(buf) {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
// Mirrors bridge team_auth.hash_secret (pbkdf2_sha256, salt=16x0x31, 200k iters).
function teamSecretHash(secret) {
  const salt = Buffer.alloc(16, 0x31);
  const digest = pbkdf2Sync(secret, salt, 200_000, 32, "sha256");
  return `pbkdf2_sha256$200000$${b64Url(salt)}$${b64Url(digest)}`;
}
function writeMembers(groveHome, session, members) {
  const dir = path.join(groveHome, session);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, "members.json"),
    `${JSON.stringify(
      { members: members.map((m) => ({ id: m.id, name: m.name, role: m.role, enabled: m.enabled ?? true, secret_hash: teamSecretHash(m.secret) })) },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

export function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Run a small python program against the bridge store (seed/inspect the DB).
export function runBridgePython(lines, args) {
  const res = spawnSync(python, ["-c", lines.join("\n"), ...args.map(String)], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  if (res.status !== 0) {
    throw new Error(`bridge python failed (${res.status}): ${res.stderr || res.stdout}`);
  }
  return res.stdout;
}

function seedBoard(dbPath, board) {
  // Tasks across the canonical columns so every board surface renders.
  return JSON.parse(
    runBridgePython(
      [
        "import json, sys",
        "from pathlib import Path",
        "from grove_bridge.store import SQLiteBoardStore",
        "store = SQLiteBoardStore(Path(sys.argv[1]))",
        "board = sys.argv[2]",
        "ids = {}",
        "for status, title, assignee in [",
        "  ('ready','seed ready task','worker'),",
        "  ('running','seed running task','worker'),",
        "  ('review','seed review task','worker'),",
        "  ('blocked','seed blocked task','worker'),",
        "  ('done','seed done task','worker'),",
        "]:",
        "    t = store.create_task(board=board, title=title, body=f'{title} body', assignee=assignee, status=status)",
        "    ids[status] = t.id",
        "print(json.dumps(ids))",
      ],
      [dbPath, board],
    ),
  );
}

function writeRegistry(groveHome, session) {
  const dir = path.join(groveHome, session);
  const workspace = path.join(dir, "workspace");
  mkdirSync(workspace, { recursive: true });
  const registry = {
    session,
    display_name: session,
    workspace,
    cwd: workspace,
    nodes: {
      lead: { name: "lead", agent: "claude", role: "orchestrator", status: "external", kind: "meta", tmux_pane: `${session}:1.0`, session_id: "s-lead" },
      worker: { name: "worker", agent: "codex", role: "maker", status: "idle", parent: "lead", tmux_pane: `${session}:1.1`, session_id: "s-worker" },
    },
    ui_e2e_fixture: true,
  };
  const regPath = path.join(dir, "registry.json");
  writeFileSync(regPath, `${JSON.stringify(registry, null, 2)}\n`, "utf8");
  return regPath;
}

/**
 * Boot an isolated Tier-1 server serving the real SPA. Returns a context with
 * baseUrl, the operator token, seed ids, and an async teardown().
 */
export async function bootTier1({ session = "uie2e", readyTimeoutMs = 25_000, teamAuth = false, members = TEAM_MEMBERS, features = ["handoff", "quotas", "shared-access"] } = {}) {
  const tmp = mkdtempSync(path.join(tmpdir(), "grove-ui-e2e-"));
  const groveHome = path.join(tmp, "grove_home");
  const homeDir = path.join(tmp, "home");
  const dbPath = path.join(tmp, "board.db");
  mkdirSync(homeDir, { recursive: true });
  mkdirSync(groveHome, { recursive: true });
  writeRegistry(groveHome, session);
  const seedIds = seedBoard(dbPath, session);
  if (teamAuth) writeMembers(groveHome, session, members);

  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const env = { ...process.env, GROVE_HOME: groveHome, HOME: homeDir, GROVE_VIEWER_SESSION: session };
  for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY", "ANTIGRAVITY_API_KEY", "CLOUDFLARE_API_TOKEN", "SLACK_BOT_TOKEN"]) delete env[k];

  const args = ["-m", "grove_bridge.web_app", "--host", "127.0.0.1", "--port", String(port), "--dist-dir", distDir, "--board-db-path", dbPath, "--session", session];
  if (teamAuth) args.push("--team-auth");
  // Enable feature-gated mutation endpoints so the role-denial backdoor reaches
  // the operator gate (403) rather than the feature gate (404).
  if (features.includes("handoff")) args.push("--enable-handoff");
  if (features.includes("quotas")) args.push("--enable-quotas");
  if (features.includes("shared-access")) args.push("--shared-access", "--shared-join-role", "admin");

  let exited = false;
  let log = "";
  const child = spawn(python, args, { cwd: repoRoot, env, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", (d) => (log += d));
  child.stderr.on("data", (d) => (log += d));
  child.on("exit", () => (exited = true));

  const deadline = Date.now() + readyTimeoutMs;
  let ready = false;
  while (Date.now() < deadline) {
    if (exited) throw new Error(`tier1 server exited early:\n${log}`);
    try {
      const r = await fetch(`${baseUrl}/api/health`);
      await r.text();
      if (r.status === 200) {
        ready = true;
        break;
      }
    } catch {
      /* not up */
    }
    await sleep(150);
  }
  if (!ready) throw new Error(`tier1 server not ready:\n${log}`);

  const idx = await (await fetch(`${baseUrl}/`)).text();
  // In local-token mode the operator token is injected; in team-auth mode auth
  // is cookie-based (no usable injected token), so only require it when local.
  const token = idx.match(/window\.__GROVE_SESSION_TOKEN__ = "([^"]+)"/)?.[1] ?? "";
  if (!teamAuth && !token) throw new Error("tier1: failed to scrape session token from index");

  async function teardown() {
    try {
      if (!exited) {
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

  return { baseUrl, port, token, session, board: session, seedIds, groveHome, dbPath, tmp, teamAuth, members, teardown, serverLog: () => log };
}

/** Login a team member -> session cookie (name=value) + csrf token. */
export async function login(baseUrl, name, secret) {
  const res = await fetch(`${baseUrl}/api/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: baseUrl },
    body: JSON.stringify({ name, secret }),
  });
  const setCookie = String(res.headers.get("set-cookie") || "").split(";")[0];
  const json = await res.json().catch(() => null);
  const eq = setCookie.indexOf("=");
  return {
    ok: res.ok,
    status: res.status,
    cookie: setCookie,
    cookieName: eq > 0 ? setCookie.slice(0, eq) : TEAM_SESSION_COOKIE,
    cookieValue: eq > 0 ? setCookie.slice(eq + 1) : "",
    csrf: json?.csrf ?? "",
    member: json?.member ?? null,
  };
}

/**
 * Issue a real Tier-1 role session. team-auth mode -> log in as the viewer /
 * operator / admin member (cookie + csrf). local-token mode -> operator only.
 * Returns { available:false, reason } when a role genuinely cannot be issued —
 * the runner records that as a FAIL/coverage-gap, never a green skip.
 */
export async function roleSession(ctx, role) {
  if (ctx.teamAuth) {
    const member = ctx.members.find((m) => m.role === role);
    if (!member) return { role, available: false, reason: `no team member seeded for role ${role}` };
    const session = await login(ctx.baseUrl, member.name, member.secret);
    if (!session.ok || !session.cookieValue) {
      return { role, available: false, reason: `login failed for ${role}: HTTP ${session.status}` };
    }
    return {
      role,
      available: true,
      cookieName: session.cookieName,
      cookieValue: session.cookieValue,
      cookie: session.cookie,
      csrf: session.csrf,
      headers: { Cookie: session.cookie, "X-Grove-CSRF": session.csrf },
    };
  }
  if (role === "operator") return { role, available: true, token: ctx.token, headers: { "X-Grove-Session-Token": ctx.token } };
  return { role, available: false, reason: "local-token boot exposes operator only; use teamAuth:true for the role matrix" };
}
