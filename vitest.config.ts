import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
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
