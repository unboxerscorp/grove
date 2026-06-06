import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Playwright e2e specs (web/e2e/playwright/**.spec.ts) run via
    // `playwright test`, not vitest. Keep the glob scoped to unit tests.
    include: ["src/**/*.test.ts", "web/src/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts", "src/**/types.ts", "src/cli.ts"],
      reporter: ["text", "json", "html"],
      thresholds: {
        lines: 80,
      },
    },
  },
});
