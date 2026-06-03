// Self-contained esbuild build for the grove-viewer dashboard plugin.
// Intentionally separate from grove's root tsup/eslint/`pnpm check`.
//
//   dist/index.js + dist/index.css  -> the production plugin bundle. React is
//   NEVER imported here, so esbuild never bundles it: the host provides it via
//   window.__LEGACY_PLUGIN_SDK__.React. xterm.js IS bundled.
//
//   mock/harness.js -> standalone verification harness (bundles real React +
//   react-dom and a mock backend) loaded by mock/index.html.
import { build } from "esbuild";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));

const shared = {
  bundle: true,
  format: "iife",
  target: ["es2020"],
  jsx: "transform",
  jsxFactory: "h",
  jsxFragment: "Fragment",
  loader: { ".css": "css" },
  logLevel: "info",
};

async function run() {
  await build({
    ...shared,
    entryPoints: { index: path.join(root, "src/index.tsx") },
    outdir: path.join(root, "dist"),
    minify: true,
    sourcemap: false,
  });

  await build({
    ...shared,
    entryPoints: { harness: path.join(root, "mock/harness.tsx") },
    outdir: path.join(root, "mock"),
    minify: false,
    sourcemap: true,
  });

  console.log("[grove-viewer] build ok → dist/index.js, dist/index.css, mock/harness.js");
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
