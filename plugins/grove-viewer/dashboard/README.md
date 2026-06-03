# grove-viewer — "Dev Room" dashboard plugin (frontend)

A Legacy dashboard plugin. Core value: **watch any grove agent's terminal
live**. Pick a node from the rail, the centerpiece terminal streams its tmux
pane over a WebSocket into xterm.js, and a compact strip links out to the full
Kanban board.

Built to the Legacy kanban plugin template: React comes from the host
(`window.__LEGACY_PLUGIN_SDK__.React`, never bundled), and the component mounts
via `window.__LEGACY_PLUGINS__.register("grove-viewer", Component)`.

## Layout

```
manifest.json        # name=grove-viewer, label="Dev Room", entry/css/api
plugin_api.py        # BACKEND CONTRACT STUB — owned by the grove-py lane
src/index.tsx        # the plugin component (node rail + live terminal + strip)
src/styles.css       # mission-control aesthetic, scoped under .grove-viewer
globals.d.ts         # ambient host-surface types
build.mjs            # esbuild → dist/index.js + dist/index.css, mock/harness.js
verify.mjs           # headless-Chrome render check against the mock harness
mock/                # standalone host shim: mock REST + mock tmux WS stream
dist/                # build output (gitignored)
```

## Develop

```bash
cd plugins/grove-viewer/dashboard
pnpm install        # local pnpm-workspace.yaml makes this its own root (isolated)
pnpm run check      # typecheck + build + headless verify  (npm run check also works)
# or individually:
pnpm run build      # dist/index.js, dist/index.css, mock/harness.js
pnpm run verify     # asserts render + xterm stream + gated ticket flow; writes screenshot
open mock/index.html  # eyeball it in a browser
```

`verify.mjs` drives the system Chrome via `puppeteer-core` (auto-detected on
macOS; override with `CHROME_PATH`). It is **not bundled** — no browser
download.

## Isolation from grove's root `pnpm check`

This package is deliberately outside grove's root build/lint:

- `tsconfig.json` (`include:["src"]`) and `tsup.config.ts` (explicit entries)
  already ignore `plugins/`.
- **Added** `plugins/**` to root `eslint.config.mjs` ignores.
- **Added** `plugins/` to root `.prettierignore`.
- A **local `pnpm-workspace.yaml`** makes this directory its own pnpm workspace
  root (pnpm stops walking up to grove's root), and `allowBuilds: { esbuild:
  true }` approves esbuild's build script so `pnpm exec`/`pnpm run` don't abort
  with `ERR_PNPM_IGNORED_BUILDS`. The root `pnpm-workspace.yaml` has no
  `packages:` glob, so this package is never pulled into grove's workspace.

## Backend contract (implemented by the grove-py lane)

```
GET  /api/plugins/grove-viewer/nodes          -> [{name, agent, tmux_pane, session_id, status}]
GET  /api/plugins/grove-viewer/board-summary  -> {board, url, columns[], recent[]}
WS   /api/plugins/grove-viewer/term?pane&ticket-> raw tmux pane text frames
POST /api/plugins/grove-viewer/send {pane,data}-> forward keystrokes (optional)
```

**WS auth** mirrors Legacy' web SDK `buildWsAuthParam()`
(legacy `web/src/lib/api.ts`), validated server-side by
`legacy_cli.web_server._ws_auth_ok`:

- **Gated** (`window.__LEGACY_AUTH_REQUIRED__` — public bind, no `--insecure`):
  `POST /api/auth/ws-ticket` (cookie auth) per connect → WS `?ticket=`. A fresh
  single-use ticket (TTL 30s) is minted on every (re)connect.
- **Loopback** / `--insecure`: WS `?token=` from `window.__LEGACY_SESSION_TOKEN__`.

The `term` socket closes `4401` on auth rejection and `1008` on a pane not
exposed by grove-viewer; the frontend surfaces both and stops the reconnect
backoff (reconnecting can't fix either).

## Activation

Build only. Loading into a running Legacy dashboard (and restarting it) is the
lead's call, with the user's awareness — not done here.
