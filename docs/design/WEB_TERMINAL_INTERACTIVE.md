# Interactive Web Terminal — grouped-session PTY embed

Replace the read-only `capture-pane` mirror with a **real interactive terminal**: each
web client gets a PTY attached to a per-client **grouped tmux session** (independent
sizing), streamed bidirectionally over the websocket and rendered in the existing
xterm.js. It fills the web width and supports direct typing. All viewers are C-level
admins (Tailscale-gated), so the read-only constraint + send-box are dropped.

Canonical tmux socket: `tmux -L dev10`.

## Current (to replace)

- Frontend `TerminalPane.tsx`: xterm.js + FitAddon, **read-only** (`disableStdin`),
  writes `CLEAR + full capture snapshot` (mirror). Input via a separate POST send box.
- Backend `/ws/terminal`: polls `_tmux_capture(pane_id)` and sends a full snapshot when
  it changes. Width is bound to the pane's columns → narrow content in a wide xterm.

## Target architecture

- **Per-connection grouped session**: on ws connect, `tmux -L dev10 new-session -d
-s web-<uid> -t <target-session>` (same group = shares windows, **independent size**).
  Set `window-size`/`aggressive-resize` so this session sizes to the attached client,
  not the smallest — this is what fills the web width without shrinking anyone.
- **PTY attach**: spawn `tmux -L dev10 attach-session -t web-<uid>` in a PTY
  (`pty.fork`/`os.openpty`). PTY stdout → ws frames; ws input → PTY stdin (keystrokes);
  ws resize msg → PTY winsize (`TIOCSWINSZ`) → tmux resizes that session.
- **Pane focus**: on attach, `select-pane -t <pane>` (+ optional `resize-pane -Z` zoom)
  to focus the node's pane. ⚠ active-pane is shared within a group — decide v1: zoom the
  target per-session, or accept shared focus. (Investigate.)
- **Lifecycle**: on ws close → kill the PTY + `tmux -L dev10 kill-session -t web-<uid>`
  (NEVER the target). Idle/timeout cleanup. One session + PTY per viewer; cap + idle-kill.
- **Frontend**: xterm `disableStdin=false`; `term.onData` → ws (input);
  `term.onResize` → ws (resize); render raw PTY bytes (drop the CLEAR+snapshot mirror).
  Reuse the existing `/api/ws-ticket` (terminal kind) + reconnect/backoff.

## Decisions / risks (apply all)

- **⚠ Sizing isolation — UNVERIFIED, GATE-FIRST**: an isolated test (board-worker, throwaway
  socket) shows grouped sessions SHARE the window object + size — `resize-window` on the web
  session also resized the base, and window-size/aggressive-resize resolve to ONE size per
  shared window. So "independent size, fills web width without shrinking the operator" is NOT
  confirmed and may be impossible for the SAME node-window. **Stage 0 gate** = a CONCLUSIVE
  isolated-replica test (2 real PTY clients at different sizes, aggressive-resize,
  same-vs-DIFFERENT current-window). Run ONLY on a throwaway socket — NEVER live `tmux -L
dev10` (it runs everyone). Build only on PASS. On FAIL, pivot: (a) accept shared size +
  zoom the target pane, (b) per-web-client SEPARATE window, (c) keep capture output + add a
  real input channel only (no grouped resize). Pane-focus (select-pane/zoom) is likely shared
  too — settle in the same gate.
- **Multi-typing**: multiple admins in one pane = standard tmux shared behavior (works;
  coordination is human). Acceptable for v1 (C-level).
- **Resource**: 1 tmux session + 1 PTY per viewer — hard cap + idle-kill on disconnect.
- **Auth**: keep the ws-ticket + pane allow-list. Interactive input now flows; viewers
  are trusted, but keep the ticket gate. The existing input-guard is bypassed by a real
  PTY — acceptable for trusted admins; note it.
- **Stability first**: this replaces a working read-only view — must not regress the
  read path or destabilize the operator's tmux.

## Stages (stability first; split-screen is a later iteration)

0. **Gate (board-worker)**: conclusive sizing-isolation test on a throwaway socket (NOT
   live dev10) → PASS/FAIL with evidence + the chosen approach if FAIL. No build until this
   settles. Ownership for the build: **task-worker** owns Stage 1 backend (heavy PTY work in
   shared `web_app.py`); board-worker owns the gate + design + Stage 2 FE + no-regression.
1. **Backend (task-worker, post-gate)**: PTY manager + bidirectional `/ws/terminal`
   (output + input + resize) + session lifecycle/cleanup, per the gate's approved approach.
2. **Frontend**: xterm stdin + resize handlers; drop the mirror/snapshot logic + send box.
3. **Harden**: resource caps, idle-kill, reconnect, error/close codes, pane-not-found.
4. **Later (operator)**: split-screen / multi-pane web layouts.
