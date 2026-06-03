// Headless render check: drive the system Chrome against the mock harness and
// assert the built SPA mounts, lists nodes + board cards, opens the task drawer
// (comments + runs), and streams terminal frames into xterm via the ws-ticket
// flow. Writes mock/verify-screenshot.png.
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
  if (!existsSync(path.join(root, "dist", "app.js"))) {
    throw new Error("dist/app.js missing — run `npm run build` first");
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
    await page.setViewport({ width: 1320, height: 860, deviceScaleFactor: 2 });

    const errors = [];
    page.on("pageerror", (e) => errors.push("pageerror: " + String(e)));
    page.on("console", (m) => {
      if (m.type() !== "error") return;
      const t = m.text();
      if (/Failed to load resource|net::|fonts\.googleapis/.test(t)) return;
      errors.push("console: " + t);
    });

    await page.goto("file://" + htmlPath, { waitUntil: "load" });

    // Shell + board (default view).
    await page.waitForSelector(".devroom .dr-brand", { timeout: 8000 });
    await page.waitForFunction(() => document.querySelectorAll(".dr-node").length >= 1, { timeout: 8000 });
    await page.waitForFunction(() => document.querySelectorAll(".dr-card").length >= 1, { timeout: 8000 });

    // #1 i18n: Korean by default; KO/EN toggle flips all labels, then back.
    const brandText = () => page.$eval(".dr-brand__title", (el) => (el.textContent ?? "").trim());
    const i18n = { ko: await brandText(), en: "" };
    await page.click('.dr-lang__btn[data-lang="en"]');
    await page.waitForFunction(
      () => (document.querySelector(".dr-brand__title")?.textContent ?? "").trim() === "Dev Room",
      { timeout: 5000 },
    );
    i18n.en = await brandText();
    await page.click('.dr-lang__btn[data-lang="ko"]');
    await page.waitForFunction(
      () => (document.querySelector(".dr-brand__title")?.textContent ?? "").trim() === "개발실",
      { timeout: 5000 },
    );

    // Capture board counts WHILE the board view is mounted.
    const board = await page.evaluate(() => ({
      columns: document.querySelectorAll(".dr-col").length,
      cards: document.querySelectorAll(".dr-card").length,
    }));

    // #3 add task: open the form, submit, expect a new card + a recorded POST.
    const NEW_TITLE = "QA verify task";
    await page.click(".dr-addbtn");
    await page.waitForSelector(".dr-addform", { timeout: 5000 });
    await page.type('.dr-addform input[name="title"]', NEW_TITLE);
    await page.click(".dr-addform__submit");
    await page.waitForFunction(
      (title) =>
        Array.from(document.querySelectorAll(".dr-card__title")).some((el) =>
          (el.textContent ?? "").includes(title),
        ),
      { timeout: 8000 },
      NEW_TITLE,
    );
    const addTask = await page.evaluate(() => ({ created: window.__MOCK__?.createdTask ?? "" }));

    // Open the task drawer on the first card; assert comments + runs loaded.
    await page.click(".dr-card");
    await page.waitForSelector(".dr-drawer__panel", { timeout: 8000 });
    await page.waitForFunction(
      () =>
        document.querySelectorAll(".dr-run").length >= 1 &&
        document.querySelectorAll(".dr-comment").length >= 1,
      { timeout: 8000 },
    );
    const drawer = await page.evaluate(() => ({
      runs: document.querySelectorAll(".dr-run").length,
      comments: document.querySelectorAll(".dr-comment").length,
    }));

    // Close the task drawer.
    await page.click(".dr-drawer__close");
    await page.waitForFunction(() => !document.querySelector(".dr-drawer"), { timeout: 8000 });

    // Interactive org canvas: switch to the Team tab; assert the graph renders
    // (nodes, bezier edges, group legend).
    await page.click('.dr-tab[data-view="team"]');
    await page.waitForSelector(".org-node", { timeout: 8000 });
    await new Promise((r) => setTimeout(r, 650)); // let the entrance layout tween settle
    const orgView = await page.evaluate(() => ({
      nodes: document.querySelectorAll(".org-node").length,
      edges: document.querySelectorAll(".org-edge").length,
      legend: document.querySelectorAll(".org-legend__item").length,
    }));

    const center = async (name) =>
      page.$eval(`[data-name="${name}"]`, (el) => {
        const r = el.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      });
    const dragTo = async (name, toX, toY) => {
      const from = await center(name);
      await page.mouse.move(from.x, from.y);
      await page.mouse.down();
      const steps = 8;
      for (let i = 1; i <= steps; i++) {
        await page.mouse.move(from.x + ((toX - from.x) * i) / steps, from.y + ((toY - from.y) * i) / steps);
        await new Promise((r) => setTimeout(r, 22));
      }
      await page.mouse.up();
    };
    const settle = () => new Promise((r) => setTimeout(r, 520));

    // #1 drag-to-reparent: drop "frontend" onto "docs" -> PATCH {parent}.
    const docsC = await center("docs");
    await dragTo("frontend", docsC.x, docsC.y);
    await page.waitForFunction(() => (window.__MOCK__?.patchedParent ?? "") !== "", { timeout: 6000 });
    const patchedParent = await page.evaluate(() => window.__MOCK__?.patchedParent ?? "");
    await settle();

    // #2 proximity grouping: drag "backend" NEAR "researcher" (not over) -> PATCH {group}.
    const resC = await center("researcher");
    await dragTo("backend", resC.x + 132, resC.y);
    await page.waitForFunction(() => (window.__MOCK__?.patchedGroup ?? "") !== "", { timeout: 6000 });
    const patchedGroup = await page.evaluate(() => window.__MOCK__?.patchedGroup ?? "");
    await settle();

    // #3 hover-"+" add child: reveals a "+" on the node -> inline create -> POST.
    const PLUS_NODE = "child-x";
    await page.hover('[data-name="root"]');
    await page.click('[data-name="root"] .org-node__plus');
    await page.waitForSelector(".org-popover .node-form", { timeout: 5000 });
    await page.type('.org-popover input[name="name"]', PLUS_NODE);
    await page.click(".org-popover .node-form__submit");
    await page.waitForFunction(
      (nm) =>
        Array.from(document.querySelectorAll(".org-node__name")).some((el) =>
          (el.textContent ?? "").includes(nm),
        ),
      { timeout: 8000 },
      PLUS_NODE,
    );
    const plusCreated = await page.evaluate(() => window.__MOCK__?.createdNode ?? "");
    await settle();

    // hover action -> node info drawer (role/group/pane facts).
    await page.hover('[data-name="root"]');
    await page.click('[data-name="root"] .org-act--info');
    await page.waitForSelector(".node-drawer", { timeout: 5000 });
    const nodeDrawer = await page.evaluate(() => ({
      facts: document.querySelectorAll(".node-drawer .dr-fact").length,
      assignForm: !!document.querySelector(".node-drawer__assign"),
    }));
    await page.click(".node-drawer .dr-drawer__close");
    await page.waitForFunction(() => !document.querySelector(".node-drawer"), { timeout: 5000 });

    // hover action -> open this node's terminal ("터미널 열기").
    await page.hover('[data-name="root"]');
    await page.click('[data-name="root"] .org-act--term');
    await page.waitForSelector(".dr-term .xterm", { timeout: 8000 });

    // #2 terminal mirror: each snapshot carries an incrementing #marker. Wait
    // for one, let several more arrive, then assert exactly ONE marker remains —
    // proving the screen is replaced each frame, not appended.
    const xtermText = () =>
      page.evaluate(() => document.querySelector(".dr-term .xterm-rows")?.textContent ?? "");
    await page.waitForFunction(() => /#\d+/.test(document.querySelector(".dr-term .xterm-rows")?.textContent ?? ""), {
      timeout: 8000,
    });
    const firstSeq = Number((await xtermText()).match(/#(\d+)/)?.[1] ?? -1);
    await page.waitForFunction(
      (prev) => {
        const m = (document.querySelector(".dr-term .xterm-rows")?.textContent ?? "").match(/#(\d+)/);
        return !!m && Number(m[1]) >= prev + 2;
      },
      { timeout: 8000 },
      firstSeq,
    );
    const term = await page.evaluate(() => ({
      markerCount: ((document.querySelector(".dr-term .xterm-rows")?.textContent ?? "").match(/#\d+/g) ?? []).length,
    }));

    const diag = await page.evaluate(() => {
      const mock = window.__MOCK__ ?? {};
      return {
        nodes: document.querySelectorAll(".dr-node").length,
        conn: (document.querySelector(".dr-conn")?.textContent ?? "").trim(),
        termChars: (document.querySelector(".dr-term .xterm-rows")?.textContent ?? "").trim().length,
        ticketMethod: mock.ticketMethod ?? "",
        ticketHeader: mock.ticketHeader ?? "",
        terminalWsUrl: mock.terminalWsUrl ?? "",
        boardWsConnected: mock.boardWsConnected ?? false,
      };
    });

    const shot = path.join(root, "mock", "verify-screenshot.png");
    await page.screenshot({ path: shot });

    const wsOk =
      diag.ticketMethod === "POST" &&
      !!diag.ticketHeader &&
      /[?&]ticket=/.test(diag.terminalWsUrl) &&
      /[?&]pane_id=/.test(diag.terminalWsUrl) &&
      diag.boardWsConnected === true;

    const i18nOk = i18n.ko === "개발실" && i18n.en === "Dev Room";
    const addOk = addTask.created === NEW_TITLE;
    const mirrorOk = term.markerCount === 1; // no accumulation
    const teamOk =
      orgView.nodes >= 1 &&
      orgView.edges >= 1 &&
      orgView.legend >= 1 &&
      patchedParent.startsWith("frontend->") &&
      !!patchedGroup &&
      plusCreated === PLUS_NODE &&
      nodeDrawer.facts >= 1 &&
      nodeDrawer.assignForm;

    const ok =
      diag.nodes >= 1 &&
      board.columns === 8 &&
      board.cards >= 1 &&
      drawer.runs >= 1 &&
      drawer.comments >= 1 &&
      diag.termChars > 20 &&
      wsOk &&
      i18nOk &&
      addOk &&
      mirrorOk &&
      teamOk &&
      errors.length === 0;

    const summary = {
      ...diag,
      ...drawer,
      ...board,
      ...term,
      orgNodes: orgView.nodes,
      edges: orgView.edges,
      legend: orgView.legend,
      patchedParent,
      patchedGroup,
      plusCreated,
      facts: nodeDrawer.facts,
      i18n,
      created: addTask.created,
      i18nOk,
      addOk,
      mirrorOk,
      teamOk,
    };
    if (!ok) {
      if (errors.length) console.error(errors.join("\n"));
      throw new Error("assertions failed: " + JSON.stringify(summary));
    }

    console.log("VERIFY PASS " + JSON.stringify(summary));
    console.log("screenshot: " + shot);
  } finally {
    await browser.close();
  }
}

main().catch((e) => {
  console.error("VERIFY FAIL: " + e.message);
  process.exit(1);
});
