// Live browser e2e against the REAL grove web server.
//
// This intentionally targets the running cockpit at http://127.0.0.1:8765 and
// clicks the SPA like an operator. It creates only unique p2-live-* list items,
// avoids existing tasks, removes its own RUN_ID fixtures, and restores mutable
// GUI feature state in finally.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import puppeteer from "puppeteer-core";

const here = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(here, "..");
const artifactDir = path.join(webRoot, "e2e", "artifacts");

const BASE_URL = process.env.GROVE_LIVE_URL ?? "http://127.0.0.1:8765";
const REAL_PROJECT = "dev10";
const REAL_PROJECT_LABEL_RE = /grove-dev|dev10/i;
const TEST_PROJECT = process.env.GROVE_LIVE_TEST_PROJECT ?? "p2-test";
const TEST_PROJECT_LABEL_RE = new RegExp(TEST_PROJECT.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
const SWITCH_PROJECT = "base-voca";
const RUN_ID = `p2-live-${Date.now().toString(36)}`;
const TEST_TERMINAL_NODE = `p2-terminal-${RUN_ID.replace(/^p2-live-/, "")}`;
const HOST_TMUX_SOCKET = process.env.GROVE_LIVE_TMUX_SOCKET ?? "dev10";
const HOST_TMUX_SESSION = process.env.GROVE_LIVE_HOST_TMUX_SESSION ?? REAL_PROJECT;
const RAW_SECRET_RE =
  /\b(?:xox[baprs]-[A-Za-z0-9-]{8,}|xapp-[A-Za-z0-9-]{8,}|sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9]{20,})\b/;

const results = [];
const skips = [];
const httpEvents = [];
const apiEvents = [];
const pageErrors = [];
const consoleErrors = [];
let screenshotSeq = 0;

function chromePath() {
  const candidates = [
    process.env.PUPPETEER_EXECUTABLE_PATH,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
  ].filter(Boolean);
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) throw new Error("No Chrome executable found; set PUPPETEER_EXECUTABLE_PATH");
  return found;
}

function readJsonFile(file, fallback) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function tmuxArgs(args) {
  const socket = HOST_TMUX_SOCKET.trim();
  return socket ? ["-L", socket, ...args] : args;
}

function runTmux(args, { allowFail = false } = {}) {
  const result = spawnSync("tmux", tmuxArgs(args), { encoding: "utf8" });
  if (!allowFail && result.status !== 0) {
    throw new Error(`tmux ${args.join(" ")} failed: ${result.stderr || result.stdout || result.status}`);
  }
  return result;
}

function tmuxSessionExists(session) {
  return runTmux(["has-session", "-t", `${session}:`], { allowFail: true }).status === 0;
}

function ensureIsolatedTmuxPane() {
  if (process.env.GROVE_LIVE_TEST_TMUX_PANE) {
    return { pane: process.env.GROVE_LIVE_TEST_TMUX_PANE, createdSession: false, createdWindow: false };
  }

  if (!tmuxSessionExists(HOST_TMUX_SESSION)) {
    throw new Error(`host tmux session not found: ${HOST_TMUX_SESSION}`);
  }
  const windowResult = runTmux([
    "new-window",
    "-d",
    "-P",
    "-F",
    "#{session_name}:#{window_index}.#{pane_index}",
    "-t",
    `${HOST_TMUX_SESSION}:`,
    "-n",
    "live-e2e",
    "printf 'p2 live terminal fixture ready\\n'; exec zsh -f",
  ]);
  const pane = windowResult.stdout.trim();
  if (!pane) throw new Error("tmux new-window did not return a pane target");
  return { pane, createdSession: false, createdWindow: true };
}

function cleanupIsolatedTmuxPane(fixture) {
  if (!fixture || process.env.GROVE_LIVE_TEST_TMUX_PANE) return;
  if (fixture.createdSession) {
    runTmux(["kill-session", "-t", `${TEST_PROJECT}:`], { allowFail: true });
  } else if (fixture.createdWindow) {
    runTmux(["kill-window", "-t", fixture.pane], { allowFail: true });
  }
}

function cleanupIsolatedRegistryFixture(fixture) {
  const registryPath = typeof fixture === "string" ? fixture : fixture?.registryPath;
  if (!registryPath) return;
  const registry = readJsonFile(registryPath, null);
  if (!registry || typeof registry !== "object" || registry.live_e2e_fixture !== true) return;
  const previousRegistryText = typeof fixture === "object" ? fixture.previousRegistryText : null;
  if (previousRegistryText !== null && previousRegistryText !== undefined) {
    const tmp = `${registryPath}.${process.pid}.restore.tmp`;
    writeFileSync(tmp, previousRegistryText, "utf8");
    renameSync(tmp, registryPath);
    return;
  }
  const projectDir = typeof fixture === "object" ? fixture.projectDir : path.dirname(registryPath);
  const groveHome = process.env.GROVE_HOME ?? path.join(homedir(), ".grove");
  const resolvedProject = path.resolve(projectDir);
  const resolvedHome = path.resolve(groveHome);
  if (resolvedProject === resolvedHome || !resolvedProject.startsWith(`${resolvedHome}${path.sep}`)) return;
  rmSync(resolvedProject, { recursive: true, force: true });
}

function sqlQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function liveBoardDbPath() {
  const explicit = process.env.GROVE_LIVE_BOARD_DB_PATH ?? process.env.GROVE_BOARD_DB;
  if (explicit?.trim()) return path.resolve(explicit.trim());
  const groveHome = process.env.GROVE_HOME ?? path.join(homedir(), ".grove");
  return path.join(groveHome, "boards", "board.db");
}

function cleanupLiveE2eBoardFixtures(runId) {
  const dbPath = liveBoardDbPath();
  if (!existsSync(dbPath)) {
    console.log(`LIVE_E2E_CLEANUP_SKIP board-db-missing ${dbPath}`);
    return;
  }
  const sql = `
PRAGMA busy_timeout=5000;
BEGIN IMMEDIATE;
CREATE TEMP TABLE live_e2e_cleanup_tasks(id TEXT PRIMARY KEY);
INSERT INTO live_e2e_cleanup_tasks(id)
  SELECT tasks.id
  FROM tasks
  JOIN boards ON boards.id = tasks.board_id
  WHERE boards.slug = ${sqlQuote(TEST_PROJECT)}
    AND tasks.title LIKE ${sqlQuote(`${runId}%`)};
SELECT 'LIVE_E2E_CLEANUP matched=' || COUNT(*) FROM live_e2e_cleanup_tasks;
DELETE FROM decision_dispatch_locks WHERE task_id IN (SELECT id FROM live_e2e_cleanup_tasks);
DELETE FROM deps WHERE parent_id IN (SELECT id FROM live_e2e_cleanup_tasks) OR child_id IN (SELECT id FROM live_e2e_cleanup_tasks);
DELETE FROM notify_subs WHERE task_id IN (SELECT id FROM live_e2e_cleanup_tasks);
DELETE FROM slack_threads WHERE task_id IN (SELECT id FROM live_e2e_cleanup_tasks);
DELETE FROM comments WHERE task_id IN (SELECT id FROM live_e2e_cleanup_tasks);
DELETE FROM runs WHERE task_id IN (SELECT id FROM live_e2e_cleanup_tasks);
DELETE FROM events WHERE task_id IN (SELECT id FROM live_e2e_cleanup_tasks);
DELETE FROM tasks WHERE id IN (SELECT id FROM live_e2e_cleanup_tasks);
DELETE FROM boards
  WHERE slug = ${sqlQuote(TEST_PROJECT)}
    AND NOT EXISTS (SELECT 1 FROM tasks WHERE tasks.board_id = boards.id);
DROP TABLE live_e2e_cleanup_tasks;
COMMIT;
`;
  const result = spawnSync("sqlite3", [dbPath, sql], { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`live e2e board fixture cleanup failed: ${result.stderr || result.stdout || result.status}`);
  }
  const summary = result.stdout.trim() || "LIVE_E2E_CLEANUP matched=0";
  console.log(summary);
}

function ensureIsolatedProjectFixture() {
  const tmuxFixture = ensureIsolatedTmuxPane();
  const groveHome = process.env.GROVE_HOME ?? path.join(homedir(), ".grove");
  const projectDir = path.join(groveHome, TEST_PROJECT);
  const workspace = path.join(projectDir, "workspace");
  const registryPath = path.join(projectDir, "registry.json");
  const previousRegistryText = existsSync(registryPath) ? readFileSync(registryPath, "utf8") : null;
  mkdirSync(workspace, { recursive: true });

  const existing = readJsonFile(registryPath, {});
  const registry = existing && typeof existing === "object" && !Array.isArray(existing) ? existing : {};
  const rawNodes = registry.nodes && typeof registry.nodes === "object" && !Array.isArray(registry.nodes) ? registry.nodes : {};
  const nodes = { ...rawNodes };
  delete nodes["project-master"];
  nodes.lead = {
    ...(typeof nodes.lead === "object" && nodes.lead ? nodes.lead : {}),
    name: "lead",
    agent: "claude",
    role: "orchestrator",
    status: "external",
    kind: "meta",
    description: "Isolated live-e2e lead.",
  };
  nodes[TEST_TERMINAL_NODE] = {
    ...(typeof nodes[TEST_TERMINAL_NODE] === "object" && nodes[TEST_TERMINAL_NODE] ? nodes[TEST_TERMINAL_NODE] : {}),
    name: TEST_TERMINAL_NODE,
    agent: "codex",
    role: "worker",
    status: "idle",
    parent: "lead",
    tmux_pane: tmuxFixture.pane,
    description: "Disposable terminal pane for isolated live-e2e node input.",
  };

  const next = {
    ...registry,
    session: TEST_PROJECT,
    tmuxSession: HOST_TMUX_SESSION,
    display_name: TEST_PROJECT,
    workspace,
    cwd: workspace,
    nodes,
    live_e2e_fixture: true,
  };
  const tmp = `${registryPath}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  renameSync(tmp, registryPath);
  return { registryPath, projectDir, previousRegistryText, tmuxFixture };
}

function redacted(value) {
  return String(value ?? "")
    .replace(RAW_SECRET_RE, (m) => `${m.slice(0, 5)}...[redacted]`)
    .slice(0, 500);
}

function safeJson(value) {
  try {
    return redacted(JSON.stringify(value));
  } catch {
    return redacted(String(value));
  }
}

function hasRawSecret(value) {
  return RAW_SECRET_RE.test(typeof value === "string" ? value : JSON.stringify(value ?? null));
}

function check(label, ok, detail = "") {
  const pass = Boolean(ok);
  results.push({ label, ok: pass, detail: redacted(detail) });
  console.log(`${pass ? "PASS" : "FAIL"} ${label}${pass || !detail ? "" : ` - ${redacted(detail)}`}`);
  return pass;
}

function assertCheck(label, ok, detail = "") {
  if (!check(label, ok, detail)) throw new Error(`${label}${detail ? `: ${redacted(detail)}` : ""}`);
}

function skip(label, detail) {
  skips.push({ label, detail });
  console.log(`SKIP ${label} - ${detail}`);
}

function slug(s) {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 64) || "step"
  );
}

function attr(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function taskSelector(taskId) {
  return `.dr-card[data-task="${attr(taskId)}"]`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function screenshot(page, label) {
  mkdirSync(artifactDir, { recursive: true });
  screenshotSeq += 1;
  const file = path.join(artifactDir, `${String(screenshotSeq).padStart(2, "0")}-${slug(label)}.png`);
  await page.screenshot({ path: file, fullPage: true });
  console.log(`SCREENSHOT ${file}`);
}

async function runStep(page, label, fn) {
  console.log(`\nSTEP ${label}`);
  try {
    await fn();
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    check(`step failed: ${label}`, false, detail);
    try {
      await screenshot(page, `failed-${label}`);
    } catch (shotErr) {
      console.log(`SCREENSHOT_FAILED ${redacted(shotErr instanceof Error ? shotErr.message : String(shotErr))}`);
    }
  }
}

function apiMatcher({ path: pathname, method = "GET" }) {
  return (response) => {
    try {
      const url = new URL(response.url());
      return url.origin === BASE_URL && url.pathname === pathname && response.request().method() === method;
    } catch {
      return false;
    }
  };
}

async function waitForApi(page, spec, timeout = 20_000) {
  return page.waitForResponse(apiMatcher(spec), { timeout });
}

async function responseJson(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

async function apiFetch(page, pathname, { method = "GET", project = TEST_PROJECT, body } = {}) {
  return page.evaluate(
    async ({ pathname: innerPath, method: innerMethod, project: innerProject, body: innerBody }) => {
      const headers = {};
      const token = window.__GROVE_SESSION_TOKEN__ ?? "";
      if (token) headers["X-Grove-Session-Token"] = token;
      if (innerProject) headers["X-Grove-Project"] = innerProject;
      if (innerBody !== undefined) headers["Content-Type"] = "application/json";
      const response = await fetch(innerPath, {
        method: innerMethod,
        headers,
        credentials: "same-origin",
        body: innerBody === undefined ? undefined : JSON.stringify(innerBody),
      });
      const text = await response.text();
      let json = null;
      try {
        json = JSON.parse(text);
      } catch {
        // non-JSON is returned as text
      }
      return { ok: response.ok, status: response.status, json, text };
    },
    { pathname, method, project, body },
  );
}

async function waitForApp(page) {
  await page.waitForSelector(".devroom .dr-brand", { visible: true, timeout: 25_000 });
  await page.waitForSelector(".proj-switcher__btn", { visible: true, timeout: 25_000 });
  await page.waitForSelector(".dr-board__cols", { timeout: 25_000 });
}

async function nav(page, view) {
  await page.waitForSelector(`.dr-tab[data-view="${view}"]`, { visible: true, timeout: 15_000 });
  await page.click(`.dr-tab[data-view="${view}"]`);
  await sleep(250);
}

async function selectProject(page, projectName, expectedRe = null) {
  await page.waitForSelector(".proj-switcher__btn", { visible: true, timeout: 15_000 });
  await page.click(".proj-switcher__btn");
  await page.waitForSelector(`.proj-item[data-project="${attr(projectName)}"]`, { visible: true, timeout: 15_000 });
  await page.click(`.proj-item[data-project="${attr(projectName)}"]`);
  await page.waitForFunction(
    ({ expected, project }) => {
      const label = document.querySelector(".proj-switcher__name")?.textContent?.trim() ?? "";
      if (expected) return new RegExp(expected, "i").test(label);
      return label.includes(project);
    },
    { timeout: 15_000 },
    { expected: expectedRe?.source ?? null, project: projectName },
  );
  await sleep(800);
}

async function textContent(page, selector) {
  return page.$eval(selector, (el) => el.textContent?.trim() ?? "");
}

async function fillField(page, selector, value) {
  await page.waitForSelector(selector, { visible: true, timeout: 15_000 });
  await page.click(selector, { clickCount: 3 });
  await page.keyboard.press("Backspace");
  if (value) await page.keyboard.type(value, { delay: 2 });
}

async function chooseAssignee(page) {
  const assignee = await page.$$eval(".dr-addform__assignee option", (options) => {
    const values = options.map((option) => option.value).filter(Boolean);
    return values.find((value) => value === "lead") ?? values[0] ?? "";
  });
  assertCheck("add task form has an assignee candidate", Boolean(assignee));
  await page.select(".dr-addform__assignee", assignee);
  return assignee;
}

async function createTaskViaUi(page, { title, body, status = "ready" }) {
  await nav(page, "board");
  const listKey = status === "ask_human" ? "ask_human" : "todo";
  await page.waitForSelector(`.dr-col[data-col="${listKey}"] .dr-col__add`, { visible: true, timeout: 15_000 });
  await page.click(`.dr-col[data-col="${listKey}"] .dr-col__add`);
  await fillField(page, ".dr-addform__title", title);
  await fillField(page, ".dr-addform__body", body);
  await chooseAssignee(page);
  const statusOptions = await page.$$eval('.dr-addform select[name="status"] option', (options) =>
    options.map((option) => option.value),
  );
  if (statusOptions.includes(status)) await page.select('.dr-addform select[name="status"]', status);
  await page.select('.dr-addform select[name="priority"]', "normal");

  const responsePromise = waitForApi(page, { path: "/api/boards/default/tasks", method: "POST" });
  await page.click(".dr-addform__submit");
  const response = await responsePromise;
  const json = await responseJson(response);
  assertCheck("list item POST returns 2xx", response.ok(), `HTTP ${response.status()} ${safeJson(json)}`);
  assertCheck("list item POST returns item id", typeof json?.id === "string", safeJson(json));
  await page.waitForSelector(taskSelector(json.id), { visible: true, timeout: 15_000 });
  check("new task card appears in board DOM", true, json.id);
  return json;
}

async function transitionTask(page, taskId, toStatus, expectedRawStatus = toStatus) {
  const selector = `${taskSelector(taskId)} .dr-card__status`;
  await page.waitForSelector(selector, { visible: true, timeout: 15_000 });
  const responsePromise = waitForApi(page, { path: `/api/tasks/${encodeURIComponent(taskId)}/status`, method: "PATCH" });
  await page.select(selector, toStatus);
  const response = await responsePromise;
  const json = await responseJson(response);
  assertCheck(`task status PATCH ${toStatus} returns 2xx`, response.ok(), `HTTP ${response.status()} ${safeJson(json)}`);
  assertCheck(`task API status is ${expectedRawStatus}`, json?.status === expectedRawStatus, safeJson(json));
  await page.waitForSelector(`${taskSelector(taskId)}[data-status="${attr(toStatus)}"]`, {
    visible: true,
    timeout: 15_000,
  });
  check(`task card moves to ${toStatus} column`, true, taskId);
  return json;
}

async function verifyTaskBodyEscaped(page, taskId) {
  await page.evaluate(() => {
    window.__p2LiveXss = 0;
  });
  await page.click(`${taskSelector(taskId)} .dr-card__open`);
  await page.waitForSelector(".dr-drawer__panel", { visible: true, timeout: 15_000 });
  await page.waitForSelector(".dr-drawer__body", { visible: true, timeout: 15_000 });
  const bodyText = await textContent(page, ".dr-drawer__body");
  const xss = await page.evaluate(() => window.__p2LiveXss === 1);
  check("item drawer renders body text", bodyText.includes("<img src=x"), bodyText);
  assertCheck("task body injection probe does not execute", !xss);
  await page.click(".dr-drawer__close");
  await page.waitForSelector(".dr-drawer__panel", { hidden: true, timeout: 10_000 }).catch(() => {});
}

async function ensureFeatureViaUi(page, feature, enabled) {
  await nav(page, "auth");
  const switchSelector = `.setup-feature[data-feature="${attr(feature)}"] .setup-switch`;
  await page.waitForSelector(switchSelector, { visible: true, timeout: 15_000 });
  const current = await page.$eval(switchSelector, (el) => el.getAttribute("data-enabled") === "1");
  check(`GUI feature ${feature} switch is visible`, true);
  if (current === enabled) {
    check(`GUI feature ${feature} already ${enabled ? "on" : "off"}`, true);
    return;
  }
  const responsePromise = waitForApi(page, {
    path: `/api/gui-features/${encodeURIComponent(feature)}`,
    method: "POST",
  });
  await page.click(switchSelector);
  const response = await responsePromise;
  const json = await responseJson(response);
  assertCheck(`GUI feature ${feature} toggle POST returns 2xx`, response.ok(), `HTTP ${response.status()} ${safeJson(json)}`);
  await page.waitForFunction(
    ({ selector, want }) => document.querySelector(selector)?.getAttribute("data-enabled") === (want ? "1" : "0"),
    { timeout: 10_000 },
    { selector: switchSelector, want: enabled },
  );
  check(`GUI feature ${feature} toggled ${enabled ? "on" : "off"} in DOM`, true);
}

async function restoreFeature(page, feature, enabled, project = TEST_PROJECT) {
  try {
    const response = await apiFetch(page, `/api/gui-features/${encodeURIComponent(feature)}`, {
      method: "POST",
      project,
      body: { enabled },
    });
    if (!response.ok) {
      console.log(`RESTORE_FAILED ${feature} HTTP ${response.status}`);
      return;
    }
    const verify = await apiFetch(page, "/api/gui-features", { project });
    const actual = verify.json?.features?.[feature]?.enabled === true;
    if (actual !== enabled) {
      console.log(`RESTORE_MISMATCH ${feature} wanted=${enabled ? "on" : "off"} actual=${actual ? "on" : "off"}`);
      return;
    }
    console.log(`RESTORE ${feature}=${enabled ? "on" : "off"}`);
  } catch (err) {
    console.log(`RESTORE_FAILED ${feature} ${redacted(err instanceof Error ? err.message : String(err))}`);
  }
}

function chooseInputCapableNode(nodes) {
  const fleet = new Set([
    "test-e2e-web",
    "test-py-bridge",
    "test-ts-core",
    "grove-qa",
    "verify-exec",
    "rev-codex-xcut",
    "rev-agy-core",
    "rev-agy-bridge",
    "rev-agy-sec",
    "grove-ts",
    "grove-infra",
  ]);
  return (
    nodes.find((node) => node.name === TEST_TERMINAL_NODE && node.terminal_allowed !== false && node.input_allowed !== false) ??
    nodes.find((node) => node.name === "a-py" && node.terminal_allowed !== false && node.input_allowed !== false) ??
    nodes.find(
      (node) =>
        node.terminal_allowed !== false &&
        node.input_allowed !== false &&
        !fleet.has(node.name) &&
        node.status !== "running",
    ) ??
    nodes.find((node) => node.terminal_allowed !== false && node.input_allowed !== false)
  );
}

async function pickNode(page, project = TEST_PROJECT) {
  let lastNodes = [];
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const response = await apiFetch(page, "/api/nodes", { project });
    assertCheck("/api/nodes returns 2xx", response.ok, `HTTP ${response.status}`);
    const nodes = Array.isArray(response.json) ? response.json : [];
    lastNodes = nodes;
    const target = chooseInputCapableNode(nodes);
    if (target) return target;
    await sleep(300);
  }
  const target = chooseInputCapableNode(lastNodes);
  assertCheck("input-capable terminal node is available", Boolean(target), safeJson(lastNodes.map((node) => node.name)));
  return target;
}

async function waitForNodeVisible(page, nodeName) {
  const selector = `.dr-node[data-node="${attr(nodeName)}"]`;
  try {
    await page.waitForSelector(selector, { visible: true, timeout: 20_000 });
    return;
  } catch {
    await page.reload({ waitUntil: "domcontentloaded", timeout: 30_000 });
    await waitForApp(page);
    await selectProject(page, TEST_PROJECT, TEST_PROJECT_LABEL_RE);
    await page.waitForSelector(selector, { visible: true, timeout: 20_000 });
  }
}

async function dev10LiveFixtures(page) {
  const response = await apiFetch(page, "/api/boards/default/tasks", { project: REAL_PROJECT });
  if (!response.ok || !Array.isArray(response.json)) {
    return { ok: false, detail: `HTTP ${response.status} ${safeJson(response.json ?? response.text)}`, items: [] };
  }
  const items = response.json.filter((task) => String(task?.title ?? "").startsWith("p2-live-"));
  return { ok: true, detail: safeJson(items.map((task) => ({ id: task.id, status: task.status, title: task.title }))), items };
}

async function closeDrawer(page, panelSelector) {
  if (await page.$(panelSelector)) {
    await page.click(`${panelSelector} .dr-drawer__close`);
    await page.waitForSelector(panelSelector, { hidden: true, timeout: 10_000 }).catch(() => {});
  }
}

async function closeBrowser(browser) {
  const browserProcess = typeof browser.process === "function" ? browser.process() : null;
  try {
    await Promise.race([
      browser.close(),
      sleep(5_000).then(() => {
        throw new Error("browser close timed out");
      }),
    ]);
  } catch (err) {
    console.log(`BROWSER_CLOSE_WARN ${redacted(err instanceof Error ? err.message : String(err))}`);
  } finally {
    if (browserProcess && browserProcess.exitCode === null && !browserProcess.killed) {
      browserProcess.kill("SIGKILL");
      await sleep(500);
    }
  }
}

async function main() {
  mkdirSync(artifactDir, { recursive: true });
  const fixture = ensureIsolatedProjectFixture();
  const { registryPath: fixtureRegistry, tmuxFixture } = fixture;
  console.log(`FIXTURE_PROJECT ${TEST_PROJECT} ${fixtureRegistry}`);
  console.log(`FIXTURE_TMUX ${tmuxFixture.pane} host=${HOST_TMUX_SESSION}`);
  const browser = await puppeteer.launch({
    executablePath: chromePath(),
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--window-size=1440,1100"],
    defaultViewport: { width: 1440, height: 1100, deviceScaleFactor: 1 },
  });
  const page = await browser.newPage();
  let originalNodeInput = null;
  let originalNodeInputProject = null;
  let boardCleanupError = null;

  page.on("pageerror", (err) => pageErrors.push(err.message));
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });
  page.on("response", (response) => {
    try {
      const url = new URL(response.url());
      if (url.origin === BASE_URL) {
        httpEvents.push({
          method: response.request().method(),
          path: url.pathname,
          status: response.status(),
        });
      }
      if (url.origin === BASE_URL && url.pathname.startsWith("/api/")) {
        apiEvents.push({
          method: response.request().method(),
          path: url.pathname,
          status: response.status(),
        });
      }
    } catch {
      // ignore non-standard URLs
    }
  });

  // Tier-2 HARD-BLOCK (Slack-spam / live-pollution lesson): external + destructive
  // mutations must NEVER reach the live cockpit server. Intercept and req.abort()
  // them; everything else (read-only/nav + the suite's bounded p2-test
  // state-changes) continues. Recorded in liveBlocked for the regression check.
  const liveBlocked = [];
  // External egress (slack send/save, node send) + destructive (kill-switch,
  // abort, despawn, delete) only. share/join/handoff/approve are internal,
  // cockpit-gated, and exercised read-only/validation-only by the suite — not
  // blocked (blocking them would break the disabled-state/validation steps).
  const LIVE_HARD_BLOCK_RE =
    /\/api\/(slack\/(test|config)|nodes\/[^/]+\/send|execution|tasks\/[^/]+\/(abort|despawn|delete))$/;
  await page.setRequestInterception(true);
  page.on("request", (req) => {
    let pathname = "";
    try {
      pathname = new URL(req.url()).pathname;
    } catch {
      /* non-standard url */
    }
    const method = req.method();
    if (method !== "GET" && method !== "HEAD" && LIVE_HARD_BLOCK_RE.test(pathname)) {
      liveBlocked.push(`${method} ${pathname}`);
      req.abort("blockedbyclient").catch(() => {});
      return;
    }
    req.continue().catch(() => {});
  });

  await page.evaluateOnNewDocument(() => {
    window.localStorage.setItem("grove.onboarded.v3", "1");
  });

  try {
    await runStep(page, "dashboard load and local-token auth", async () => {
      const response = await page.goto(BASE_URL, { waitUntil: "domcontentloaded", timeout: 30_000 });
      assertCheck("dashboard document returns 2xx", response?.ok(), `HTTP ${response?.status()}`);
      await waitForApp(page);
      const title = await page.title();
      check("dashboard title loads", /Grove/.test(title), title);
      const boot = await page.evaluate(() => ({
        token: window.__GROVE_SESSION_TOKEN__,
        authRequired: window.__GROVE_AUTH_REQUIRED__,
        authMode: window.__GROVE_AUTH_MODE__,
      }));
      assertCheck("session token is injected for loopback browser", typeof boot.token === "string" && boot.token.length > 20);
      check("auth required flag is injected", boot.authRequired === true, safeJson(boot));
      const me = await apiFetch(page, "/api/me", { project: TEST_PROJECT });
      assertCheck("/api/me returns 2xx", me.ok, `HTTP ${me.status} ${safeJson(me.json)}`);
      check("live role is operator-equivalent local-token", me.json?.auth_mode === "local-token" && me.json?.member === null, safeJson(me.json));
      skip("viewer browser role", "live cockpit is local-token; /api/share is disabled, so no real viewer cookie fixture is available");
      skip("admin browser role", "live cockpit is local-token; no real admin team session is exposed");
      const pollution = await dev10LiveFixtures(page);
      assertCheck("dev10 board has no p2-live fixtures before run", pollution.ok && pollution.items.length === 0, pollution.detail);
    });

    await runStep(page, "Tier-2 hard-block: external/destructive requests are aborted (no live egress)", async () => {
      const before = liveBlocked.length;
      // Deliberately attempt forbidden external/destructive mutations from page
      // context; the interceptor must req.abort() each BEFORE it reaches the live server.
      const probes = await page.evaluate(async () => {
        const targets = [
          ["nodeSend", "/api/nodes/worker/send", { text: "probe" }],
          ["slackTest", "/api/slack/test", {}],
          ["slackSave", "/api/slack/config", { app_token: "xapp-probe", bot_token: "xoxb-probe" }],
          ["execKill", "/api/execution", { kill_switch: true }],
        ];
        const out = {};
        for (const [k, p, body] of targets) {
          try {
            await fetch(p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
            out[k] = "reached-server";
          } catch {
            out[k] = "aborted";
          }
        }
        return out;
      });
      check(
        "external/destructive page requests are aborted before reaching the live server",
        Object.values(probes).every((v) => v === "aborted"),
        JSON.stringify(probes),
      );
      check(
        "hard-block recorded the aborted external/destructive requests (no egress)",
        liveBlocked.length >= before + 4,
        `${liveBlocked.length - before} blocked: ${liveBlocked.slice(before).join(", ")}`,
      );
    });

    await runStep(page, "project switch to isolated p2-test", async () => {
      await selectProject(page, TEST_PROJECT, TEST_PROJECT_LABEL_RE);
      await nav(page, "board");
      const label = await textContent(page, ".proj-switcher__name");
      check("project switcher shows isolated p2-test", TEST_PROJECT_LABEL_RE.test(label), label);
      const columns = await page.$$eval(".dr-col", (cols) => cols.map((col) => col.getAttribute("data-col")));
      check("board renders human-facing workflow lists", ["todo", "ask_human"].every((c) => columns.includes(c)), columns.join(","));
    });

    let lifecycleTaskId = "";
    await runStep(page, "board CRUD, status transitions, durability, injection safety", async () => {
      const injectionBody = '<img src=x onerror="window.__p2LiveXss=1"> p2 live body text';
      const injectionTitle = `${RUN_ID}-board-lifecycle <img src=x onerror="window.__p2LiveTitleXss=1">`;
      await page.evaluate(() => {
        window.__p2LiveTitleXss = 0;
      });
      const task = await createTaskViaUi(page, {
        title: injectionTitle,
        body: injectionBody,
        status: "ready",
      });
      lifecycleTaskId = task.id;
      const cardTitle = await textContent(page, `${taskSelector(lifecycleTaskId)} .dr-card__title`);
      const titleXss = await page.evaluate(() => window.__p2LiveTitleXss === 1);
      check("task card title renders injection text", cardTitle.includes("<img src=x"), cardTitle);
      assertCheck("task title injection probe does not execute", !titleXss);
      await verifyTaskBodyEscaped(page, lifecycleTaskId);
      await transitionTask(page, lifecycleTaskId, "running", "running");
      await transitionTask(page, lifecycleTaskId, "review", "review");
      await transitionTask(page, lifecycleTaskId, "done", "done");
      const apiTask = await apiFetch(page, `/api/tasks/${encodeURIComponent(lifecycleTaskId)}`, { project: TEST_PROJECT });
      check("done task is readable through API", apiTask.ok && apiTask.json?.status === "done", safeJson(apiTask.json));
      await page.reload({ waitUntil: "domcontentloaded", timeout: 30_000 });
      await waitForApp(page);
      await selectProject(page, TEST_PROJECT, TEST_PROJECT_LABEL_RE);
      await nav(page, "board");
      await page.waitForSelector(`${taskSelector(lifecycleTaskId)}[data-status="done"]`, { visible: true, timeout: 20_000 });
      check("done/soft-delete lane survives browser reload", true, lifecycleTaskId);
    });

    await runStep(page, "inbox blocked task answer journey", async () => {
      const task = await createTaskViaUi(page, {
        title: `${RUN_ID}-inbox-answer`,
        body: "Blocked for live browser answer path.",
        status: "ready",
      });
      await transitionTask(page, task.id, "blocked", "blocked");
      const inbox = await apiFetch(page, "/api/inbox", { project: TEST_PROJECT });
      assertCheck("/api/inbox returns blocked task", inbox.ok && Array.isArray(inbox.json?.items), safeJson(inbox.json));
      check("blocked task appears in inbox API", inbox.json.items.some((item) => item.task_id === task.id), safeJson(inbox.json.items));
      await page.click(".dr-navitem--inbox");
      await page.waitForSelector(`.inbox-item[data-task="${attr(task.id)}"]`, { visible: true, timeout: 15_000 });
      await fillField(page, `.inbox-item[data-task="${attr(task.id)}"] .inbox-answer__input`, "Answer from live browser e2e.");
      const responsePromise = waitForApi(page, { path: `/api/tasks/${encodeURIComponent(task.id)}/answer`, method: "POST" });
      await page.click(`.inbox-item[data-task="${attr(task.id)}"] .inbox-answer__submit`);
      const response = await responsePromise;
      const json = await responseJson(response);
      assertCheck("inbox answer POST returns 2xx", response.ok(), `HTTP ${response.status()} ${safeJson(json)}`);
      await page.waitForFunction(
        (id) => !document.querySelector(`.inbox-item[data-task="${id.replace(/"/g, '\\"')}"]`),
        { timeout: 15_000 },
        task.id,
      );
      const answered = await apiFetch(page, `/api/tasks/${encodeURIComponent(task.id)}`, { project: TEST_PROJECT });
      check("answered inbox task unblocks to ready", answered.ok && answered.json?.status === "ready", safeJson(answered.json));
      await page.click(".dr-drawer__close");
    });

    await runStep(page, "master chat live surface and history endpoint", async () => {
      await page.waitForSelector(".dr-mchat__fab", { visible: true, timeout: 15_000 });
      await page.click(".dr-mchat__fab");
      await page.waitForSelector(".dr-mchat__panel .dr-mchat__input", { visible: true, timeout: 15_000 });
      const history = await apiFetch(page, "/api/master/chat", { project: TEST_PROJECT });
      assertCheck("master chat history GET returns 2xx", history.ok, `HTTP ${history.status} ${safeJson(history.json)}`);
      check("master chat history payload contains messages array", Array.isArray(history.json?.messages), safeJson(history.json));
      await page.evaluate(() => {
        window.__p2LiveChatXss = 0;
      });
      await fillField(
        page,
        ".dr-mchat__input",
        'Summarize the current project board in one short sentence. <img src=x onerror="window.__p2LiveChatXss=1">',
      );
      const surface = await page.evaluate(() => ({
        panel: !!document.querySelector(".dr-mchat__panel"),
        input: document.querySelector(".dr-mchat__input")?.value ?? "",
        sendEnabled: !(document.querySelector(".dr-mchat__send")?.disabled ?? true),
        xssRan: window.__p2LiveChatXss === 1,
      }));
      check("master chat panel accepts typed prompt", surface.panel && surface.input.includes("<img src=x"), safeJson(surface));
      assertCheck("master chat typed prompt injection probe does not execute", !surface.xssRan, safeJson(surface));
      check("master chat send affordance enables for non-empty prompt", surface.sendEnabled, safeJson(surface));
      skip(
        "master chat live POST",
        "live e2e avoids reentrant self-call into the active grove-master; routed POST is covered by bridge regressions and mock verify",
      );
      await page.click(".dr-mchat__x");
      await page.waitForSelector(".dr-mchat__panel", { hidden: true, timeout: 10_000 });
    });

    await runStep(page, "Slack status and secret redaction", async () => {
      await selectProject(page, REAL_PROJECT, REAL_PROJECT_LABEL_RE);
      const status = await apiFetch(page, "/api/slack/config/status", { project: REAL_PROJECT });
      assertCheck("/api/slack/config/status returns 2xx", status.ok, `HTTP ${status.status}`);
      check("Slack status reports socket connection", status.json?.status === "socket_connected", safeJson(status.json));
      check("Slack routes direct chat to chat-master", status.json?.tokens?.default_node === "chat-master", safeJson(status.json));
      check("Slack status network payload does not expose raw tokens", !hasRawSecret(status.json), "raw token pattern present in /api/slack/config/status");
      check("Slack settings panel is not exposed in MVP sidebar", (await page.$('.dr-tab[data-view="integrations"]')) === null);
    });

    await runStep(page, "audit API remains healthy while drawer is hidden", async () => {
      const audit = await apiFetch(page, "/api/audit", { project: REAL_PROJECT });
      assertCheck("/api/audit returns 2xx", audit.ok, `HTTP ${audit.status} ${safeJson(audit.json)}`);
      assertCheck("/api/audit payload is a list", Array.isArray(audit.json?.items), safeJson(audit.json));
      check("audit drawer is not exposed in simplified cockpit", (await page.$(".dr-audit-btn")) === null);
      check("delegation chain drawer is not exposed in simplified cockpit", (await page.$(".dr-chain-btn")) === null);
    });

    await runStep(page, "legacy ops panels stay out of the default sidebar", async () => {
      const tabs = await page.$$eval(".dr-tab[data-view]", (items) => items.map((item) => item.getAttribute("data-view")));
      const hidden = ["integrations", "connect", "exec", "cost", "ledger", "insights", "trend", "agg", "handoff", "routing"];
      check("default sidebar hides legacy ops views", hidden.every((view) => !tabs.includes(view)), tabs.join(","));
      skip("legacy ops panel UI journey", "covered by isolated API/verify suites; hidden from the simplified default cockpit");
    });

    await runStep(page, "connect stays hidden from MVP surface", async () => {
      const tabs = await page.$$eval(".dr-tab[data-view]", (items) => items.map((item) => item.getAttribute("data-view")));
      check("connect is hidden from the default sidebar", !tabs.includes("connect"), tabs.join(","));
      check("connect panel markup is absent on the MVP dashboard", (await page.$(".connect")) === null);
    });

    await runStep(page, "terminal view, connect command, operator send", async () => {
      const masterConnect = await apiFetch(page, "/api/nodes/grove-master/connect", { project: REAL_PROJECT });
      assertCheck("grove-master connect API returns 2xx", masterConnect.ok, `HTTP ${masterConnect.status} ${safeJson(masterConnect.json)}`);
      check("grove-master connect uses SSH tmux attach", masterConnect.json?.mode === "ssh_tmux_attach", safeJson(masterConnect.json));
      check(
        "grove-master SSH attach command targets the master pane",
          typeof masterConnect.json?.commands?.ssh_attach === "string" &&
          masterConnect.json.commands.ssh_attach.includes("ssh ") &&
          masterConnect.json.commands.ssh_attach.includes("tmux -L dev10 select-pane -t dev10:0.0") &&
          masterConnect.json.commands.ssh_attach.includes("tmux -L dev10 attach -t dev10"),
        safeJson(masterConnect.json),
      );

      await selectProject(page, TEST_PROJECT, TEST_PROJECT_LABEL_RE);
      if (await page.$(".dr-mchat__panel")) {
        await page.click(".dr-mchat__x");
        await page.waitForSelector(".dr-mchat__panel", { hidden: true, timeout: 10_000 }).catch(() => {});
      }
      const featurePayload = await apiFetch(page, "/api/gui-features", { project: TEST_PROJECT });
      assertCheck("/api/gui-features returns 2xx", featurePayload.ok, `HTTP ${featurePayload.status}`);
      originalNodeInput = featurePayload.json?.features?.["node-input"]?.enabled === true;
      originalNodeInputProject = TEST_PROJECT;
      const node = await pickNode(page, TEST_PROJECT);
      check("input-capable terminal node is available", Boolean(node), safeJson(node));
      check("terminal send uses isolated p2-test node", node.name === TEST_TERMINAL_NODE, safeJson(node));

      await waitForNodeVisible(page, node.name);
      await page.click(`.dr-node[data-node="${attr(node.name)}"]`);
      await page.waitForFunction(
        (name) => document.querySelector(".dr-term__name")?.textContent?.trim() === name,
        { timeout: 15_000 },
        node.name,
      );
      await page.waitForFunction(
        () => {
          const conn = document.querySelector(".dr-conn");
          return conn?.classList.contains("is-live") || conn?.classList.contains("is-error");
        },
        { timeout: 30_000 },
      );
      const connClass = await page.$eval(".dr-conn", (el) => el.className);
      assertCheck("terminal websocket reaches live state", /\bis-live\b/.test(connClass), connClass);

      const connectPromise = waitForApi(page, { path: `/api/nodes/${encodeURIComponent(node.name)}/connect`, method: "GET" });
      await page.click(".dr-term__connect-btn");
      const connectResponse = await connectPromise;
      const connectJson = await responseJson(connectResponse);
      assertCheck("node connect API returns 2xx", connectResponse.ok(), `HTTP ${connectResponse.status()} ${safeJson(connectJson)}`);
      check("node connect is scoped to isolated p2-test pane", connectJson?.tmux_target === tmuxFixture.pane, safeJson(connectJson));
      await page.waitForSelector(".dr-term__connect-code", { visible: true, timeout: 10_000 });
      check("node connect command is rendered", (await textContent(page, ".dr-term__connect-code")).includes("tmux"));

      // SAFETY-BLOCK (BUG task_44c55f46756544ce98096fa50610812d): node send is an
      // external-effect control — firing it on the LIVE cockpit server violates the
      // agreed method (live = confirm-open/cancel only; real send success path is
      // Tier-1 mock/dry-run isolated-pane only). Assert the send UI is exposed,
      // type then CANCEL without submitting, and assert NO /api/nodes/*/send POST
      // occurs.
      await ensureFeatureViaUi(page, "node-input", true);
      await page.click(`.dr-node[data-node="${attr(node.name)}"]`);
      await page.waitForSelector(".dr-term__send-input", { visible: true, timeout: 15_000 });
      check("node send UI is exposed (input + button present)", (await page.$(".dr-term__send-btn")) !== null);
      let liveSendPosted = false;
      const sendGuard = (req) => {
        try {
          const u = new URL(req.url());
          if (req.method() === "POST" && /\/api\/nodes\/[^/]+\/send$/.test(u.pathname)) liveSendPosted = true;
        } catch {
          /* ignore */
        }
      };
      page.on("request", sendGuard);
      try {
        await fillField(page, ".dr-term__send-input", `${RUN_ID}-DRY-RUN (never sent on live)`);
        await page.click(".dr-term__send-input", { clickCount: 3 });
        await page.keyboard.press("Backspace"); // cancel: clear, do not submit
        await page.keyboard.press("Escape");
        await sleep(800);
      } finally {
        page.off("request", sendGuard);
      }
      check(
        "SAFETY-BLOCK: live node send is NOT fired (no /api/nodes/*/send POST) [task_44c55f46]",
        liveSendPosted === false,
        "a /api/nodes/*/send POST reached the live server — safety violation",
      );
    });

    await runStep(page, "project switch base-voca and back", async () => {
      const projects = await apiFetch(page, "/api/projects", { project: "" });
      assertCheck("/api/projects returns 2xx before optional switch", projects.ok, `HTTP ${projects.status}`);
      const available = Array.isArray(projects.json) ? projects.json.map((project) => project?.name).filter(Boolean) : [];
      if (!available.includes(SWITCH_PROJECT)) {
        skip(`project switch ${SWITCH_PROJECT}`, `project not present in this live host: ${available.join(",") || "(none)"}`);
        await selectProject(page, TEST_PROJECT, TEST_PROJECT_LABEL_RE);
        return;
      }
      await selectProject(page, SWITCH_PROJECT, new RegExp(SWITCH_PROJECT, "i"));
      const label = await textContent(page, ".proj-switcher__name");
      check("project switcher shows base-voca", new RegExp(SWITCH_PROJECT, "i").test(label), label);
      const nodes = await apiFetch(page, "/api/nodes", { project: SWITCH_PROJECT });
      check("base-voca nodes API is scoped and readable", nodes.ok && Array.isArray(nodes.json), `HTTP ${nodes.status}`);
      await selectProject(page, REAL_PROJECT, REAL_PROJECT_LABEL_RE);
      check("project switcher shows grove-dev/dev10", REAL_PROJECT_LABEL_RE.test(await textContent(page, ".proj-switcher__name")));
      await selectProject(page, TEST_PROJECT, TEST_PROJECT_LABEL_RE);
      check("project switcher returns to isolated p2-test", TEST_PROJECT_LABEL_RE.test(await textContent(page, ".proj-switcher__name")));
    });

    await runStep(page, "organization chart master and leads", async () => {
      await nav(page, "team");
      await selectProject(page, REAL_PROJECT, REAL_PROJECT_LABEL_RE);
      const liveOrg = await apiFetch(page, "/api/org", { project: REAL_PROJECT });
      assertCheck("live org API returns 2xx", liveOrg.ok, `HTTP ${liveOrg.status} ${safeJson(liveOrg.json)}`);
      check("live org default assignee is grove-master", liveOrg.json?.default_assignee === "grove-master", safeJson(liveOrg.json));
      check("live org root is grove-master", liveOrg.json?.master_org?.project_master?.name === "grove-master", safeJson(liveOrg.json));
      const orgNodes = Array.isArray(liveOrg.json?.nodes) ? liveOrg.json.nodes : [];
      const requiredNodes = ["grove-master", "web", "slack", "advisor"];
      check(
        "live org API exposes all runtime nodes",
        requiredNodes.every((name) => orgNodes.some((node) => node?.name === name)),
        safeJson(orgNodes),
      );
      check(
        "live org API exposes node metadata",
        orgNodes
          .filter((node) => requiredNodes.includes(node?.name))
          .every(
            (node) =>
              typeof node?.role === "string" &&
              node.role.length > 0 &&
              typeof node?.cwd === "string" &&
              node.cwd.length > 0 &&
              typeof node?.tmux_pane === "string" &&
              /^dev10:\d+\.\d+$/.test(node.tmux_pane) &&
              node.pane_exists === true,
          ),
        safeJson(orgNodes),
      );
      await nav(page, "team");
      await page.waitForSelector(".org-master, .master-org__root", { visible: true, timeout: 20_000 });
      const masterText = await page.evaluate(() => {
        const el = document.querySelector(".org-master") ?? document.querySelector(".master-org__root");
        return el?.textContent?.trim() ?? "";
      });
      check("org chart shows GROVE MASTER", /GROVE MASTER|MASTER/i.test(masterText), masterText);
      const leadProjects = await page.$$eval(".org-plead, .master-org__project", (items) =>
        items.map((item) => item.getAttribute("data-project") || item.textContent || "").filter(Boolean),
      );
      check("org chart shows project leads", leadProjects.some((item) => /dev10|grove-dev/i.test(item)), leadProjects.join(","));
    });

    await runStep(page, "sidebar and logo", async () => {
      const tabs = await page.$$eval(".dr-tab[data-view]", (items) => items.map((item) => item.getAttribute("data-view")));
      check("sidebar exposes MVP cockpit views", ["board", "team", "terminal", "auth"].every((view) => tabs.includes(view)), tabs.join(","));
      check("sidebar hides retired ops views", ["integrations", "connect", "exec", "cost", "ledger", "insights", "trend", "agg", "handoff", "routing"].every((view) => !tabs.includes(view)), tabs.join(","));
      check("command palette trigger is not exposed", (await page.$(".cmdk-trigger")) === null);
      check("audit drawer trigger is not exposed", (await page.$(".dr-audit-btn")) === null);
      check("inbox remains exposed for ask-human answers", (await page.$(".dr-navitem--inbox")) !== null);
      const logoLoaded = await page.$eval(".dr-brand .dr-mark__img", (img) => img.complete && img.naturalWidth > 0);
      check("Grove logo image loads", logoLoaded);
    });

    await runStep(page, "dev10 pollution guard after live mutations", async () => {
      const pollution = await dev10LiveFixtures(page);
      assertCheck("dev10 board has no p2-live fixtures after run", pollution.ok && pollution.items.length === 0, pollution.detail);
    });

    await screenshot(page, "live-final");
  } finally {
    if (originalNodeInput !== null) {
      await restoreFeature(page, "node-input", originalNodeInput, originalNodeInputProject ?? TEST_PROJECT);
    }
    try {
      await closeBrowser(browser);
    } finally {
      try {
        cleanupLiveE2eBoardFixtures(RUN_ID);
      } catch (err) {
        boardCleanupError = err;
        console.log(`LIVE_E2E_CLEANUP_FAILED ${redacted(err instanceof Error ? err.message : String(err))}`);
      }
      cleanupIsolatedTmuxPane(tmuxFixture);
      cleanupIsolatedRegistryFixture(fixture);
    }
  }

  if (boardCleanupError) throw boardCleanupError;

  check("no uncaught page exceptions", pageErrors.length === 0, pageErrors.join(" | "));
  const expected404Paths = new Set(["/api/share", "/api/join", "/api/summary", "/api/aggregate"]);
  const expected404Count = httpEvents.filter((event) => event.status === 404 && expected404Paths.has(event.path)).length;
  const unexpected404Events = httpEvents.filter((event) => event.status === 404 && !expected404Paths.has(event.path));
  check("no unexpected 404 responses during live journey", unexpected404Events.length === 0, safeJson(unexpected404Events));
  const expectedNoisy4xxPaths = new Set(["/api/share", "/api/join", "/api/summary", "/api/aggregate"]);
  let remainingExpected4xxConsole = httpEvents.filter(
    (event) => event.status >= 400 && event.status < 500 && expectedNoisy4xxPaths.has(event.path),
  ).length;
  const noisyConsole = consoleErrors.filter((line) => {
    if (/favicon/i.test(line)) return false;
    // Expected: the Tier-2 hard-block aborts external/destructive requests, which
    // surface as ERR_BLOCKED_BY_CLIENT console errors. These are the safety net
    // working as intended, not a defect.
    if (/ERR_BLOCKED_BY_CLIENT/.test(line)) return false;
    if (
      /Failed to load resource: the server responded with a status of (400|401|403|404)/.test(line) &&
      remainingExpected4xxConsole > 0
    ) {
      remainingExpected4xxConsole -= 1;
      return false;
    }
    return true;
  });
  check("no unexpected browser console errors", noisyConsole.length === 0, noisyConsole.join(" | "));
  const relevantServerErrors = apiEvents.filter((event) => event.status >= 500);
  check("no 5xx API responses during live journey", relevantServerErrors.length === 0, safeJson(relevantServerErrors));

  const passed = results.filter((result) => result.ok).length;
  const failed = results.filter((result) => !result.ok);
  console.log(`\nRESULT ${passed}/${results.length} checks passed`);
  if (skips.length) {
    console.log(`SKIPS ${skips.length}`);
    for (const item of skips) console.log(`- ${item.label}: ${item.detail}`);
  }
  if (failed.length) {
    console.log("FAILURES");
    for (const item of failed) console.log(`- ${item.label}${item.detail ? `: ${item.detail}` : ""}`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(`FATAL ${redacted(err instanceof Error ? err.stack || err.message : String(err))}`);
  process.exitCode = 1;
});
