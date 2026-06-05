import { defineConfig } from "@playwright/test";

// Smoke-level Playwright config for the Grove cockpit SPA.
//
// Runs against the system Google Chrome (channel: "chrome") so NO Playwright
// browser binaries are downloaded — important in offline/CI sandboxes. Each
// worker boots a fully isolated grove-web server (see fixtures.ts -> bootTier1):
// temp port + temp GROVE_HOME + throwaway board db + fresh seed, serving the real
// built SPA from web/dist. Nothing here touches ~/.grove, dev10, or a live agent.
//
// Scope: dashboard load -> board render -> project switch -> tasks visible. These
// are deliberately shallow (the org hierarchy / master-chat / project-create form
// are in flux), so they assert presence/render, not deep behavior.
export default defineConfig({
  testDir: "./specs",
  testMatch: "**/*.spec.ts",
  // Keep all generated output (traces/screenshots on failure, .last-run.json)
  // contained under this scaffold dir and gitignored, not scattered at web/.
  outputDir: "./.pw-results",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  timeout: 60_000,
  expect: { timeout: 10_000 },
  use: {
    channel: "chrome",
    headless: true,
    actionTimeout: 10_000,
    navigationTimeout: 30_000,
    trace: "off",
    video: "off",
    screenshot: "off",
  },
});
