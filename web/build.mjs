// Self-contained esbuild build for the Grove web cockpit. Intentionally
// separate from grove's root tsup/eslint/`pnpm check`.
//
//   dist/index.html + dist/app-[hash].js + dist/app-[hash].css -> the static app
//   the grove web server serves at /. React + react-dom + xterm are all bundled
//   in. The bundle filename is CONTENT-HASHED so each deploy gets a new name and
//   browsers can't serve a stale cached bundle (the generated index references
//   the current hash). Fixed-name aliases (app.js/app.css) are also written for
//   the local mock harness + verify.mjs, which load the bundle by stable name.
//
//   mock/harness.js -> standalone mock backend loaded by mock/index.html for
//   headless verification (verify.mjs).
import { build } from "esbuild";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
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
  const result = await build({
    ...shared,
    entryPoints: { app: path.join(root, "src/main.tsx") },
    outdir: path.join(root, "dist"),
    entryNames: "[name]-[hash]",
    minify: true,
    sourcemap: false,
    metafile: true,
  });

  // Resolve the content-hashed output filenames from the metafile.
  const outputs = Object.keys(result.metafile.outputs).map((p) => path.basename(p));
  const jsName = outputs.find((n) => n.endsWith(".js"));
  const cssName = outputs.find((n) => n.endsWith(".css"));
  if (!jsName || !cssName) {
    throw new Error(`build: could not resolve hashed bundle outputs (got ${outputs.join(", ")})`);
  }

  // Generate dist/index.html referencing the hashed bundle (cache-busting).
  const template = await readFile(path.join(root, "index.html"), "utf8");
  const html = template.replace("/app.css", `/${cssName}`).replace("/app.js", `/${jsName}`);
  await writeFile(path.join(root, "dist", "index.html"), html);

  // Fixed-name aliases for the local mock harness (mock/index.html -> ../dist/app.js)
  // and verify.mjs, which read the bundle by stable name. The SERVER never serves
  // these (its index references the hashed names); they exist only for local checks.
  await copyFile(path.join(root, "dist", jsName), path.join(root, "dist", "app.js"));
  await copyFile(path.join(root, "dist", cssName), path.join(root, "dist", "app.css"));

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

  console.log(
    `[cockpit] build ok → dist/index.html (→ ${jsName}, ${cssName}), dist/app.js+app.css aliases, mock/harness.js`,
  );
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
