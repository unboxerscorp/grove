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

    // V2-W4 node status heatmap (from GET /api/status) + server health dot
    // (GET /api/health). Mock summary: running=2, stale=1, total=5 (idle=2).
    await page.waitForFunction(
      () => /\d/.test(document.querySelector(".nodestat__chip.is-running")?.textContent ?? ""),
      { timeout: 8000 },
    );
    await page.waitForSelector(".health-dot.is-ok", { timeout: 8000 });
    const statusBar = await page.evaluate(() => ({
      present: !!document.querySelector(".nodestat"),
      segs: document.querySelectorAll(".nodestat__seg").length,
      running: (document.querySelector(".nodestat__chip.is-running")?.textContent ?? "").trim(),
      total: (document.querySelector(".nodestat__total")?.textContent ?? "").trim(),
      healthOk: !!document.querySelector(".health-dot.is-ok"),
    }));
    const statusBarOk =
      statusBar.present &&
      statusBar.segs === 3 &&
      /2/.test(statusBar.running) &&
      /5/.test(statusBar.total) &&
      statusBar.healthOk;

    // V4-W4 node-status detail panel (GET /api/status?detail=1): per-node rows
    // with last-seen + an "inferred" badge for non-heartbeat sources.
    await page.click(".nodestat__more");
    await page.waitForSelector(".nodestat-detail .nodestat-row", { timeout: 6000 });
    const detail = await page.evaluate(() => ({
      rows: document.querySelectorAll(".nodestat-detail .nodestat-row").length,
      inferred: document.querySelectorAll(".nodestat-row__inferred").length,
      seen: !!document.querySelector(".nodestat-row__seen"),
      detailFetched: window.__MOCK__?.statusDetailFetched === true,
    }));
    await page.click(".nodestat__more"); // collapse
    const detailOk = detail.rows >= 1 && detail.inferred >= 1 && detail.seen && detail.detailFetched;

    // V4-W1 audit drawer (GET /api/audit): events render, cursor paging, filter.
    await page.click(".dr-audit-btn");
    await page.waitForSelector(".audit-drawer", { timeout: 5000 });
    await page.waitForFunction(() => document.querySelectorAll(".audit-event").length >= 1, { timeout: 6000 });
    const audit1 = await page.evaluate(() => ({
      events: document.querySelectorAll(".audit-event").length,
      hasActor: !!document.querySelector(".audit-event__actor"),
      hasAction: !!document.querySelector(".audit-event__action"),
      hasMore: !!document.querySelector(".audit-more"),
    }));
    await page.click(".audit-more");
    await page.waitForFunction((n) => document.querySelectorAll(".audit-event").length > n, { timeout: 6000 }, audit1.events);
    const auditAfterMore = await page.evaluate(() => ({
      events: document.querySelectorAll(".audit-event").length,
      cursorUsed: window.__MOCK__?.auditCursorUsed === true,
    }));
    await page.type('.audit-filter input[name="node"]', "backend");
    await page.waitForFunction(() => (window.__MOCK__?.auditFilter ?? "").includes("node=backend"), { timeout: 5000 });
    const auditFilter = await page.evaluate(() => window.__MOCK__?.auditFilter ?? "");
    await page.click(".audit-drawer .dr-drawer__close");
    await page.waitForFunction(() => !document.querySelector(".audit-drawer"), { timeout: 5000 });
    const auditOk =
      audit1.events >= 1 &&
      audit1.hasActor &&
      audit1.hasAction &&
      audit1.hasMore &&
      auditAfterMore.events > audit1.events &&
      auditAfterMore.cursorUsed &&
      /node=backend/.test(auditFilter);

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

    // #4 board live (claim -> running -> done): a board-tail event must reload
    // the snapshot and re-column the card. The live spark lights while the
    // socket is up. COLUMNS: triage,todo,scheduled,ready,running,blocked,review,done.
    await page.waitForSelector(".dr-spark.is-on", { timeout: 8000 });
    const boardLiveSpark = await page.evaluate(() => !!document.querySelector(".dr-spark.is-on"));
    const RUNNING_COL = 4;
    const DONE_COL = 7;
    const colIndexOf = (id) =>
      page.evaluate((tid) => {
        const cols = Array.from(document.querySelectorAll(".dr-col"));
        for (let i = 0; i < cols.length; i++) {
          const here = Array.from(cols[i].querySelectorAll(".dr-card__id")).some((el) =>
            (el.textContent ?? "").includes(tid),
          );
          if (here) return i;
        }
        return -1;
      }, id);
    const cardInCol = (idx, id) =>
      page.waitForFunction(
        (i, tid) => {
          const col = document.querySelectorAll(".dr-col")[i];
          return (
            !!col &&
            Array.from(col.querySelectorAll(".dr-card__id")).some((el) =>
              (el.textContent ?? "").includes(tid),
            )
          );
        },
        { timeout: 8000 },
        idx,
        id,
      );
    const claimColBefore = await colIndexOf("G-4"); // seeded as "ready" (3)
    await page.evaluate(() => window.__MOCK__?.claimTask("G-4"));
    await cardInCol(RUNNING_COL, "G-4");
    const claimCol = await colIndexOf("G-4");
    await page.evaluate(() => window.__MOCK__?.completeTask("G-4"));
    await cardInCol(DONE_COL, "G-4");
    const completeCol = await colIndexOf("G-4");
    const boardLiveOk =
      boardLiveSpark === true &&
      claimColBefore === 3 &&
      claimCol === RUNNING_COL &&
      completeCol === DONE_COL;

    // #N4 board WS lifecycle (여정6: WS 재연결·백오프): onopen catch-up reload,
    // non-4401 close -> reconnect, 4401 (auth reject) -> stop the loop.
    const REVIEW_COL = 6;
    const boardConnAfterLive = await page.evaluate(() => window.__MOCK__?.boardWsConnects ?? 0);
    // Silently move G-2 (review) -> done with NO board event, then force a
    // reconnect: only the onopen catch-up snapshot reload can surface it in Done.
    await page.evaluate(() => window.__MOCK__?.silentSetStatus("G-2", "done"));
    const n4CatchUpBefore = await colIndexOf("G-2"); // still review (6) — no reload yet
    await page.evaluate(() => window.__MOCK__?.closeBoard(1006));
    await cardInCol(DONE_COL, "G-2");
    await page.waitForFunction(() => !!document.querySelector(".dr-spark.is-on"), { timeout: 8000 });
    const n4CatchUpCol = await colIndexOf("G-2");
    const n4Reconnected = await page.evaluate(
      (prev) => (window.__MOCK__?.boardWsConnects ?? 0) > prev,
      boardConnAfterLive,
    );
    // 4401 must stop the reconnect loop: connects must NOT grow, spark goes dark.
    const boardConnBefore4401 = await page.evaluate(() => window.__MOCK__?.boardWsConnects ?? 0);
    await page.evaluate(() => window.__MOCK__?.closeBoard(4401));
    await new Promise((r) => setTimeout(r, 1500)); // > the 1s backoff a retry would use
    const n4NoReconnect = await page.evaluate(
      (prev) => (window.__MOCK__?.boardWsConnects ?? 0) === prev,
      boardConnBefore4401,
    );
    const n4SparkOff = await page.evaluate(() => !document.querySelector(".dr-spark.is-on"));
    const n4Ok =
      n4CatchUpBefore === REVIEW_COL &&
      n4Reconnected === true &&
      n4CatchUpCol === DONE_COL &&
      n4NoReconnect === true &&
      n4SparkOff === true;

    // #N2 ask-human visualization (여정3): a blocked task is surfaced in the
    // Blocked column and its drawer shows the blocked status pill. (A dedicated
    // "사람 대기" badge + Slack-thread link in the drawer is still a product gap
    // — no SPA UI exists yet; this asserts the blocked visualization that does.)
    const BLOCKED_COL = 5;
    const n2BlockedCol = await colIndexOf("G-7"); // G-7 is seeded status: "blocked"
    await page.evaluate(() => {
      const cards = Array.from(document.querySelectorAll(".dr-card"));
      const target = cards.find((c) => (c.querySelector(".dr-card__id")?.textContent ?? "").includes("G-7"));
      if (target instanceof HTMLElement) target.click();
    });
    await page.waitForSelector(".dr-drawer__panel", { timeout: 8000 });
    const n2Drawer = await page.evaluate(() => ({
      ticket: (document.querySelector(".dr-drawer__ticket")?.textContent ?? "").trim(),
      hasPill: !!document.querySelector(".dr-drawer .dr-pill"),
    }));
    await page.click(".dr-drawer__close");
    await page.waitForFunction(() => !document.querySelector(".dr-drawer"), { timeout: 8000 });
    const n2Ok = n2BlockedCol === BLOCKED_COL && n2Drawer.ticket === "G-7" && n2Drawer.hasPill === true;

    // Interactive org canvas: switch to the Team tab; assert the graph renders
    // (nodes, bezier edges, group legend).
    await page.click('.dr-tab[data-view="team"]');
    await page.waitForSelector(".org-node", { timeout: 8000 });
    await new Promise((r) => setTimeout(r, 650)); // let the entrance layout tween settle
    const orgView = await page.evaluate(() => ({
      nodes: document.querySelectorAll(".org-node").length,
      edges: document.querySelectorAll(".org-edge").length,
      legend: document.querySelectorAll(".org-legend__item").length,
      descs: document.querySelectorAll(".org-node__desc").length,
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

    // V4-W2 delegation overlay: off by default; the toggle reveals a distinct
    // dashed/arrow layer of actor -> target.node edges (root->backend merged to
    // count=2), and toggling off hides them again. Run on the clean layout.
    const delegToggle = await page.$(".org-deleg-toggle");
    const delegOffBefore = await page.evaluate(() => document.querySelectorAll(".org-deleg-edge").length);
    await page.$eval(".org-deleg-toggle", (el) => el.click());
    await page.waitForFunction(() => document.querySelectorAll(".org-deleg-edge").length >= 1, { timeout: 6000 });
    const delegOn = await page.evaluate(() => {
      const edges = Array.from(document.querySelectorAll(".org-deleg-edge"));
      return {
        count: edges.length,
        arrow: edges.some((e) => (e.getAttribute("marker-end") || "").includes("org-deleg-arrow")),
        dashed: edges.some((e) => getComputedStyle(e).strokeDasharray !== "none"),
        rootBackendCount: document.querySelector('[data-deleg="root>backend"]')?.getAttribute("data-count") ?? "",
        legend: !!document.querySelector(".org-deleg-legend"),
        marker: !!document.querySelector("#org-deleg-arrow"),
      };
    });
    await page.$eval(".org-deleg-toggle", (el) => el.click());
    await page.waitForFunction(() => document.querySelectorAll(".org-deleg-edge").length === 0, { timeout: 5000 });
    const delegOffAfter = await page.evaluate(() => document.querySelectorAll(".org-deleg-edge").length);
    const delegationEdgesOk =
      !!delegToggle &&
      delegOffBefore === 0 &&
      delegOn.count >= 1 &&
      delegOn.arrow &&
      delegOn.dashed &&
      delegOn.marker &&
      delegOn.rootBackendCount === "2" &&
      delegOn.legend &&
      delegOffAfter === 0;

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
    await page.type('.org-popover input[name="description"]', "qa-desc");
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
    const plusDesc = await page.evaluate(() => window.__MOCK__?.createdNodeDesc ?? "");
    await settle();

    // V5-W2 dashboard delegate: node action -> small form (title + optional body)
    // -> POST /api/boards/{board}/tasks with assignee=<node>, status="ready"
    // (web equivalent of `grove delegate`).
    await page.hover('[data-name="root"]');
    await page.click('[data-name="root"] .org-act--delegate');
    await page.waitForSelector(".org-popover--delegate .delegate-form", { timeout: 5000 });
    await page.type('.delegate-form input[name="delegateTitle"]', "delegated work");
    await page.type('.delegate-form textarea[name="delegateBody"]', "do the thing");
    await page.click(".delegate-form .delegate-form__submit");
    await page.waitForFunction(
      () => (window.__MOCK__?.lastTaskPost?.assignee ?? "") === "root",
      { timeout: 6000 },
    );
    const deleg = await page.evaluate(() => window.__MOCK__?.lastTaskPost ?? {});
    // Popover closes on success (form unmounts).
    await page.waitForFunction(() => !document.querySelector(".org-popover--delegate"), { timeout: 5000 });
    const delegateOk =
      deleg.assignee === "root" &&
      deleg.status === "ready" &&
      deleg.title === "delegated work" &&
      deleg.hasBody === true;
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

    // #N5 terminal connection-state transitions (여정6: connecting→live→
    // reconnecting→error). The mirror above already drove connecting->live.
    await page.waitForSelector(".dr-led.is-live", { timeout: 8000 });
    const n5Live0 = await page.evaluate(() => !!document.querySelector(".dr-led.is-live"));
    const termConnBefore = await page.evaluate(() => window.__MOCK__?.terminalWsConnects ?? 0);
    // Abnormal close -> "reconnecting" LED -> auto-reconnect -> "live" again.
    await page.evaluate(() => window.__MOCK__?.closeTerminal(1006));
    await page.waitForSelector(".dr-led.is-reconnecting", { timeout: 6000 });
    const n5Reconnecting = await page.evaluate(() => !!document.querySelector(".dr-led.is-reconnecting"));
    await page.waitForSelector(".dr-led.is-live", { timeout: 8000 });
    const n5Relive = await page.evaluate(() => !!document.querySelector(".dr-led.is-live"));
    const n5TermReconnected = await page.evaluate(
      (prev) => (window.__MOCK__?.terminalWsConnects ?? 0) > prev,
      termConnBefore,
    );
    // 4401 (session/ticket rejected) -> terminal "error" end state, no reconnect.
    const termConnBeforeErr = await page.evaluate(() => window.__MOCK__?.terminalWsConnects ?? 0);
    await page.evaluate(() => window.__MOCK__?.closeTerminal(4401));
    await page.waitForSelector(".dr-led.is-error", { timeout: 6000 });
    const n5Error = await page.evaluate(() => !!document.querySelector(".dr-led.is-error"));
    await new Promise((r) => setTimeout(r, 1200));
    const n5NoReconnectOnAuth = await page.evaluate(
      (prev) => (window.__MOCK__?.terminalWsConnects ?? 0) === prev,
      termConnBeforeErr,
    );
    const n5Ok =
      n5Live0 === true &&
      n5Reconnecting === true &&
      n5Relive === true &&
      n5TermReconnected === true &&
      n5Error === true &&
      n5NoReconnectOnAuth === true;

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

    // Dev-tool auth status panel: 5 tools, LEDs, login-hint reveal, URL hint, refresh.
    await page.click('.dr-tab[data-view="auth"]');
    await page.waitForSelector(".auth-row", { timeout: 8000 });
    const authRows = await page.$$eval(".auth-row", (els) => els.length);
    const authLeds = await page.evaluate(() => ({
      ok: document.querySelectorAll(".auth-led.is-ok").length,
      warn: document.querySelectorAll(".auth-led.is-warn").length,
    }));
    await page.click('[data-tool="codex"] .auth-login');
    await page.waitForSelector('[data-tool="codex"] .auth-hint', { timeout: 5000 });
    const codexHint = await page.$eval('[data-tool="codex"] .auth-hint__cmd', (el) => (el.textContent ?? "").trim());
    const cfHref = await page.$eval('[data-tool="cf"] .auth-login', (el) => el.getAttribute("href") ?? "");
    await page.click(".auth-refresh");
    await page.waitForFunction(() => (window.__MOCK__?.authStatusFetched ?? 0) >= 2, { timeout: 6000 });
    const authFetches = await page.evaluate(() => window.__MOCK__?.authStatusFetched ?? 0);
    const authOk =
      authRows === 5 &&
      authLeds.ok >= 1 &&
      authLeds.warn >= 1 &&
      codexHint === "codex login" &&
      cfHref.startsWith("http") &&
      authFetches >= 2;

    // V4-W3 cost/credit panel: 3 agent cards; estimate/inferred values flagged
    // (codex registry=exact, no badge; claude/agy inferred=badge); agy credit
    // reported UNKNOWN with a warning (never an estimated remaining balance);
    // no backend path/status leaks into the UI.
    await page.click('.dr-tab[data-view="cost"]');
    await page.waitForSelector('.cost-card[data-agent="codex"]', { timeout: 8000 });
    const cost = await page.evaluate(() => ({
      cards: document.querySelectorAll(".cost-grid .cost-card").length,
      estBadges: document.querySelectorAll(".cost-card .cost-metric__badge").length,
      codexEst: document.querySelectorAll('[data-agent="codex"] .cost-metric.is-est').length,
      codexTokens: (
        document.querySelector('[data-agent="codex"] .cost-cell .cost-metric__value')?.textContent ?? ""
      ).trim(),
      claudeEst: document.querySelectorAll('[data-agent="claude"] .cost-metric.is-est').length,
      agyUnknown: !!document.querySelector('[data-agent="agy"] .cost-credit.is-unknown'),
      agyUnknownText: (
        document.querySelector('[data-agent="agy"] .cost-credit__unknown')?.textContent ?? ""
      ).trim(),
      agyWarn: !!document.querySelector('[data-agent="agy"] .cost-credit__warn'),
      fetched: window.__MOCK__?.costFetched === true,
      leak: /\/api\/cost|HTTP \d/.test(document.querySelector(".cost")?.textContent ?? ""),
    }));
    const costOk =
      cost.cards === 3 &&
      cost.estBadges >= 1 &&
      cost.codexEst === 0 &&
      cost.codexTokens === "1.23M" &&
      cost.claudeEst >= 1 &&
      cost.agyUnknown &&
      cost.agyUnknownText.length > 0 &&
      cost.agyWarn &&
      cost.fetched &&
      !cost.leak;

    // #N1 project switch re-scope + no residue (여정1/5): switching to an
    // isolated project swaps org/board/nodes wholesale — none of the default
    // project's nodes/cards may bleed through — and switching back restores it.
    await page.click(".proj-switcher__btn");
    await page.waitForSelector('.proj-item[data-project="solo-x"]', { timeout: 6000 });
    await page.click('.proj-item[data-project="solo-x"]');
    await page.waitForFunction(
      () => (document.querySelector(".proj-switcher__name")?.textContent ?? "").trim() === "solo-x",
      { timeout: 6000 },
    );
    // node rail re-scoped to the single solo node.
    await page.waitForFunction(() => document.querySelectorAll(".dr-node").length === 1, { timeout: 8000 });
    const soloScope = await page.evaluate(() => {
      const names = Array.from(document.querySelectorAll(".dr-node__name")).map((e) => (e.textContent ?? "").trim());
      return { count: names.length, hasSolo: names.includes("solo"), hasRoot: names.includes("root") };
    });
    // org canvas re-scoped (one node, no default-project root residue).
    await page.click('.dr-tab[data-view="team"]');
    await page.waitForFunction(
      () => document.querySelectorAll(".org-node").length === 1 && !!document.querySelector('[data-name="solo"]'),
      { timeout: 8000 },
    );
    const soloOrg = await page.evaluate(() => ({
      nodes: document.querySelectorAll(".org-node").length,
      hasRoot: !!document.querySelector('[data-name="root"]'),
    }));
    // board re-scoped: the solo task shows, none of the default project's G- cards.
    await page.click('.dr-tab[data-view="board"]');
    await page.waitForFunction(
      () => Array.from(document.querySelectorAll(".dr-card__title")).some((e) => (e.textContent ?? "").includes("solo task")),
      { timeout: 8000 },
    );
    const soloBoard = await page.evaluate(() => ({
      gResidue: Array.from(document.querySelectorAll(".dr-card__id")).some((e) =>
        (e.textContent ?? "").trim().startsWith("G-"),
      ),
    }));
    // switch back to dev10 -> default context returns (no permanent loss).
    await page.click(".proj-switcher__btn");
    await page.waitForSelector('.proj-item[data-project="dev10"]', { timeout: 6000 });
    await page.click('.proj-item[data-project="dev10"]');
    await page.waitForFunction(
      () => (document.querySelector(".proj-switcher__name")?.textContent ?? "").trim() === "dev10",
      { timeout: 6000 },
    );
    await page.waitForFunction(() => document.querySelectorAll(".dr-node").length > 1, { timeout: 8000 });
    await page.waitForFunction(
      () => Array.from(document.querySelectorAll(".dr-card__id")).some((e) => (e.textContent ?? "").trim().startsWith("G-")),
      { timeout: 8000 },
    );
    const backScope = await page.evaluate(() => {
      const names = Array.from(document.querySelectorAll(".dr-node__name")).map((e) => (e.textContent ?? "").trim());
      const ids = Array.from(document.querySelectorAll(".dr-card__id")).map((e) => (e.textContent ?? "").trim());
      return { hasRoot: names.includes("root"), hasG: ids.some((id) => id.startsWith("G-")) };
    });
    const n1Ok =
      soloScope.count === 1 &&
      soloScope.hasSolo === true &&
      soloScope.hasRoot === false &&
      soloOrg.nodes === 1 &&
      soloOrg.hasRoot === false &&
      soloBoard.gResidue === false &&
      backScope.hasRoot === true &&
      backScope.hasG === true;

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
        terminalTicketKind: mock.terminalTicketKind ?? "",
        boardWsConnected: mock.boardWsConnected ?? false,
        boardWsTicket: mock.boardWsTicket ?? "",
        boardWsConnects: mock.boardWsConnects ?? 0,
        wsTicketProject: mock.wsTicketProject ?? "",
        projectHeader: mock.projectHeader ?? "",
      };
    });

    const shot = path.join(root, "mock", "verify-screenshot.png");
    await page.screenshot({ path: shot });

    // ws-ticket kind/pane binding (negative path): a BOARD-bound ticket used on
    // /ws/terminal must be rejected (1008) and stream nothing. This proves the
    // mock enforces the contract — so the FE must request the right kind/pane.
    // Run AFTER diag capture: this probe POSTs another ws-ticket and would
    // otherwise clobber diag.wsTicketProject (used by wsBindOk).
    const wsMismatch = await page.evaluate(async () => {
      const tok = window.__GROVE_SESSION_TOKEN__ ?? "";
      const res = await fetch("/api/ws-ticket", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Grove-Session-Token": tok, "X-Grove-Project": "dev10" },
        body: JSON.stringify({ kind: "board" }),
      });
      const { ticket } = await res.json();
      return await new Promise((resolve) => {
        const ws = new WebSocket(`ws:///ws/terminal?ticket=${encodeURIComponent(ticket)}&pane_id=grove:0.0`);
        let gotFrame = false;
        ws.onmessage = () => {
          gotFrame = true;
        };
        ws.onclose = (e) => resolve({ code: e.code, gotFrame });
        setTimeout(() => resolve({ code: -1, gotFrame }), 1500);
      });
    });

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

    // FE requests a terminal-bound ticket for /ws/terminal (positive), and a
    // board ticket on /ws/terminal is rejected with 1008 (negative).
    const wsKindOk =
      diag.terminalTicketKind === "terminal" && wsMismatch.code === 1008 && wsMismatch.gotFrame === false;

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
      plusDesc === "qa-desc" &&
      orgView.descs >= 1 &&
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
      boardLiveOk &&
      n4Ok &&
      n5Ok &&
      n1Ok &&
      n2Ok &&
      teamOk &&
      slackOk &&
      authOk &&
      costOk &&
      projectOk &&
      wsBindOk &&
      wsKindOk &&
      statusBarOk &&
      detailOk &&
      auditOk &&
      delegationEdgesOk &&
      delegateOk &&
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
      boardLiveOk,
      boardLiveSpark,
      claimColBefore,
      claimCol,
      completeCol,
      n4Ok,
      n4Reconnected,
      n4CatchUpCol,
      n4NoReconnect,
      n4SparkOff,
      n5Ok,
      n5Reconnecting,
      n5Relive,
      n5TermReconnected,
      n5Error,
      n1Ok,
      soloScope,
      soloOrg,
      soloBoard,
      backScope,
      n2Ok,
      n2BlockedCol,
      teamOk,
      slackOk,
      authOk,
      authRows,
      codexHint,
      cfHref,
      plusDesc,
      orgDescs: orgView.descs,
      wsBindOk,
      wsKindOk,
      statusBarOk,
      statusBar,
      detailOk,
      detail,
      auditOk,
      audit: { ...audit1, after: auditAfterMore, filter: auditFilter },
      costOk,
      cost,
      delegationEdgesOk,
      deleg: { offBefore: delegOffBefore, ...delegOn, offAfter: delegOffAfter },
      delegateOk,
      delegatePost: deleg,
      terminalTicketKind: diag.terminalTicketKind,
      wsMismatchCode: wsMismatch.code,
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
