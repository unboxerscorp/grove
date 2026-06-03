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

    // node info drawer — run on the clean initial layout, before drag mutations.
    // Native DOM click (still fires React onClick) — robust against the action
    // overlay's negative offset / canvas clipping that can foil mouse targeting.
    await page.$eval('[data-name="root"] .org-act--info', (el) => el.click());
    await page.waitForSelector(".node-drawer", { timeout: 8000 });
    const nodeDrawer = await page.evaluate(() => ({
      facts: document.querySelectorAll(".node-drawer .dr-fact").length,
      assignForm: !!document.querySelector(".node-drawer__assign"),
    }));
    await page.click(".node-drawer .dr-drawer__close");
    await page.waitForFunction(() => !document.querySelector(".node-drawer"), { timeout: 8000 });

    // Drag-intent labels: a read-only probe (snaps back, no PATCH) that checks
    // the floating badge flips between reparent and group modes.
    const badge = () =>
      page.evaluate(() => ({
        text: document.querySelector(".org-dragbadge")?.textContent ?? "",
        cls: document.querySelector(".org-dragbadge")?.className ?? "",
      }));
    const fStart = await center("frontend");
    const dC0 = await center("docs");
    const rC0 = await center("researcher");
    const glide = async (ax, ay, bx, by) => {
      for (let i = 1; i <= 6; i++) {
        await page.mouse.move(ax + ((bx - ax) * i) / 6, ay + ((by - ay) * i) / 6);
        await new Promise((r) => setTimeout(r, 18));
      }
    };
    await page.mouse.move(fStart.x, fStart.y);
    await page.mouse.down();
    await glide(fStart.x, fStart.y, dC0.x, dC0.y); // over docs -> reparent
    const badgeReparent = await badge();
    await glide(dC0.x, dC0.y, rC0.x + 132, rC0.y); // near researcher -> group
    const badgeGroup = await badge();
    await glide(rC0.x + 132, rC0.y, rC0.x + 320, rC0.y); // far empty -> snap back
    await page.mouse.up();
    await settle();
    const dragLabelsOk =
      /is-reparent/.test(badgeReparent.cls) &&
      badgeReparent.text.length > 0 &&
      /is-group/.test(badgeGroup.cls) &&
      badgeGroup.text.length > 0;

    // #2 proximity grouping (initial layout: "researcher" is rightmost, so the
    // space to its right is empty): drag "backend" there -> PATCH {group}.
    const resC = await center("researcher");
    await dragTo("backend", resC.x + 132, resC.y);
    await page.waitForFunction(() => /:research$/.test(window.__MOCK__?.patchedGroup ?? ""), { timeout: 6000 });
    const patchedGroup = await page.evaluate(() => window.__MOCK__?.patchedGroup ?? "");
    await settle();

    // #4 group exit: drag the now-grouped "backend" far from every node -> {group:null}.
    const farPoint = await page.evaluate(() => {
      const c = document.querySelector(".org-canvas").getBoundingClientRect();
      let maxRight = c.left;
      document.querySelectorAll(".org-node").forEach((n) => {
        maxRight = Math.max(maxRight, n.getBoundingClientRect().right);
      });
      return { x: Math.min(maxRight + 240, c.right - 36), y: c.top + 110 };
    });
    await dragTo("backend", farPoint.x, farPoint.y);
    await page.waitForFunction(() => /:null$/.test(window.__MOCK__?.patchedGroup ?? ""), { timeout: 6000 });
    const groupExit = await page.evaluate(() => window.__MOCK__?.patchedGroup ?? "");
    await settle();

    // #3 detach: the edge ✕ AND a node "부모 끊기" action both PATCH {parent:null}.
    // Assert the edge ✕ is present/reachable, then use the node action (timing-
    // deterministic) to actually detach "docs" -> root.
    const cutAffordance = await page.evaluate(
      () => !!document.querySelector('[data-edge-child="docs"] .org-edge-cut'),
    );
    await page.hover('[data-name="docs"]');
    await page.click('[data-name="docs"] .org-act--detach');
    await page.waitForFunction(() => /->null$/.test(window.__MOCK__?.patchedParent ?? ""), { timeout: 6000 });
    const cutParent = await page.evaluate(() => window.__MOCK__?.patchedParent ?? "");
    await settle();

    // #1 drag-to-reparent: drop "frontend" onto "docs" -> PATCH {parent}.
    const docsC = await center("docs");
    await dragTo("frontend", docsC.x, docsC.y);
    await page.waitForFunction(() => /^frontend->/.test(window.__MOCK__?.patchedParent ?? ""), { timeout: 6000 });
    const patchedParent = await page.evaluate(() => window.__MOCK__?.patchedParent ?? "");
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
    const term = await page.evaluate(() => {
      const rows = document.querySelector(".dr-term .xterm-rows")?.textContent ?? "";
      return {
        markerCount: (rows.match(/#\d+/g) ?? []).length,
        termChars: rows.trim().length,
        conn: (document.querySelector(".dr-conn")?.textContent ?? "").trim(),
      };
    });

    // Slack integration panel.
    await page.click('.dr-tab[data-view="integrations"]');
    await page.waitForSelector(".slack", { timeout: 8000 });
    const slackStatus0 = await page.$eval(".slack-status__label", (el) => (el.textContent ?? "").trim());

    // manifest download -> GET /api/slack/manifest
    await page.click(".slack-manifest__btn");
    await page.waitForFunction(() => window.__MOCK__?.manifestFetched === true, { timeout: 6000 });
    const manifestFetched = await page.evaluate(() => window.__MOCK__?.manifestFetched === true);

    // token validation: invalid prefix -> inline error, no POST.
    const appInput = await page.$('.slack input[name="appToken"]');
    await appInput.type("nope-invalid");
    await page.click(".slack-save");
    await page.waitForSelector(".slack-field__err", { timeout: 4000 });
    const validationErr = await page.evaluate(() => !!document.querySelector(".slack-field__err"));

    // fix + fill valid tokens + channel/node mapping, then save -> POST /api/slack/config
    await appInput.click({ clickCount: 3 });
    await appInput.type("xapp-test-0001-abcd1234");
    const botInput = await page.$('.slack input[name="botToken"]');
    await botInput.type("xoxb-test-0002-wxyz5678");
    await page.type('.slack input[name="channel"]', "#dev");
    const nodeOptions = await page.$$eval('.slack select[name="node"] option', (els) => els.length);
    await page.select('.slack select[name="node"]', "root");
    await page.click(".slack-save");
    await page.waitForFunction(() => !!window.__MOCK__?.slackConfig, { timeout: 6000 });
    const slackCfg = await page.evaluate(() => window.__MOCK__?.slackConfig ?? {});
    await page.waitForSelector(".slack-masked", { timeout: 5000 });
    const maskedText = await page.$$eval(".slack-masked code", (els) => els.map((e) => e.textContent ?? "").join(" "));
    const statusAfterSave = await page.$eval(".slack-status__label", (el) => (el.textContent ?? "").trim());

    // test connection -> POST /api/slack/test -> socket_connected
    await page.click(".slack-test");
    await page.waitForFunction(() => window.__MOCK__?.slackTested === true, { timeout: 6000 });
    await page.waitForFunction(() => !!document.querySelector(".slack-status.is-live"), { timeout: 5000 });
    const liveAfterTest = await page.evaluate(() => !!document.querySelector(".slack-status.is-live"));

    const slackOk =
      manifestFetched &&
      validationErr === true &&
      typeof slackCfg.app_token === "string" &&
      slackCfg.app_token.startsWith("xapp-") &&
      typeof slackCfg.bot_token === "string" &&
      slackCfg.bot_token.startsWith("xoxb-") &&
      slackCfg.default_channel === "#dev" &&
      !!slackCfg.default_node &&
      /1234/.test(maskedText) &&
      /5678/.test(maskedText) &&
      liveAfterTest === true &&
      nodeOptions >= 2;

    // Project switcher: list, switch, new project, load project (integrity).
    const projName = () => page.$eval(".proj-switcher__name", (el) => (el.textContent ?? "").trim());
    await page.click(".proj-switcher__btn");
    await page.waitForSelector(".proj-menu", { timeout: 6000 });
    const projItems = await page.$$eval(".proj-item", (els) => els.length);
    const projInitial = await projName();
    await page.click('.proj-item[data-project="infra-ops"]');
    await page.waitForFunction(
      () => (document.querySelector(".proj-switcher__name")?.textContent ?? "").trim() === "infra-ops",
      { timeout: 5000 },
    );
    const projAfterSwitch = await projName();

    await page.click(".proj-switcher__btn");
    await page.waitForSelector(".proj-menu__new", { timeout: 5000 });
    await page.click(".proj-menu__new");
    await page.waitForSelector(".proj-modal.is-new", { timeout: 5000 });
    await page.type('.proj-modal input[name="projName"]', "demo-proj");
    await page.click(".proj-new__submit");
    await page.waitForFunction(() => !!window.__MOCK__?.createdProject, { timeout: 6000 });
    await page.waitForFunction(
      () => (document.querySelector(".proj-switcher__name")?.textContent ?? "").trim() === "demo-proj",
      { timeout: 5000 },
    );
    const newCfg = await page.evaluate(() => window.__MOCK__?.createdProject ?? {});
    const projAfterNew = await projName();

    await page.click(".proj-switcher__btn");
    await page.waitForSelector(".proj-menu__load", { timeout: 5000 });
    await page.click(".proj-menu__load");
    await page.waitForSelector(".proj-modal.is-load", { timeout: 5000 });
    await page.type('.proj-modal input[name="loadPath"]', "/Users/dev/loaded-proj");
    await page.click(".proj-load__submit");
    await page.waitForSelector(".proj-result", { timeout: 6000 });
    const loadResult = await page.evaluate(() => ({
      buckets: document.querySelectorAll(".proj-result__bucket").length,
      ok: !!document.querySelector(".proj-result__ok.is-ok"),
    }));
    await page.click(".proj-load__switch");
    await page.waitForFunction(
      () => (document.querySelector(".proj-switcher__name")?.textContent ?? "").trim() === "loaded-proj",
      { timeout: 5000 },
    );
    const loadedPath = await page.evaluate(() => window.__MOCK__?.loadedPath ?? "");
    const projAfterLoad = await projName();

    // confirm the active project reaches the backend (X-Grove-Project) on reload
    await page.click('.dr-tab[data-view="team"]');
    await page.waitForSelector(".org-node", { timeout: 8000 });
    await page.waitForFunction(() => (window.__MOCK__?.projectHeader ?? "") === "loaded-proj", { timeout: 6000 });

    const projectOk =
      projItems >= 2 &&
      projInitial === "dev10" &&
      projAfterSwitch === "infra-ops" &&
      newCfg.name === "demo-proj" &&
      projAfterNew === "demo-proj" &&
      loadResult.buckets >= 3 &&
      loadResult.ok === true &&
      loadedPath.includes("loaded-proj") &&
      projAfterLoad === "loaded-proj";

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
        boardWsTicket: mock.boardWsTicket ?? "",
        boardWsConnects: mock.boardWsConnects ?? 0,
        wsTicketProject: mock.wsTicketProject ?? "",
        projectHeader: mock.projectHeader ?? "",
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

    // ws-ticket carries the project; board WS connects via that ticket and
    // reconnects on project switch with the new project bound.
    const wsBindOk =
      diag.boardWsTicket !== "" &&
      diag.wsTicketProject === "loaded-proj" &&
      diag.boardWsConnects >= 2;

    const i18nOk = i18n.ko === "개발실" && i18n.en === "Dev Room";
    const addOk = addTask.created === NEW_TITLE;
    const mirrorOk = term.markerCount === 1; // no accumulation
    const teamOk =
      orgView.nodes >= 1 &&
      orgView.edges >= 1 &&
      orgView.legend >= 1 &&
      dragLabelsOk &&
      cutAffordance &&
      cutParent === "docs->null" &&
      patchedParent.startsWith("frontend->") &&
      patchedGroup.endsWith(":research") &&
      groupExit === "backend:null" &&
      plusCreated === PLUS_NODE &&
      nodeDrawer.facts >= 1 &&
      nodeDrawer.assignForm;

    const ok =
      diag.nodes >= 1 &&
      board.columns === 8 &&
      board.cards >= 1 &&
      drawer.runs >= 1 &&
      drawer.comments >= 1 &&
      term.termChars > 20 &&
      wsOk &&
      i18nOk &&
      addOk &&
      mirrorOk &&
      teamOk &&
      slackOk &&
      projectOk &&
      wsBindOk &&
      diag.projectHeader === projAfterLoad &&
      errors.length === 0;

    const summary = {
      ...diag,
      ...drawer,
      ...board,
      ...term,
      orgNodes: orgView.nodes,
      edges: orgView.edges,
      legend: orgView.legend,
      dragLabelsOk,
      badgeReparent: badgeReparent.text,
      badgeGroup: badgeGroup.text,
      cutAffordance,
      cutParent,
      patchedParent,
      patchedGroup,
      groupExit,
      plusCreated,
      facts: nodeDrawer.facts,
      i18n,
      created: addTask.created,
      i18nOk,
      addOk,
      mirrorOk,
      teamOk,
      slackOk,
      wsBindOk,
      slackStatus0,
      slackCfg,
      statusAfterSave,
      nodeOptions,
      projectOk,
      projItems,
      projInitial,
      projAfterSwitch,
      projAfterNew,
      projAfterLoad,
      loadResult,
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
