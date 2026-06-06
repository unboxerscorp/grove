# Grove web cockpit

A **standalone single-page app** served by the grove web server at `/`. Not a
plugin: grove ships and mounts this directly. It gives you a live cockpit over a
running grove — human-facing items with comments + runs, the organization
roster, and a live xterm.js view of any agent's tmux pane.

Core surfaces: the item list, item drawer, organization roster, and terminal
mirror. React + react-dom + xterm are bundled into a single static `app.js` —
no external runtime, no plugin host.

## Layout

```
index.html           # production template (server injects the config script)
src/main.tsx         # entry: createRoot(#app).render(<App/>)
src/app.tsx          # shell: header, tabs, node rail, board/terminal stage, drawer
src/api.ts           # REST + ws-ticket + WS url + base64 helpers
src/types.ts         # wire types
src/constants.ts     # columns + presentation helpers
src/components/*.tsx  # BoardView, TaskDrawer, NodeList, TerminalPane
src/styles.css        # the "observatory" theme (scoped, no globals leaked)
build.mjs            # esbuild -> dist/{index.html,app.js,app.css} + mock/harness.js
verify.mjs           # headless-Chrome end-to-end check against the mock
mock/                # standalone mock backend (REST + WS) + harness page
dist/                # build output (gitignored) — what the server serves
```

## Develop

```bash
cd web
pnpm install        # local pnpm-workspace.yaml makes this its own root (isolated)
pnpm run check      # typecheck + build + headless verify   (npm run check also works)
# or individually:
pnpm run build      # dist/index.html, dist/app.js, dist/app.css, mock/harness.js
pnpm run verify     # mounts the built app against the mock; writes a screenshot
open mock/index.html  # eyeball it in a browser
```

`verify.mjs` drives the system Chrome via `puppeteer-core` (auto-detected on
macOS; override with `CHROME_PATH`); no browser is downloaded.

## Isolation from grove's root `pnpm check`

- `tsconfig.json` (`include:["src"]`) and `tsup.config.ts` (explicit entries)
  already ignore `web/`.
- **Added** `web/**` to root `eslint.config.mjs` ignores.
- **Added** `web/` to root `.prettierignore`.
- A local `pnpm-workspace.yaml` makes this its own pnpm root with
  `allowBuilds: { esbuild: true }` (so `pnpm exec`/`run` don't abort on
  `ERR_PNPM_IGNORED_BUILDS`); `dist/` is matched by the root `.gitignore`.

## Backend contract (implemented by the grove web server)

The page is served with a config script injected before the bundle:
`window.__GROVE_SESSION_TOKEN__` and `window.__GROVE_AUTH_REQUIRED__`.

REST (all sent with header `X-Grove-Session-Token: <token>`):

```
GET  /api/boards                              -> [{id, name, task_count?}]
GET  /api/boards/:id/tasks?status=&assignee=  -> [Task]
GET  /api/tasks/:id                           -> Task
GET  /api/tasks/:id/comments                  -> [Comment]
GET  /api/tasks/:id/runs                      -> [Run]
GET  /api/nodes                               -> [{name, agent, tmux_pane, session_id, status}]
POST /api/ws-ticket                           -> {ticket, ttl_seconds}   (30s, single-use)
```

WebSockets (auth via a ticket from `POST /api/ws-ticket`, since upgrades can't
carry the header):

```
WS /ws/board?ticket=                  -> event-tail; client reads the REST snapshot first,
                                         then applies events by cursor (reloads on event)
WS /ws/terminal?ticket=&pane_id=      -> TerminalFrame{seq, pane_id, bytes_base64, ts}
                                         decoded to bytes and written to xterm; read-only
```

The terminal socket closes `4401` on a rejected ticket and `1008` on a pane that
isn't available; the client surfaces both and stops its reconnect backoff.
