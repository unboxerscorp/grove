import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Vitest runs the project's unit tests under src/ only. Playwright e2e
    // specs (web/e2e/playwright/**.spec.ts) run via `playwright test`, not
    // vitest — scope the glob so vitest doesn't try to execute them.
    include: ["src/**/*.test.ts"],
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
