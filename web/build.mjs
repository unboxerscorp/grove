// Self-contained esbuild build for the Grove web cockpit. Intentionally
// separate from grove's root tsup/eslint/`pnpm check`.
//
//   dist/index.html + dist/app.js + dist/app.css -> the static app the grove
//   web server serves at /. React + react-dom + xterm are all bundled in.
//
//   mock/harness.js -> standalone mock backend loaded by mock/index.html for
//   headless verification (verify.mjs).
import { build } from "esbuild";
import { copyFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));

const shared = {
  bundle: true,
  format: "iife",
  target: ["es2020"],
  jsx: "automatic",
  loader: { ".css": "css" },
  logLevel: "info",
  define: { "process.env.NODE_ENV": '"production"' },
};

async function run() {
  await build({
    ...shared,
    entryPoints: { app: path.join(root, "src/main.tsx") },
    outdir: path.join(root, "dist"),
    minify: true,
    sourcemap: false,
  });
  await copyFile(path.join(root, "index.html"), path.join(root, "dist/index.html"));
  await mkdir(path.join(root, "dist", "assets"), { recursive: true });
  await copyFile(path.join(root, "assets", "grove-icon.svg"), path.join(root, "dist", "assets", "grove-icon.svg"));
  await copyFile(path.join(root, "assets", "grove-icon.png"), path.join(root, "dist", "assets", "grove-icon.png"));

  await build({
    ...shared,
    entryPoints: { harness: path.join(root, "mock/harness.ts") },
    outdir: path.join(root, "mock"),
    minify: false,
    sourcemap: true,
  });

  console.log("[cockpit] build ok → dist/index.html, dist/app.js, dist/app.css, mock/harness.js");
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
