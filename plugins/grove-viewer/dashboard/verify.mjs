// Headless render check: drive the system Chrome against the mock harness and
// assert the production bundle actually mounts, lists nodes, and streams the
// mock tmux output into xterm.js. Writes mock/verify-screenshot.png.
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import puppeteer from "puppeteer-core";

const root = path.dirname(fileURLToPath(import.meta.url));
const htmlPath = path.join(root, "mock", "index.html");

function findChrome() {
  return [
    process.env.CHROME_PATH,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
  ]
    .filter(Boolean)
    .find((p) => existsSync(p));
}

async function main() {
  if (!existsSync(path.join(root, "dist", "index.js"))) {
    throw new Error("dist/index.js missing — run `npm run build` first");
  }
  const executablePath = findChrome();
  if (!executablePath) throw new Error("no Chrome/Chromium found; set CHROME_PATH");

  const browser = await puppeteer.launch({
    executablePath,
    headless: true,
    args: ["--no-sandbox", "--disable-gpu"],
  });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 2 });

    const errors = [];
    page.on("pageerror", (e) => errors.push("pageerror: " + String(e)));
    page.on("console", (m) => {
      if (m.type() !== "error") return;
      const t = m.text();
      if (/Failed to load resource|net::|fonts\.googleapis/.test(t)) return; // ignore offline font/resource noise
      errors.push("console: " + t);
    });

    await page.goto("file://" + htmlPath, { waitUntil: "load" });

    await page.waitForSelector(".grove-viewer", { timeout: 8000 });
    await page.waitForFunction(() => document.querySelectorAll(".gv-node").length >= 1, { timeout: 8000 });
    await page.waitForSelector(".xterm", { timeout: 8000 });
    await page.waitForFunction(
      () => (document.querySelector(".xterm")?.textContent ?? "").includes("mock stream"),
      { timeout: 8000 },
    );

    const diag = await page.evaluate(() => {
      const w = window;
      return {
        nodes: document.querySelectorAll(".gv-node").length,
        selected: document.querySelectorAll(".gv-node.is-selected").length,
        conn: (document.querySelector(".gv-conn")?.textContent ?? "").trim(),
        chips: document.querySelectorAll(".gv-chip").length,
        boardLink: document.querySelector(".gv-strip__link")?.getAttribute("href") ?? "",
        termChars: (document.querySelector(".xterm")?.textContent ?? "").trim().length,
        // Gated WS-auth assertions (window.__LEGACY_AUTH_REQUIRED__ = true):
        ticketMethod: w.__WS_TICKET_METHOD__ ?? "",
        wsUrl: w.__WS_URL__ ?? "",
      };
    });

    const shot = path.join(root, "mock", "verify-screenshot.png");
    await page.screenshot({ path: shot });

    const ticketOk = diag.ticketMethod === "POST" && /[?&]ticket=mock-ticket-123(?:&|$)/.test(diag.wsUrl);
    const ok =
      diag.nodes >= 1 &&
      diag.selected === 1 &&
      diag.chips >= 1 &&
      diag.termChars > 20 &&
      ticketOk &&
      errors.length === 0;

    if (!ok) {
      if (errors.length) console.error(errors.join("\n"));
      throw new Error("assertions failed: " + JSON.stringify(diag));
    }

    console.log("VERIFY PASS " + JSON.stringify(diag));
    console.log("screenshot: " + shot);
  } finally {
    await browser.close();
  }
}

main().catch((e) => {
  console.error("VERIFY FAIL: " + e.message);
  process.exit(1);
});
