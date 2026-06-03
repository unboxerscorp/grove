/**
 * Standalone mock harness for grove-viewer.
 *
 * Stands in for the Legacy dashboard host so dist/index.js can be exercised in
 * a plain browser (file://). It must run BEFORE dist/index.js: it installs the
 * host SDK (real React), the plugin registry (mounts the registered component),
 * a mock REST backend, and a mock tmux WebSocket that streams ANSI text.
 */
import * as React from "react";
import { createRoot } from "react-dom/client";

const h = React.createElement;

const NODES = [
  { name: "root", agent: "claude", tmux_pane: "grove:0.0", session_id: "sess-root", status: "running" },
  { name: "backend", agent: "codex", tmux_pane: "grove:0.1", session_id: "sess-be", status: "running" },
  { name: "frontend", agent: "claude", tmux_pane: "grove:0.2", session_id: "sess-fe", status: "idle" },
  { name: "researcher", agent: "claude", tmux_pane: "grove:0.3", session_id: "sess-re", status: "error" },
  { name: "docs", agent: "codex", tmux_pane: "grove:1.0", session_id: "sess-docs", status: "done" },
];

const SUMMARY = {
  board: "grove",
  url: "/kanban?board=grove",
  columns: [
    { key: "triage", label: "Triage", count: 3 },
    { key: "doing", label: "Doing", count: 2 },
    { key: "review", label: "Review", count: 1 },
    { key: "done", label: "Done", count: 9 },
  ],
  recent: [{ id: "S3", title: "grove-viewer dashboard", status: "doing" }],
};

// --- host SDK + plugin registry --------------------------------------------
window.__LEGACY_PLUGIN_SDK__ = { React };
window.__LEGACY_SESSION_TOKEN__ = "mock-session-token";
// Exercise the gated (auth-required) path: the harder branch the reviewer
// flagged — POST /api/auth/ws-ticket -> WS ?ticket=. Set false to test loopback.
window.__LEGACY_AUTH_REQUIRED__ = true;
window.__LEGACY_PLUGINS__ = {
  register(_name: string, Comp: unknown) {
    const el = document.getElementById("root");
    if (el) createRoot(el).render(h(Comp as React.FC));
  },
};

// --- mock REST backend ------------------------------------------------------
const realFetch = window.fetch.bind(window);
function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (url.includes("/api/plugins/grove-viewer/nodes")) return Promise.resolve(json(NODES));
  if (url.includes("/api/plugins/grove-viewer/board-summary")) return Promise.resolve(json(SUMMARY));
  if (url.includes("/api/auth/ws-ticket")) {
    // Assert the frontend uses POST (Legacy contract), not GET.
    const method = (init?.method ?? "GET").toUpperCase();
    (window as unknown as { __WS_TICKET_METHOD__?: string }).__WS_TICKET_METHOD__ = method;
    return Promise.resolve(json({ ticket: "mock-ticket-123", ttl_seconds: 30 }));
  }
  if (url.includes("/api/plugins/grove-viewer/send")) return Promise.resolve(json({ ok: true }));
  return realFetch(input, init);
}) as typeof fetch;

// --- mock tmux stream over WebSocket ---------------------------------------
const LINES = [
  "\x1b[2m$\x1b[0m pnpm -s test\r\n",
  "\x1b[90m> grove@0.1.0 test\x1b[0m\r\n",
  "\x1b[32m✓\x1b[0m src/orchestrator.test.ts \x1b[90m(14)\x1b[0m\r\n",
  "\x1b[32m✓\x1b[0m src/fanin.test.ts \x1b[90m(8)\x1b[0m\r\n",
  "\x1b[1;32m Test Files  2 passed (2)\x1b[0m\r\n",
  "\r\n\x1b[2m$\x1b[0m grove status --tree\r\n",
  "\x1b[38;5;154mroot\x1b[0m ─┬─ backend   \x1b[32m●\x1b[0m running\r\n",
  "        ├─ frontend  \x1b[33m○\x1b[0m idle\r\n",
  "        └─ docs      \x1b[36m✓\x1b[0m done\r\n\r\n",
];

class MockWS {
  url: string;
  readyState = 0;
  binaryType = "blob";
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: ((ev: { code: number }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private i = 0;

  constructor(url: string) {
    this.url = url;
    // Expose the connected URL so the verifier can assert the auth query param.
    (window as unknown as { __WS_URL__?: string }).__WS_URL__ = url;
    setTimeout(() => this.open(), 140);
  }

  private emit(s: string) {
    this.onmessage?.({ data: s });
  }

  private open() {
    this.readyState = 1;
    this.onopen?.({});
    let pane = "?";
    try {
      pane = new URL(this.url.replace(/^ws/, "http")).searchParams.get("pane") ?? "?";
    } catch {
      /* keep default */
    }
    this.emit(
      `\x1b[38;5;154m●\x1b[0m \x1b[1mgrove-viewer\x1b[0m mock stream — pane \x1b[36m${pane}\x1b[0m\r\n`,
    );
    this.emit("\x1b[2magent online · attached to tmux pane\x1b[0m\r\n\r\n");
    this.timer = setInterval(() => {
      this.emit(LINES[this.i % LINES.length]!);
      this.i++;
    }, 650);
  }

  send(_data: string) {
    /* interactive echo not needed for verification */
  }

  close() {
    this.readyState = 3;
    if (this.timer) clearInterval(this.timer);
    this.onclose?.({ code: 1000 });
  }
}

window.WebSocket = MockWS as unknown as typeof WebSocket;
