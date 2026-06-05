import { test as base, expect } from "@playwright/test";
// Reuse the proven Tier-1 isolation boot (temp port + temp GROVE_HOME + throwaway
// board db + fresh seed, serving the real SPA). Same isolation the puppeteer
// harness uses, so the Playwright layer shares one source of truth for "isolated
// server" rather than re-implementing it.
import { bootTier1 } from "../tier1/fixtures.mjs";

export type GroveServer = {
  baseUrl: string;
  token: string;
  board: string;
  session: string;
  seedIds: Record<string, string>;
};

// `server` is worker-scoped: one isolated grove-web server per worker, booted
// once and torn down after the worker's tests finish. `page` is overridden to
// dismiss the first-run onboarding overlay before any navigation, so smoke tests
// land straight on the dashboard. API-only tests (using `request`) never trigger
// the page override, so they pay no browser cost.
export const test = base.extend<Record<string, never>, { server: GroveServer }>({
  server: [
    async ({}, use) => {
      // No "shared-access" feature: that flag flips the server into team-cookie
      // auth (web_app AuthMode.TEAM_COOKIE), which would require members.json. The
      // smoke runs as the loopback operator (LOCAL_TOKEN), so leave it off — the
      // server then injects the real operator token the SPA needs to fetch data.
      const ctx = await bootTier1({ session: "pw-e2e", features: [] });
      await use({
        baseUrl: ctx.baseUrl,
        token: ctx.token,
        board: ctx.board,
        session: ctx.session,
        seedIds: ctx.seedIds,
      });
      await ctx.teardown();
    },
    { scope: "worker" },
  ],
  page: async ({ page }, use) => {
    await page.addInitScript(() => window.localStorage.setItem("grove.onboarded.v3", "1"));
    await use(page);
  },
});

export { expect };
