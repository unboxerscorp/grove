import { defineConfig } from "tsup";

export default defineConfig({
  entry: { cli: "src/cli.ts", index: "src/index.ts" },
  format: ["esm"],
  target: "node20",
  dts: true,
  clean: true,
  shims: false,
  splitting: false,
  sourcemap: false,
});
