// UI interaction inventory crawler (DISCOVERY ONLY — never clicks interactive
// controls). Boots an isolated Tier-1 server serving the real SPA, navigates
// every view/drawer (nav is the only allowed click — it is itself a registered
// nav oracle), and enumerates interactive elements into
// web/e2e/registry/button-inventory.json. This file is the *coverage
// denominator*: the runner FAILs any enabled interactive not in
// registry/controls.json ∪ registry/ignore-list.json (coverage ratchet).

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import puppeteer from "puppeteer-core";

import { bootTier1 } from "./tier1/fixtures.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(here, "registry", "button-inventory.json");

const VIEWS = ["board", "team", "terminal", "exec", "ledger", "trend", "insights", "integrations", "connect", "routing", "agg", "handoff", "cost", "auth"];
// Drawers/overlays reachable from global chrome (nav-class controls).
const DRAWERS = [
  { id: "inbox", open: ".dr-inbox-btn", panel: ".inbox-drawer, .dr-drawer" },
  { id: "audit", open: ".dr-audit-btn", panel: ".audit-drawer" },
  { id: "master-chat", open: ".dr-mchat__fab", panel: ".dr-mchat__panel" },
  { id: "command-palette", open: ".cmdk-trigger", panel: ".cmdk" },
  { id: "project-switcher", open: ".proj-switcher__btn", panel: ".proj-menu" },
];

function findChrome() {
  return [process.env.PUPPETEER_EXECUTABLE_PATH, process.env.CHROME_PATH, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Chromium.app/Contents/MacOS/Chromium", "/usr/bin/google-chrome", "/usr/bin/chromium"]
    .filter(Boolean)
    .find((p) => existsSync(p));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Enumerate interactive elements within a scope, in the browser context.
const ENUMERATE = (scopeSel) => {
  const root = document.querySelector(scopeSel) || document.body;
  const SEL = 'button, [role="button"], a[href], input[type="submit"], input[type="checkbox"], input[type="radio"], input[type="file"], select, textarea, [draggable="true"], [role="tab"], [role="switch"], [contenteditable="true"]';
  const norm = (s) => (s || "").replace(/\s+/g, " ").trim().slice(0, 60);
  const out = [];
  for (const el of root.querySelectorAll(SEL)) {
    const cls = (typeof el.className === "string" ? el.className : "").split(" ").filter(Boolean);
    const compClass = cls.find((c) => /__|--|-/.test(c)) || cls[0] || "";
    const name = norm(el.getAttribute("aria-label") || el.getAttribute("title") || el.getAttribute("placeholder") || el.value || el.textContent);
    const role = el.getAttribute("role") || el.tagName.toLowerCase();
    const disabled = Boolean(el.disabled) || el.getAttribute("aria-disabled") === "true";
    const stableHook = el.getAttribute("data-testid") || el.getAttribute("data-e2e") || el.getAttribute("data-action") || el.getAttribute("data-cmd") || "";
    out.push({ tag: el.tagName.toLowerCase(), role, name, compClass, classes: cls.slice(0, 3), disabled, stableHook });
  }
  return out;
};

async function main() {
  const ctx = await bootTier1();
  const executablePath = findChrome();
  if (!executablePath) throw new Error("no Chrome found; set PUPPETEER_EXECUTABLE_PATH");
  const browser = await puppeteer.launch({ executablePath, headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"], defaultViewport: { width: 1440, height: 1000 } });
  const inventory = [];
  let pageErrors = 0;
  try {
    const page = await browser.newPage();
    await page.evaluateOnNewDocument(() => window.localStorage.setItem("grove.onboarded.v3", "1"));
    page.on("pageerror", () => (pageErrors += 1));
    await page.goto(`${ctx.baseUrl}/`, { waitUntil: "networkidle2", timeout: 30000 });
    await page.waitForSelector(".devroom .dr-brand", { timeout: 20000 });

    // Global chrome (header/sidebar) — present in every view.
    for (const item of await page.evaluate(ENUMERATE, ".dr-top, .dr-rail, .dr-nav")) inventory.push({ view: "chrome", ...item });

    for (const view of VIEWS) {
      try {
        await page.click(`.dr-tab[data-view="${view}"]`);
        await sleep(500);
        for (const item of await page.evaluate(ENUMERATE, ".dr-stage")) inventory.push({ view, ...item });
      } catch {
        inventory.push({ view, tag: "(view)", role: "(unreachable)", name: "tab not reachable", compClass: "", classes: [], disabled: true, stableHook: "" });
      }
    }

    // Drawers/overlays (open via nav-class control, enumerate, close via Escape).
    for (const d of DRAWERS) {
      try {
        await page.click(d.open);
        await page.waitForSelector(d.panel.split(",")[0].trim(), { timeout: 4000 }).catch(() => {});
        await sleep(350);
        for (const item of await page.evaluate(ENUMERATE, d.panel.split(",")[0].trim())) inventory.push({ view: `drawer:${d.id}`, ...item });
        await page.keyboard.press("Escape");
        await sleep(200);
      } catch {
        inventory.push({ view: `drawer:${d.id}`, tag: "(drawer)", role: "(unreachable)", name: d.open, compClass: "", classes: [], disabled: true, stableHook: "" });
      }
    }
  } finally {
    await browser.close();
    await ctx.teardown();
  }

  // Stable id per control for coverage matching.
  const withIds = inventory.map((c) => ({
    id: `${c.view}::${c.compClass || c.tag}::${(c.name || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "(unnamed)"}`,
    ...c,
    needs_stable_hook: !c.stableHook,
  }));
  const enabled = withIds.filter((c) => !c.disabled && c.role !== "(unreachable)");
  const snapshot = {
    generated_for: "isolated Tier-1",
    counts: { total: withIds.length, enabled: enabled.length, needs_stable_hook: withIds.filter((c) => c.needs_stable_hook).length },
    page_errors_during_crawl: pageErrors,
    controls: withIds,
  };
  mkdirSync(path.dirname(OUT), { recursive: true });
  writeFileSync(OUT, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
  console.log(`INVENTORY ${OUT}`);
  console.log(`total=${snapshot.counts.total} enabled=${snapshot.counts.enabled} needs_stable_hook=${snapshot.counts.needs_stable_hook} page_errors=${pageErrors}`);
}

main().catch((e) => {
  console.error(`INVENTORY FATAL ${e.message || e}`);
  process.exit(2);
});
