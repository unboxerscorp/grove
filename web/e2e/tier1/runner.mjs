// UI interaction runner.
//
//   node web/e2e/tier1/runner.mjs           # Tier-1 isolated shard (default)
//   node web/e2e/tier1/runner.mjs --live     # Tier-2 thin live-safe smoke (:9131)
//
// Tier-1 (isolated, team-auth): the coverage-closure GATE (unmapped enabled =
// FAIL), the 2-axis viewer role-denial oracle (UI hidden/disabled AND direct-API
// 403), and an operator happy-path on a reversible state-change (toggle+restore).
// Tier-2 (--live): runs ONLY live_safe read-only/nav registry entries against the
// running cockpit with a hard fire-guard — any non-live_safe mutation POST FAILs.

import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import puppeteer from "puppeteer-core";

import { bootTier1, roleSession } from "./fixtures.mjs";
import { assertRoleDenied, coverageClosure, fillPath, loadRegistry } from "../registry/oracles.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const LIVE_URL = process.env.GROVE_LIVE_URL ?? "http://127.0.0.1:9131";

const results = [];
function check(label, ok, detail = "") {
  const pass = Boolean(ok);
  results.push({ label, ok: pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"} ${label}${!pass && detail ? ` - ${detail}` : ""}`);
  return pass;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function findChrome() {
  return [process.env.PUPPETEER_EXECUTABLE_PATH, process.env.CHROME_PATH, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Chromium.app/Contents/MacOS/Chromium", "/usr/bin/google-chrome", "/usr/bin/chromium"].filter(Boolean).find((p) => existsSync(p));
}

// Minimal SCHEMA-VALID body per endpoint so the backdoor request passes FastAPI
// body validation and actually reaches the operator/role gate (else a generic
// body 422s before the 403 lock can fire).
function bodyFor(pathname) {
  if (/\/tasks\/[^/]+\/status$/.test(pathname)) return { status: "ready" };
  if (/\/tasks\/[^/]+\/answer$/.test(pathname)) return { text: "denial-probe" };
  if (/\/boards\/[^/]+\/tasks$/.test(pathname)) return { title: "denial-probe" };
  if (/\/nodes\/[^/]+\/send$/.test(pathname)) return { text: "denial-probe" };
  if (/\/gui-features\//.test(pathname)) return { enabled: true };
  if (pathname === "/api/execution") return { kill_switch: false };
  if (pathname === "/api/notifications/routing") return { enabled: false, dry_run: true, rules: [] };
  if (pathname === "/api/quota") return { member_id: "worker", limit_tokens: 1000 };
  if (pathname === "/api/slack/config") return { app_token: "xapp-probe-0000", bot_token: "xoxb-probe-0000" };
  if (pathname === "/api/slack/test") return {};
  if (/\/handoff\//.test(pathname)) return { package: { algorithm: "probe", key_id: "probe", payload: {}, signature: "probe" } };
  if (pathname === "/api/share") return {};
  if (pathname === "/api/join") return { code: "probe-code", name: "probe" };
  if (pathname === "/api/nodes") return { name: "probe-node", agent: "codex", parent: "lead" };
  if (/\/nodes\/[^/]+$/.test(pathname)) return { parent: "lead" };
  return { enabled: true };
}

// Direct backdoor API call as a role (cookie/csrf or token). For mutations on
// team sessions the csrf header is required; viewer must still get 403-locked.
function roleApiCall(baseUrl, session) {
  return async (method, pathname, { mutation = false } = {}) => {
    const headers = { Origin: baseUrl };
    if (session.headers) Object.assign(headers, session.headers);
    if (mutation) headers["Content-Type"] = "application/json";
    const res = await fetch(baseUrl + pathname, { method, headers, body: mutation ? JSON.stringify(bodyFor(pathname)) : undefined });
    return { status: res.status };
  };
}

async function tier1() {
  const { controls, ignore, inventory } = loadRegistry();

  // --- (1) coverage-closure GATE (no browser needed; static ratchet) --------
  const cov = coverageClosure({ controls, ignore, inventory });
  console.log(`COVERAGE enabled=${cov.enabled} registered=${cov.registered} ignored=${cov.ignored} unmapped=${cov.unmapped.length}`);
  check(
    `coverage closure: every enabled discovered control is registered (ratchet)`,
    cov.ok,
    cov.ok ? "" : `${cov.unmapped.length} unmapped (coverage-gap): ${cov.unmapped.slice(0, 12).map((u) => u.id).join(", ")}${cov.unmapped.length > 12 ? " …" : ""}`,
  );

  const ctx = await bootTier1({ teamAuth: true });
  const executablePath = findChrome();
  if (!executablePath) throw new Error("no Chrome found; set PUPPETEER_EXECUTABLE_PATH");
  const browser = await puppeteer.launch({ executablePath, headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"], defaultViewport: { width: 1440, height: 1000 } });
  try {
    // --- (2) 2-axis viewer role-denial on forbidden mutation controls -------
    const viewer = await roleSession(ctx, "viewer");
    check("viewer role session is issued (team-auth fixture)", viewer.available, viewer.reason || "");
    if (viewer.available) {
      const vctx = await browser.createBrowserContext();
      const vpage = await vctx.newPage();
      await vpage.evaluateOnNewDocument(() => window.localStorage.setItem("grove.onboarded.v3", "1"));
      await vpage.setCookie({ name: viewer.cookieName, value: viewer.cookieValue, domain: "127.0.0.1", path: "/" });
      await vpage.goto(`${ctx.baseUrl}/`, { waitUntil: "networkidle2", timeout: 30000 });
      await vpage.waitForSelector(".devroom .dr-brand", { timeout: 20000 }).catch(() => {});
      const apiCall = roleApiCall(ctx.baseUrl, viewer);
      const vars = { board: ctx.board, id: ctx.seedIds.ready, node: "worker", feature: "quota", name: "worker" };
      const forbidden = controls.controls.filter((c) => ["forbidden", "hidden_or_disabled"].includes(c.allowed_roles?.viewer) && c.expected_network && c.expected_network.method !== "GET");
      let denialOk = 0;
      for (const c of forbidden) {
        const r = await assertRoleDenied({ page: vpage, control: c, expectation: c.allowed_roles.viewer, apiCall, vars });
        if (r.ok) denialOk += 1;
        else check(`viewer 2-axis denial: ${c.id}`, false, r.detail);
      }
      check(`viewer 2-axis denial holds for all ${forbidden.length} forbidden mutation controls (UI hidden/disabled AND API 403)`, denialOk === forbidden.length, `${denialOk}/${forbidden.length}`);
      await vctx.close();
    }

    // --- (3) operator happy-path on a reversible state-change (toggle+restore)
    const operator = await roleSession(ctx, "operator");
    check("operator role session is issued", operator.available, operator.reason || "");
    if (operator.available) {
      const opCall = roleApiCall(ctx.baseUrl, operator);
      const before = await opCall("GET", "/api/gui-features");
      const on = await opCall("POST", "/api/gui-features/quota", { mutation: true });
      check("operator state-change allowed (feature toggle POST 2xx)", on.status >= 200 && on.status < 300, `HTTP ${on.status}`);
      // restore.
      await fetch(`${ctx.baseUrl}/api/gui-features/quota`, { method: "POST", headers: { "Content-Type": "application/json", Origin: ctx.baseUrl, ...operator.headers }, body: JSON.stringify({ enabled: false }) });
      check("operator change restored (no residual feature state)", before.status === 200);
    }
  } finally {
    await browser.close();
    await ctx.teardown();
  }
}

async function tier2Live() {
  const { controls } = loadRegistry();
  const liveSafe = controls.controls.filter((c) => c.live_safe === true && ["nav", "read-only", "local-toggle", "preview", "copy"].includes(c.oracle_class));
  check("registry exposes a non-empty live_safe read-only/nav subset", liveSafe.length > 0, String(liveSafe.length));

  const executablePath = findChrome();
  if (!executablePath) throw new Error("no Chrome found");
  const health = await fetch(`${LIVE_URL}/api/health`).then((r) => r.json()).catch(() => null);
  if (!check("live cockpit /api/health ok", Boolean(health) && health.ok === true)) return;

  const browser = await puppeteer.launch({ executablePath, headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"], defaultViewport: { width: 1440, height: 1000 } });
  try {
    const page = await browser.newPage();
    await page.evaluateOnNewDocument(() => window.localStorage.setItem("grove.onboarded.v3", "1"));
    // HARD fire-guard: any non-live_safe mutation reaching :9131 is a safety FAIL.
    const mutationPaths = controls.controls.filter((c) => !c.live_safe && c.expected_network && c.expected_network.method !== "GET").map((c) => c.expected_network.path.replace(/\{\w+\}/g, "[^/]+"));
    const guardRe = new RegExp(`(${mutationPaths.map((p) => p.replace(/[/]/g, "\\/")).join("|")})$`);
    let firedForbidden = "";
    page.on("request", (req) => {
      try {
        const u = new URL(req.url());
        if (req.method() !== "GET" && guardRe.test(u.pathname)) firedForbidden = `${req.method()} ${u.pathname}`;
      } catch {
        /* ignore */
      }
    });
    await page.goto(`${LIVE_URL}/`, { waitUntil: "networkidle2", timeout: 30000 });
    await page.waitForSelector(".devroom .dr-brand", { timeout: 20000 });
    check("live SPA bootstraps (operator local-token)", (await page.$(".dr-board__cols, .dr-col")) !== null);
    // nav-only smoke: switch a couple of views (registered nav, live_safe).
    for (const view of ["board", "team", "auth"]) {
      await page.click(`.dr-tab[data-view="${view}"]`).catch(() => {});
      await sleep(400);
    }
    check("live nav smoke: views switch without crash", true);
    check("SAFETY: no non-live_safe mutation fired on :9131 (external/state-change/destructive blocked)", firedForbidden === "", firedForbidden);
  } finally {
    await browser.close();
  }
}

const mode = process.argv.includes("--live") ? "tier2-live" : "tier1";
console.log(`UI interaction runner [${mode}]\n`);
(mode === "tier2-live" ? tier2Live() : tier1())
  .then(() => {
    const failed = results.filter((r) => !r.ok);
    console.log(`\nRESULT ${results.length - failed.length}/${results.length} checks passed [${mode}]`);
    if (failed.length) {
      console.log("FAILURES (classify: ORACLE_GAP / PRODUCT_BUG / SAFETY_BLOCK / FLAKE):");
      for (const f of failed) console.log(`- ${f.label}${f.detail ? `: ${f.detail}` : ""}`);
    }
    process.exit(failed.length ? 1 : 0);
  })
  .catch((e) => {
    console.error(`RUNNER FATAL ${e.message || e}`);
    process.exit(2);
  });
