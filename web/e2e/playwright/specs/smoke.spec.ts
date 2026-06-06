import { test, expect } from "../fixtures";
import { makeApi } from "../api";

// Cockpit smoke journey: dashboard load -> board render -> project switch ->
// tasks visible, plus a reusable API-helper smoke. Deliberately shallow — the
// org hierarchy, master-chat, and project-create form are changing under Wave1/2/3,
// so these assert that stable surfaces render/respond, not deep behavior.
test.describe("cockpit smoke", () => {
  test("dashboard loads and the SPA bootstraps", async ({ page, server }) => {
    await page.goto(server.baseUrl, { waitUntil: "domcontentloaded" });
    await expect(page.locator(".devroom")).toBeVisible();
    await expect(page.locator(".dr-brand").first()).toBeVisible();
  });

  test("board renders with seeded task cards", async ({ page, server }) => {
    await page.goto(server.baseUrl, { waitUntil: "domcontentloaded" });
    await expect(page.locator(".dr-board__cols, .dr-col").first()).toBeVisible();
    // The isolated server seeded tasks across columns; shallow check = >=1 card.
    await expect(page.locator(".dr-card").first()).toBeVisible();
  });

  test("project switcher opens and lists projects (smoke, no deep assertion)", async ({ page, server }) => {
    await page.goto(server.baseUrl, { waitUntil: "domcontentloaded" });
    const trigger = page.locator(".proj-switcher__btn");
    await expect(trigger).toBeVisible();
    await trigger.click();
    // Menu portals to <body>; assert it renders with a project list container.
    await expect(page.locator(".proj-menu")).toBeVisible();
    await expect(page.locator(".proj-menu__list")).toBeVisible();
  });

  test("switching project keeps the board + tasks visible", async ({ page, server }) => {
    await page.goto(server.baseUrl, { waitUntil: "domcontentloaded" });
    await page.locator(".proj-switcher__btn").click();
    await expect(page.locator(".proj-menu")).toBeVisible();
    const items = page.locator(".proj-menu__list .proj-item");
    if ((await items.count()) > 0) {
      // Re-select a project (touches no org/create surface) and assert re-render.
      await items.first().click();
    } else {
      // No selectable project in the isolated server: just close the menu.
      await page.locator(".proj-menu__scrim").click({ trial: false }).catch(() => {});
    }
    await expect(page.locator(".dr-board__cols, .dr-col").first()).toBeVisible();
    await expect(page.locator(".dr-card").first()).toBeVisible();
  });

  test("terminal view mounts the dynamic grid (no single/grid toggle)", async ({ page, server }) => {
    await page.goto(server.baseUrl, { waitUntil: "domcontentloaded" });
    // Visible terminal nav item (the hidden compat hooks are plain .dr-tab).
    await page.locator(".dr-navitem[data-view='terminal']").click();
    // New UX: the terminal view is the read-only dynamic grid (cells when the SPA
    // has terminal nodes, else the empty "+" state). The old single|grid toggle is
    // gone. The deep flow (cell render, +button modal, expand->full single view
    // with send box, ×-close, non-collapsed layout) is verified against real nodes
    // in verify.mjs; this isolated server doesn't expose terminal nodes/streams.
    await expect(page.locator(".dr-termgrid")).toBeVisible();
    await expect(page.locator(".dr-termview__modes")).toHaveCount(0);
  });

  test("API helper reaches health + list items with the operator token", async ({ request, server }) => {
    const api = makeApi(request, server.baseUrl, server.token);
    const health = await api.health();
    expect(health.ok()).toBeTruthy();

    const tasks = await api.boardTasks(server.board);
    expect(tasks.status()).toBe(200);
    const body = await tasks.json();
    // Foundation smoke: the seeded board exposes a tasks collection.
    const list = (body && (body.tasks ?? body.items)) ?? body;
    expect(Array.isArray(list)).toBeTruthy();
  });
});
