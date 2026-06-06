// Headless render check: drive the system Chrome against the mock harness and
// assert the built SPA mounts, lists nodes + board cards, opens the task drawer
// (comments + runs), and streams terminal frames into xterm via the ws-ticket
// flow. Writes mock/verify-screenshot.png.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import puppeteer from "puppeteer-core";

const root = path.dirname(fileURLToPath(import.meta.url));
const htmlPath = path.join(root, "mock", "index.html");

function assertNoInboxUnblockCopy() {
  const source = readFileSync(path.join(root, "src", "i18n.tsx"), "utf8");
  const bundle = existsSync(path.join(root, "dist", "app.js")) ? readFileSync(path.join(root, "dist", "app.js"), "utf8") : "";
  const forbidden = /(작업을 해제|unblock the task|답변·해제|Answer · unblock)/i;
  if (forbidden.test(`${source}\n${bundle}`)) {
    throw new Error("inbox answer copy must describe answering the human-facing item, not unblocking a task");
  }
}

function assertNoDelegateTaskCopy() {
  const source = readFileSync(path.join(root, "src", "i18n.tsx"), "utf8");
  const rolePresets = readFileSync(path.join(root, "src", "rolePresets.ts"), "utf8");
  const bundle = existsSync(path.join(root, "dist", "app.js")) ? readFileSync(path.join(root, "dist", "app.js"), "utf8") : "";
  const forbidden =
    /(작업 위임|작업 부여|보드 task|위임한 범위|Delegate task|Assign task|Delegate to this node|이 노드로 위임)/i;
  if (forbidden.test(`${source}\n${rolePresets}\n${bundle}`)) {
    throw new Error("node action copy must describe creating human-facing items, not delegated tasks");
  }
}

function assertNoLegacyProjectMasterMock() {
  const source = readFileSync(path.join(root, "mock", "harness.ts"), "utf8");
  const bundle = existsSync(path.join(root, "mock", "harness.js"))
    ? readFileSync(path.join(root, "mock", "harness.js"), "utf8")
    : "";
  if (/project-master/i.test(`${source}\n${bundle}`)) {
    throw new Error("web mock must not expose legacy project-master defaults");
  }
}

function assertNoLegacyProjectMasterE2eFixtures() {
  const fixtures = [
    readFileSync(path.join(root, "e2e", "tier1", "fixtures.mjs"), "utf8"),
    readFileSync(path.join(root, "e2e", "live.mjs"), "utf8"),
  ]
    .join("\n")
    .replace(/^\s*delete nodes\["project-master"\];\n?/gm, "");
  if (/project-master/i.test(fixtures)) {
    throw new Error("web e2e fixtures must not create legacy project-master defaults");
  }
}

function assertLiveE2eDefaultsCurrentPort() {
  const liveScripts = [
    readFileSync(path.join(root, "e2e", "live.mjs"), "utf8"),
    readFileSync(path.join(root, "e2e", "tier1", "runner.mjs"), "utf8"),
    readFileSync(path.join(root, "e2e", "registry", "controls.json"), "utf8"),
  ].join("\n");
  if (/127\.0\.0\.1:9131|:9131\b/.test(liveScripts)) {
    throw new Error("live e2e defaults must target the current cockpit port 8765, not stale 9131");
  }
}

function assertLiveE2eAvoidsReentrantMasterChatPost() {
  const live = readFileSync(path.join(root, "e2e", "live.mjs"), "utf8");
  if (/path:\s*["']\/api\/master\/chat["']\s*,\s*method:\s*["']POST["']/.test(live)) {
    throw new Error("live e2e must not POST /api/master/chat because it can reenter the active grove-master turn");
  }
}

function assertTerminalPaneDisablesXtermStdin() {
  // #N9 xterm stdin disabled: terminal panes are mirrors; typed input goes only
  // through the explicit node send form when that feature is available.
  const source = readFileSync(path.join(root, "src", "components", "TerminalPane.tsx"), "utf8");
  if (
    !/const\s+XTERM_DISABLE_STDIN\s*=\s*true\s*;/.test(source) ||
    !/disableStdin:\s*XTERM_DISABLE_STDIN/.test(source) ||
    !/data-xterm-stdin=\{XTERM_DISABLE_STDIN\s*\?\s*["']disabled["']\s*:\s*["']enabled["']\}/.test(source)
  ) {
    throw new Error("TerminalPane must keep xterm stdin disabled and expose that state for N9 verification");
  }
}

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

async function verifyRetiredLegacySurfaces(browser) {
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
  await page.waitForSelector(".devroom .dr-brand", { timeout: 8000 });
  await page.waitForFunction(() => document.querySelectorAll(".dr-node").length >= 1, { timeout: 8000 });
  await page.waitForFunction(() => document.querySelectorAll(".dr-card").length >= 1, { timeout: 8000 });

  const hiddenViews = ["connect", "exec", "cost", "ledger", "insights", "trend", "agg", "handoff", "routing"];
  const visibleViews = ["board", "team", "terminal", "integrations", "auth"];
  const defaultSurface = await page.evaluate(
    ({ hiddenViews, visibleViews }) => {
      const inSidebar = (selector) => !!document.querySelector(`.dr-sidebar ${selector}`);
      return {
        visibleViewsOk: visibleViews.every((v) => inSidebar(`.dr-tab[data-view="${v}"]`)),
        hiddenViewsAbsent: hiddenViews.every((v) => !inSidebar(`.dr-tab[data-view="${v}"]`)),
        hiddenViewsPresent: hiddenViews.filter((v) => inSidebar(`.dr-tab[data-view="${v}"]`)),
        chainAbsent: !inSidebar(".dr-chain-btn"),
        drawersOk: inSidebar(".dr-audit-btn") && inSidebar(".dr-inbox-btn"),
      };
    },
    { hiddenViews, visibleViews },
  );

  await page.keyboard.down("Control");
  await page.keyboard.press("KeyK");
  await page.keyboard.up("Control");
  await page.waitForSelector(".cmdk__panel", { timeout: 6000 });
  const palette = await page.evaluate(
    ({ hiddenViews, visibleViews }) => {
      const cmds = Array.from(document.querySelectorAll(".cmdk__item[role='option']")).map(
        (el) => el.getAttribute("data-cmd") ?? "",
      );
      return {
        options: cmds.length,
        visibleViewsOk: visibleViews.every((v) => cmds.includes(`view:${v}`)),
        drawersOk: cmds.includes("drawer:audit") && cmds.includes("drawer:inbox") && !cmds.includes("drawer:chain"),
        hiddenCommands: hiddenViews.filter((v) => cmds.includes(`view:${v}`)),
      };
    },
    { hiddenViews, visibleViews },
  );
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => !document.querySelector(".cmdk__panel"), { timeout: 5000 });

  const SHARE_DEMO_CODE = "grove-demo-join-0001";
  const page2 = await browser.newPage();
  await page2.setViewport({ width: 1100, height: 800, deviceScaleFactor: 1 });
  const joinErrors = [];
  page2.on("pageerror", (e) => joinErrors.push("pageerror: " + String(e)));
  page2.on("console", (m) => {
    if (m.type() !== "error") return;
    const t = m.text();
    if (/Failed to load resource|net::|fonts\.googleapis/.test(t)) return;
    joinErrors.push("console: " + t);
  });
  await page2.evaluateOnNewDocument(() => {
    try {
      localStorage.setItem("grove.onboarded.v3", "1");
    } catch {
      /* ignore */
    }
  });
  await page2.goto("file://" + htmlPath + "?join=" + SHARE_DEMO_CODE, { waitUntil: "load" });
  await page2.waitForSelector('.connect-join[data-card="join"]', { timeout: 8000 });
  await page2.waitForFunction(() => !window.location.href.includes("join="), { timeout: 8000 });
  const joinPrefill = await page2.evaluate(() => ({
    connectVisible: !!document.querySelector(".connect"),
    connectTabHidden: !document.querySelector('.dr-sidebar .dr-tab[data-view="connect"]'),
    code: document.querySelector(".connect-join__code")?.value ?? "",
    urlScrubbed: !/[?&]join=/.test(window.location.search) && !window.location.href.includes("grove-demo-join-0001"),
  }));
  await page2.$eval(".connect-join__code", (el) => {
    const d = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value");
    d.set.call(el, "totally-wrong-code");
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await page2.type(".connect-join__name", "legacy-peer");
  await page2.click(".connect-join__btn");
  await page2.waitForSelector("[data-join-err]", { timeout: 8000 });
  const joinBad = await page2.evaluate(() => ({
    err: document.querySelector("[data-join-err]")?.getAttribute("data-join-err") ?? "",
    joined: window.__MOCK__?.joined ?? null,
  }));
  await page2.$eval(
    ".connect-join__code",
    (el, value) => {
      const d = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value");
      d.set.call(el, value);
      el.dispatchEvent(new Event("input", { bubbles: true }));
    },
    SHARE_DEMO_CODE,
  );
  await page2.click(".connect-join__btn");
  await page2.waitForSelector('.connect-joined[data-join="ok"]', { timeout: 8000 });
  const joinOk = await page2.evaluate(() => ({
    member: document.querySelector(".connect-joined__member .connect-chip")?.textContent?.trim() ?? "",
    role: (document.querySelector(".connect-joined__role")?.textContent ?? "").trim(),
    joined: window.__MOCK__?.joined ?? null,
  }));
  await page2.close();

  const ok =
    defaultSurface.visibleViewsOk &&
    defaultSurface.hiddenViewsAbsent &&
    defaultSurface.chainAbsent &&
    defaultSurface.drawersOk &&
    palette.options === 7 &&
    palette.visibleViewsOk &&
    palette.drawersOk &&
    palette.hiddenCommands.length === 0 &&
    joinPrefill.connectVisible &&
    joinPrefill.connectTabHidden &&
    joinPrefill.code === SHARE_DEMO_CODE &&
    joinPrefill.urlScrubbed &&
    joinBad.err === "invalid" &&
    joinBad.joined === null &&
    joinOk.member.includes("legacy-peer") &&
    joinOk.role === "operator" &&
    joinOk.joined?.name === "legacy-peer" &&
    errors.length === 0 &&
    joinErrors.length === 0;

  if (!ok) {
    await page.screenshot({ path: path.join(root, "mock", "verify-legacy-hidden-screenshot.png"), fullPage: true });
    await page.close();
    throw new Error(
      JSON.stringify(
        {
          defaultSurface,
          palette,
          joinPrefill,
          joinBad,
          joinOk,
          errors,
          joinErrors,
        },
        null,
        2,
      ),
    );
  }
  await page.close();
  console.log(
    "VERIFY OK",
    JSON.stringify({
      mode: "legacy-hidden",
      defaultSurface,
      palette,
      join: { prefilled: joinPrefill.code === SHARE_DEMO_CODE, member: joinOk.member, role: joinOk.role },
    }),
  );
}

async function coreMain() {
  assertNoInboxUnblockCopy();
  assertNoDelegateTaskCopy();
  assertNoLegacyProjectMasterMock();
  assertNoLegacyProjectMasterE2eFixtures();
  assertLiveE2eDefaultsCurrentPort();
  assertLiveE2eAvoidsReentrantMasterChatPost();
  assertTerminalPaneDisablesXtermStdin();
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
    await page.evaluateOnNewDocument(() => {
      window.__GROVE_MOCK_STATUS_DELAY_MS__ = 1200;
    });

    await page.goto("file://" + htmlPath, { waitUntil: "load" });
    await page.waitForSelector(".devroom .dr-brand", { timeout: 8000 });
    await page.waitForFunction(() => document.querySelectorAll(".dr-node").length >= 1, { timeout: 8000 });
    await page.waitForFunction(() => document.querySelectorAll(".dr-card").length >= 1, { timeout: 8000 });
    await page.waitForFunction(() => !document.querySelector(".onb-wizard"), { timeout: 2000 });

    const statusLoading = await page.evaluate(() => {
      const text = (document.querySelector(".nodestat")?.textContent ?? "").replace(/\s+/g, " ").trim();
      return {
        loading: !!document.querySelector(".nodestat__loading"),
        text,
        noFalseZero: !/0\s*(전체|total)/i.test(text),
      };
    });
    await page.evaluate(() => window.__MOCK__?.setStatusDelay?.(0));

    const sidebar = await page.evaluate(() => {
      const inSidebar = (selector) => !!document.querySelector(`.dr-sidebar ${selector}`);
      const groups = Array.from(document.querySelectorAll(".dr-sidebar .dr-navgroup")).map((g) =>
        g.getAttribute("data-group"),
      );
      const visibleViews = ["board", "team", "terminal", "integrations", "auth"];
      const hiddenViews = ["connect", "exec", "cost", "ledger", "insights", "trend", "agg", "handoff", "routing"];
      return {
        groups,
        visibleViewsOk: visibleViews.every((v) => inSidebar(`.dr-tab[data-view="${v}"]`)),
        hiddenViewsAbsent: hiddenViews.every((v) => !inSidebar(`.dr-tab[data-view="${v}"]`)),
        drawersOk: inSidebar(".dr-audit-btn") && inSidebar(".dr-inbox-btn") && !inSidebar(".dr-chain-btn"),
        liveStat: (document.querySelector(".dr-stat__n")?.textContent ?? "").trim(),
        liveMeta: (document.querySelector(".dr-rail__meta")?.textContent ?? "").replace(/\s+/g, " ").trim(),
      };
    });

    const collectI18nSnapshot = () =>
      page.evaluate(() => ({
        htmlLang: document.documentElement.lang,
        stored: localStorage.getItem("grove.lang"),
        brandSub: (document.querySelector(".dr-brand__sub")?.textContent ?? "").trim(),
        navGroups: Array.from(document.querySelectorAll(".dr-sidebar .dr-navgroup__label")).map((el) =>
          (el.textContent ?? "").trim(),
        ),
        tabs: Array.from(document.querySelectorAll(".dr-sidebar .dr-tab")).map((el) => (el.textContent ?? "").trim()),
        boardTitle: (document.querySelector(".dr-board__title")?.textContent ?? "").trim(),
        boardLists: Array.from(document.querySelectorAll(".dr-col__title")).map((el) => (el.textContent ?? "").trim()),
        addButton: (document.querySelector(".dr-addbtn")?.textContent ?? "").trim(),
      }));
    const collectI18nAddForm = () =>
      page.evaluate(() => ({
        heading: (document.querySelector(".dr-addform__head")?.textContent ?? "").trim(),
        title: document.querySelector(".dr-addform__title")?.getAttribute("placeholder") ?? "",
        body: document.querySelector(".dr-addform__body")?.getAttribute("placeholder") ?? "",
        assignee: document.querySelector(".dr-addform__assignee")?.getAttribute("aria-label") ?? "",
        submit: (document.querySelector(".dr-addform__submit")?.textContent ?? "").trim(),
        cancel: (document.querySelector(".dr-addform__cancel")?.textContent ?? "").trim(),
      }));
    const i18nKo = await collectI18nSnapshot();
    await page.click('.dr-lang__btn[data-lang="en"]');
    await page.waitForFunction(
      () => (document.querySelector(".dr-board__title")?.textContent ?? "").trim() === "Human lists",
      { timeout: 6000 },
    );
    const i18nEn = await collectI18nSnapshot();
    await page.click(".dr-addbtn");
    await page.waitForSelector(".dr-addform", { timeout: 5000 });
    const i18nEnForm = await collectI18nAddForm();
    await page.click(".dr-addform__cancel");
    await page.waitForFunction(() => !document.querySelector(".dr-addform"), { timeout: 5000 });
    await page.reload({ waitUntil: "load" });
    await page.waitForSelector(".devroom .dr-brand", { timeout: 8000 });
    await page.waitForFunction(() => document.querySelectorAll(".dr-card").length >= 1, { timeout: 8000 });
    const i18nEnReload = await collectI18nSnapshot();
    await page.click('.dr-lang__btn[data-lang="ko"]');
    await page.waitForFunction(
      () => (document.querySelector(".dr-board__title")?.textContent ?? "").trim() === "사람용 목록",
      { timeout: 6000 },
    );
    const i18nKoAgain = await collectI18nSnapshot();
    const i18nFullOk =
      // #N7 full-label i18n snapshot: core tabs, board panels, and add-item form
      // switch language immediately and persist through reload.
      i18nKo.htmlLang === "ko" &&
      i18nKo.navGroups.includes("작업") &&
      i18nKo.navGroups.includes("커뮤니케이션") &&
      i18nKo.tabs.some((t) => /목록/.test(t)) &&
      i18nKo.tabs.some((t) => /터미널/.test(t)) &&
      i18nKo.boardTitle === "사람용 목록" &&
      i18nKo.boardLists.join("|").includes("피드백 및 할 일") &&
      i18nEn.htmlLang === "en" &&
      i18nEn.stored === "en" &&
      i18nEn.navGroups.includes("Work") &&
      i18nEn.navGroups.includes("Comms") &&
      i18nEn.tabs.some((t) => /Lists/.test(t)) &&
      i18nEn.tabs.some((t) => /Terminal/.test(t)) &&
      i18nEn.boardTitle === "Human lists" &&
      i18nEn.boardLists.join("|").includes("Feedback and to-dos") &&
      i18nEn.addButton === "+ Add" &&
      i18nEnForm.heading === "New item" &&
      i18nEnForm.title === "Title (required)" &&
      i18nEnForm.body === "Body (optional)" &&
      i18nEnForm.assignee === "Assignee" &&
      i18nEnForm.submit === "Add" &&
      i18nEnForm.cancel === "Cancel" &&
      i18nEnReload.htmlLang === "en" &&
      i18nEnReload.stored === "en" &&
      i18nEnReload.boardTitle === "Human lists" &&
      i18nKoAgain.htmlLang === "ko" &&
      i18nKoAgain.stored === "ko" &&
      i18nKoAgain.boardTitle === "사람용 목록";

    await page.waitForFunction(
      () => /\d/.test(document.querySelector(".nodestat__chip.is-running")?.textContent ?? ""),
      { timeout: 8000 },
    );
    const num = (s) => parseInt((s || "").trim(), 10);
    const statusInitial = await page.evaluate(() => ({
      running: (document.querySelector(".nodestat__chip.is-running")?.textContent ?? "").trim(),
      idle: (document.querySelector(".nodestat__chip.is-idle")?.textContent ?? "").trim(),
    }));
    const activeAliasSetup = await page.evaluate(() => {
      const setNodeStatus = window.__MOCK__?.setNodeStatus;
      return typeof setNodeStatus === "function" ? setNodeStatus("frontend", "active") : false;
    });
    if (activeAliasSetup) {
      const before = await page.evaluate(() => window.__MOCK__?.statusFetches ?? 0);
      await page.waitForFunction((prev) => (window.__MOCK__?.statusFetches ?? 0) > prev, { timeout: 8000 }, before);
      await page.waitForFunction(
        () =>
          parseInt((document.querySelector(".nodestat__chip.is-running")?.textContent ?? "").trim(), 10) === 3 &&
          parseInt((document.querySelector(".nodestat__chip.is-idle")?.textContent ?? "").trim(), 10) === 2,
        { timeout: 8000 },
      );
    }
    const statusActiveAlias = await page.evaluate(() => ({
      running: (document.querySelector(".nodestat__chip.is-running")?.textContent ?? "").trim(),
      idle: (document.querySelector(".nodestat__chip.is-idle")?.textContent ?? "").trim(),
    }));
    const statusActiveAliasOk =
      num(statusInitial.running) === 2 &&
      num(statusInitial.idle) === 3 &&
      activeAliasSetup &&
      num(statusActiveAlias.running) === 3 &&
      num(statusActiveAlias.idle) === 2;

    await page.evaluate(() => window.__MOCK__?.setOrgDelay?.(800));
    await page.click('.dr-sidebar .dr-tab[data-view="team"]');
    await page.waitForSelector(".org", { timeout: 8000 });
    await new Promise((r) => setTimeout(r, 120));
    const teamLoading = await page.evaluate(() => ({
      nodes: document.querySelectorAll(".org-node").length,
      emptyCopy: /노드가 없습니다|no nodes yet/i.test(document.querySelector(".org__msg")?.textContent ?? ""),
      msg: (document.querySelector(".org__msg")?.textContent ?? "").trim(),
      sub: (document.querySelector(".org__sub")?.textContent ?? "").trim(),
    }));
    await page.evaluate(() => window.__MOCK__?.setOrgDelay?.(0));
    await page.waitForSelector(".org-node", { timeout: 8000 });
    const teamFinal = await page.evaluate(() => ({
      nodes: document.querySelectorAll(".org-node").length,
      sub: (document.querySelector(".org__sub")?.textContent ?? "").trim(),
    }));

    await page.click('.dr-sidebar .dr-tab[data-view="terminal"]');
    await page.waitForSelector(".dr-term .xterm", { timeout: 8000 });
    await page.waitForFunction(() => /#\d+/.test(document.querySelector(".dr-term .xterm-rows")?.textContent ?? ""), {
      timeout: 8000,
    });
    await page.waitForSelector(".dr-led.is-live", { timeout: 8000 });
    const terminal = await page.evaluate(() => ({
      name: (document.querySelector(".dr-term__name")?.textContent ?? "").trim(),
      pane: (document.querySelector(".dr-term__pane")?.textContent ?? "").trim(),
      chars: (document.querySelector(".dr-term .xterm-rows")?.textContent ?? "").trim().length,
      ticketKind: window.__MOCK__?.terminalTicketKind ?? "",
      wsUrl: window.__MOCK__?.terminalWsUrl ?? "",
      sendBox: document.querySelectorAll(".dr-term__send-input").length,
      viewOnly: document.querySelectorAll('.dr-term__send-viewer[data-viewonly="1"]').length,
      modeLabel: (document.querySelector(".dr-term__ro")?.textContent ?? "").trim(),
    }));

    await page.$eval('.dr-sidebar .dr-tab[data-view="integrations"]', (el) => el.click());
    await page.waitForSelector(".slack-guide", { timeout: 8000 });
    const slackGuide = await page.evaluate(() => {
      const text = document.querySelector(".slack")?.textContent ?? "";
      return {
        hasFreeChat: /자유 대화|free-form|GROVE MASTER/.test(text),
        hasFeedback: /feedback|피드백/.test(text),
        noOldTaskPreview: !/bug: <|task: <|task preview|board task|role checks|gates/i.test(text),
        noReadOnlyCopy: !/(read-only|읽기 전용)/i.test(text),
      };
    });

    await page.$eval('.dr-sidebar .dr-tab[data-view="board"]', (el) => el.click());
    await page.waitForSelector(".dr-board", { timeout: 8000 });
    const board = await page.evaluate(() => ({
      title: (document.querySelector(".dr-board__title")?.textContent ?? "").trim(),
      lists: Array.from(document.querySelectorAll(".dr-col__title")).map((el) => (el.textContent ?? "").trim()),
      noStatusFilters: document.querySelectorAll(".dr-board__filters, .dr-filter").length === 0,
    }));

    const ok =
      JSON.stringify(sidebar.groups) === JSON.stringify(["work", "comms", "audit", "setup"]) &&
      sidebar.visibleViewsOk &&
      sidebar.hiddenViewsAbsent &&
      sidebar.drawersOk &&
      sidebar.liveStat === "4" &&
      /4\/6/.test(sidebar.liveMeta) &&
      statusActiveAliasOk &&
      i18nFullOk &&
      statusLoading.loading &&
      statusLoading.noFalseZero &&
      teamLoading.nodes === 0 &&
      !teamLoading.emptyCopy &&
      teamFinal.nodes >= 1 &&
      terminal.name === "root" &&
      /terminal/.test(terminal.ticketKind) &&
      /ws\/terminal/.test(terminal.wsUrl) &&
      terminal.chars > 0 &&
      terminal.sendBox === 1 &&
      terminal.viewOnly === 0 &&
      !/(read-only|읽기 전용)/i.test(terminal.modeLabel) &&
      slackGuide.hasFreeChat &&
      slackGuide.hasFeedback &&
      slackGuide.noOldTaskPreview &&
      slackGuide.noReadOnlyCopy &&
      /사람용|Human/i.test(board.title) &&
      board.lists.length === 2 &&
      board.noStatusFilters &&
      errors.length === 0;

    await page.screenshot({ path: path.join(root, "mock", "verify-screenshot.png"), fullPage: true });
    if (!ok) {
      throw new Error(
        JSON.stringify(
          {
            sidebar,
            teamLoading,
            teamFinal,
            terminal,
            slackGuide,
            board,
            statusInitial,
            statusActiveAlias,
            statusActiveAliasOk,
            statusLoading,
            i18nKo,
            i18nEn,
            i18nEnForm,
            i18nEnReload,
            i18nKoAgain,
            i18nFullOk,
            errors,
          },
          null,
          2,
        ),
      );
    }
    console.log(
      "VERIFY OK",
      JSON.stringify({
        mode: "core",
        sidebarGroups: sidebar.groups,
        teamLoading,
        teamFinal,
        terminal: { name: terminal.name, pane: terminal.pane, chars: terminal.chars },
        statusInitial,
        statusActiveAlias,
        statusLoading,
        i18nFullOk,
        lists: board.lists,
      }),
    );
  } finally {
    await browser.close();
  }
}

async function main() {
  const legacyFull = process.env.GROVE_VERIFY_FULL === "1" && process.env.GROVE_VERIFY_LEGACY_FULL === "1";
  if (!legacyFull) {
    await coreMain();
    return;
  }

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

    assertNoInboxUnblockCopy();
    assertNoDelegateTaskCopy();
    assertNoLegacyProjectMasterMock();
    assertNoLegacyProjectMasterE2eFixtures();
    assertLiveE2eDefaultsCurrentPort();
    assertLiveE2eAvoidsReentrantMasterChatPost();
    assertTerminalPaneDisablesXtermStdin();
    await verifyRetiredLegacySurfaces(browser);
    // The historical full-panel script below is intentionally archived. It
    // assumes the old all-surfaces sidebar and is no longer the default
    // legacy-full contract after the cockpit simplification.
    if (process.env.GROVE_VERIFY_ARCHIVED_FULL !== "1") return;

    await page.goto("file://" + htmlPath, { waitUntil: "load" });

    // Shell + board (default view).
    await page.waitForSelector(".devroom .dr-brand", { timeout: 8000 });
    await page.waitForFunction(() => document.querySelectorAll(".dr-node").length >= 1, { timeout: 8000 });
    await page.waitForFunction(() => document.querySelectorAll(".dr-card").length >= 1, { timeout: 8000 });

    // Onboarding is manual-only: it must not cover the live cockpit on first
    // paint, but the sidebar tutorial button should still launch the wizard.
    const wizInitiallyAbsent = await page.evaluate(() => !document.querySelector(".onb-wizard"));
    const sidebarTutorial = await page.evaluate(() => !!document.querySelector(".dr-tutorial-btn"));
    await page.click(".dr-tutorial-btn");
    await page.waitForSelector(".onb-wizard", { timeout: 8000 });
    const wizStep0 = await page.evaluate(() => ({
      visible: !!document.querySelector(".onb-wizard"),
      step: document.querySelector(".onb-step")?.getAttribute("data-step"),
      dots: document.querySelectorAll(".onb-stepper__dot").length,
    }));
    await page.click(".onb-next"); // welcome -> project
    await page.waitForSelector(".onb-proj-name", { timeout: 5000 });
    const wizStep1 = await page.evaluate(() => ({
      step: document.querySelector(".onb-step")?.getAttribute("data-step"),
      hasCreate: !!document.querySelector(".onb-proj-create"),
      hasLoad: !!document.querySelector(".onb-proj-load"),
      hasImport: !!document.querySelector(".onb-import-note"),
    }));
    await page.click(".onb-next"); // project -> board
    await page.waitForFunction(() => document.querySelector(".onb-step")?.getAttribute("data-step") === "2", { timeout: 5000 });
    const wizBoard = await page.evaluate(() => ({
      step: document.querySelector(".onb-step")?.getAttribute("data-step"),
      hasBoardCta: !!document.querySelector(".onb-goto-board"),
    }));
    await page.click(".onb-next"); // board -> node
    await page.waitForFunction(() => document.querySelector(".onb-step")?.getAttribute("data-step") === "3", { timeout: 5000 });
    const wizNode = await page.evaluate(() => ({
      step: document.querySelector(".onb-step")?.getAttribute("data-step"),
      hasTeamCta: !!document.querySelector(".onb-goto-team"),
    }));
    await page.click(".onb-next"); // node -> setup
    await page.waitForFunction(() => document.querySelector(".onb-step")?.getAttribute("data-step") === "4", { timeout: 5000 });
    const wizLast = await page.evaluate(() => ({
      step: document.querySelector(".onb-step")?.getAttribute("data-step"),
      hasFinish: !!document.querySelector(".onb-finish"),
      activeDot: Array.from(document.querySelectorAll(".onb-stepper__dot")).findIndex((d) => d.classList.contains("is-active")),
    }));
    await page.click(".onb-skip"); // skip/dismiss -> hide + persist flag
    await page.waitForFunction(() => !document.querySelector(".onb-wizard"), { timeout: 5000 });
    const wizFlag = await page.evaluate(() => localStorage.getItem("grove.onboarded.v3"));
    await page.reload({ waitUntil: "load" });
    await page.waitForSelector(".devroom .dr-brand", { timeout: 8000 });
    await page.waitForFunction(() => document.querySelectorAll(".dr-node").length >= 1, { timeout: 8000 });
    await page.waitForFunction(() => document.querySelectorAll(".dr-card").length >= 1, { timeout: 8000 });
    const wizAfterReload = await page.evaluate(() => !!document.querySelector(".onb-wizard"));
    await page.click(".dr-tutorial-btn");
    await page.waitForSelector(".onb-wizard", { timeout: 5000 });
    const sidebarTutorialOpen = await page.evaluate(
      () => document.querySelector(".onb-step")?.getAttribute("data-step") === "0",
    );
    await page.click(".onb-skip");
    await page.waitForFunction(() => !document.querySelector(".onb-wizard"), { timeout: 5000 });
    const wizardOk =
      wizInitiallyAbsent &&
      sidebarTutorial &&
      wizStep0.visible &&
      wizStep0.step === "0" &&
      wizStep0.dots === 5 &&
      wizStep1.step === "1" &&
      wizStep1.hasCreate &&
      wizStep1.hasLoad &&
      wizStep1.hasImport &&
      wizBoard.step === "2" &&
      wizBoard.hasBoardCta &&
      wizNode.step === "3" &&
      wizNode.hasTeamCta &&
      wizLast.step === "4" &&
      wizLast.hasFinish &&
      wizLast.activeDot === 4 &&
      wizFlag === "1" &&
      wizAfterReload === false &&
      sidebarTutorialOpen;

    // V2-W4 node status heatmap (from GET /api/status) + server health dot
    // (GET /api/health). Mock summary mirrors _node_liveness_summary:
    // running=2, idle=3, stale=0, error=1, total=6 — error is its OWN bucket,
    // NOT folded into stale, and idle is the backend's count (not derived).
    await page.waitForFunction(
      () => /\d/.test(document.querySelector(".nodestat__chip.is-running")?.textContent ?? ""),
      { timeout: 8000 },
    );
    await page.waitForSelector(".health-dot.is-ok", { timeout: 8000 });
    const statusBar = await page.evaluate(() => ({
      present: !!document.querySelector(".nodestat"),
      segs: document.querySelectorAll(".nodestat__seg").length,
      errSeg: !!document.querySelector(".nodestat__seg.is-error"),
      running: (document.querySelector(".nodestat__chip.is-running")?.textContent ?? "").trim(),
      idle: (document.querySelector(".nodestat__chip.is-idle")?.textContent ?? "").trim(),
      stale: (document.querySelector(".nodestat__chip.is-stale")?.textContent ?? "").trim(),
      error: (document.querySelector(".nodestat__chip.is-error")?.textContent ?? "").trim(),
      total: (document.querySelector(".nodestat__total")?.textContent ?? "").trim(),
      healthOk: !!document.querySelector(".health-dot.is-ok"),
    }));
    const num = (s) => parseInt((s || "").trim(), 10);
    const statusBarOk =
      statusBar.present &&
      statusBar.segs === 4 && // running/idle/stale/error
      statusBar.errSeg && // dedicated error segment in the bar
      num(statusBar.running) === 2 &&
      num(statusBar.idle) === 3 && // backend idle, not folded from error; human-as-node is idle/external
      num(statusBar.error) === 1 && // error is its own bucket
      num(statusBar.stale) === 0 &&
      /6/.test(statusBar.total) &&
      statusBar.healthOk;

    // V8-W1 presence indicator (GET /api/presence): team mode (default) → member
    // chips with role-coloured dots + name/role only (no id/secret); toggle to
    // local → "anonymous N". Toggle back to keep the header compact afterwards.
    await page.waitForFunction(() => document.querySelectorAll(".dr-presence__chip").length >= 1, { timeout: 8000 });
    const presence = await page.evaluate(() => {
      const el = document.querySelector(".dr-presence");
      const chips = Array.from(document.querySelectorAll(".dr-presence__chip"));
      return {
        present: !!el,
        chips: chips.length,
        names: chips.map((c) => c.getAttribute("data-member")),
        admin: !!document.querySelector(".dr-presence__chip.is-admin"),
        operator: !!document.querySelector(".dr-presence__chip.is-operator"),
        viewer: !!document.querySelector(".dr-presence__chip.is-viewer"),
        // name/role only — no id-/session-/token-like strings leak into the DOM.
        noLeak: !/sess-|token|"id"|_id/i.test(el?.textContent ?? ""),
      };
    });
    // Toggle to local and leave it: the compact "anonymous N" keeps the header
    // uncluttered for the remaining header-button tests (audit/chain/inbox/lang).
    await page.evaluate(() => window.__MOCK__?.setPresenceMode("local"));
    await page.waitForFunction(() => !!document.querySelector(".dr-presence__anon"), { timeout: 8000 });
    const presenceAnon = await page.evaluate(
      () => (document.querySelector(".dr-presence__anon")?.textContent ?? "").trim(),
    );
    const presenceOk =
      presence.present &&
      presence.chips === 3 &&
      presence.names.join(",") === "alice,bob,carol" &&
      presence.admin &&
      presence.operator &&
      presence.viewer &&
      presence.noLeak &&
      /1/.test(presenceAnon);

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

    // V12-W2b autopickup toggle (real config, distinct from the ⚡ inferred
    // badge): GET shows enabled state; POST flips it; global gate OFF disables
    // the toggle with a reason; a team-viewer 403 locks the toggles.
    const reopenDetail = async () => {
      await page.click(".nodestat__more"); // open
      await page.waitForSelector(".nodestat-detail .pickup-toggle", { timeout: 6000 });
    };
    const closeDetail = async () => {
      await page.click(".nodestat__more");
      await page.waitForFunction(() => !document.querySelector(".nodestat-detail"), { timeout: 5000 });
    };
    await reopenDetail();
    // Native el.click() for the toggles: the detail dropdown's absolute position
    // can foil page.click() coordinate targeting (same pattern as the org actions).
    const clickToggle = (n) => page.$eval(`.pickup-toggle[data-node="${n}"]`, (el) => el.click());
    const pickInit = await page.evaluate(() => {
      const tg = Array.from(document.querySelectorAll(".pickup-toggle"));
      return { count: tg.length, anyOn: tg.some((t) => t.getAttribute("data-enabled") === "1") };
    });
    const pNode = await page.evaluate(() => document.querySelector(".pickup-toggle")?.getAttribute("data-node"));
    // enable via POST
    await clickToggle(pNode);
    await page.waitForFunction(
      (n) => document.querySelector(`.pickup-toggle[data-node="${n}"]`)?.getAttribute("data-enabled") === "1",
      { timeout: 6000 },
      pNode,
    );
    const afterEnable = await page.evaluate(() => window.__MOCK__?.autopickupPost ?? null);
    // disable via POST
    await clickToggle(pNode);
    await page.waitForFunction(
      (n) => document.querySelector(`.pickup-toggle[data-node="${n}"]`)?.getAttribute("data-enabled") === "0",
      { timeout: 6000 },
      pNode,
    );
    const afterDisable = await page.evaluate(() => window.__MOCK__?.autopickupPost ?? null);

    // v1.13 execution toggle: a SEPARATE per-node flag rendered alongside the
    // autopickup toggle (both present), flipped via its own POST.
    const execToggleInit = await page.evaluate(() => ({
      execCount: document.querySelectorAll(".exec-toggle").length,
      pickupCount: document.querySelectorAll(".pickup-toggle").length,
    }));
    const eNode = await page.evaluate(() => document.querySelector(".exec-toggle")?.getAttribute("data-exec-node"));
    await page.$eval(`.exec-toggle[data-exec-node="${eNode}"]`, (el) => el.click());
    await page.waitForFunction(
      (n) => document.querySelector(`.exec-toggle[data-exec-node="${n}"]`)?.getAttribute("data-enabled") === "1",
      { timeout: 6000 },
      eNode,
    );
    const execToggled = await page.evaluate(() => window.__MOCK__?.execTogglePost ?? null);
    const execToggleOk =
      execToggleInit.execCount >= 1 &&
      execToggleInit.pickupCount >= 1 && // both flags shown (separate)
      Boolean(execToggled) &&
      execToggled.enabled === true;

    // global gate OFF -> toggle disabled + reason (no enable possible). Reopen
    // refetches fresh state (pickup is cleared on close, so no stale toggle).
    await page.evaluate(() => window.__MOCK__.setAutopickupGlobal(false, false));
    await closeDetail();
    await reopenDetail();
    const globalOffState = await page.evaluate(() => {
      const tg = document.querySelector(".pickup-toggle");
      return {
        disabled: !!tg && tg.disabled === true,
        locked: !!tg && tg.classList.contains("is-locked"),
        reason: (document.querySelector(".pickup-toggle__reason")?.textContent ?? "").trim(),
      };
    });

    // kill-switch ON (gate enabled=true, kill_switch=true) -> toggle disabled
    // with the dedicated kill-switch reason (distinct from the gate-off reason).
    await page.evaluate(() => window.__MOCK__.setAutopickupGlobal(true, true));
    await closeDetail();
    await reopenDetail();
    const killSwitchState = await page.evaluate(() => {
      const tg = document.querySelector(".pickup-toggle");
      return {
        disabled: !!tg && tg.disabled === true,
        reason: (document.querySelector(".pickup-toggle__reason")?.textContent ?? "").trim(),
      };
    });

    // team viewer -> POST 403 -> toggles locked + reason (gate restored first).
    await page.evaluate(() => window.__MOCK__.setAutopickupGlobal(true, false));
    await page.evaluate(() => (window.__MOCK__.denyAutopickup = true));
    await closeDetail();
    await reopenDetail();
    const vNode = await page.evaluate(() => document.querySelector(".pickup-toggle")?.getAttribute("data-node"));
    await clickToggle(vNode);
    await page.waitForFunction(
      () =>
        document.querySelectorAll(".pickup-toggle[disabled]").length >= 1 &&
        /권한|operator/.test(document.querySelector(".pickup-toggle__reason")?.textContent ?? ""),
      { timeout: 6000 },
    );
    const viewerState = await page.evaluate(() => ({
      disabled: document.querySelectorAll(".pickup-toggle[disabled]").length >= 1,
      reason: (document.querySelector(".pickup-toggle__reason")?.textContent ?? "").trim(),
      denials: window.__MOCK__?.autopickupDenied ?? 0,
    }));
    await page.evaluate(() => (window.__MOCK__.denyAutopickup = false));
    await closeDetail();

    // P2-1: mock mirrors backend node validation — invalid name 400, unknown
    // node 404, known node 200 (applies to GET + POST via _node_in_project).
    const nodeReject = await page.evaluate(async () => {
      const status = async (n) => (await fetch(`/api/nodes/${n}/autopickup`)).status;
      return { invalid: await status("bad%20name"), unknown: await status("ghostnode"), known: await status("root") };
    });

    const pickupToggleOk =
      pickInit.count >= 1 &&
      !pickInit.anyOn && // initially all off
      Boolean(afterEnable) &&
      afterEnable.enabled === true && // enable POST
      Boolean(afterDisable) &&
      afterDisable.enabled === false && // disable POST
      globalOffState.disabled &&
      globalOffState.locked &&
      /게이트|gate/.test(globalOffState.reason) && // global off -> disabled + reason
      killSwitchState.disabled &&
      /킬 스위치|kill-switch/.test(killSwitchState.reason) && // kill-switch on -> disabled + reason
      viewerState.disabled &&
      /권한|operator/.test(viewerState.reason) &&
      viewerState.denials >= 1 && // viewer 403 -> locked + reason
      nodeReject.invalid === 400 && // mock node validation (mirrors backend)
      nodeReject.unknown === 404 &&
      nodeReject.known === 200;

    // V4-W1 audit drawer (GET /api/audit): events render, cursor paging, filter.
    await page.$eval(".dr-audit-btn", (el) => el.click());
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

    // V11-W2 autonomy visibility (audit): autopickup/retro events get distinct
    // chips + glyphs and quick action filters (exact action filter on /api/audit).
    await page.$eval(".dr-audit-btn", (el) => el.click());
    await page.waitForSelector(".audit-drawer", { timeout: 5000 });
    // The drawer re-renders (not remounts), so clear the node filter carried over
    // from the auditOk test before exercising the action quick-filters.
    await page.click('.audit-filter input[name="node"]', { clickCount: 3 });
    await page.keyboard.press("Backspace");
    await page.waitForFunction(() => /node=&/.test(window.__MOCK__?.auditFilter ?? ""), { timeout: 5000 });
    await page.click('.audit-qf[data-action="autopickup"]');
    await page.waitForFunction(
      () => {
        const evs = Array.from(document.querySelectorAll(".audit-event"));
        return (
          evs.length >= 1 &&
          evs.every((e) => e.querySelector(".audit-event__action")?.getAttribute("data-action") === "autopickup")
        );
      },
      { timeout: 6000 },
    );
    const autoPick = await page.evaluate(() => ({
      count: document.querySelectorAll(".audit-event.is-autopickup").length,
      chip: !!document.querySelector(".audit-event__action.is-autopickup"),
      glyph: !!document.querySelector(".audit-event.is-autopickup .audit-event__glyph"),
      filter: window.__MOCK__?.auditFilter ?? "",
    }));
    await page.click('.audit-qf[data-action="retro"]');
    await page.waitForFunction(
      () => {
        const evs = Array.from(document.querySelectorAll(".audit-event"));
        return (
          evs.length >= 1 &&
          evs.every((e) => e.querySelector(".audit-event__action")?.getAttribute("data-action") === "retro")
        );
      },
      { timeout: 6000 },
    );
    const autoRetro = await page.evaluate(() => ({
      count: document.querySelectorAll(".audit-event.is-retro").length,
      chip: !!document.querySelector(".audit-event__action.is-retro"),
    }));
    await page.click(".audit-drawer .dr-drawer__close");
    await page.waitForFunction(() => !document.querySelector(".audit-drawer"), { timeout: 5000 });
    const autoAuditOk =
      autoPick.count >= 1 &&
      autoPick.chip &&
      autoPick.glyph &&
      /action=autopickup/.test(autoPick.filter) &&
      autoRetro.count >= 1 &&
      autoRetro.chip;

    // V6-W3 delegation-chain explorer: multi-hop chains derived from the audit
    // assign/delegate graph (mock has root->backend->researcher). Open the
    // drawer, assert a >=3-node (2-hop) chain in order, then focus a node.
    await page.$eval(".dr-chain-btn", (el) => el.click());
    await page.waitForSelector(".chain-drawer", { timeout: 5000 });
    await page.waitForFunction(() => document.querySelectorAll(".chain-row").length >= 1, { timeout: 6000 });
    const chain = await page.evaluate(() => {
      const rows = Array.from(document.querySelectorAll(".chain-row"));
      const multi = rows.find((r) => r.querySelectorAll(".chain-node").length >= 3);
      const nodesOf = (r) =>
        Array.from(r.querySelectorAll(".chain-node")).map((n) => n.getAttribute("data-node"));
      return {
        rows: rows.length,
        hasMultiHop: !!multi,
        multiNodes: multi ? nodesOf(multi) : [],
        arrows: multi ? multi.querySelectorAll(".chain-arrow").length : 0,
      };
    });
    // Focus a node: only chains through it remain, with that chip highlighted.
    await page.type('.chain-filter input[name="node"]', "researcher");
    await page.waitForFunction(
      () =>
        document.querySelectorAll(".chain-row").length >= 1 && !!document.querySelector(".chain-node.is-focus"),
      { timeout: 5000 },
    );
    const chainFocus = await page.evaluate(() => ({
      rows: document.querySelectorAll(".chain-row").length,
      focus: document.querySelector(".chain-node.is-focus")?.getAttribute("data-node") ?? "",
      allThroughFocus: Array.from(document.querySelectorAll(".chain-row")).every((r) =>
        Array.from(r.querySelectorAll(".chain-node")).some((n) => n.getAttribute("data-node") === "researcher"),
      ),
    }));
    await page.click(".chain-drawer .dr-drawer__close");
    await page.waitForFunction(() => !document.querySelector(".chain-drawer"), { timeout: 5000 });
    const chainOk =
      chain.rows >= 1 &&
      chain.hasMultiHop &&
      chain.multiNodes.join(">") === "root>backend>researcher" &&
      chain.arrows >= 2 &&
      chainFocus.rows >= 1 &&
      chainFocus.focus === "researcher" &&
      chainFocus.allThroughFocus;

    // V7-W1 decision inbox: header badge count, list of blocked/ask-human items,
    // answer an item -> POST /api/tasks/{id}/answer -> item drops out + badge
    // decrements; then a 403 (team viewer) locks the answer UI behind a notice.
    const inboxBadgeBefore = await page.evaluate(
      () => (document.querySelector(".dr-inbox-btn__badge")?.textContent ?? "").trim(),
    );
    await page.$eval(".dr-inbox-btn", (el) => el.click());
    await page.waitForSelector(".inbox-drawer", { timeout: 5000 });
    await page.waitForFunction(() => document.querySelectorAll(".inbox-item").length >= 1, { timeout: 6000 });
    const inboxBefore = await page.evaluate(() => ({
      items: document.querySelectorAll(".inbox-item").length,
      hasHuman: !!document.querySelector(".inbox-type.is-human"),
      hasReason: !!document.querySelector(".inbox-item__reason"),
      hasAnswer: !!document.querySelector('[data-task="H-1"] .inbox-answer__input'),
      placeholder: document.querySelector('[data-task="H-1"] .inbox-answer__input')?.getAttribute("placeholder") ?? "",
      answerButton: (document.querySelector('[data-task="H-1"] .inbox-answer__submit')?.textContent ?? "").trim(),
    }));
    // Answer H-1 -> POST -> it drops out of the list.
    await page.type('[data-task="H-1"] .inbox-answer__input', "approved: ship Friday");
    await page.click('[data-task="H-1"] .inbox-answer__submit');
    await page.waitForFunction(() => !document.querySelector('[data-task="H-1"]'), { timeout: 6000 });
    const answered = await page.evaluate(() => ({
      task: window.__MOCK__?.answeredTask ?? "",
      text: window.__MOCK__?.answerText ?? "",
      removed: window.__MOCK__?.inboxRemoved ?? 0,
      items: document.querySelectorAll(".inbox-item").length,
    }));
    // Header badge decremented (liveTick refetch of the count).
    await page.waitForFunction(
      (prev) => (document.querySelector(".dr-inbox-btn__badge")?.textContent ?? "").trim() !== prev,
      { timeout: 6000 },
      inboxBadgeBefore,
    );
    const inboxBadgeAfter = await page.evaluate(
      () => (document.querySelector(".dr-inbox-btn__badge")?.textContent ?? "").trim(),
    );
    // Team-viewer denial: next answer 403 -> safe notice + answer UI hidden.
    await page.evaluate(() => (window.__MOCK__.denyAnswer = true));
    await page.type('[data-task="H-2"] .inbox-answer__input', "should fail");
    await page.click('[data-task="H-2"] .inbox-answer__submit');
    await page.waitForSelector(".inbox-denied", { timeout: 6000 });
    const deniedState = await page.evaluate(() => ({
      notice: !!document.querySelector(".inbox-denied"),
      answerHidden: !document.querySelector(".inbox-answer__input"),
    }));
    await page.evaluate(() => (window.__MOCK__.denyAnswer = false));
    await page.click(".inbox-drawer .dr-drawer__close");
    await page.waitForFunction(() => !document.querySelector(".inbox-drawer"), { timeout: 5000 });
    const inboxOk =
      inboxBadgeBefore === "2" &&
      inboxBefore.items === 2 &&
      inboxBefore.hasHuman &&
      inboxBefore.hasReason &&
      inboxBefore.hasAnswer &&
      !/(작업을 해제|unblock the task|답변·해제|answer\s*·\s*unblock)/i.test(
        `${inboxBefore.placeholder} ${inboxBefore.answerButton}`,
      ) &&
      answered.task === "H-1" &&
      answered.text === "approved: ship Friday" &&
      answered.removed === 1 &&
      answered.items === 1 &&
      inboxBadgeAfter === "1" &&
      deniedState.notice &&
      deniedState.answerHidden;

    // #1 i18n: Korean by default; KO/EN toggle flips all labels, then back.
    const brandText = () => page.$eval(".dr-brand__title", (el) => (el.textContent ?? "").trim());
    const i18n = { ko: await brandText(), en: "" };
    await page.click('.dr-lang__btn[data-lang="en"]');
    await page.waitForFunction(
      () => (document.querySelector(".dr-brand__title")?.textContent ?? "").trim() === "GROVE",
      { timeout: 5000 },
    );
    i18n.en = await brandText();
    await page.click('.dr-lang__btn[data-lang="ko"]');
    await page.waitForFunction(
      () => (document.querySelector(".dr-brand__title")?.textContent ?? "").trim() === "GROVE",
      { timeout: 5000 },
    );
    const shellBatch = await page.evaluate(() => {
      const nodes = Array.from(document.querySelectorAll(".dr-node"));
      const depths = nodes.map((n) => Number(n.getAttribute("data-depth") ?? "0"));
      return {
        brand: (document.querySelector(".dr-brand__title")?.textContent ?? "").trim(),
        markSvgSource:
          document
            .querySelector('.dr-brand .dr-mark source[type="image/svg+xml"]')
            ?.getAttribute("srcset") ?? "",
        markPngFallback: document.querySelector(".dr-brand .dr-mark img")?.getAttribute("src") ?? "",
        markCurrentSrc: document.querySelector(".dr-brand .dr-mark img")?.currentSrc ?? "",
        markLoaded: (document.querySelector(".dr-brand .dr-mark img")?.naturalWidth ?? 0) > 0,
        noDevRoomSub: !/개발실|dev room/i.test(document.querySelector(".dr-brand")?.textContent ?? ""),
        nodes: nodes.length,
        nested: depths.some((d) => d >= 1),
        roots: depths.filter((d) => d === 0).length,
        tutorial: !!document.querySelector(".dr-tutorial-btn"),
      };
    });

    // Capture board counts WHILE the board view is mounted.
    const board = await page.evaluate(() => ({
      columns: document.querySelectorAll(".dr-col").length,
      cards: document.querySelectorAll(".dr-card").length,
    }));
    const boardBatch = await page.evaluate(() => {
      return {
        addButtons: document.querySelectorAll(".dr-col__add").length,
        readyHasAdd: !!document.querySelector('.dr-col[data-col="ready"] .dr-col__add'),
        progressHasAdd: !!document.querySelector('.dr-col[data-col="running"] .dr-col__add'),
        reviewHasAdd: !!document.querySelector('.dr-col[data-col="review"] .dr-col__add'),
        blockedHasAdd: !!document.querySelector('.dr-col[data-col="blocked"] .dr-col__add'),
        askHumanHasAdd: !!document.querySelector('.dr-col[data-col="ask_human"] .dr-col__add'),
        doneHasAdd: !!document.querySelector('.dr-col[data-col="done"] .dr-col__add'),
      };
    });
    await page.$eval('.dr-col[data-col="review"] .dr-col__add', (el) => el.click());
    await page.waitForSelector(".dr-addform", { timeout: 5000 });
    const boardBatchAdd = await page.$eval('.dr-addform select[name="status"]', (el) => el.value);
    await page.$eval(".dr-addform__cancel", (el) => el.click());
    await page.waitForFunction(() => !document.querySelector(".dr-addform"), { timeout: 5000 });

    // 긴급 #4 board card: the TITLE is the primary text (>= the id slug), the raw
    // id is only a small secondary slug, and long ids/titles WRAP — never causing
    // horizontal overflow. We inject a 60-char unbreakable token into a title to
    // prove wrapping without needing a long-id fixture.
    const boardCard = await page.evaluate(() => {
      const card = document.querySelector(".dr-card");
      const titleEl = card?.querySelector(".dr-card__title");
      const idEl = card?.querySelector(".dr-card__id");
      const titleCs = titleEl ? getComputedStyle(titleEl) : null;
      const titleFs = titleEl ? parseFloat(titleCs.fontSize) : 0;
      const idFs = idEl ? parseFloat(getComputedStyle(idEl).fontSize) : 0;
      // probe overflow with a long unbreakable token in a real card title
      const probe = document.querySelector(".dr-card__title");
      const orig = probe ? probe.textContent : "";
      if (probe) probe.textContent = "task_" + "2398abcdef0123456789".repeat(3); // 65 chars, no spaces
      const cards = Array.from(document.querySelectorAll(".dr-card"));
      const cols = Array.from(document.querySelectorAll(".dr-col"));
      const noOverflow =
        cards.every((c) => c.scrollWidth <= c.clientWidth + 1) &&
        cols.every((c) => c.scrollWidth <= c.clientWidth + 1);
      if (probe) probe.textContent = orig; // restore
      return {
        titlePresent: (titleEl?.textContent ?? "").trim().length > 0,
        titleProminent: titleFs >= idFs && titleFs >= 13, // title is the largest text
        idSecondary: idFs > 0 && idFs < titleFs, // id slug is smaller/secondary
        wraps: !!titleCs && (titleCs.overflowWrap === "anywhere" || titleCs.wordBreak === "break-word" || titleCs.wordBreak === "break-all"),
        noOverflow,
      };
    });
    const boardCardOk =
      boardCard.titlePresent && boardCard.titleProminent && boardCard.idSecondary && boardCard.wraps && boardCard.noOverflow;

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
    await page.$eval(".dr-card__open", (el) => el.click());
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

    // v1.11 planner FE surfacing: read-only ranked node recommendations in the
    // task drawer. Snapshot task-mutation diag before/after to prove recommending
    // never auto-assigns/claims (read_only is preserved end to end).
    const mutBefore = await page.evaluate(() =>
      JSON.stringify({
        lastTaskPost: window.__MOCK__?.lastTaskPost ?? null,
        assignedAssignee: window.__MOCK__?.assignedAssignee ?? "",
      }),
    );
    await page.waitForSelector(".plan-panel .plan-role", { timeout: 6000 });
    await page.click(".plan-panel .plan-role", { clickCount: 3 }); // clear prefilled role
    await page.keyboard.press("Backspace");
    await page.type(".plan-panel .plan-role", "backend");
    await page.click(".plan-panel .plan-run");
    await page.waitForFunction(() => document.querySelectorAll(".plan-cand").length >= 1, { timeout: 6000 });
    const planner = await page.evaluate(() => {
      const cands = Array.from(document.querySelectorAll(".plan-cand"));
      return {
        count: cands.length,
        nodes: cands.map((c) => c.getAttribute("data-node")),
        firstRank: (cands[0]?.querySelector(".plan-cand__rank")?.textContent ?? "").trim(),
        hasScore: !!document.querySelector(".plan-cand__score"),
        factors: document.querySelectorAll(".plan-factor").length,
        hasConf: !!document.querySelector(".plan-conf"),
        readonly: !!document.querySelector(".plan-readonly"),
        readonlyText: (document.querySelector(".plan-readonly")?.textContent ?? "").trim(),
        role: window.__MOCK__?.planRole ?? "",
        fetches: window.__MOCK__?.planFetches ?? 0,
      };
    });
    const mutAfter = await page.evaluate(() =>
      JSON.stringify({
        lastTaskPost: window.__MOCK__?.lastTaskPost ?? null,
        assignedAssignee: window.__MOCK__?.assignedAssignee ?? "",
      }),
    );
    // P2: mock redaction mirrors backend _plan_public_terms in TWO stages and
    // order — _safe_log_text (absolute path -> [path], secret -> [redacted])
    // BEFORE tokenizing. An absolute path + secret-token role must therefore
    // come back masked with NO "passwd"/"xoxb"/"etc" leaking through.
    await page.click(".plan-panel .plan-role", { clickCount: 3 });
    await page.keyboard.press("Backspace");
    await page.type(".plan-panel .plan-role", "/etc/passwd xoxb-1234567890abcdef backend");
    await page.click(".plan-panel .plan-run");
    await page.waitForFunction(() => (window.__MOCK__?.planFetches ?? 0) >= 2, { timeout: 6000 });
    const redactTerms = await page.evaluate(() => window.__MOCK__?.planRoleTerms ?? []);
    const redactionOk =
      Array.isArray(redactTerms) &&
      redactTerms.includes("path") && // /etc/passwd absolute path masked
      redactTerms.includes("redacted") && // xoxb-… secret token masked
      redactTerms.includes("backend") &&
      !redactTerms.includes("passwd") && // leaf must NOT survive the path mask
      !redactTerms.includes("xoxb") && // secret prefix must NOT survive
      !redactTerms.includes("etc") &&
      !redactTerms.some((x) => typeof x === "string" && x.length > 48);

    // V12-W2 planner -> delegate one-click: EXPLICIT two-step (button -> confirm).
    // Candidates are present (from the recommend above). Recommending alone never
    // POSTs (proven by mutBefore===mutAfter); the "Delegate" button only opens a
    // confirm (still no POST); the delegate POST fires only after "Confirm".
    const delegBefore = await page.evaluate(() => JSON.stringify(window.__MOCK__?.lastTaskPost ?? null));
    await page.click('[data-node="backend"] .plan-deleg__btn');
    await page.waitForSelector('[data-node="backend"] .plan-deleg__yes', { timeout: 5000 });
    const afterAsk = await page.evaluate(() => JSON.stringify(window.__MOCK__?.lastTaskPost ?? null));
    await page.click('[data-node="backend"] .plan-deleg__yes');
    await page.waitForSelector('[data-node="backend"] .plan-deleg__ok', { timeout: 6000 });
    const delegated = await page.evaluate(() => ({
      post: window.__MOCK__?.lastTaskPost ?? null,
      ok: !!document.querySelector('[data-node="backend"] .plan-deleg__ok'),
      okText: (document.querySelector('[data-node="backend"] .plan-deleg__ok')?.textContent ?? "").trim(),
    }));
    const plannerDelegateOk =
      delegBefore === afterAsk && // confirm step: NO POST before "Confirm"
      delegated.ok &&
      Boolean(delegated.post) &&
      delegated.post.assignee === "backend" &&
      delegated.post.status === "ready" &&
      delegBefore !== JSON.stringify(delegated.post); // POST only after confirm

    // P1: an error must render a FIXED message — never the raw cause / request
    // path / role input (which could be a secret).
    await page.evaluate(() => (window.__MOCK__.planError = true));
    await page.click(".plan-panel .plan-role", { clickCount: 3 });
    await page.keyboard.press("Backspace");
    await page.type(".plan-panel .plan-role", "xoxb-leak-secret-role");
    await page.click(".plan-panel .plan-run");
    await page.waitForSelector(".plan-panel .plan-msg.is-error", { timeout: 6000 });
    const errState = await page.evaluate(() => {
      const txt = (document.querySelector(".plan-panel .plan-msg.is-error")?.textContent ?? "").trim();
      return { text: txt, leak: /xoxb-leak-secret-role|\/api\/plan|HTTP \d|task_id=/.test(txt) };
    });
    await page.evaluate(() => (window.__MOCK__.planError = false));
    const errorNoLeakOk =
      /추천을 불러오지 못했습니다|Couldn't load/.test(errState.text) && errState.leak === false;

    const plannerSurfaceOk =
      planner.count >= 3 &&
      planner.firstRank === "#1" &&
      planner.nodes[0] === "backend" &&
      planner.hasScore &&
      planner.factors >= 3 &&
      planner.hasConf &&
      planner.readonly &&
      /자동 배정하지 않습니다|수동/.test(planner.readonlyText) &&
      planner.role === "backend" &&
      planner.fetches >= 1 &&
      mutBefore === mutAfter && // no auto-delegation as a side effect
      redactionOk &&
      plannerDelegateOk &&
      errorNoLeakOk;

    // Close the task drawer.
    await page.click(".dr-drawer__close");
    await page.waitForFunction(() => !document.querySelector(".dr-drawer"), { timeout: 8000 });

    // v1.13 execution loop — timeline (per-task transitions) + approval queue.
    // Timeline: open G-2's drawer (it carries audit.execution.* transitions).
    await page.evaluate(() => {
      const card = Array.from(document.querySelectorAll(".dr-card")).find((c) =>
        (c.querySelector(".dr-card__id")?.textContent ?? "").includes("G-2"),
      );
      card?.querySelector(".dr-card__open")?.click();
    });
    await page.waitForSelector(".exec-timeline__item", { timeout: 8000 });
    const timeline = await page.evaluate(() => {
      const items = Array.from(document.querySelectorAll(".exec-timeline__item"));
      return {
        count: items.length,
        phases: items.map((i) => i.getAttribute("data-phase")),
        // V15-W2 gantt/step viz: bars + per-phase durations + current highlight + total.
        bars: document.querySelectorAll(".exec-gantt__bar").length,
        durations: items.map((i) => i.getAttribute("data-duration")),
        current: document.querySelector(".exec-timeline__item.is-current")?.getAttribute("data-phase") ?? "",
        currentBar: !!document.querySelector(".exec-gantt__bar.is-current"),
        total: (document.querySelector(".exec-timeline__total")?.textContent ?? "").trim(),
        durText: (document.querySelector(".exec-timeline__dur")?.textContent ?? "").trim(),
      };
    });
    // V17-W2 handoff EXPORT: from the open task drawer, generate a SIGNED
    // package. The copyable JSON carries the signature (receiver needs it to
    // verify); the human meta line shows only handoff_id + key_id (never the
    // signing key). Read-only: exporting must not mutate the receiver/sender.
    await page.$eval(".handoff-export__btn", (el) => el.click());
    await page.waitForSelector('.handoff-pkg[data-handoff="export"]', { timeout: 8000 });
    const hExport = await page.evaluate(() => {
      const ta = document.querySelector(".handoff-export__json");
      const jsonText = ta ? ta.value : "";
      let parsed = null;
      try {
        parsed = JSON.parse(jsonText);
      } catch {
        /* ignore */
      }
      const meta = document.querySelector(".handoff-pkg__meta")?.textContent ?? "";
      return {
        shown: !!document.querySelector('.handoff-pkg[data-handoff="export"]'),
        idShown: /^handoff_[A-Za-z0-9_-]{16,}$/.test(document.querySelector(".handoff-pkg__id")?.textContent ?? ""),
        keyShown: /room-alpha/.test(document.querySelector(".handoff-pkg__key")?.textContent ?? ""),
        copyBtn: !!document.querySelector(".handoff-export__copy"),
        // human meta line shows key_id but never the raw signature digest.
        metaNoSig: !/hs_[0-9a-f]/.test(meta),
        jsonText,
        keyId: parsed?.key_id ?? "",
        hasSig: typeof parsed?.signature === "string" && parsed.signature.length > 0,
        handoffId: parsed?.payload?.handoff_id ?? "",
        exported: window.__MOCK__?.handoffExported ?? "",
      };
    });
    await page.click(".dr-drawer__close");
    await page.waitForFunction(() => !document.querySelector(".dr-drawer"), { timeout: 8000 });
    const execTimelineOk =
      timeline.count === 7 && // full 7-step happy path (mirrors store.py)
      timeline.phases[0] === "claim" &&
      timeline.phases.includes("approval-pending") && // was missing pre-v1.15
      timeline.phases.includes("approve") &&
      timeline.phases[timeline.phases.length - 1] === "complete";
    const execTimelineVizOk =
      timeline.bars === 7 && // one gantt bar per phase
      timeline.durations[0] === "10" && // claim phase: 10s
      timeline.durations[1] === "30" && // preflight: 30s
      timeline.durations[2] === "60" && // approval-pending: 60s (human wait)
      timeline.durations[6] === "" && // complete (latest) has no duration
      timeline.current === "complete" && // latest phase highlighted
      timeline.currentBar &&
      timeline.total.length > 0 && // total duration shown
      timeline.durText === "10s"; // first row renders its computed duration

    // Approval queue: approve + abort are EXPLICIT (button → confirm → POST).
    await page.$eval('.dr-tab[data-view="exec"]', (el) => el.click());
    await page.waitForSelector(".exec-queue", { timeout: 8000 });
    await page.waitForFunction(() => document.querySelectorAll(".exec-queue__item").length >= 2, { timeout: 8000 });
    const queueInit = await page.evaluate(() => ({
      count: document.querySelectorAll(".exec-queue__item").length,
      tasks: Array.from(document.querySelectorAll(".exec-queue__item")).map((i) => i.getAttribute("data-task")),
      gate: !!document.querySelector(".exec-gate"),
    }));

    // P1: team viewer -> approve/abort/kill-switch controls PROACTIVELY hidden
    // (queue still populated). Re-enter the tab to refetch /api/me.
    const reenterExec = async () => {
      await page.$eval('.dr-tab[data-view="board"]', (el) => el.click());
      await page.waitForFunction(() => document.querySelectorAll(".dr-card").length >= 1, { timeout: 8000 });
      await page.$eval('.dr-tab[data-view="exec"]', (el) => el.click());
      await page.waitForSelector(".exec-queue", { timeout: 8000 });
    };
    await page.evaluate(() => window.__MOCK__.setViewer(true));
    await reenterExec();
    await page.waitForSelector(".exec-viewer-note", { timeout: 8000 });
    const viewerLock = await page.evaluate(() => ({
      note: !!document.querySelector(".exec-viewer-note"),
      ks: document.querySelectorAll(".exec-ks__btn").length,
      approve: document.querySelectorAll(".exec-approve-btn").length,
      abort: document.querySelectorAll(".exec-abort-btn").length,
      readonly: document.querySelectorAll(".exec-queue__readonly").length,
    }));
    const viewerLockOk =
      viewerLock.note &&
      viewerLock.ks === 0 &&
      viewerLock.approve === 0 &&
      viewerLock.abort === 0 &&
      viewerLock.readonly >= 2;
    await page.evaluate(() => window.__MOCK__.setViewer(false));
    await reenterExec();
    await page.waitForSelector(".exec-approve-btn", { timeout: 8000 });

    const beforeApprove = await page.evaluate(() => window.__MOCK__?.execApprove ?? null);
    await page.click('[data-task="G-5"] .exec-approve-btn');
    await page.waitForSelector('[data-task="G-5"] .exec-confirm-yes', { timeout: 5000 });
    const execAfterAsk = await page.evaluate(() => window.__MOCK__?.execApprove ?? null);
    await page.click('[data-task="G-5"] .exec-confirm-yes');
    await page.waitForFunction(() => !document.querySelector('[data-task="G-5"]'), { timeout: 6000 });
    const approved = await page.evaluate(() => window.__MOCK__?.execApprove ?? null);
    await page.click('[data-task="G-6"] .exec-abort-btn');
    await page.waitForSelector('[data-task="G-6"] .exec-confirm-yes', { timeout: 5000 });
    await page.click('[data-task="G-6"] .exec-confirm-yes');
    await page.waitForFunction(() => !document.querySelector('[data-task="G-6"]'), { timeout: 6000 });
    const aborted = await page.evaluate(() => window.__MOCK__?.execAbort ?? null);
    const execQueueOk =
      queueInit.count >= 2 &&
      queueInit.gate &&
      queueInit.tasks.includes("G-5") &&
      queueInit.tasks.includes("G-6") &&
      beforeApprove === null &&
      execAfterAsk === null && // confirm step: NO POST before "Confirm"
      approved === "G-5" &&
      aborted === "G-6";

    // P2-4: kill-switch arm is also explicit (confirm BEFORE the POST fires).
    const gateBeforeKs = await page.evaluate(() => JSON.stringify(window.__MOCK__?.execGatePost ?? null));
    await page.click('.exec-ks__btn[data-ks="global"]');
    await page.waitForSelector(".exec-confirm--gate .exec-confirm-yes", { timeout: 5000 });
    const gateAfterAsk = await page.evaluate(() => JSON.stringify(window.__MOCK__?.execGatePost ?? null));
    await page.click(".exec-confirm--gate .exec-confirm-yes");
    await page.waitForFunction(() => window.__MOCK__?.execGatePost?.kill_switch === true, { timeout: 6000 });
    const ksArmed = await page.evaluate(() => window.__MOCK__?.execGatePost?.kill_switch === true);
    const killSwitchOk = gateBeforeKs === gateAfterAsk && ksArmed; // no POST before confirm
    // clear it back so the gate is restored.
    await page.click('.exec-ks__btn[data-ks="global"]');
    await page.waitForSelector(".exec-confirm--gate .exec-confirm-yes", { timeout: 5000 });
    await page.click(".exec-confirm--gate .exec-confirm-yes");
    await page.waitForFunction(() => window.__MOCK__?.execGatePost?.kill_switch === false, { timeout: 6000 });

    // Return to the board view so the remaining board tests run as before.
    await page.$eval('.dr-tab[data-view="board"]', (el) => el.click());
    await page.waitForFunction(() => document.querySelectorAll(".dr-card").length >= 1, { timeout: 8000 });

    const execLoopOk =
      execToggleOk && execTimelineOk && execTimelineVizOk && execQueueOk && viewerLockOk && killSwitchOk;

    // #4 board live (claim -> running -> done): a board-tail event must reload
    // the snapshot and re-column the card. The live spark lights while the
    // socket is up. COLUMNS: triage,todo,scheduled,ready,running,blocked,review,done.
    await page.waitForSelector(".dr-spark.is-on", { timeout: 8000 });
    const boardLiveSpark = await page.evaluate(() => !!document.querySelector(".dr-spark.is-on"));
    const RUNNING_COL = 1; // running (canonical order: ready, running, ...)
    const DONE_COL = 5;
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
    const claimColBefore = await colIndexOf("G-4"); // ready = column 0
    await page.evaluate(() => window.__MOCK__?.claimTask("G-4"));
    await cardInCol(RUNNING_COL, "G-4");
    const claimCol = await colIndexOf("G-4");
    await page.evaluate(() => window.__MOCK__?.completeTask("G-4"));
    await cardInCol(DONE_COL, "G-4");
    const completeCol = await colIndexOf("G-4");
    const boardLiveOk =
      boardLiveSpark === true &&
      claimColBefore === 0 && // ready is column 0
      claimCol === RUNNING_COL &&
      completeCol === DONE_COL;

    // V7-W3 board cursor replay: on reconnect the FE requests events-after its
    // last-seen cursor (precise), NOT a from-0 reload. An event that lands
    // during downtime is replayed — scoped to exactly the missed event(s).
    const liveMaxBefore = await page.evaluate(() => window.__MOCK__?.boardLiveMaxCursor ?? 0);
    const connBeforeReplay = await page.evaluate(() => window.__MOCK__?.boardWsConnects ?? 0);
    await page.evaluate(() => window.__MOCK__?.closeBoard(1006));
    // Push a board event while the socket is down (G-5 todo -> running): missed
    // live, recoverable only via the reconnect's events-after-cursor replay.
    await page.evaluate(() => window.__MOCK__?.missEvent("G-5", "running", "task.claimed"));
    await page.waitForFunction(
      (prev) => (window.__MOCK__?.boardWsConnects ?? 0) > prev,
      { timeout: 8000 },
      connBeforeReplay,
    );
    await cardInCol(RUNNING_COL, "G-5");
    const replay = await page.evaluate(() => ({
      cursorParam: window.__MOCK__?.boardCursorParam ?? -1,
      replayCount: window.__MOCK__?.boardLastReplayCount ?? -1,
    }));
    const cursorReplayOk =
      liveMaxBefore > 0 &&
      replay.cursorParam === liveMaxBefore && // reconnected with the tracked cursor
      replay.replayCount === 1; // only the 1 missed event replayed (not from 0)

    // #N4 board WS lifecycle (여정6: WS 재연결·백오프): onopen catch-up reload,
    // non-4401 close -> reconnect, 4401 (auth reject) -> stop the loop.
    const REVIEW_COL = 2;
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
    const BLOCKED_COL = 3;
    const n2BlockedCol = await colIndexOf("G-7"); // G-7 is seeded status: "blocked"
    await page.evaluate(() => {
      const cards = Array.from(document.querySelectorAll(".dr-card"));
      const target = cards.find((c) => (c.querySelector(".dr-card__id")?.textContent ?? "").includes("G-7"));
      target?.querySelector(".dr-card__open")?.click();
    });
    await page.waitForSelector(".dr-drawer__panel", { timeout: 8000 });
    const n2Drawer = await page.evaluate(() => ({
      ticket: (document.querySelector(".dr-drawer__ticket")?.textContent ?? "").trim(),
      hasPill: !!document.querySelector(".dr-drawer .dr-pill"),
    }));
    await page.click(".dr-drawer__close");
    await page.waitForFunction(() => !document.querySelector(".dr-drawer"), { timeout: 8000 });
    const n2Ok = n2BlockedCol === BLOCKED_COL && n2Drawer.ticket === "G-7" && n2Drawer.hasPill === true;

    // v1.29 manual workflow status (task_d0ed0b8 / task_ae67d): the on-card status
    // dropdown issues a real PATCH /api/tasks/{id}/status (canonical key) and the
    // card moves to its new column on the refetch. Drive G-7 (blocked) -> review
    // via its own card's <select>, then restore it so downstream state is intact.
    const manualFrom = await colIndexOf("G-7"); // BLOCKED_COL
    const cardManualOptions = await page.$$eval('.dr-card[data-task="G-7"] .dr-card__status option', (els) =>
      els.map((el) => el.getAttribute("value") ?? ""),
    );
    await page.evaluate(() => {
      if (window.__MOCK__) window.__MOCK__.statusPatched = null;
    });
    await page.select('.dr-card[data-task="G-7"] .dr-card__status', "review");
    await cardInCol(REVIEW_COL, "G-7");
    const manualTo = await colIndexOf("G-7");
    const manualStatusDiag = await page.evaluate(() => window.__MOCK__?.statusPatched ?? null);
    await page.select('.dr-card[data-task="G-7"] .dr-card__status', "blocked"); // restore
    await cardInCol(BLOCKED_COL, "G-7");
    const manualStatusOk =
      manualFrom === BLOCKED_COL &&
      manualTo === REVIEW_COL &&
      !cardManualOptions.includes("ask_human") &&
      !!manualStatusDiag &&
      manualStatusDiag.id === "G-7" &&
      manualStatusDiag.canonical === "review";

    // v1.29 reviewer field (task_c7e0363f): (a) a reviewed card shows the reviewer
    // badge; (b) the add form carries a reviewer dropdown whose value reaches the
    // create POST; (c) the drawer reviewer dropdown PATCHes /reviewer and the
    // drawer reflects it. G-2 was seeded with reviewer "researcher".
    const reviewerBadge = await page.evaluate(() => {
      const card = document.querySelector('.dr-card[data-task="G-2"]');
      const b = card?.querySelector(".dr-card__reviewer");
      return { present: !!b, reviewer: b?.getAttribute("data-reviewer") ?? "" };
    });
    // (b) create with reviewer via the add form.
    await page.evaluate(() => {
      if (window.__MOCK__) window.__MOCK__.lastTaskPost = null;
    });
    await page.$eval(".dr-addbtn", (el) => el.click());
    await page.waitForSelector(".dr-addform__reviewer", { timeout: 5000 });
    await page.type('.dr-addform input[name="title"]', "Reviewed task");
    await page.select(".dr-addform__reviewer", "researcher");
    await page.click(".dr-addform__submit");
    await page.waitForFunction(() => (window.__MOCK__?.lastTaskPost?.reviewer ?? "") === "researcher", {
      timeout: 6000,
    });
    const reviewerCreate = await page.evaluate(() => window.__MOCK__?.lastTaskPost ?? null);
    // (c) update reviewer via the drawer; assert PATCH + drawer reflection, then clear.
    await page.evaluate(() => {
      if (window.__MOCK__) window.__MOCK__.reviewerPatched = null;
    });
    await page.$eval('.dr-card[data-task="G-1"] .dr-card__open', (el) => el.click());
    await page.waitForSelector(".dr-workflow__reviewer", { timeout: 8000 });
    const drawerManualOptions = await page.$$eval(".dr-workflow__status option", (els) =>
      els.map((el) => el.getAttribute("value") ?? ""),
    );
    await page.select(".dr-workflow__reviewer", "researcher");
    await page.waitForFunction(
      () => document.querySelector(".dr-fact[data-reviewer]")?.getAttribute("data-reviewer") === "researcher",
      { timeout: 6000 },
    );
    const reviewerUpdate = await page.evaluate(() => window.__MOCK__?.reviewerPatched ?? null);
    const drawerReviewer = await page.evaluate(
      () => document.querySelector(".dr-fact[data-reviewer]")?.getAttribute("data-reviewer") ?? "",
    );
    await page.select(".dr-workflow__reviewer", ""); // clear (restore open-task delegation state)
    await page.click(".dr-drawer__close");
    await page.waitForFunction(() => !document.querySelector(".dr-drawer"), { timeout: 8000 });
    const reviewerOk =
      reviewerBadge.present &&
      reviewerBadge.reviewer === "researcher" &&
      !!reviewerCreate &&
      reviewerCreate.reviewer === "researcher" &&
      !!reviewerUpdate &&
      reviewerUpdate.id === "G-1" &&
      reviewerUpdate.reviewer === "researcher" &&
      drawerReviewer === "researcher";
    const manualOptionsOk =
      cardManualOptions.length >= 1 &&
      drawerManualOptions.length >= 1 &&
      !cardManualOptions.includes("ask_human") &&
      !drawerManualOptions.includes("ask_human");

    // Interactive org canvas: switch to the Team tab; assert the graph renders
    // (nodes, bezier edges, group legend). The org request can be slow on the
    // live bridge, so the initial loading state must not look like an empty org.
    await page.evaluate(() => window.__MOCK__?.setOrgDelay?.(800));
    await page.$eval('.dr-tab[data-view="team"]', (el) => el.click());
    await page.waitForSelector(".org", { timeout: 5000 });
    await new Promise((r) => setTimeout(r, 120));
    const orgLoading = await page.evaluate(() => ({
      nodes: document.querySelectorAll(".org-node").length,
      emptyCopy: /노드가 없습니다|no nodes yet/i.test(document.querySelector(".org__msg")?.textContent ?? ""),
      msg: document.querySelector(".org__msg")?.textContent ?? "",
    }));
    await page.evaluate(() => window.__MOCK__?.setOrgDelay?.(0));
    await page.waitForSelector(".org-node", { timeout: 8000 });
    await new Promise((r) => setTimeout(r, 650)); // let the entrance layout tween settle
    const orgView = await page.evaluate(() => ({
      nodes: document.querySelectorAll(".org-node").length,
      edges: document.querySelectorAll(".org-edge").length,
      legend: document.querySelectorAll(".org-legend__item").length,
      descs: document.querySelectorAll(".org-node__desc").length,
      taskBadges: document.querySelectorAll(".org-node__taskbadge").length,
    }));
    const masterOrgInitial = await page.evaluate(() => ({
      root: !!document.querySelector(".master-org__root"),
      human: /human\s+1/.test(document.querySelector(".master-org")?.textContent ?? ""),
      projectButtons: Array.from(document.querySelectorAll(".master-org__project")).map(
        (el) => el.getAttribute("data-project") ?? "",
      ),
    }));
    await page.click(".master-org__root");
    await page.waitForSelector(".dr-mchat__panel", { timeout: 5000 });
    const masterRootChatOpen = (await page.$(".dr-mchat__panel")) !== null;
    await page.click(".dr-mchat__x");
    await page.waitForFunction(() => !document.querySelector(".dr-mchat__panel"), { timeout: 5000 });
    await page.click('.master-org__project[data-project="infra-ops"]');
    await page.waitForFunction(
      () => (document.querySelector(".proj-switcher__name")?.textContent ?? "").trim() === "grove-infra",
      { timeout: 6000 },
    );
    const masterProjectSwitch = await page.evaluate(() => ({
      current: (document.querySelector(".proj-switcher__name")?.textContent ?? "").trim(),
      header: window.__MOCK__?.projectHeader ?? "",
    }));
    await page.click(".proj-switcher__btn");
    await page.waitForSelector('.proj-item[data-project="dev10"]', { timeout: 6000 });
    await page.click('.proj-item[data-project="dev10"]');
    await page.waitForFunction(
      () => (document.querySelector(".proj-switcher__name")?.textContent ?? "").trim() === "grove-dev",
      { timeout: 6000 },
    );
    await page.waitForSelector(".org-node", { timeout: 8000 });
    const masterOrgOk =
      masterOrgInitial.root &&
      masterOrgInitial.human &&
      masterOrgInitial.projectButtons.includes("infra-ops") &&
      masterRootChatOpen &&
      masterProjectSwitch.current === "grove-infra" &&
      masterProjectSwitch.header === "infra-ops";

    // V11-W2 autonomy visibility (org): a node that self-claimed (autopickup
    // actor in the audit) shows an inferred "⚡ auto" badge — read-only.
    await page.waitForSelector('[data-name="backend"] .org-node__auto', { timeout: 6000 });
    const autoNode = await page.evaluate(() => ({
      onBackend: !!document.querySelector('[data-name="backend"] .org-node__auto'),
      count: document.querySelectorAll(".org-node__auto").length,
      // Visible text must reveal the inference (not read as a config flag).
      text: (document.querySelector('[data-name="backend"] .org-node__auto')?.textContent ?? "").trim(),
    }));
    const autonomyVisOk =
      autoAuditOk && autoNode.onBackend && autoNode.count >= 1 && /추론|inferred/.test(autoNode.text);

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

    // V4-W2 + v1.29 delegation overlay: off by default; the toggle reveals
    // current open-task edges first, then history mode renders the audit-derived
    // legacy edge set (root->backend merged to count=2). Run on the clean layout.
    const delegToggle = await page.$(".org-deleg-toggle");
    const delegOffBefore = await page.evaluate(() => document.querySelectorAll(".org-deleg-edge").length);
    await page.$eval(".org-deleg-toggle", (el) => el.click());
    await page.waitForFunction(() => document.querySelectorAll(".org-deleg-edge").length >= 1, { timeout: 6000 });
    const delegCurrent = await page.evaluate(() => {
      const edges = Array.from(document.querySelectorAll(".org-deleg-edge"));
      return {
        count: edges.length,
        arrow: edges.some((e) => (e.getAttribute("marker-end") || "").includes("org-deleg-arrow")),
        dashed: edges.some((e) => getComputedStyle(e).strokeDasharray !== "none"),
        ids: edges.map((e) => e.getAttribute("data-deleg") ?? ""),
        fromOrchestrator: edges.some((e) => /^(lead|root)>/.test(e.getAttribute("data-deleg") ?? "")),
        legend: !!document.querySelector(".org-deleg-legend"),
        marker: !!document.querySelector("#org-deleg-arrow"),
        mode: document.querySelector(".org-deleg-layer")?.getAttribute("data-mode") ?? "",
      };
    });
    await page.$eval('.org-deleg-mode__btn[data-mode="history"]', (el) => el.click());
    await page.waitForFunction(() => !!document.querySelector('[data-deleg="root>backend"]'), { timeout: 6000 });
    const delegHistory = await page.evaluate(() => ({
      count: document.querySelectorAll(".org-deleg-edge").length,
      mode: document.querySelector(".org-deleg-layer")?.getAttribute("data-mode") ?? "",
      rootBackendCount: document.querySelector('[data-deleg="root>backend"]')?.getAttribute("data-count") ?? "",
    }));
    await page.$eval(".org-deleg-toggle", (el) => el.click());
    await page.waitForFunction(() => document.querySelectorAll(".org-deleg-edge").length === 0, { timeout: 5000 });
    const delegOffAfter = await page.evaluate(() => document.querySelectorAll(".org-deleg-edge").length);
    const delegationEdgesOk =
      !!delegToggle &&
      delegOffBefore === 0 &&
      delegCurrent.count >= 1 &&
      delegCurrent.arrow &&
      delegCurrent.dashed &&
      delegCurrent.marker &&
      delegCurrent.legend &&
      delegCurrent.mode === "current" &&
      delegCurrent.fromOrchestrator &&
      delegHistory.count >= 1 &&
      delegHistory.mode === "history" &&
      delegHistory.rootBackendCount === "2" &&
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
    await glide(dC0.x, dC0.y, rC0.x, rC0.y + 132); // near researcher -> group
    const badgeGroup = await badge();
    await glide(rC0.x, rC0.y + 132, rC0.x + 320, rC0.y + 132); // far empty -> snap back
    await page.mouse.up();
    await settle();
    const dragLabelsOk =
      /is-reparent/.test(badgeReparent.cls) &&
      badgeReparent.text.length > 0 &&
      /is-group/.test(badgeGroup.cls) &&
      badgeGroup.text.length > 0;

    // #2 proximity grouping: drag "backend" near "researcher" into empty space
    // below the card -> PATCH {group}. The human node can occupy the right side.
    const resC = await center("researcher");
    await dragTo("backend", resC.x, resC.y + 132);
    await page.waitForFunction(() => /:research$/.test(window.__MOCK__?.patchedGroup ?? ""), { timeout: 6000 });
    const patchedGroup = await page.evaluate(() => window.__MOCK__?.patchedGroup ?? "");
    await settle();

    // #4 group exit: drag the now-grouped "backend" far from every node -> {group:null}.
    const farPoint = await page.evaluate(() => {
      const c = document.querySelector(".org-canvas").getBoundingClientRect();
      const centers = Array.from(document.querySelectorAll(".org-node")).map((n) => {
        const r = n.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      });
      let best = { x: c.right - 36, y: c.bottom - 36, d: -1 };
      for (let x = c.left + 36; x <= c.right - 36; x += 48) {
        for (let y = c.top + 36; y <= c.bottom - 36; y += 48) {
          const d = Math.min(...centers.map((p) => Math.hypot(x - p.x, y - p.y)));
          if (d > best.d) best = { x, y, d };
        }
      }
      return { x: best.x, y: best.y };
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

    // PR-E role preset: the toolbar "+ add node" form exposes a role-preset
    // select + a read-only persona PREVIEW + an EDITABLE role body. Picking a
    // preset fills both; the wire carries `role_preset` (snake_case) and, when
    // the body is edited, a free `role` override.
    const PRESET_NODE = "preset-fe";
    const PRESET_KEY = "maker-fe";
    const ROLE_OVERRIDE = "너는 maker-fe다. override-xyz GROVE";
    await page.click(".org__tools .org-addbtn");
    await page.waitForSelector(".node-form .node-form__role-preset", { timeout: 5000 });
    await page.type('.node-form input[name="name"]', PRESET_NODE);
    await page.select(".node-form__role-preset", PRESET_KEY);
    await page.waitForFunction(
      () => {
        const ta = document.querySelector(".node-form__role");
        return ta && ta.value.includes("GROVE");
      },
      { timeout: 5000 },
    );
    const presetApplied = await page.evaluate(() => {
      const prev = document.querySelector(".node-form__role-preview-body");
      const ta = document.querySelector(".node-form__role");
      return {
        previewLen: (prev?.textContent ?? "").length,
        previewHasGrove: /GROVE/.test(prev?.textContent ?? ""),
        taLen: (ta?.value ?? "").length,
        taHasGrove: /GROVE/.test(ta?.value ?? ""),
      };
    });
    // Edit the editable role body (React-controlled: native setter + input event)
    // so the override travels as `role` alongside the preset key.
    await page.evaluate((txt) => {
      const ta = document.querySelector(".node-form__role");
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
      setter.call(ta, txt);
      ta.dispatchEvent(new Event("input", { bubbles: true }));
    }, ROLE_OVERRIDE);
    const previewAfterEdit = await page.evaluate(
      () => document.querySelector(".node-form__role-preview-body")?.textContent ?? "",
    );
    await page.click(".node-form .node-form__submit");
    await page.waitForFunction(
      (nm) => window.__MOCK__?.createdNode === nm,
      { timeout: 8000 },
      PRESET_NODE,
    );
    const presetCreate = await page.evaluate(() => ({
      node: window.__MOCK__?.createdNode ?? "",
      rolePreset: window.__MOCK__?.createdNodeRolePreset ?? "",
      role: window.__MOCK__?.createdNodeRole ?? "",
    }));
    const nodeFormPresetOk =
      presetApplied.previewLen > 20 &&
      presetApplied.previewHasGrove &&
      presetApplied.taLen > 20 &&
      presetApplied.taHasGrove &&
      // preview stays the canonical preset body after the editable diverges
      previewAfterEdit.includes("GROVE") &&
      !previewAfterEdit.includes("override-xyz") &&
      presetCreate.node === PRESET_NODE &&
      presetCreate.rolePreset === PRESET_KEY &&
      presetCreate.role.includes("override-xyz");
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

    // V27+ project model (1:1:1 + web→node + SSH): board-select removed,
    // assignee is a required node dropdown (default real node), operator-only web→node
    // send box (viewer locked), copyable SSH/connect command per node. The
    // terminal is attached to node "root" from the n5 test above.
    // v2 org model: the root/master pane is terminal-visible and input-capable;
    // the remaining guardrails are auth/origin/node-input/rate-limit, not pane
    // hierarchy.
    await page.waitForSelector(".dr-term__tools", { timeout: 8000 });
    const leadTerm = await page.evaluate(() => ({
      toolsPresent: !!document.querySelector(".dr-term__tools"),
      noViewOnly: document.querySelectorAll('.dr-term__send-viewer[data-viewonly="1"]').length === 0,
      sendBox: document.querySelectorAll(".dr-term__send-input").length === 1,
      connectBtn: document.querySelectorAll(".dr-term__connect-btn").length === 1,
      modeLabel: (document.querySelector(".dr-term__ro")?.textContent ?? "").trim(),
      streaming: (document.querySelector(".dr-term .xterm-rows")?.textContent ?? "").trim().length > 0,
      xtermStdin: document.querySelector(".dr-term__host")?.getAttribute("data-xterm-stdin") ?? "",
    }));
    await page.$eval(".dr-term__connect-btn", (el) => el.click());
    await page.waitForSelector(".dr-term__connect-code", { timeout: 6000 });
    const leadConnect = await page.evaluate(() => ({
      cmd: (document.querySelector(".dr-term__connect-code")?.textContent ?? "").trim(),
      label: (document.querySelector(".dr-term__connect-label")?.textContent ?? "").trim(),
      fetched: window.__MOCK__?.nodeConnectFetched ?? "",
    }));
    await page.type(".dr-term__send-input", "echo root");
    await page.$eval(".dr-term__send-btn", (el) => el.click());
    await page.waitForFunction(() => window.__MOCK__?.nodeSent?.node === "root", { timeout: 6000 });
    const rootNodeSent = await page.evaluate(() => window.__MOCK__?.nodeSent ?? null);
    await page.waitForFunction(() => (document.querySelector(".dr-term__send-input")?.value ?? "") === "", {
      timeout: 8000,
    });
    const pickRail = (name) =>
      page.evaluate((n) => {
        const btn = Array.from(document.querySelectorAll(".dr-node")).find(
          (b) => (b.querySelector(".dr-node__name")?.textContent ?? "").trim() === n,
        );
        btn?.click();
      }, name);
    // switch to a worker node (backend, grove:0.1 — input_allowed): SSH + send work.
    await pickRail("backend");
    await page.waitForSelector(".dr-term__connect-btn", { timeout: 8000 });
    await page.$eval(".dr-term__connect-btn", (el) => el.click());
    await page.waitForSelector(".dr-term__connect-code", { timeout: 6000 });
    const sshCmd = await page.evaluate(() => ({
      cmd: (document.querySelector(".dr-term__connect-code")?.textContent ?? "").trim(),
      copyBtn: !!document.querySelector(".dr-term__connect-copy"),
      fetched: window.__MOCK__?.nodeConnectFetched ?? "",
    }));
    const sendBoxOperator = await page.evaluate(() => !!document.querySelector(".dr-term__send-input"));
    await page.type(".dr-term__send-input", "echo hi");
    await page.$eval(".dr-term__send-btn", (el) => el.click());
    await page.waitForFunction(() => window.__MOCK__?.nodeSent != null, { timeout: 6000 });
    const nodeSent = await page.evaluate(() => window.__MOCK__?.nodeSent ?? null);
    // The send above is async on the FE: waitForFunction(nodeSent) only proves the
    // MOCK recorded it, NOT that the FE's success handler (setBusy(false) +
    // setText("")) has run. Wait for the box to actually clear so the next send
    // starts from an idle box — otherwise the probe races send#1's completion
    // (busy stays true / setText("") wipes typed text → button stuck disabled).
    await page.waitForFunction(() => (document.querySelector(".dr-term__send-input")?.value ?? "") === "", {
      timeout: 8000,
    });
    // v1.32: with the "node-input" gui-feature OFF, an operator send 404s and the
    // disabled copy must point to the Setup toggle (not a CLI --enable flag). A 404
    // does NOT touch nodeSent, so the prior assertion stays valid.
    await page.evaluate(() => window.__MOCK__.setNodeInput(false));
    await page.type(".dr-term__send-input", "echo off");
    await page.waitForFunction(
      () => {
        const b = document.querySelector(".dr-term__send-btn");
        return !!b && !b.disabled;
      },
      { timeout: 8000 },
    );
    await page.$eval(".dr-term__send-btn", (el) => el.click());
    await page.waitForSelector('.dr-term__send-err[data-send-err="disabled"]', { timeout: 8000 });
    const nodeInputDisabled = await page.evaluate(
      () => (document.querySelector('.dr-term__send-err[data-send-err="disabled"]')?.textContent ?? "").trim(),
    );
    await page.evaluate(() => window.__MOCK__.setNodeInput(true));
    // viewer lock on a worker node -> send box hidden + note.
    await page.evaluate(() => window.__MOCK__.setViewer(true));
    await pickRail("frontend");
    await page.waitForSelector(".dr-term__send-viewer", { timeout: 8000 });
    const sendViewer = await page.evaluate(() => ({
      viewerNote: !!document.querySelector(".dr-term__send-viewer"),
      sendInput: document.querySelectorAll(".dr-term__send-input").length, // hidden for viewers
    }));
    await page.evaluate(() => window.__MOCK__.setViewer(false));
    await pickRail("backend");
    await page.waitForSelector(".dr-term__send-input", { timeout: 8000 });

    // board: no board-select + required assignee dropdown defaulting to a visible node.
    await page.$eval('.dr-tab[data-view="board"]', (el) => el.click());
    await page.waitForFunction(() => document.querySelectorAll(".dr-card").length >= 1, { timeout: 8000 });
    await page.click(".dr-addbtn");
    await page.waitForSelector(".dr-addform", { timeout: 5000 });
    await page.waitForFunction(
      () => {
        const el = document.querySelector(".dr-addform__assignee");
        return el && el.tagName === "SELECT" && el.value;
      },
      { timeout: 6000 },
    );
    const assignee = await page.evaluate(() => {
      const el = document.querySelector(".dr-addform__assignee");
      return {
        isSelect: el?.tagName === "SELECT",
        required: el?.required === true,
        value: el?.value ?? "",
        options: el ? el.querySelectorAll("option").length : 0,
        hasProjectMaster: el
          ? Array.from(el.querySelectorAll("option")).some((o) => o.value === "project-master")
          : true,
        noFreeInput: !document.querySelector('.dr-addform input[name="assignee"]'),
      };
    });
    await page.$eval(".dr-addform__cancel", (el) => el.click());
    const noBoardSelect = await page.evaluate(() => document.querySelectorAll(".dr-board-select").length === 0);

    const projModelOk =
      // 1 project = 1 board: the board picker UI is gone.
      noBoardSelect &&
      // assignee = required dropdown, default visible persistent node, no free input.
      assignee.isSelect &&
      assignee.required &&
      assignee.value === "root" &&
      assignee.options >= 2 &&
      assignee.hasProjectMaster === false &&
      assignee.noFreeInput &&
      // root/master pane: streams, connects, and accepts operator send like any
      // other live node.
      leadTerm.toolsPresent &&
      leadTerm.noViewOnly &&
      leadTerm.sendBox &&
      leadTerm.connectBtn &&
      !/(read-only|읽기 전용)/i.test(leadTerm.modeLabel) &&
      leadTerm.streaming &&
      leadTerm.xtermStdin === "disabled" &&
      /tmux attach/.test(leadConnect.cmd) &&
      /Local tmux attach/.test(leadConnect.label) &&
      leadConnect.fetched === "root" &&
      rootNodeSent?.node === "root" &&
      rootNodeSent?.text === "echo root" &&
      // SSH/connect command (copyable) on a worker node.
      /tmux attach/.test(sshCmd.cmd) &&
      sshCmd.copyBtn &&
      sshCmd.fetched === "backend" &&
      // operator web→node send box on a worker node: records a POST.
      sendBoxOperator &&
      nodeSent?.node === "backend" &&
      nodeSent?.text === "echo hi" &&
      // node-input disabled copy points to the Setup toggle, not a CLI flag.
      /Setup/.test(nodeInputDisabled) &&
      !/--enable/.test(nodeInputDisabled) &&
      // viewer is locked out of node input.
      sendViewer.viewerNote &&
      sendViewer.sendInput === 0;

    // Slack integration panel.
    await page.$eval('.dr-tab[data-view="integrations"]', (el) => el.click());
    await page.waitForSelector(".slack", { timeout: 8000 });
    const slackStatus0 = await page.$eval(".slack-status__label", (el) => (el.textContent ?? "").trim());
    const slackGuide = await page.evaluate(() => {
      const root = document.querySelector(".slack-guide");
      const text = root?.textContent ?? "";
      return {
        present: !!root,
        commandRows: document.querySelectorAll(".slack-guide__command").length,
        hasBlockKit: /Block Kit|블록 키트/.test(text),
        hasBugFeedbackTask: /bug|feedback|task|버그|피드백|태스크/.test(text),
        hasAnswer: /answer|답만|답변/.test(text),
        // v1.32: intake guidance points to the Setup toggle, not a CLI flag.
        hasIntakeToggle: /Setup/.test(text),
        noEnableFlag: !/--enable/.test(text),
      };
    });

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
      slackGuide.present &&
      slackGuide.commandRows >= 4 &&
      slackGuide.hasBlockKit &&
      slackGuide.hasBugFeedbackTask &&
      slackGuide.hasAnswer &&
      slackGuide.hasIntakeToggle &&
      slackGuide.noEnableFlag &&
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

    // V20-W2 Slack intake visualization: (1) intent-triage intake status in the
    // Slack panel (enabled/disabled + triage one-liner, secrets masked), and (2)
    // slack-origin audit events (actor.kind="slack", action="slack_intake_create")
    // surfaced with a distinct chip + quick filter. Read-only; intake is in Slack.
    const intakeOn = await page.evaluate(() => ({
      present: !!document.querySelector(".slack-intake"),
      enabled: document.querySelector(".slack-intake")?.getAttribute("data-intake") ?? "",
      badgeOn: !!document.querySelector(".slack-intake__badge.is-on"),
      flow: (document.querySelector(".slack-intake__flow")?.textContent ?? "").trim(),
      note: (document.querySelector(".slack-intake__note")?.textContent ?? "").trim(),
      noSecret: !/xapp-[A-Za-z0-9]|xoxb-[A-Za-z0-9]/.test(document.querySelector(".slack-intake")?.textContent ?? ""),
    }));
    // EXACT backend contract: the status carries a top-level `intake.enabled`
    // boolean — not a flat/invented field. Assert the raw JSON shape directly.
    const intakeShapeOn = await page.evaluate(async () => {
      const j = await fetch("/api/slack/config/status").then((r) => r.json());
      return {
        hasIntake: Object.prototype.hasOwnProperty.call(j, "intake"),
        enabledType: typeof (j.intake && j.intake.enabled),
        enabledVal: j?.intake?.enabled ?? null,
        noFlat: !("intake_enabled" in j), // never a flat invented key
      };
    });
    // toggle intake OFF -> disabled badge (status re-fetched on panel remount).
    const reenterIntegrations = async () => {
      await page.$eval('.dr-tab[data-view="board"]', (el) => el.click());
      await page.waitForFunction(() => document.querySelectorAll(".dr-card").length >= 1, { timeout: 8000 });
      await page.$eval('.dr-tab[data-view="integrations"]', (el) => el.click());
      await page.waitForSelector(".slack-intake", { timeout: 8000 });
    };
    await page.evaluate(() => window.__MOCK__.setSlackIntake(false));
    await reenterIntegrations();
    await page.waitForSelector(".slack-intake__badge.is-off", { timeout: 8000 });
    const intakeOff = await page.evaluate(() => ({
      enabled: document.querySelector(".slack-intake")?.getAttribute("data-intake") ?? "",
      badgeOff: !!document.querySelector(".slack-intake__badge.is-off"),
    }));
    await page.evaluate(() => window.__MOCK__.setSlackIntake(true)); // restore

    // older backend OMITS the field entirely -> FE must render "unknown", never
    // silently "disabled" (graceful), and the raw status must carry no intake key.
    await page.evaluate(() => window.__MOCK__.setSlackIntake(null));
    await reenterIntegrations();
    await page.waitForSelector('.slack-intake[data-intake="unknown"]', { timeout: 8000 });
    const intakeUnknown = await page.evaluate(async () => {
      const j = await fetch("/api/slack/config/status").then((r) => r.json());
      return {
        state: document.querySelector(".slack-intake")?.getAttribute("data-intake") ?? "",
        label: (document.querySelector(".slack-intake__badge")?.textContent ?? "").trim(),
        hasIntakeField: Object.prototype.hasOwnProperty.call(j, "intake"),
      };
    });
    await page.evaluate(() => window.__MOCK__.setSlackIntake(true)); // restore
    await reenterIntegrations();

    // audit drawer: filter to slack-intake; every event carries the Slack chip.
    await page.$eval(".dr-audit-btn", (el) => el.click());
    await page.waitForSelector(".audit-drawer", { timeout: 5000 });
    await page.click('.audit-qf[data-action="slack_intake_create"]');
    await page.waitForFunction(
      () => {
        const evs = Array.from(document.querySelectorAll(".audit-event"));
        return (
          evs.length >= 1 &&
          evs.every((e) => e.querySelector(".audit-event__action")?.getAttribute("data-action") === "slack_intake_create")
        );
      },
      { timeout: 6000 },
    );
    const slackAudit = await page.evaluate(() => ({
      count: document.querySelectorAll(".audit-event").length,
      allChip: Array.from(document.querySelectorAll(".audit-event")).every((e) => !!e.querySelector(".audit-event__slack")),
      chips: document.querySelectorAll(".audit-event__slack").length,
      slackClass: document.querySelectorAll(".audit-event.is-slack").length,
      actors: Array.from(document.querySelectorAll(".audit-event__actor")).map((e) => (e.textContent ?? "").trim()),
      filter: window.__MOCK__?.auditFilter ?? "",
    }));
    await page.click(".audit-drawer .dr-drawer__close");
    await page.waitForFunction(() => !document.querySelector(".audit-drawer"), { timeout: 5000 });

    const slackIntakeOk =
      // intake status surfaced (enabled), with the triage one-liner + read-only note.
      intakeOn.present &&
      intakeOn.enabled === "on" &&
      intakeOn.badgeOn &&
      /등록|create/.test(intakeOn.flow) &&
      /답만|answer/.test(intakeOn.flow) &&
      intakeOn.note.length > 0 &&
      intakeOn.noSecret && // no raw token leaked in the intake card
      // exact backend shape: top-level intake.enabled boolean, no flat field.
      intakeShapeOn.hasIntake &&
      intakeShapeOn.enabledType === "boolean" &&
      intakeShapeOn.enabledVal === true &&
      intakeShapeOn.noFlat &&
      // disabled state reflected.
      intakeOff.enabled === "off" &&
      intakeOff.badgeOff &&
      // graceful unknown when the backend omits the field (no fabricated "off").
      intakeUnknown.state === "unknown" &&
      /알 수 없음|Unknown/.test(intakeUnknown.label) &&
      !intakeUnknown.hasIntakeField &&
      // slack-intake audit events: distinct chip + working action quick-filter.
      slackAudit.count === 2 &&
      slackAudit.allChip &&
      slackAudit.chips === 2 &&
      slackAudit.slackClass === 2 &&
      slackAudit.actors.some((a) => /jiwoo|minji/.test(a)) &&
      /action=slack_intake_create/.test(slackAudit.filter);

    // Dev-tool auth status panel: 5 tools, LEDs, login-hint reveal, URL hint, refresh.
    await page.$eval('.dr-tab[data-view="auth"]', (el) => el.click());
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
    await page.waitForSelector(".setup-feature", { timeout: 8000 });
    const setupFeatures = await page.evaluate(() => ({
      fetched: window.__MOCK__?.guiFeaturesFetched === true,
      cards: document.querySelectorAll(".setup-feature").length,
      switches: document.querySelectorAll('.setup-switch[role="switch"]').length,
      on: document.querySelectorAll('.setup-switch[data-enabled="1"]').length,
      off: document.querySelectorAll('.setup-switch[data-enabled="0"]').length,
      digestBefore: document
        .querySelector('.setup-feature[data-feature="digest"] .setup-switch')
        ?.getAttribute("data-enabled"),
    }));
    await page.$eval('.setup-feature[data-feature="digest"] .setup-switch', (el) => el.click());
    await page.waitForFunction(() => window.__MOCK__?.guiFeaturePost?.key === "digest", { timeout: 6000 });
    // The Setup toggle is the REAL control: after the POST turns digest OFF, the
    // switch UI must actually flip to OFF (data-enabled="0"), not just record the POST.
    await page.waitForFunction(
      () =>
        document
          .querySelector('.setup-feature[data-feature="digest"] .setup-switch')
          ?.getAttribute("data-enabled") === "0",
      { timeout: 6000 },
    );
    const setupToggle = await page.evaluate(() => ({
      post: window.__MOCK__?.guiFeaturePost ?? null,
      digestAfter: document
        .querySelector('.setup-feature[data-feature="digest"] .setup-switch')
        ?.getAttribute("data-enabled"),
    }));

    // v1.32 P1: a RISK feature's ENABLE requires a 2-step confirm — arming POSTs
    // nothing, cancel POSTs nothing, confirm POSTs exactly once. (Disable stays a
    // single immediate POST.) Exercise on handoff: disable it (immediate), then
    // run the enable→cancel and enable→confirm paths (the confirm restores it ON).
    await page.$eval('.setup-feature[data-feature="handoff"] .setup-switch', (el) => el.click());
    await page.waitForFunction(
      () =>
        document.querySelector('.setup-feature[data-feature="handoff"] .setup-switch')?.getAttribute("data-enabled") ===
        "0",
      { timeout: 6000 },
    );
    const riskBaseCount = await page.evaluate(() => window.__MOCK__?.guiFeaturePostCount ?? 0);
    // arm enable -> confirm affordance appears, NO POST
    await page.$eval('.setup-feature[data-feature="handoff"] .setup-switch', (el) => el.click());
    await page.waitForSelector('.setup-feature[data-feature="handoff"] .setup-confirm', { timeout: 6000 });
    const riskArmCount = await page.evaluate(() => window.__MOCK__?.guiFeaturePostCount ?? 0);
    // cancel -> NO POST, affordance gone, still OFF
    await page.$eval('.setup-feature[data-feature="handoff"] .setup-confirm__no', (el) => el.click());
    await page.waitForFunction(
      () => !document.querySelector('.setup-feature[data-feature="handoff"] .setup-confirm'),
      { timeout: 6000 },
    );
    const riskCancel = await page.evaluate(() => ({
      count: window.__MOCK__?.guiFeaturePostCount ?? 0,
      enabled: document
        .querySelector('.setup-feature[data-feature="handoff"] .setup-switch')
        ?.getAttribute("data-enabled"),
    }));
    // arm again -> confirm -> exactly one POST, now ON (restores handoff)
    await page.$eval('.setup-feature[data-feature="handoff"] .setup-switch', (el) => el.click());
    await page.waitForSelector('.setup-feature[data-feature="handoff"] .setup-confirm__yes', { timeout: 6000 });
    await page.$eval('.setup-feature[data-feature="handoff"] .setup-confirm__yes', (el) => el.click());
    await page.waitForFunction(
      () =>
        document.querySelector('.setup-feature[data-feature="handoff"] .setup-switch')?.getAttribute("data-enabled") ===
        "1",
      { timeout: 6000 },
    );
    const riskConfirm = await page.evaluate(() => ({
      count: window.__MOCK__?.guiFeaturePostCount ?? 0,
      post: window.__MOCK__?.guiFeaturePost ?? null,
    }));
    const riskConfirmOk =
      riskArmCount === riskBaseCount && // arm: 0 POST
      riskCancel.count === riskBaseCount && // cancel: 0 POST
      riskCancel.enabled === "0" && // still off after cancel
      riskConfirm.count === riskBaseCount + 1 && // confirm: exactly 1 POST
      riskConfirm.post?.key === "handoff" &&
      riskConfirm.post?.enabled === true;

    const setupFeatureOk =
      setupFeatures.fetched &&
      setupFeatures.cards === 8 &&
      setupFeatures.switches === 8 &&
      setupFeatures.on + setupFeatures.off === 8 &&
      setupFeatures.digestBefore === "1" &&
      setupToggle.post?.enabled === false &&
      setupToggle.digestAfter === "0" &&
      riskConfirmOk;
    const authOk =
      authRows === 5 &&
      authLeds.ok >= 1 &&
      authLeds.warn >= 1 &&
      codexHint === "codex login" &&
      cfHref.startsWith("http") &&
      authFetches >= 2 &&
      setupFeatureOk;

    // V4-W3 cost/credit panel: 3 agent cards; estimate/inferred values flagged
    // (codex registry=exact, no badge; claude/agy inferred=badge); agy credit
    // reported UNKNOWN with a warning (never an estimated remaining balance);
    // no backend path/status leaks into the UI.
    await page.$eval('.dr-tab[data-view="cost"]', (el) => el.click());
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

    // V15-W2 usage report (GET /api/usage): node/day rollup; agy honestly unknown.
    await page.waitForSelector(".usage .usage-node", { timeout: 8000 });
    const usage = await page.evaluate(() => {
      const agy = document.querySelector('.usage-node[data-node="agy-1"]');
      const backend = document.querySelector('.usage-node[data-node="backend"]');
      const backendTok = backend
        ? (backend.querySelectorAll(".usage-cell .cost-metric__value")[1]?.textContent ?? "").trim()
        : "";
      return {
        present: !!document.querySelector(".usage"),
        nodes: document.querySelectorAll(".usage-node").length,
        days: document.querySelectorAll(".usage-day").length,
        agyPresent: !!agy,
        agyAgent: agy?.getAttribute("data-usage-agent") ?? "",
        agyCreditUnknown: !!agy?.querySelector(".cost-credit.is-unknown"),
        agyCreditText: (agy?.querySelector(".cost-credit__unknown")?.textContent ?? "").trim(),
        agyWarn: !!agy?.querySelector(".cost-credit__warn"),
        // cells: [runs, total_tokens, cost]. agy tokens are KNOWN from metadata;
        // only cost (+ credit) are honestly unknown.
        agyTok: agy ? (agy.querySelectorAll(".usage-cell .cost-metric__value")[1]?.textContent ?? "").trim() : "",
        agyCost: agy ? (agy.querySelectorAll(".usage-cell .cost-metric__value")[2]?.textContent ?? "").trim() : "",
        backendTok,
        fetched: window.__MOCK__?.usageFetched === true,
      };
    });
    const usageReportOk =
      usage.present &&
      usage.nodes >= 2 &&
      usage.days >= 2 &&
      usage.agyPresent &&
      usage.agyAgent === "agy" &&
      usage.agyCreditUnknown && // honest: ⚠ 알 수 없음 (추정하지 않음)
      usage.agyCreditText.length > 0 &&
      usage.agyWarn &&
      usage.agyTok === "44" && // agy tokens KNOWN from run metadata (not unknown)
      /알 수 없음|unknown/.test(usage.agyCost) && // only cost is honestly unknown
      usage.backendTok === "890.1k" && // real backend total_tokens rendered
      usage.fetched;

    // V16-W2 aggregation view (GET /api/summary + POST /api/aggregate, read-only):
    // own (trusted+fresh) + operator-pasted peer summaries (one stale-trusted,
    // one untrusted-key) are ACTUALLY submitted and verified; combined =
    // trusted+fresh only; untrusted/stale flagged excluded; default-OFF graceful.
    await page.$eval('.dr-tab[data-view="agg"]', (el) => el.click());
    await page.waitForSelector(".agg-combined", { timeout: 8000 });
    // initially own only (1 room).
    await page.waitForFunction(() => document.querySelectorAll(".agg-room").length === 1, { timeout: 6000 });
    // paste a trusted-but-stale peer (room-beta, old ts) -> excluded from combined.
    const stalePeer = JSON.stringify({
      algorithm: "hmac-sha256",
      key_id: "room-beta",
      signature: "sig-beta",
      payload: {
        schema: "grove.summary.v1",
        project: "infra-ops",
        version: "1.16",
        generated_at: 1000000000,
        summary: { boards: { total: 2 }, tasks: { total: 12, by_status: { ready: 5, done: 7 } }, nodes: { total: 4 }, runs: { total: 8 } },
      },
    });
    // paste an untrusted-key peer -> untrusted, excluded.
    const untrustedPeer = JSON.stringify({
      algorithm: "hmac-sha256",
      key_id: "ghost-key",
      signature: "x",
      payload: {
        schema: "grove.summary.v1",
        project: "ghost",
        version: "1.16",
        generated_at: 1780543000,
        summary: { boards: { total: 9 }, tasks: { total: 99 }, nodes: { total: 9 }, runs: { total: 9 } },
      },
    });
    await page.type(".agg-paste__input", stalePeer);
    await page.click(".agg-paste__add");
    await page.waitForFunction(() => document.querySelectorAll(".agg-room").length === 2, { timeout: 6000 });
    await page.type(".agg-paste__input", untrustedPeer);
    await page.click(".agg-paste__add");
    await page.waitForFunction(() => document.querySelectorAll(".agg-room").length === 3, { timeout: 6000 });
    const agg = await page.evaluate(() => ({
      combined: !!document.querySelector(".agg-combined"),
      sources: (document.querySelector(".agg-combined__sources")?.textContent ?? "").trim(),
      rooms: document.querySelectorAll(".agg-room").length,
      trusted: document.querySelectorAll(".agg-badge.is-trusted").length,
      untrusted: document.querySelectorAll(".agg-badge.is-untrusted").length,
      fresh: document.querySelectorAll(".agg-fresh.is-fresh").length,
      stale: document.querySelectorAll(".agg-fresh.is-stale").length,
      untrustedExcluded: !!document.querySelector('.agg-room[data-trust="untrusted"].is-excluded .agg-room__excluded'),
      staleExcluded: !!document.querySelector('.agg-room[data-freshness="stale"].is-excluded .agg-room__excluded'),
      keyShown: !!document.querySelector('.agg-room[data-key="room-alpha"]'),
      // only key_id surfaces — never the signature/algorithm/keys.
      noSecret: !/sig-alpha|sig-beta|signature|hmac/i.test(document.querySelector(".agg")?.textContent ?? ""),
      // allowlist: own's non-allowed "weird" task status is bucketed to "other".
      otherBucket: !!document.querySelector('.agg-bystatus__chip[data-status="other"]'),
      submitted: window.__MOCK__?.aggregateSubmitted ?? 0,
      aggregated: window.__MOCK__?.aggregated === true,
    }));
    await page.evaluate(() => window.__MOCK__.setSummaryEnabled(false));
    await page.$eval('.dr-tab[data-view="board"]', (el) => el.click());
    await page.waitForFunction(() => document.querySelectorAll(".dr-card").length >= 1, { timeout: 8000 });
    await page.$eval('.dr-tab[data-view="agg"]', (el) => el.click());
    await page.waitForSelector(".agg-disabled", { timeout: 8000 });
    const aggDisabled = await page.evaluate(() => ({
      notice: !!document.querySelector(".agg-disabled"),
      text: (document.querySelector(".agg-disabled")?.textContent ?? "").trim(),
      rooms: document.querySelectorAll(".agg-room").length,
    }));
    await page.evaluate(() => window.__MOCK__.setSummaryEnabled(true)); // restore
    const aggViewOk =
      agg.combined &&
      /1/.test(agg.sources) && // combined = 1 trusted-fresh source (own only)
      agg.rooms === 3 && // own + 2 actually-submitted peers (no fabrication)
      agg.submitted === 3 && // FE submitted own + 2 pasted summaries
      agg.trusted === 2 && // own + room-beta
      agg.untrusted === 1 && // ghost-key
      agg.fresh >= 1 &&
      agg.stale >= 1 &&
      agg.untrustedExcluded &&
      agg.staleExcluded &&
      agg.otherBucket && // allowlist: "weird" -> "other"
      agg.keyShown &&
      agg.noSecret &&
      agg.aggregated &&
      aggDisabled.notice &&
      aggDisabled.rooms === 0 &&
      /비활성|disabled/.test(aggDisabled.text);

    // V17-W2 handoff ACCEPT (receiver-local = human decision): paste the SIGNED
    // package exported above -> local preview (title + freshness) -> an EXPLICIT
    // accept (confirm) is the ONLY path that creates a local task. Nothing is
    // created/run before the confirm. Re-accepting the same package is idempotent
    // (existing, not a 2nd task). A tampered package is rejected with a FIXED
    // message and never records an acceptance. Default-OFF degrades gracefully.
    const setHandoffPaste = (v) =>
      page.$eval(
        ".handoff-paste__input",
        (el, val) => {
          const d = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value");
          d.set.call(el, val);
          el.dispatchEvent(new Event("input", { bubbles: true }));
        },
        v,
      );
    await page.$eval('.dr-tab[data-view="handoff"]', (el) => el.click());
    await page.waitForSelector(".handoff-paste__input", { timeout: 8000 });
    // paste the valid package + preview (NO POST yet).
    await setHandoffPaste(hExport.jsonText);
    await page.$eval(".handoff-preview__btn", (el) => el.click());
    await page.waitForSelector('.handoff-preview[data-handoff="preview"]', { timeout: 8000 });
    const hPreview = await page.evaluate(() => ({
      shown: !!document.querySelector('.handoff-preview[data-handoff="preview"]'),
      fresh: !!document.querySelector(".handoff-fresh.is-fresh"),
      title: (document.querySelector(".handoff-preview__title")?.textContent ?? "").trim(),
      acceptBtn: !!document.querySelector(".handoff-accept__btn"),
      accepted: window.__MOCK__?.handoffAccepted ?? null, // accept-前 mutation 0
    }));
    // click accept -> CONFIRM appears; still NO POST (two-step gate).
    await page.$eval(".handoff-accept__btn", (el) => el.click());
    await page.waitForSelector(".handoff-accept__yes", { timeout: 6000 });
    const hPreConfirm = await page.evaluate(() => window.__MOCK__?.handoffAccepted ?? null);
    // confirm -> POST -> created (local task).
    await page.$eval(".handoff-accept__yes", (el) => el.click());
    await page.waitForSelector('.handoff-result.is-trusted[data-status="created"]', { timeout: 8000 });
    const hCreated = await page.evaluate(() => ({
      status: document.querySelector(".handoff-result")?.getAttribute("data-status") ?? "",
      text: (document.querySelector(".handoff-result")?.textContent ?? "").trim(),
      accepted: window.__MOCK__?.handoffAccepted ?? null,
    }));
    // re-accept the SAME package -> idempotent "existing" (no duplicate task).
    await page.$eval(".handoff-preview__btn", (el) => el.click());
    await page.waitForSelector('.handoff-preview[data-handoff="preview"]', { timeout: 6000 });
    await page.$eval(".handoff-accept__btn", (el) => el.click());
    await page.waitForSelector(".handoff-accept__yes", { timeout: 6000 });
    await page.$eval(".handoff-accept__yes", (el) => el.click());
    await page.waitForSelector('.handoff-result.is-trusted[data-status="existing"]', { timeout: 8000 });
    const hExisting = await page.evaluate(() => ({
      status: document.querySelector(".handoff-result")?.getAttribute("data-status") ?? "",
      created: window.__MOCK__?.handoffAccepted?.created ?? null,
    }));
    // TAMPER: flip a payload field -> signature mismatch -> rejected (fixed msg).
    const tampered = JSON.parse(hExport.jsonText);
    tampered.payload.task.title = (tampered.payload.task.title ?? "") + " (tampered)";
    await setHandoffPaste(JSON.stringify(tampered));
    await page.$eval(".handoff-preview__btn", (el) => el.click());
    await page.waitForSelector('.handoff-preview[data-handoff="preview"]', { timeout: 6000 });
    await page.$eval(".handoff-accept__btn", (el) => el.click());
    await page.waitForSelector(".handoff-accept__yes", { timeout: 6000 });
    const acceptedBeforeTamper = await page.evaluate(() => JSON.stringify(window.__MOCK__?.handoffAccepted ?? null));
    await page.$eval(".handoff-accept__yes", (el) => el.click());
    await page.waitForSelector(".handoff-result.is-rejected", { timeout: 8000 });
    const hReject = await page.evaluate(() => ({
      reject: document.querySelector(".handoff-result.is-rejected")?.getAttribute("data-reject") ?? "",
      text: (document.querySelector(".handoff-result.is-rejected")?.textContent ?? "").trim(),
      accepted: JSON.stringify(window.__MOCK__?.handoffAccepted ?? null), // unchanged by a tampered accept
    }));
    // default-OFF graceful: handoff disabled -> fixed disabled notice, no task.
    await page.evaluate(() => window.__MOCK__.setHandoffEnabled(false));
    await page.$eval(".handoff-preview__btn", (el) => el.click());
    await page.waitForSelector('.handoff-preview[data-handoff="preview"]', { timeout: 6000 });
    await page.$eval(".handoff-accept__btn", (el) => el.click());
    await page.waitForSelector(".handoff-accept__yes", { timeout: 6000 });
    await page.$eval(".handoff-accept__yes", (el) => el.click());
    await page.waitForSelector('.handoff-result.is-rejected[data-reject="disabled"]', { timeout: 8000 });
    const hDisabled = await page.evaluate(() => ({
      reject: document.querySelector(".handoff-result.is-rejected")?.getAttribute("data-reject") ?? "",
      text: (document.querySelector(".handoff-result.is-rejected")?.textContent ?? "").trim(),
    }));
    await page.evaluate(() => window.__MOCK__.setHandoffEnabled(true)); // restore
    const handoffOk =
      // export: signed package shown, copyable JSON carries the signature, human
      // meta exposes key_id only (never the signing digest).
      hExport.shown &&
      hExport.idShown &&
      hExport.keyShown &&
      hExport.copyBtn &&
      hExport.hasSig &&
      hExport.keyId === "room-alpha" &&
      hExport.metaNoSig &&
      /^handoff_[A-Za-z0-9_-]{16,}$/.test(hExport.handoffId) &&
      hExport.exported === hExport.handoffId &&
      // accept preview: shown + fresh, and ZERO mutation before the explicit confirm.
      hPreview.shown &&
      hPreview.fresh &&
      hPreview.title.length > 0 &&
      hPreview.acceptBtn &&
      hPreview.accepted === null && // no POST after preview
      hPreConfirm === null && // no POST after clicking accept (confirm pending)
      // created only on explicit confirm.
      hCreated.status === "created" &&
      hCreated.accepted?.created === true &&
      /수락됨|Accepted/.test(hCreated.text) &&
      // idempotent re-accept of the same package.
      hExisting.status === "existing" &&
      hExisting.created === false &&
      // tampered -> rejected with a FIXED message, no secret leaked, ledger intact.
      hReject.reject === "rejected" &&
      /거부|Rejected/.test(hReject.text) &&
      !/hs_[0-9a-f]/.test(hReject.text) &&
      acceptedBeforeTamper === hReject.accepted &&
      // default-OFF graceful.
      hDisabled.reject === "disabled" &&
      /비활성|disabled/.test(hDisabled.text);

    // V18-W2 easy connection (shared-access): the invite/join surface is no
    // longer part of the default cockpit nav, but a peer share URL (?join=)
    // still opens the join screen pre-filled -> joins -> dashboard. Mirrors
    // web_app.py /api/join while keeping the default UI focused.
    const SHARE_DEMO_CODE = "grove-demo-join-0001"; // matches the mock's seeded code
    await page.evaluate(() => window.__MOCK__?.setPresenceMode("team")); // an earlier test left it "local"
    const connectDefaultHidden = await page.evaluate(() => !document.querySelector('.dr-sidebar .dr-tab[data-view="connect"]'));
    const shareIssue = { hiddenFromDefaultNav: connectDefaultHidden };
    const connPresence = { skipped: "connect panel hidden from default cockpit" };
    const projOperator = { skipped: "connect panel hidden from default cockpit" };
    const projViewer = { skipped: "connect panel hidden from default cockpit" };

    // PEER join via a share URL deep-link (?join=) — isolated page so the main
    // page's mock state is untouched. The join screen opens pre-filled; a wrong
    // code shows a FIXED message; the seeded code joins -> member session.
    const page2 = await browser.newPage();
    await page2.setViewport({ width: 1100, height: 800, deviceScaleFactor: 1 });
    const join2Errors = [];
    page2.on("pageerror", (e) => join2Errors.push("pageerror: " + String(e)));
    // a peer arriving via a share link should not meet the first-run wizard.
    await page2.evaluateOnNewDocument(() => {
      try {
        localStorage.setItem("grove.onboarded.v3", "1");
      } catch {
        /* ignore */
      }
    });
    await page2.goto("file://" + htmlPath + "?join=" + SHARE_DEMO_CODE, { waitUntil: "load" });
    await page2.waitForSelector('.connect-join[data-card="join"]', { timeout: 8000 });
    // P2: the one-time code is scrubbed from the URL (replaceState) once captured.
    await page2.waitForFunction(() => !window.location.href.includes("join="), { timeout: 8000 });
    const joinPrefill = await page2.evaluate(() => ({
      connectVisible: !!document.querySelector(".connect"),
      connectTabHidden: !document.querySelector('.dr-sidebar .dr-tab[data-view="connect"]'),
      code: document.querySelector(".connect-join__code")?.value ?? "",
      // code lives only in state now — neither the search string nor the full
      // href (address bar + history entry) may still carry it.
      urlScrubbed: !/[?&]join=/.test(window.location.search) && !window.location.href.includes("grove-demo-join-0001"),
    }));
    // wrong code -> fixed "invalid" message (no raw leak), no session.
    await page2.$eval(".connect-join__code", (el) => {
      const d = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value");
      d.set.call(el, "totally-wrong-code");
      el.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await page2.type(".connect-join__name", "jiwoo");
    await page2.click(".connect-join__btn");
    await page2.waitForSelector("[data-join-err]", { timeout: 8000 });
    const joinBad = await page2.evaluate(() => ({
      err: document.querySelector("[data-join-err]")?.getAttribute("data-join-err") ?? "",
      text: (document.querySelector("[data-join-err]")?.textContent ?? "").trim(),
      joined: window.__MOCK__?.joined ?? null, // no session created on a bad code
    }));
    // correct (seeded) code -> member session -> joined card.
    await page2.$eval(".connect-join__code", (el, v) => {
      const d = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value");
      d.set.call(el, v);
      el.dispatchEvent(new Event("input", { bubbles: true }));
    }, SHARE_DEMO_CODE);
    await page2.click(".connect-join__btn");
    await page2.waitForSelector('.connect-joined[data-join="ok"]', { timeout: 8000 });
    const joinOk = await page2.evaluate(() => ({
      member: document.querySelector(".connect-joined__member .connect-chip")?.textContent?.trim() ?? "",
      role: (document.querySelector(".connect-joined__role")?.textContent ?? "").trim(),
      joined: window.__MOCK__?.joined ?? null,
    }));
    await page2.close();

    const sharedAccessOk =
      // default cockpit: connect is hidden from ordinary sidebar navigation.
      connectDefaultHidden &&
      // join deep-link: ?join= pre-fills the code; bad code is rejected (fixed
      // msg, no session); seeded code yields a member session.
      joinPrefill.connectVisible &&
      joinPrefill.connectTabHidden &&
      joinPrefill.code === SHARE_DEMO_CODE &&
      joinPrefill.urlScrubbed &&
      joinBad.err === "invalid" &&
      /잘못된|Invalid/.test(joinBad.text) &&
      joinBad.joined === null &&
      joinOk.member.includes("jiwoo") &&
      joinOk.role === "operator" &&
      joinOk.joined?.name === "jiwoo" &&
      join2Errors.length === 0;

    // V19-W2 ledger/quota: per-member runs/tokens/cost (read-only) + soft budget
    // + host pressure. Mirrors web_app.py /api/ledger + /api/quota. Asserts: agy
    // cost honestly unknown, soft-throttle (never hard-kill), host-pressure warn,
    // operator-only quota set (explicit confirm), viewer lock, quotas-off notice.
    const reenterLedger = async () => {
      await page.$eval('.dr-tab[data-view="board"]', (el) => el.click());
      await page.waitForFunction(() => document.querySelectorAll(".dr-card").length >= 1, { timeout: 8000 });
      await page.$eval('.dr-tab[data-view="ledger"]', (el) => el.click());
      await page.waitForSelector(".ledger-host", { timeout: 8000 });
    };
    await page.$eval('.dr-tab[data-view="ledger"]', (el) => el.click());
    await page.waitForSelector(".ledger-member", { timeout: 8000 });
    const readMembers = () =>
      page.evaluate(() => {
        const read = (id) => {
          const el = document.querySelector(`.ledger-member[data-member="${id}"]`);
          if (!el) return null;
          return {
            role: el.getAttribute("data-role"),
            throttle: !!el.querySelector(".ledger-throttle.is-active"),
            throttleNote: (el.querySelector(".ledger-throttle__note")?.textContent ?? "").trim(),
            budgetOk: !!el.querySelector(".ledger-budget__ok"),
            unknown: el.querySelectorAll(".ledger-metric.is-unknown").length, // cost is honestly unknown
            warnAgy: Array.from(el.querySelectorAll(".ledger-warn")).some((w) => /agy/i.test(w.textContent ?? "")),
            editBtn: !!el.querySelector(".ledger-quota__edit"),
            readonly: !!el.querySelector(".ledger-quota__readonly"),
          };
        };
        return {
          count: document.querySelectorAll(".ledger-member").length,
          scope: document.querySelector(".ledger__scope")?.getAttribute("data-scope") ?? "",
          alice: read("m-alice"),
          bob: read("m-bob"),
          carol: read("m-carol"),
        };
      });
    const ledgerAll = await readMembers();
    // host pressure: nominal first.
    const hostNominal = await page.evaluate(() => ({
      present: !!document.querySelector(".ledger-host"),
      status: document.querySelector(".ledger-host")?.getAttribute("data-status") ?? "",
      saturatedClass: !!document.querySelector(".ledger-host.is-saturated"),
    }));
    // flip host to saturated -> warn color.
    await page.evaluate(() => window.__MOCK__.setHostSaturated(true));
    await reenterLedger();
    const hostSat = await page.evaluate(() => ({
      status: document.querySelector(".ledger-host")?.getAttribute("data-status") ?? "",
      saturatedClass: !!document.querySelector(".ledger-host.is-saturated"),
      warnBadge: !!document.querySelector(".ledger-host__badge.is-warn"),
    }));
    await page.evaluate(() => window.__MOCK__.setHostSaturated(false));
    await reenterLedger();

    // operator quota control: set carol's soft budget (edit -> save -> CONFIRM -> POST).
    await page.$eval('.ledger-member[data-member="m-carol"] .ledger-quota__edit', (el) => el.click());
    await page.waitForSelector('.ledger-member[data-member="m-carol"] .ledger-quota__run', { timeout: 6000 });
    await page.type('.ledger-member[data-member="m-carol"] .ledger-quota__run', "10");
    await page.$eval('.ledger-member[data-member="m-carol"] .ledger-quota__save', (el) => el.click());
    await page.waitForSelector('.ledger-member[data-member="m-carol"] .ledger-quota__yes', { timeout: 6000 });
    const quotaBeforeYes = await page.evaluate(() => window.__MOCK__?.quotaSet ?? null); // no POST before confirm
    await page.$eval('.ledger-member[data-member="m-carol"] .ledger-quota__yes', (el) => el.click());
    await page.waitForFunction(() => window.__MOCK__?.quotaSet?.member === "m-carol", { timeout: 8000 });
    const quotaSet = await page.evaluate(() => window.__MOCK__?.quotaSet ?? null);

    // viewer lock: self scope only + read-only (no quota control).
    await page.evaluate(() => window.__MOCK__.setViewer(true));
    await reenterLedger();
    await page.waitForFunction(() => (document.querySelector(".ledger__scope")?.getAttribute("data-scope") ?? "") === "self", { timeout: 8000 });
    const ledgerViewer = await page.evaluate(() => ({
      scope: document.querySelector(".ledger__scope")?.getAttribute("data-scope") ?? "",
      members: document.querySelectorAll(".ledger-member").length,
      editBtns: document.querySelectorAll(".ledger-quota__edit").length, // hidden for viewers
      readonly: document.querySelectorAll(".ledger-quota__readonly").length,
    }));
    await page.evaluate(() => window.__MOCK__.setViewer(false));
    await reenterLedger();

    // quotas-off: graceful notice, no quota controls.
    await page.evaluate(() => window.__MOCK__.setQuotaEnabled(false));
    await reenterLedger();
    await page.waitForSelector(".ledger-quota__disabled", { timeout: 8000 });
    const ledgerNoQuota = await page.evaluate(() => ({
      disabled: !!document.querySelector(".ledger-quota__disabled"),
      // v1.32: the disabled notice points to the Setup toggle, not a CLI flag.
      text: (document.querySelector(".ledger-quota__disabled")?.textContent ?? "").trim(),
      editBtns: document.querySelectorAll(".ledger-quota__edit").length,
      members: document.querySelectorAll(".ledger-member").length, // ledger still renders
    }));
    await page.evaluate(() => window.__MOCK__.setQuotaEnabled(true));

    const ledgerQuotaOk =
      // operator sees all members; cost honestly unknown; agy warning surfaced.
      ledgerAll.count === 3 &&
      ledgerAll.scope === "all" &&
      ledgerAll.alice?.unknown >= 1 && // cost unknown
      ledgerAll.bob?.unknown >= 1 &&
      ledgerAll.bob?.warnAgy && // agy credit unknown surfaced
      // soft-throttle is a WARNING only (bob over run limit), alice within budget.
      ledgerAll.bob?.throttle &&
      /중단 아님|not killed/.test(ledgerAll.bob?.throttleNote ?? "") &&
      ledgerAll.alice?.budgetOk &&
      !ledgerAll.alice?.throttle &&
      // host pressure: nominal -> saturated warn.
      hostNominal.present &&
      hostNominal.status === "nominal" &&
      !hostNominal.saturatedClass &&
      hostSat.status === "saturated" &&
      hostSat.saturatedClass &&
      hostSat.warnBadge &&
      // operator quota set: explicit confirm gate (no POST before confirm).
      quotaBeforeYes === null &&
      quotaSet?.member === "m-carol" &&
      quotaSet?.soft_run_limit === 10 &&
      // viewer: self scope, single member, NO quota control (read-only).
      ledgerViewer.scope === "self" &&
      ledgerViewer.members === 1 &&
      ledgerViewer.editBtns === 0 &&
      ledgerViewer.readonly >= 1 &&
      // quotas off: graceful notice, controls gone, ledger still renders.
      ledgerNoQuota.disabled &&
      /Setup/.test(ledgerNoQuota.text) &&
      !/--enable/.test(ledgerNoQuota.text) &&
      ledgerNoQuota.editBtns === 0 &&
      ledgerNoQuota.members === 3;

    // V22-W2 retro analytics insights (advisory, read-only): insight cards render
    // (throughput/themes/patterns/outcomes/cost), advisory banner is explicit,
    // small-sample -> low-confidence label, operator-only (viewer 403), disabled
    // (404) degrades gracefully. Mirrors web_app.py /api/retro/analytics.
    const reenterInsights = async () => {
      await page.$eval('.dr-tab[data-view="board"]', (el) => el.click());
      await page.waitForFunction(() => document.querySelectorAll(".dr-card").length >= 1, { timeout: 8000 });
      await page.$eval('.dr-tab[data-view="insights"]', (el) => el.click());
      await page.waitForSelector(".insights", { timeout: 8000 });
    };
    await page.$eval('.dr-tab[data-view="insights"]', (el) => el.click());
    await page.waitForSelector(".insights-advisory", { timeout: 8000 });
    const insights = await page.evaluate(() => ({
      advisory: !!document.querySelector(".insights-advisory"),
      advisoryText: (document.querySelector(".insights-advisory")?.textContent ?? "").trim(),
      advisoryActions: document.querySelector(".insights-advisory")?.getAttribute("data-actions") ?? "",
      mode: document.querySelector(".insights-advisory")?.getAttribute("data-mode") ?? "",
      throughput: !!document.querySelector('.insights-card[data-card="throughput"]'),
      sparkBars: document.querySelectorAll(".insights-spark__bar").length,
      themes: document.querySelectorAll(".insights-theme").length,
      themeNames: Array.from(document.querySelectorAll(".insights-theme")).map((e) => e.getAttribute("data-theme")),
      patterns: !!document.querySelector('.insights-card[data-card="patterns"]'),
      outcomeRows: document.querySelectorAll(".insights-outcome").length,
      // agy cost honestly unknown
      agyUnknown: !!document.querySelector('.insights-cost [data-agy="unknown"]'),
      // medium sample -> no low-confidence badge yet
      lowConfBadge: !!document.querySelector(".insights-badge.is-lowconf"),
    }));
    // small sample -> low-confidence label.
    await page.evaluate(() => window.__MOCK__.setRetroLowConfidence(true));
    await reenterInsights();
    await page.waitForSelector(".insights-badge.is-lowconf", { timeout: 8000 });
    const insightsLow = await page.evaluate(() => ({
      lowConfBadge: !!document.querySelector(".insights-badge.is-lowconf"),
      text: (document.querySelector(".insights-badge.is-lowconf")?.textContent ?? "").trim(),
      advisoryStill: !!document.querySelector(".insights-advisory"), // still advisory
    }));
    await page.evaluate(() => window.__MOCK__.setRetroLowConfidence(false));
    await reenterInsights();
    // operator-only: a viewer gets a fixed graceful notice (403), no cards.
    await page.evaluate(() => window.__MOCK__.setViewer(true));
    await reenterInsights();
    await page.waitForSelector('.insights-msg[data-err="forbidden"]', { timeout: 8000 });
    const insightsViewer = await page.evaluate(() => ({
      forbidden: !!document.querySelector('.insights-msg[data-err="forbidden"]'),
      cards: document.querySelectorAll(".insights-card").length,
    }));
    await page.evaluate(() => window.__MOCK__.setViewer(false));
    await reenterInsights();
    // disabled (404): graceful notice, no cards.
    await page.evaluate(() => window.__MOCK__.setRetroAnalyticsEnabled(false));
    await reenterInsights();
    await page.waitForSelector('.insights-msg[data-err="disabled"]', { timeout: 8000 });
    const insightsDisabled = await page.evaluate(() => ({
      disabled: !!document.querySelector('.insights-msg[data-err="disabled"]'),
      text: (document.querySelector('.insights-msg[data-err="disabled"]')?.textContent ?? "").trim(),
      cards: document.querySelectorAll(".insights-card").length,
    }));
    await page.evaluate(() => window.__MOCK__.setRetroAnalyticsEnabled(true));

    const retroAnalyticsOk =
      // cards render with the advisory banner (mode advisory, zero actions).
      insights.advisory &&
      /참고용|advisory/i.test(insights.advisoryText) &&
      insights.mode === "advisory" &&
      insights.advisoryActions === "0" &&
      insights.throughput &&
      insights.sparkBars >= 3 &&
      insights.themes >= 2 &&
      insights.themeNames.includes("testing") &&
      insights.patterns &&
      insights.outcomeRows >= 2 && // by_node + by_role
      insights.agyUnknown && // agy cost honestly unknown
      !insights.lowConfBadge && // medium sample: no low-conf label
      // low-confidence label on small sample (still advisory).
      insightsLow.lowConfBadge &&
      /낮은 신뢰도|Low confidence/.test(insightsLow.text) &&
      insightsLow.advisoryStill &&
      // operator-only: viewer locked out gracefully (no cards).
      insightsViewer.forbidden &&
      insightsViewer.cards === 0 &&
      // disabled: graceful notice, no cards.
      insightsDisabled.disabled &&
      /Setup/.test(insightsDisabled.text) &&
      !/--enable/.test(insightsDisabled.text) &&
      insightsDisabled.cards === 0;

    // V23-W2 usage trend / anomaly (advisory, read-only): trend sparkline + delta,
    // anomaly flags as SIGNALS only (no throttle/abort), forecast labelled "not a
    // prediction", agy cost unknown (never a spike), thin-data low confidence,
    // window selector, operator-only. Mirrors web_app.py /api/usage/trend.
    const reenterTrend = async () => {
      await page.$eval('.dr-tab[data-view="board"]', (el) => el.click());
      await page.waitForFunction(() => document.querySelectorAll(".dr-card").length >= 1, { timeout: 8000 });
      await page.$eval('.dr-tab[data-view="trend"]', (el) => el.click());
      await page.waitForSelector(".trend", { timeout: 8000 });
    };
    await page.$eval('.dr-tab[data-view="trend"]', (el) => el.click());
    await page.waitForSelector(".trend-node", { timeout: 8000 });
    const trend = await page.evaluate(() => {
      const node = (id) => document.querySelector(`.trend-node[data-node="${id}"]`);
      const backend = node("backend");
      const frontend = node("frontend");
      const researcher = node("researcher");
      return {
        advisory: !!document.querySelector(".trend-advisory"),
        advisoryActions: document.querySelector(".trend-advisory")?.getAttribute("data-actions") ?? "",
        advisoryEnforced: document.querySelector(".trend-advisory")?.getAttribute("data-enforced") ?? "",
        advisoryText: (document.querySelector(".trend-advisory")?.textContent ?? "").trim(),
        nodes: document.querySelectorAll(".trend-node").length,
        sparkBars: document.querySelectorAll(".trend-spark__bar").length,
        // backend: token spike flagged + highlighted last bar
        backendSpike: !!backend?.querySelector('.trend-anomaly[data-anomaly="flagged"][data-kind="tokens"]'),
        backendSpikeBar: !!backend?.querySelector(".trend-spark__bar.is-spike"),
        // frontend (agy): cost excluded/unknown, NOT flagged as spike
        frontAgyExcluded: !!frontend?.querySelector('.trend-anomaly.is-excluded[data-kind="cost"]'),
        frontTokFlagged: !!frontend?.querySelector('.trend-anomaly[data-anomaly="flagged"][data-kind="tokens"]'),
        frontCostUnknown: !!frontend?.querySelector('[data-agy="unknown"]'),
        // researcher: thin data -> low confidence
        researcherLowConf: !!researcher?.querySelector('[data-confidence="low"]'),
        // forecast label present on every node (not a prediction)
        forecastLabels: document.querySelectorAll('[data-forecast="label"]').length,
        forecastText: (document.querySelector('[data-forecast="label"]')?.textContent ?? "").trim(),
        // READ-ONLY: no action buttons anywhere except the window selector
        nonWindowButtons: Array.from(document.querySelectorAll(".trend button")).filter((b) => !b.classList.contains("trend-window__btn")).length,
        windowActive: document.querySelector(".trend-window__btn.is-on")?.getAttribute("data-window") ?? "",
      };
    });
    // window selector: switch to 7d -> refetch sends window=7d.
    await page.click('.trend-window__btn[data-window="7d"]');
    await page.waitForFunction(() => window.__MOCK__?.usageTrendWindow === "7d", { timeout: 6000 });
    const trendWindow = await page.evaluate(() => ({
      sent: window.__MOCK__?.usageTrendWindow ?? "",
      active: document.querySelector(".trend-window__btn.is-on")?.getAttribute("data-window") ?? "",
    }));
    // contract: a window outside the 7d/14d/30d allowlist is REJECTED with 400
    // (mirrors web_app.py _usage_trend_window) — never a silent 14d fallback. The
    // FE only ever sends allowlisted windows; assert the raw contract directly.
    const trendWindowContract = await page.evaluate(async () => {
      const bad = await fetch("/api/usage/trend?window=5d");
      const empty = await fetch("/api/usage/trend?window=");
      const good = await fetch("/api/usage/trend?window=30d");
      return { bad: bad.status, empty: empty.status, good: good.status };
    });
    // operator-only: viewer (403) -> graceful notice, no node cards.
    await page.evaluate(() => window.__MOCK__.setViewer(true));
    await reenterTrend();
    await page.waitForSelector('.trend-msg[data-err="forbidden"]', { timeout: 8000 });
    const trendViewer = await page.evaluate(() => ({
      forbidden: !!document.querySelector('.trend-msg[data-err="forbidden"]'),
      nodes: document.querySelectorAll(".trend-node").length,
    }));
    await page.evaluate(() => window.__MOCK__.setViewer(false));
    await reenterTrend();
    // disabled (404) -> graceful notice, no node cards.
    await page.evaluate(() => window.__MOCK__.setUsageTrendEnabled(false));
    await reenterTrend();
    await page.waitForSelector('.trend-msg[data-err="disabled"]', { timeout: 8000 });
    const trendDisabled = await page.evaluate(() => ({
      disabled: !!document.querySelector('.trend-msg[data-err="disabled"]'),
      text: (document.querySelector('.trend-msg[data-err="disabled"]')?.textContent ?? "").trim(),
      nodes: document.querySelectorAll(".trend-node").length,
    }));
    await page.evaluate(() => window.__MOCK__.setUsageTrendEnabled(true));

    const trendAnomalyOk =
      // trend renders, advisory banner (no actions, never enforced).
      trend.advisory &&
      trend.advisoryActions === "0" &&
      trend.advisoryEnforced === "0" &&
      trend.nodes === 3 &&
      trend.sparkBars >= 6 &&
      // anomaly = ADVISORY signal: backend token spike flagged + highlighted bar.
      trend.backendSpike &&
      trend.backendSpikeBar &&
      /이상 신호|Anomaly/.test(trend.advisoryText) &&
      // agy cost: unknown + excluded, never mis-flagged as a spike.
      trend.frontAgyExcluded &&
      !trend.frontTokFlagged &&
      trend.frontCostUnknown &&
      // thin-data -> low confidence.
      trend.researcherLowConf &&
      // forecast labelled "not a prediction" on each node.
      trend.forecastLabels === 3 &&
      /예측 아님|Not a prediction/.test(trend.forecastText) &&
      // READ-ONLY: zero action buttons (only the window selector exists).
      trend.nonWindowButtons === 0 &&
      trend.windowActive === "14d" &&
      // window selector works.
      trendWindow.sent === "7d" &&
      trendWindow.active === "7d" &&
      // invalid window -> 400 (allowlist), valid -> 200; no silent fallback.
      trendWindowContract.bad === 400 &&
      trendWindowContract.empty === 400 &&
      trendWindowContract.good === 200 &&
      // operator-only + disabled graceful.
      trendViewer.forbidden &&
      trendViewer.nodes === 0 &&
      trendDisabled.disabled &&
      /Setup/.test(trendDisabled.text) &&
      !/--enable/.test(trendDisabled.text) &&
      trendDisabled.nodes === 0;

    // V24-W2 notification routing config: read-only rule view + dry-run state +
    // escalation, operator-only config (explicit confirm), viewer lock, graceful
    // unconfigured. Mirrors web_app.py /api/notifications/routing.
    const reenterRouting = async () => {
      await page.$eval('.dr-tab[data-view="board"]', (el) => el.click());
      await page.waitForFunction(() => document.querySelectorAll(".dr-card").length >= 1, { timeout: 8000 });
      await page.$eval('.dr-tab[data-view="routing"]', (el) => el.click());
      await page.waitForSelector(".routing", { timeout: 8000 });
    };
    await page.$eval('.dr-tab[data-view="routing"]', (el) => el.click());
    await page.waitForSelector(".routing-rule", { timeout: 8000 });
    const routing = await page.evaluate(() => {
      const r1 = document.querySelector('.routing-rule[data-rule="blocked-to-ops"]');
      return {
        rules: document.querySelectorAll(".routing-rule").length,
        dryRunBadge: !!document.querySelector(".routing-dryrun.is-dry"),
        dryRunText: (document.querySelector(".routing-dryrun")?.textContent ?? "").trim(),
        enabledBadge: !!document.querySelector(".routing-badge.is-on"),
        // rule 1 shows its condition + target + escalation (window + max)
        cond: !!r1?.querySelector(".routing-cond"),
        target: (r1?.querySelector(".routing-target")?.textContent ?? "").trim(),
        escWindow: !!r1?.querySelector(".routing-esc__window"),
        escMax: (r1?.querySelector(".routing-esc__max")?.textContent ?? "").trim(),
        // operator sees the config affordance
        configBtn: !!document.querySelector(".routing-edit__btn"),
        readonly: !!document.querySelector(".routing-readonly"),
      };
    });
    // operator config: edit → save → CONFIRM (no POST yet) → confirm → POST.
    await page.$eval(".routing-edit__btn", (el) => el.click());
    await page.waitForSelector('.routing-editor[data-editor="open"]', { timeout: 6000 });
    await page.type(".routing-edit__name", "anomaly-route");
    await page.type(".routing-edit__room", "C-alerts");
    await page.$eval(".routing-edit__save", (el) => el.click());
    await page.waitForSelector(".routing-confirm__yes", { timeout: 6000 });
    const routingBeforeYes = await page.evaluate(() => window.__MOCK__?.routingPosted ?? null);
    await page.$eval(".routing-confirm__yes", (el) => el.click());
    await page.waitForFunction(() => window.__MOCK__?.routingPosted != null, { timeout: 8000 });
    const routingPosted = await page.evaluate(() => window.__MOCK__?.routingPosted ?? null);
    // viewer lock: read-only note, no config editor.
    await page.evaluate(() => window.__MOCK__.setViewer(true));
    await reenterRouting();
    await page.waitForSelector(".routing-readonly", { timeout: 8000 });
    const routingViewer = await page.evaluate(() => ({
      readonly: !!document.querySelector(".routing-readonly"),
      configBtn: !!document.querySelector(".routing-edit__btn"),
      rules: document.querySelectorAll(".routing-rule").length, // still readable
    }));
    await page.evaluate(() => window.__MOCK__.setViewer(false));
    await reenterRouting();
    // graceful unconfigured.
    await page.evaluate(() => window.__MOCK__.setRoutingConfigured(false));
    await reenterRouting();
    await page.waitForSelector('.routing-empty[data-empty="1"]', { timeout: 8000 });
    const routingEmpty = await page.evaluate(() => ({
      empty: !!document.querySelector('.routing-empty[data-empty="1"]'),
      rules: document.querySelectorAll(".routing-rule").length,
    }));
    await page.evaluate(() => window.__MOCK__.setRoutingConfigured(true));

    const routingConfigOk =
      // read-only rule view + dry-run prominently shown.
      routing.rules === 2 &&
      routing.dryRunBadge &&
      /dry-run/.test(routing.dryRunText) &&
      routing.enabledBadge &&
      routing.cond &&
      /slack:C-ops/.test(routing.target) &&
      // escalation window + bounded max surfaced.
      routing.escWindow &&
      /1/.test(routing.escMax) &&
      // operator config: confirm-gated POST (nothing before confirm).
      routing.configBtn &&
      !routing.readonly &&
      routingBeforeYes === null &&
      routingPosted?.rules === 1 &&
      routingPosted?.dry_run === true &&
      // viewer locked to read-only (still reads the rules, no editor).
      routingViewer.readonly &&
      !routingViewer.configBtn &&
      routingViewer.rules >= 1 &&
      // graceful unconfigured.
      routingEmpty.empty &&
      routingEmpty.rules === 0;

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
    await page.$eval('.dr-tab[data-view="team"]', (el) => el.click());
    await page.waitForFunction(
      () => document.querySelectorAll(".org-node").length === 1 && !!document.querySelector('[data-name="solo"]'),
      { timeout: 8000 },
    );
    const soloOrg = await page.evaluate(() => ({
      nodes: document.querySelectorAll(".org-node").length,
      hasRoot: !!document.querySelector('[data-name="root"]'),
    }));
    // board re-scoped: the solo task shows, none of the default project's G- cards.
    await page.$eval('.dr-tab[data-view="board"]', (el) => el.click());
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
      () => (document.querySelector(".proj-switcher__name")?.textContent ?? "").trim() === "grove-dev",
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
      () => (document.querySelector(".proj-switcher__name")?.textContent ?? "").trim() === "grove-infra",
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
    await page.waitForSelector(".proj-modal.is-new .proj-result", { timeout: 6000 });
    const createResult = await page.evaluate(() => ({
      buckets: document.querySelectorAll(".proj-modal.is-new .proj-result__bucket").length,
      board: (document.querySelector(".proj-modal.is-new .proj-result__bucket.is-restored .proj-result__items")?.textContent ?? "").trim(),
      master: (document.querySelector(".proj-modal.is-new .proj-result__bucket.is-fresh .proj-result__items")?.textContent ?? "").trim(),
      dashboard: (document.querySelector(".proj-modal.is-new .proj-result__bucket.is-stale .proj-result__items")?.textContent ?? "").trim(),
    }));
    await page.click(".proj-new__switch");
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
    await page.$eval('.dr-tab[data-view="team"]', (el) => el.click());
    await page.waitForSelector(".org-node", { timeout: 8000 });
    await page.waitForFunction(() => (window.__MOCK__?.projectHeader ?? "") === "loaded-proj", { timeout: 6000 });

    const projectOk =
      projItems >= 2 &&
      projInitial === "grove-dev" && // display_name (internal: dev10)
      projAfterSwitch === "grove-infra" && // display_name (internal: infra-ops)
      newCfg.name === "demo-proj" &&
      createResult.buckets >= 3 &&
      createResult.board === "demo-proj" &&
      createResult.master === "lead" &&
      createResult.dashboard.includes("demo-proj") &&
      projAfterNew === "demo-proj" &&
      loadResult.buckets >= 3 &&
      loadResult.ok === true &&
      loadedPath.includes("loaded-proj") &&
      projAfterLoad === "loaded-proj";

    // V15-W2 mobile responsive pass: at 390px the safe surfaces stay usable —
    // tabs reachable, ExecutionPanel gate/kill-switch fit, node-status detail
    // reachable, and no page-level horizontal overflow. Restore the viewport
    // afterwards. (CSS-only; no behaviour change.)
    await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2 });
    await new Promise((r) => setTimeout(r, 200));
    // Native clicks: at 390px the tab bar scrolls horizontally, so coordinate
    // clicks can miss; el.click() still fires the handler (the point here is that
    // the control is reachable + the layout fits, not pointer hit-testing).
    await page.$eval('.dr-tab[data-view="exec"]', (el) => el.click());
    await page.waitForSelector(".exec-gate", { timeout: 8000 });
    const mobile = await page.evaluate(() => {
      const vw = 390;
      const fits = (sel) => {
        const el = document.querySelector(sel);
        if (!el) return false;
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.right <= vw + 2 && r.left >= -2;
      };
      return {
        execTabActive: !!document.querySelector('.dr-tab[data-view="exec"].is-active'),
        gateFits: fits(".exec-gate"),
        ksBtn: !!document.querySelector(".exec-ks__btn"),
        nodestat: !!document.querySelector(".nodestat"),
        noHOverflow: document.documentElement.scrollWidth <= vw + 3,
      };
    });
    // node-status detail reachable + fits at mobile width.
    await page.$eval(".nodestat__more", (el) => el.click());
    await page.waitForSelector(".nodestat-detail", { timeout: 6000 });
    const detailFits = await page.evaluate(() => {
      const el = document.querySelector(".nodestat-detail");
      if (!el) return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.right <= 390 + 2 && r.left >= -2;
    });
    await page.$eval(".nodestat__more", (el) => el.click()); // collapse
    await page.setViewport({ width: 1320, height: 860, deviceScaleFactor: 2 }); // restore
    const mobileOk =
      mobile.execTabActive && mobile.gateFits && mobile.ksBtn && mobile.nodestat && mobile.noHOverflow && detailFits;

    // V24-W1 left sidebar nav: all panels/drawers moved from the top strip into a
    // grouped, collapsible left sidebar; top bar minimized; mobile hamburger
    // drawer. Every panel stays reachable (legacy hook classes preserved), so the
    // flags above don't regress. (Viewport is back to desktop after mobileOk.)
    const SIDEBAR_VIEWS = [
      "board", "team", "terminal", "integrations", "exec", "cost",
      "ledger", "insights", "trend", "agg", "handoff", "connect", "routing", "auth",
    ];
    const sidebar = await page.evaluate((views) => {
      const sb = document.querySelector(".dr-sidebar");
      const inSb = (sel) => !!sb?.querySelector(sel);
      return {
        present: !!sb,
        groups: document.querySelectorAll(".dr-sidebar .dr-navgroup").length,
        groupIds: Array.from(document.querySelectorAll(".dr-sidebar .dr-navgroup")).map((g) => g.getAttribute("data-group")),
        // every view panel is reachable from the sidebar
        allViews: views.every((v) => inSb(`.dr-tab[data-view="${v}"]`)),
        // the three drawer triggers moved here too
        drawers: inSb(".dr-audit-btn") && inSb(".dr-chain-btn") && inSb(".dr-inbox-btn"),
        // top bar is minimized: no nav tabs / drawer buttons left in the header...
        topNoNav: document.querySelectorAll(".dr-top .dr-tab, .dr-top .dr-audit-btn, .dr-top .dr-chain-btn, .dr-top .dr-inbox-btn").length === 0,
        // ...but the essentials remain in the header.
        topKeeps:
          !!document.querySelector(".dr-top .dr-brand") &&
          !!document.querySelector(".dr-top .proj-switcher") &&
          !!document.querySelector(".dr-top .dr-presence") &&
          !!document.querySelector(".dr-top .dr-lang"),
      };
    }, SIDEBAR_VIEWS);
    // active highlight via a sidebar item.
    await page.$eval('.dr-sidebar .dr-tab[data-view="ledger"]', (el) => el.click());
    await page.waitForSelector('.dr-sidebar .dr-tab[data-view="ledger"].is-active', { timeout: 6000 });
    const sidebarActive = await page.evaluate(() => !!document.querySelector('.dr-sidebar .dr-tab[data-view="ledger"].is-active'));
    // collapse a group -> its items hide; re-expand -> they return.
    await page.$eval('.dr-navgroup[data-group="ops"] .dr-navgroup__head', (el) => el.click());
    await page.waitForFunction(() => !document.querySelector('.dr-navgroup[data-group="ops"] .dr-tab[data-view="trend"]'), { timeout: 6000 });
    const groupCollapsed = await page.evaluate(() => !document.querySelector('.dr-navgroup[data-group="ops"] .dr-tab[data-view="trend"]'));
    await page.$eval('.dr-navgroup[data-group="ops"] .dr-navgroup__head', (el) => el.click());
    await page.waitForSelector('.dr-navgroup[data-group="ops"] .dr-tab[data-view="trend"]', { timeout: 6000 });
    const groupReexpanded = await page.evaluate(() => !!document.querySelector('.dr-navgroup[data-group="ops"] .dr-tab[data-view="trend"]'));
    // mobile: hamburger visible + sidebar off-canvas; opening it slides in.
    await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2 });
    // the sidebar animates to translateX(-100%) on the desktop->mobile switch;
    // wait for that slide-OUT to finish before measuring (don't race the 0.22s
    // transition with a fixed timeout).
    await page.waitForFunction(
      () => {
        const sb = document.querySelector(".dr-sidebar");
        const r = sb?.getBoundingClientRect();
        return !!r && r.right <= 2;
      },
      { timeout: 4000 },
    );
    const mobileNav = await page.evaluate(() => {
      const ham = document.querySelector(".dr-hamburger");
      const sb = document.querySelector(".dr-sidebar");
      const r = sb?.getBoundingClientRect();
      return {
        hamburgerVisible: !!ham && ham.offsetParent !== null,
        offCanvas: !!r && r.right <= 2, // translated off-screen to the left
        noHOverflow: document.documentElement.scrollWidth <= 390 + 3,
      };
    });
    await page.$eval(".dr-hamburger", (el) => el.click());
    await page.waitForSelector(".dr-sidebar.is-open", { timeout: 6000 });
    await new Promise((r) => setTimeout(r, 320)); // let the 0.22s slide-in settle
    const drawerNav = await page.evaluate(() => {
      const sb = document.querySelector(".dr-sidebar.is-open");
      const r = sb?.getBoundingClientRect();
      return { open: !!sb, onScreen: !!r && r.left >= -2 && r.left < 60, scrim: !!document.querySelector(".dr-nav-scrim") };
    });
    await page.$eval(".dr-hamburger", (el) => el.click()); // close
    await page.setViewport({ width: 1320, height: 860, deviceScaleFactor: 2 }); // restore
    const sidebarNavOk =
      sidebar.present &&
      sidebar.groups >= 6 &&
      sidebar.allViews && // all 13 panels reachable from the sidebar
      sidebar.drawers && // audit/chain/inbox drawers reachable too
      sidebar.topNoNav && // top bar minimized
      sidebar.topKeeps && // brand/project/presence/lang stay up top
      sidebarActive &&
      groupCollapsed &&
      groupReexpanded &&
      mobileNav.hamburgerVisible &&
      mobileNav.offCanvas &&
      mobileNav.noHOverflow &&
      drawerNav.open &&
      drawerNav.onScreen &&
      drawerNav.scrim;

    // V25-W1 command palette (Cmd-K): open via keyboard + button, list every
    // view/drawer, fuzzy filter → keyboard select → navigate. NAVIGATION-ONLY
    // (no mutation), Esc closes + restores focus. (Viewport is desktop here.)
    // a snapshot of mutation markers proves the palette never mutates.
    const MUT_KEYS = ["routingPosted", "quotaSet", "handoffAccepted", "execApprove", "execAbort", "aggregated", "joined", "shareIssued", "slackConfig", "createdTask"];
    const palMutSnap = () => page.evaluate((keys) => JSON.stringify(keys.map((k) => window.__MOCK__?.[k] ?? null)), MUT_KEYS);
    const palMutBefore = await palMutSnap();
    // open via Cmd/Ctrl-K
    await page.keyboard.down("Control");
    await page.keyboard.press("KeyK");
    await page.keyboard.up("Control");
    await page.waitForSelector(".cmdk__panel", { timeout: 6000 });
    await page.waitForFunction(() => document.activeElement === document.querySelector(".cmdk__input"), { timeout: 8000 });
    const paletteOpened = await page.evaluate(() => ({
      panel: !!document.querySelector('.cmdk__panel[role="dialog"]'),
      listbox: !!document.querySelector('.cmdk__list[role="listbox"]'),
      // every sidebar view + drawer is listed
      options: document.querySelectorAll('.cmdk__item[role="option"]').length,
      // focus moved into the palette input (focus trap)
      inputFocused: document.activeElement === document.querySelector(".cmdk__input"),
    }));
    // fuzzy filter (works regardless of KO/EN labels via the english keyword) +
    // keyboard select -> view switch.
    await page.type(".cmdk__input", "ledger");
    // wait until the filter narrowed so the top match is ledger (don't let Enter
    // fire against the still-unfiltered list).
    await page.waitForFunction(
      () => document.querySelector('.cmdk__item[role="option"]')?.getAttribute("data-cmd") === "view:ledger",
      { timeout: 6000 },
    );
    const filtered = await page.evaluate(() => ({
      count: document.querySelectorAll('.cmdk__item[role="option"]').length,
      first: document.querySelector('.cmdk__item[role="option"]')?.getAttribute("data-cmd") ?? "",
    }));
    await page.keyboard.press("Enter"); // run the active (top) command
    await page.waitForSelector('.dr-tab[data-view="ledger"].is-active', { timeout: 6000 });
    const navLedger = await page.evaluate(() => ({
      active: !!document.querySelector('.dr-tab[data-view="ledger"].is-active'),
      closed: !document.querySelector(".cmdk__panel"), // palette closes after select
    }));
    // reach a DRAWER via the palette (audit).
    await page.keyboard.down("Control");
    await page.keyboard.press("KeyK");
    await page.keyboard.up("Control");
    await page.waitForSelector(".cmdk__panel", { timeout: 6000 });
    await page.type(".cmdk__input", "audit");
    await page.waitForFunction(() => !!document.querySelector('.cmdk__item[data-cmd="drawer:audit"]'), { timeout: 6000 });
    await page.$eval('.cmdk__item[data-cmd="drawer:audit"]', (el) => el.click());
    await page.waitForSelector(".audit-drawer", { timeout: 6000 });
    const navDrawer = await page.evaluate(() => !!document.querySelector(".audit-drawer"));
    await page.$eval(".audit-drawer .dr-drawer__close", (el) => el.click());
    await page.waitForFunction(() => !document.querySelector(".audit-drawer"), { timeout: 6000 });
    // ↑/↓ keyboard nav changes the active option.
    await page.keyboard.down("Control");
    await page.keyboard.press("KeyK");
    await page.keyboard.up("Control");
    await page.waitForSelector(".cmdk__panel", { timeout: 6000 });
    const firstActive = await page.evaluate(() => document.querySelector('.cmdk__item[aria-selected="true"]')?.getAttribute("data-cmd") ?? "");
    await page.keyboard.press("ArrowDown");
    const afterDown = await page.evaluate(() => document.querySelector('.cmdk__item[aria-selected="true"]')?.getAttribute("data-cmd") ?? "");
    // Esc closes the palette.
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => !document.querySelector(".cmdk__panel"), { timeout: 6000 });
    const escClosed = await page.evaluate(() => !document.querySelector(".cmdk__panel"));
    // open via the BUTTON (real click focuses it), then Esc -> focus restored.
    await page.click(".cmdk-trigger");
    await page.waitForSelector(".cmdk__panel", { timeout: 6000 });
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => !document.querySelector(".cmdk__panel"), { timeout: 6000 });
    const focusRestored = await page.evaluate(() => document.activeElement === document.querySelector(".cmdk-trigger"));
    const palMutAfter = await palMutSnap();

    const commandPaletteOk =
      paletteOpened.panel &&
      paletteOpened.listbox &&
      paletteOpened.options === 17 && // 14 views + 3 drawers
      paletteOpened.inputFocused &&
      filtered.count >= 1 &&
      filtered.first === "view:ledger" &&
      navLedger.active &&
      navLedger.closed &&
      navDrawer && // drawer reachable via palette
      firstActive !== "" &&
      afterDown !== firstActive && // ↓ moved the selection
      escClosed &&
      focusRestored && // focus returned to the trigger
      palMutBefore === palMutAfter; // NAVIGATION-ONLY: zero mutations

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

    // --- MasterChat (floating read/action-gated chat) — isolated page -----
    // Drives the v1.27 widget against the mock backend contract on a throwaway
    // page (no effect on the main page's state/screenshot/diag): operator sees
    // the FAB; the panel opens; the history GET 405 is graceful (no fatal, no
    // "unavailable" banner); an answer send increments masterChatSent + carries
    // origin "floating_web_chat" and renders answer.text; a preview send renders
    // the proposal bubble; and a viewer (?viewer=1) can ask factual questions
    // while action-like turns remain operator-gated.
    const mpage = await browser.newPage();
    await mpage.setViewport({ width: 1320, height: 860, deviceScaleFactor: 2 });
    const mchatErrors = [];
    mpage.on("pageerror", (e) => mchatErrors.push("pageerror: " + String(e)));
    mpage.on("console", (m) => {
      if (m.type() !== "error") return;
      const tx = m.text();
      if (/Failed to load resource|net::|fonts\.googleapis/.test(tx)) return;
      mchatErrors.push("console: " + tx);
    });

    await mpage.goto("file://" + htmlPath, { waitUntil: "load" });
    await mpage.waitForSelector(".dr-mchat__fab", { timeout: 8000 });
    const mchatFabPresent = (await mpage.$(".dr-mchat__fab")) !== null;
    await mpage.click(".dr-mchat__fab");
    await mpage.waitForSelector(".dr-mchat__panel", { timeout: 5000 });
    await mpage.waitForSelector(".dr-mchat__empty", { timeout: 5000 });
    const mchatHistory = await mpage.evaluate(() => ({
      empty: !!document.querySelector(".dr-mchat__empty"),
      notice: !!document.querySelector(".dr-mchat__notice"),
    }));

    // answer path: send a question -> masterChatSent++, origin, user bubble sent,
    // master bubble from answer.text.
    const mchatSentBefore = await mpage.evaluate(() => window.__MOCK__?.masterChatSent ?? 0);
    await mpage.type(".dr-mchat__input", "what is the current status");
    await mpage.keyboard.press("Enter");
    await mpage.waitForFunction(
      () => document.querySelectorAll('.dr-mchat__row[data-role="master"] .dr-mchat__bubble').length >= 1,
      { timeout: 5000 },
    );
    const mchatAnswer = await mpage.evaluate(() => {
      const masters = Array.from(
        document.querySelectorAll('.dr-mchat__row[data-role="master"] .dr-mchat__bubble'),
      ).map((b) => b.textContent ?? "");
      return {
        sent: window.__MOCK__?.masterChatSent ?? 0,
        origin: window.__MOCK__?.masterChatOrigin ?? "",
        userSent: !!document.querySelector('.dr-mchat__row[data-role="user"][data-status="sent"]'),
        masterText: masters[masters.length - 1] ?? "",
        factText: (document.querySelector(".dr-mchat__facts")?.textContent ?? "").trim(),
        noProjectMaster: !/project-master/i.test(
          [masters[masters.length - 1] ?? "", document.querySelector(".dr-mchat__facts")?.textContent ?? ""].join(
            " ",
          ),
        ),
      };
    });

    // preview path: an "add …" message -> LLM-authored preview plus a confirm control.
    await mpage.type(".dr-mchat__input", "add a login page");
    await mpage.keyboard.press("Enter");
    await mpage.waitForFunction(
      () =>
        Array.from(document.querySelectorAll('.dr-mchat__row[data-role="master"] .dr-mchat__bubble')).some((b) =>
          /handoff for MASTER|decision ledger/.test(b.textContent ?? ""),
        ),
      { timeout: 5000 },
    );
    const mchatPreview = await mpage.evaluate(() => {
      const masters = Array.from(
        document.querySelectorAll('.dr-mchat__row[data-role="master"] .dr-mchat__bubble'),
      ).map((b) => b.textContent ?? "");
      return {
        masterBubbles: masters.length,
        hasPreviewText: masters.some((t) => /handoff for MASTER|decision ledger/.test(t)),
        hasConfirm: !!document.querySelector(".dr-mchat__confirm"),
      };
    });
    await mpage.click(".dr-mchat__confirm");
    await mpage.waitForFunction(
      () =>
        Array.from(document.querySelectorAll('.dr-mchat__row[data-role="master"] .dr-mchat__bubble')).some((b) =>
          /Recorded assistant_mock_/.test(b.textContent ?? ""),
        ),
      { timeout: 5000 },
    );
    const mchatConfirm = await mpage.evaluate(() => {
      const masters = Array.from(
        document.querySelectorAll('.dr-mchat__row[data-role="master"] .dr-mchat__bubble'),
      ).map((b) => b.textContent ?? "");
      return {
        masterBubbles: masters.length,
        confirmed: masters.some((t) => /Recorded assistant_mock_/.test(t)),
        confirmHidden: !document.querySelector(".dr-mchat__confirm"),
      };
    });

    // denied path: a deploy/destructive message -> the LLM-authored answer.text is
    // shown; the non-LLM operator_gate.reason must NOT be exposed to the user.
    const deniedBeforeCount = mchatConfirm.masterBubbles;
    await mpage.type(".dr-mchat__input", "deploy to prod");
    await mpage.keyboard.press("Enter");
    await mpage.waitForFunction(
      (count) =>
        Array.from(document.querySelectorAll('.dr-mchat__row[data-role="master"] .dr-mchat__bubble'))
          .slice(count)
          .some((b) => /production\/destructive|can't run it from chat/.test(b.textContent ?? "")),
      { timeout: 5000 },
      deniedBeforeCount,
    );
    const mchatDenied = await mpage.evaluate(() => {
      const masters = Array.from(
        document.querySelectorAll('.dr-mchat__row[data-role="master"] .dr-mchat__bubble'),
      ).map((b) => b.textContent ?? "");
      return {
        llmShown: masters.some((t) => /mock-llm/.test(t)),
        gateHidden: !masters.some((t) => /non-llm|GATE:/.test(t)),
      };
    });

    // transport fallback: the unified backend returns its one-line assistant
    // fallback as a NORMAL 200 answer (answer.text) — rendered like any reply, not
    // a FE-authored notice.
    const fallbackBeforeCount = await mpage.$$eval('.dr-mchat__row[data-role="master"] .dr-mchat__bubble', (nodes) => nodes.length);
    await mpage.evaluate(() => window.__MOCK__.setMasterTransportBusy(true));
    await mpage.type(".dr-mchat__input", "status while busy");
    await mpage.keyboard.press("Enter");
    await mpage.waitForFunction(
      (count) =>
        Array.from(document.querySelectorAll('.dr-mchat__row[data-role="master"] .dr-mchat__bubble'))
          .slice(count)
          .some((b) => /잠시 뒤 다시 시도/.test(b.textContent ?? "")),
      { timeout: 5000 },
      fallbackBeforeCount,
    );
    const mchatFallback = await mpage.evaluate(() => ({
      shownAsAnswer: Array.from(
        document.querySelectorAll('.dr-mchat__row[data-role="master"] .dr-mchat__bubble'),
      ).some((b) => /잠시 뒤 다시 시도/.test(b.textContent ?? "")),
      noNotice: !document.querySelector(".dr-mchat__notice"),
    }));
    await mpage.evaluate(() => window.__MOCK__.setMasterTransportBusy(false));

    // hard transport death (503 {detail}): NO FE "준비 중"/"unavailable" notice; the
    // message just becomes retryable (the only allowed transport affordance).
    await mpage.evaluate(() => window.__MOCK__.setMasterChatEnabled(false));
    await mpage.type(".dr-mchat__input", "ping after death");
    await mpage.keyboard.press("Enter");
    await mpage.waitForFunction(
      () =>
        Array.from(document.querySelectorAll('.dr-mchat__row[data-role="user"]')).some(
          (r) => r.getAttribute("data-status") === "error",
        ),
      { timeout: 5000 },
    );
    const mchat503 = await mpage.evaluate(() => {
      const panelText = document.querySelector(".dr-mchat__panel")?.textContent ?? "";
      return {
        noNotice: !document.querySelector(".dr-mchat__notice"),
        noDevText: !/준비 중|being set up|available soon/.test(panelText),
        userError: Array.from(document.querySelectorAll('.dr-mchat__row[data-role="user"]')).some(
          (r) => r.getAttribute("data-status") === "error",
        ),
      };
    });
    await mpage.evaluate(() => window.__MOCK__.setMasterChatEnabled(true));

    // v1.29 cross-project org (task_c2fda5b7): the GROVE MASTER root in the org
    // chart opens the floating chat via the safe custom event, and a non-current
    // project-lead chip switches the active project (onSwitchProject -> switchProject).
    // Close the FAB-opened panel first so the root-driven re-open is unambiguous.
    await mpage.$eval(".dr-mchat__x", (el) => el.click());
    await mpage.waitForFunction(() => !document.querySelector(".dr-mchat__panel"), { timeout: 5000 });
    await mpage.$eval('.dr-tab[data-view="team"]', (el) => el.click());
    await mpage.waitForSelector(".org-master", { timeout: 8000 });
    await mpage.$eval(".org-master", (el) => el.click());
    await mpage.waitForSelector(".dr-mchat__panel", { timeout: 5000 });
    const masterRootOpensChat = (await mpage.$(".dr-mchat__panel")) !== null;
    // other project lead -> click switches projects (header display_name flips).
    const pleadTarget = await mpage.evaluate(
      () => document.querySelector(".org-plead:not(.is-current)")?.getAttribute("data-project") ?? "",
    );
    const projBeforePlead = await mpage.$eval(".proj-switcher__name", (el) => (el.textContent ?? "").trim());
    await mpage.$eval(".org-plead:not(.is-current)", (el) => el.click());
    await mpage.waitForFunction(
      (prev) => (document.querySelector(".proj-switcher__name")?.textContent ?? "").trim() !== prev,
      { timeout: 6000 },
      projBeforePlead,
    );
    const projAfterPlead = await mpage.$eval(".proj-switcher__name", (el) => (el.textContent ?? "").trim());
    const leadSwitchesProject = !!pleadTarget && projAfterPlead !== projBeforePlead;

    // Viewer read path: a viewer mount (?viewer=1) can open the launcher and ask
    // factual/read-only questions, but action-like turns are denied and never
    // produce a confirmation control.
    await mpage.goto("file://" + htmlPath + "?viewer=1", { waitUntil: "load" });
    await mpage.waitForSelector(".devroom .dr-brand", { timeout: 8000 });
    await mpage.waitForFunction(() => (window.__MOCK__?.meFetches ?? 0) >= 1, { timeout: 5000 });
    await mpage.waitForSelector(".dr-mchat__fab", { timeout: 5000 });
    const viewerSentBefore = await mpage.evaluate(() => window.__MOCK__?.masterChatSent ?? 0);
    await mpage.click(".dr-mchat__fab");
    await mpage.waitForSelector(".dr-mchat__panel", { timeout: 5000 });
    await mpage.type(".dr-mchat__input", "리뷰어 몇 명?");
    await mpage.keyboard.press("Enter");
    await mpage.waitForFunction(
      (before) =>
        (window.__MOCK__?.masterChatSent ?? 0) === before + 1 &&
        Array.from(document.querySelectorAll('.dr-mchat__row[data-role="master"] .dr-mchat__bubble')).some((b) =>
          /Reviewers:\s*2|reviewers\s+2/.test(b.textContent ?? ""),
        ),
      { timeout: 5000 },
      viewerSentBefore,
    );
    const mchatViewerRead = await mpage.evaluate((before) => {
      const masters = Array.from(
        document.querySelectorAll('.dr-mchat__row[data-role="master"] .dr-mchat__bubble'),
      ).map((b) => b.textContent ?? "");
      return {
        fabPresent: !!document.querySelector(".dr-mchat__fab"),
        sentIncremented: (window.__MOCK__?.masterChatSent ?? 0) === before + 1,
        hasAnswer: masters.some((t) => /follow up/.test(t)),
        hasFacts: /reviewers\s+2/.test(document.querySelector(".dr-mchat__facts")?.textContent ?? ""),
        confirmHidden: !document.querySelector(".dr-mchat__confirm"),
      };
    }, viewerSentBefore);
    const viewerActionSentBefore = await mpage.evaluate(() => window.__MOCK__?.masterChatSent ?? 0);
    const viewerUserRowsBefore = await mpage.$$eval('.dr-mchat__row[data-role="user"]', (nodes) => nodes.length);
    await mpage.type(".dr-mchat__input", "deploy to prod");
    await mpage.keyboard.press("Enter");
    await mpage.waitForFunction(
      (count) =>
        Array.from(document.querySelectorAll('.dr-mchat__row[data-role="user"]'))
          .slice(count)
          .some((r) => r.getAttribute("data-status") === "error"),
      { timeout: 5000 },
      viewerUserRowsBefore,
    );
    const mchatViewerAction = await mpage.evaluate((before) => ({
      deniedWithoutMutation: (window.__MOCK__?.masterChatSent ?? 0) === before,
      userError: Array.from(document.querySelectorAll('.dr-mchat__row[data-role="user"]')).some(
        (r) => r.getAttribute("data-status") === "error" && /deploy to prod/.test(r.textContent ?? ""),
      ),
      confirmHidden: !document.querySelector(".dr-mchat__confirm"),
    }), viewerActionSentBefore);
    await mpage.close();

    const mchat = {
      fabPresent: mchatFabPresent,
      history: mchatHistory,
      answer: {
        sentIncremented: mchatAnswer.sent === mchatSentBefore + 1,
        origin: mchatAnswer.origin,
        userSent: mchatAnswer.userSent,
        hasAnswer: /follow up/.test(mchatAnswer.masterText),
        hasFacts: /reviewers\s+2/.test(mchatAnswer.factText) && /ask-human\s+1/.test(mchatAnswer.factText),
        noProjectMaster: mchatAnswer.noProjectMaster,
      },
      preview: mchatPreview,
      confirm: mchatConfirm,
      denied: mchatDenied,
      fallback: mchatFallback,
      hard503: mchat503,
      masterRootOpensChat,
      leadSwitch: { target: pleadTarget, from: projBeforePlead, to: projAfterPlead, switched: leadSwitchesProject },
      viewer: { read: mchatViewerRead, action: mchatViewerAction },
      errors: mchatErrors.length,
    };
    const masterChatOk =
      mchat.fabPresent &&
      mchat.history.empty &&
      mchat.history.notice === false &&
      mchat.answer.sentIncremented &&
      mchat.answer.origin === "floating_web_chat" &&
      mchat.answer.userSent &&
      mchat.answer.hasAnswer &&
      mchat.answer.hasFacts &&
      mchat.answer.noProjectMaster &&
      mchat.preview.hasPreviewText &&
      mchat.preview.hasConfirm &&
      mchat.confirm.confirmed &&
      mchat.confirm.confirmHidden &&
      mchat.denied.llmShown &&
      mchat.denied.gateHidden &&
      mchat.fallback.shownAsAnswer &&
      mchat.fallback.noNotice &&
      mchat.hard503.noNotice &&
      mchat.hard503.noDevText &&
      mchat.hard503.userError &&
      mchat.masterRootOpensChat &&
      mchat.leadSwitch.switched &&
      mchat.viewer.read.fabPresent &&
      mchat.viewer.read.sentIncremented &&
      mchat.viewer.read.hasAnswer &&
      mchat.viewer.read.hasFacts &&
      mchat.viewer.read.confirmHidden &&
      mchat.viewer.action.deniedWithoutMutation &&
      mchat.viewer.action.userError &&
      mchat.viewer.action.confirmHidden &&
      mchat.errors === 0;

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

    const batchUiOk =
      shellBatch.brand === "GROVE" &&
      shellBatch.markSvgSource.includes("grove-icon.svg") &&
      shellBatch.markPngFallback.includes("grove-icon.png") &&
      shellBatch.markCurrentSrc.includes("grove-icon.svg") &&
      shellBatch.markLoaded &&
      shellBatch.noDevRoomSub &&
      shellBatch.nodes >= 1 &&
      shellBatch.nested &&
      shellBatch.roots >= 1 &&
      shellBatch.tutorial &&
      boardBatch.addButtons === 3 &&
      boardBatch.readyHasAdd &&
      boardBatch.progressHasAdd &&
      boardBatch.reviewHasAdd &&
      boardBatch.blockedHasAdd === false &&
      boardBatch.askHumanHasAdd === false &&
      boardBatch.doneHasAdd === false &&
      boardBatchAdd === "review" &&
      orgView.taskBadges >= 1;
    const i18nOk = i18n.ko === "GROVE" && i18n.en === "GROVE";
    const addOk = addTask.created === NEW_TITLE;
    const mirrorOk = term.markerCount === 1; // no accumulation
    const teamOk =
      orgLoading.nodes === 0 &&
      !orgLoading.emptyCopy &&
      orgView.nodes >= 1 &&
      orgView.edges >= 1 &&
      orgView.legend >= 1 &&
      masterOrgOk &&
      dragLabelsOk &&
      cutAffordance &&
      cutParent === "docs->null" &&
      patchedParent.startsWith("frontend->") &&
      patchedGroup.endsWith(":research") &&
      groupExit === "backend:null" &&
      plusCreated === PLUS_NODE &&
      plusDesc === "qa-desc" &&
      nodeFormPresetOk &&
      orgView.descs >= 1 &&
      nodeDrawer.facts >= 1 &&
      nodeDrawer.assignForm;

    const ok =
      diag.nodes >= 1 &&
      board.columns === 6 && // canonical workflow columns
      board.cards >= 1 &&
      boardCardOk &&
      drawer.runs >= 1 &&
      drawer.comments >= 1 &&
      term.termChars > 20 &&
      wsOk &&
      i18nOk &&
      addOk &&
      mirrorOk &&
      boardLiveOk &&
      cursorReplayOk &&
      n4Ok &&
      n5Ok &&
      projModelOk &&
      n1Ok &&
      n2Ok &&
      manualStatusOk &&
      manualOptionsOk &&
      reviewerOk &&
      teamOk &&
      slackOk &&
      slackIntakeOk &&
      authOk &&
      costOk &&
      usageReportOk &&
      aggViewOk &&
      handoffOk &&
      sharedAccessOk &&
      ledgerQuotaOk &&
      retroAnalyticsOk &&
      trendAnomalyOk &&
      routingConfigOk &&
      mobileOk &&
      sidebarNavOk &&
      commandPaletteOk &&
      projectOk &&
      wsBindOk &&
      wsKindOk &&
      statusBarOk &&
      detailOk &&
      auditOk &&
      chainOk &&
      inboxOk &&
      presenceOk &&
      wizardOk &&
      autonomyVisOk &&
      plannerSurfaceOk &&
      pickupToggleOk &&
      execLoopOk &&
      delegationEdgesOk &&
      delegateOk &&
      masterChatOk &&
      batchUiOk &&
      diag.projectHeader === projAfterLoad &&
      errors.length === 0;

    const summary = {
      ...diag,
      ...drawer,
      ...board,
      boardCardOk,
      boardCard,
      ...term,
      orgNodes: orgView.nodes,
      orgNoPrematureEmpty: orgLoading.nodes === 0 && !orgLoading.emptyCopy,
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
      nodeFormPresetOk,
      nodeFormPreset: { ...presetApplied, ...presetCreate },
      facts: nodeDrawer.facts,
      i18n,
      batchUiOk,
      shellBatch,
      boardBatch,
      boardBatchAdd,
      created: addTask.created,
      i18nOk,
      addOk,
      mirrorOk,
      boardLiveOk,
      boardLiveSpark,
      claimColBefore,
      claimCol,
      completeCol,
      cursorReplayOk,
      cursorReplay: { liveMaxBefore, ...replay },
      n4Ok,
      n4Reconnected,
      n4CatchUpCol,
      n4NoReconnect,
      n4SparkOff,
      n5Ok,
      projModelOk,
      projModel: {
        noBoardSelect,
        assignee,
        leadTerm,
        rootNodeSent,
        sshCmd,
        sendBoxOperator,
        nodeSent,
        nodeInputDisabled,
        sendViewer,
      },
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
      manualStatusOk,
      manualOptionsOk,
      manualStatus: {
        from: manualFrom,
        to: manualTo,
        patched: manualStatusDiag,
        cardOptions: cardManualOptions,
        drawerOptions: drawerManualOptions,
      },
      reviewerOk,
      reviewer: {
        badge: reviewerBadge,
        create: reviewerCreate ? reviewerCreate.reviewer : null,
        update: reviewerUpdate,
        drawer: drawerReviewer,
      },
      teamOk,
      slackOk,
      slackIntakeOk,
      slackIntake: { on: intakeOn, shape: intakeShapeOn, off: intakeOff, unknown: intakeUnknown, audit: slackAudit },
      authOk,
      setupFeatureOk,
      setupFeatures,
      setupToggle,
      riskConfirmOk,
      riskConfirm: { base: riskBaseCount, arm: riskArmCount, cancel: riskCancel, confirm: riskConfirm },
      authRows,
      codexHint,
      cfHref,
      plusDesc,
      orgDescs: orgView.descs,
      orgTaskBadges: orgView.taskBadges,
      wsBindOk,
      wsKindOk,
      statusBarOk,
      statusBar,
      detailOk,
      detail,
      auditOk,
      audit: { ...audit1, after: auditAfterMore, filter: auditFilter },
      chainOk,
      chain: { ...chain, focus: chainFocus },
      inboxOk,
      inbox: { badgeBefore: inboxBadgeBefore, ...inboxBefore, ...answered, badgeAfter: inboxBadgeAfter, ...deniedState },
      presenceOk,
      presence: { ...presence, anon: presenceAnon },
      wizardOk,
      wizard: { s0: wizStep0, s1: wizStep1, last: wizLast, flag: wizFlag, afterReload: wizAfterReload },
      autonomyVisOk,
      autonomy: { pick: autoPick, retro: autoRetro, node: autoNode },
      pickupToggleOk,
      pickup: { init: pickInit, enable: afterEnable, disable: afterDisable, globalOff: globalOffState, killSwitch: killSwitchState, viewer: viewerState, nodeReject },
      execLoopOk,
      exec: { toggleOk: execToggleOk, timeline, timelineOk: execTimelineOk, timelineVizOk: execTimelineVizOk, queue: queueInit, approved, aborted, queueOk: execQueueOk, viewerLock, viewerLockOk, killSwitchOk },
      plannerSurfaceOk,
      planner: {
        ...planner,
        redactTerms,
        redactionOk,
        delegate: { noPostOnAsk: delegBefore === afterAsk, ...delegated },
        plannerDelegateOk,
        errText: errState.text,
        errLeak: errState.leak,
      },
      costOk,
      cost,
      usageReportOk,
      usage,
      aggViewOk,
      agg: { ...agg, disabled: aggDisabled },
      handoffOk,
      handoff: { export: hExport, preview: hPreview, preConfirm: hPreConfirm, created: hCreated, existing: hExisting, reject: hReject, disabled: hDisabled },
      sharedAccessOk,
      sharedAccess: { share: shareIssue, presence: connPresence, projOperator, projViewer, joinPrefill, joinBad, joinOk },
      ledgerQuotaOk,
      ledger: { all: ledgerAll, hostNominal, hostSat, quotaBeforeYes, quotaSet, viewer: ledgerViewer, noQuota: ledgerNoQuota },
      retroAnalyticsOk,
      retro: { insights, low: insightsLow, viewer: insightsViewer, disabled: insightsDisabled },
      trendAnomalyOk,
      trend: { ...trend, window: trendWindow, windowContract: trendWindowContract, viewer: trendViewer, disabled: trendDisabled },
      routingConfigOk,
      routing: { ...routing, beforeYes: routingBeforeYes, posted: routingPosted, viewer: routingViewer, empty: routingEmpty },
      mobileOk,
      mobile: { ...mobile, detailFits },
      sidebarNavOk,
      sidebar: { ...sidebar, active: sidebarActive, collapsed: groupCollapsed, reexpanded: groupReexpanded, mobileNav, drawerNav },
      commandPaletteOk,
      cmdk: { ...paletteOpened, filtered, navLedger, navDrawer, firstActive, afterDown, escClosed, focusRestored, mutClean: palMutBefore === palMutAfter },
      delegationEdgesOk,
      deleg: { offBefore: delegOffBefore, current: delegCurrent, history: delegHistory, offAfter: delegOffAfter },
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
      masterChatOk,
      mchat,
    };
    if (!ok) {
      if (errors.length) console.error(errors.join("\n"));
      throw new Error("assertions failed: " + JSON.stringify(summary));
    }

    console.log("VERIFY PASS " + JSON.stringify(summary));
    console.log("screenshot: " + shot);
  } finally {
    await closeBrowser(browser);
  }
}

async function closeBrowser(browser) {
  const proc = browser.process();
  const close = browser.close().catch(() => undefined);
  const timeout = new Promise((resolve) => setTimeout(resolve, 5000, "timeout"));
  const result = await Promise.race([close.then(() => "closed"), timeout]);
  if (result !== "closed") {
    if (proc?.pid) {
      try {
        process.kill(proc.pid, "SIGKILL");
      } catch {
        // The process may already have exited after Puppeteer's close signal.
      }
      await Promise.race([
        new Promise((resolve) => proc.once("exit", resolve)),
        new Promise((resolve) => setTimeout(resolve, 2000)),
      ]);
    }
  }
}

main()
  .then(() => {
    process.exit(0);
  })
  .catch((e) => {
    console.error("VERIFY FAIL: " + (e.stack || e.message));
    process.exit(1);
  });
