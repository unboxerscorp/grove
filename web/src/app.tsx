import { useCallback, useEffect, useMemo, useState } from "react";

import { api, AUTH_REQUIRED, setProject, wsUrl } from "./api";
import type { Project } from "./api";
import { BoardView } from "./components/BoardView";
import { NodeList } from "./components/NodeList";
import { AuditDrawer } from "./components/AuditDrawer";
import { ChainDrawer } from "./components/ChainDrawer";
import { InboxDrawer } from "./components/InboxDrawer";
import { PresenceIndicator } from "./components/PresenceIndicator";
import { OnboardingWizard } from "./components/OnboardingWizard";
import { AuthPanel } from "./components/AuthPanel";
import { AggregationPanel } from "./components/AggregationPanel";
import { ConnectPanel } from "./components/ConnectPanel";
import { CostPanel } from "./components/CostPanel";
import { ExecutionPanel } from "./components/ExecutionPanel";
import { HandoffPanel } from "./components/HandoffPanel";
import { LedgerPanel } from "./components/LedgerPanel";
import { HealthDot } from "./components/HealthDot";
import { NodeStatusBar } from "./components/NodeStatusBar";
import { OrgChart } from "./components/OrgChart";
import { ProjectSwitcher } from "./components/ProjectSwitcher";
import { SlackPanel } from "./components/SlackPanel";
import { TaskDrawer } from "./components/TaskDrawer";
import { TerminalPane } from "./components/TerminalPane";
import { cx } from "./constants";
import { useI18n } from "./i18n";
import type { Board, GroveNode } from "./types";

type View = "board" | "team" | "terminal" | "integrations" | "exec" | "cost" | "ledger" | "agg" | "handoff" | "connect" | "auth";

// A share URL deep-links as <index>?join=<code> (web_app.py _share_url). Read the
// code once at startup so opening a share link lands on the join screen with the
// code pre-filled — the core "easy connection" path for a peer.
function initialJoinCode(): string | null {
  try {
    const c = new URLSearchParams(window.location.search).get("join");
    return c && c.trim() ? c.trim() : null;
  } catch {
    return null;
  }
}

// The join code is a ONE-TIME secret: once it's read into state, strip it from
// the address bar + browser history (replaceState, no new entry) so a refresh,
// shared screenshot, or back/forward never re-exposes it. State keeps the value.
function scrubJoinFromUrl(): void {
  try {
    const url = new URL(window.location.href);
    if (!url.searchParams.has("join")) return;
    url.searchParams.delete("join");
    window.history.replaceState(window.history.state, "", url.toString());
  } catch {
    /* history API unavailable — best-effort */
  }
}

function GroveMark() {
  return (
    <svg className="dr-mark" viewBox="0 0 24 24" width={22} height={22} aria-hidden="true">
      <path
        d="M12 22V13M12 13L7 9M12 13l5-4M12 9V3"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.6}
        strokeLinecap="round"
      />
      <circle cx={12} cy={3} r={1.7} fill="currentColor" />
      <circle cx={7} cy={9} r={1.5} fill="currentColor" />
      <circle cx={17} cy={9} r={1.5} fill="currentColor" />
    </svg>
  );
}

export function App() {
  const { t, lang, setLang } = useI18n();
  const [boards, setBoards] = useState<Board[]>([]);
  const [boardId, setBoardId] = useState<string | null>(null);
  const [nodes, setNodes] = useState<GroveNode[]>([]);
  const [selectedPane, setSelectedPane] = useState<string | null>(null);
  const [joinCode] = useState<string | null>(initialJoinCode);
  const [view, setView] = useState<View>(joinCode ? "connect" : "board");
  // Current member role: member null (local-token) = operator; only a team
  // "viewer" loses project-create + share. Re-confirmed on navigation / refresh.
  const [isViewer, setIsViewer] = useState(false);
  const [openTaskId, setOpenTaskId] = useState<string | null>(null);
  const [auditOpen, setAuditOpen] = useState(false);
  const [chainOpen, setChainOpen] = useState(false);
  const [inboxOpen, setInboxOpen] = useState(false);
  const [inboxCount, setInboxCount] = useState(0);
  const [liveTick, setLiveTick] = useState(0);
  const [boardLive, setBoardLive] = useState(false);
  const [projects, setProjects] = useState<Project[]>([]);
  const [project, setActiveProject] = useState<string | null>(null);
  // Bumped on project switch to re-scope boards + nodes to the new project.
  const [projectTick, setProjectTick] = useState(0);

  const loadProjects = useCallback(
    () =>
      api
        .listProjects()
        .then((list) => {
          const ps = Array.isArray(list) ? list : [];
          setProjects(ps);
          // Adopt the first project as the default context on first load.
          setActiveProject((prev) => {
            if (prev) return prev;
            const first = ps[0]?.name ?? null;
            if (first) {
              setProject(first);
              setProjectTick((x) => x + 1);
            }
            return first;
          });
        })
        .catch(() => setProjects([])),
    [],
  );

  useEffect(() => {
    void loadProjects();
  }, [loadProjects]);

  // Scrub the one-time join code from the URL right after it's captured into
  // state, so the secret never lingers in the address bar / history.
  useEffect(() => {
    scrubJoinFromUrl();
  }, []);

  // Role for control-gating (project create + share). Re-confirmed on navigation
  // and after a join (liveTick) so a freshly-joined member's role takes effect.
  useEffect(() => {
    let alive = true;
    api
      .getMe()
      .then((me) => alive && setIsViewer(me?.member?.role === "viewer"))
      .catch(() => alive && setIsViewer(false));
    return () => {
      alive = false;
    };
  }, [projectTick, liveTick, view]);

  const switchProject = useCallback((name: string) => {
    setProject(name); // api header
    setActiveProject(name);
    setBoardId(null);
    setSelectedPane(null);
    setProjectTick((x) => x + 1);
    setLiveTick((x) => x + 1);
  }, []);

  // Boards (re-scoped per project; pick the first by default).
  useEffect(() => {
    api
      .listBoards()
      .then((b) => {
        const list = Array.isArray(b) ? b : [];
        setBoards(list);
        setBoardId((prev) => prev ?? list[0]?.id ?? null);
      })
      .catch(() => setBoards([]));
  }, [projectTick]);

  // Nodes (re-scoped per project; poll).
  useEffect(() => {
    let alive = true;
    const load = () =>
      api
        .listNodes()
        .then((n) => {
          if (alive) setNodes(Array.isArray(n) ? n : []);
        })
        .catch(() => {
          /* keep last */
        });
    void load();
    const t = setInterval(() => void load(), 5000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [projectTick]);

  // Decision-inbox count for the header badge (re-scoped per project; refreshed
  // on liveTick so a submitted answer / new block updates the badge).
  useEffect(() => {
    let alive = true;
    api
      .getInbox({ limit: 1 })
      .then((p) => {
        if (alive) setInboxCount(typeof p.total === "number" ? p.total : (p.items?.length ?? 0));
      })
      .catch(() => {
        if (alive) setInboxCount(0);
      });
    return () => {
      alive = false;
    };
  }, [liveTick, projectTick]);

  // Board event-tail: a single-use ws-ticket (carrying the current project via
  // the X-Grove-Session-Token/X-Grove-Project headers) is minted, then the
  // socket connects with ?ticket= so the backend can bind it to the active
  // project. Re-runs on projectTick too, so switching project (and initial
  // adoption, where boardId is unchanged) reconnects with a fresh project-bound
  // ticket. Reconnects use exponential backoff (capped); a 4401 close (auth
  // rejected) stops the loop — a reload is needed, not a retry storm.
  //
  // Cursor replay: each board event carries a `cursor` (rowid). We track the
  // last one and reconnect with ?cursor=<last> so /ws/board replays only the
  // events-after-cursor missed during downtime — not a blanket from-0 dump.
  // First connect / no cursor yet → no param → the onopen catch-up reload is
  // the fallback. `lastCursor` lives per effect-run, so a project/board switch
  // resets it (the new board starts fresh with the full-reload fallback).
  useEffect(() => {
    if (!boardId) return;
    let disposed = false;
    let ws: WebSocket | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let backoff = 1000;
    let lastCursor: number | null = null;

    const scheduleReconnect = () => {
      if (disposed) return;
      const delay = Math.min(backoff, 15000);
      backoff = Math.min(backoff * 2, 15000);
      timer = setTimeout(connect, delay);
    };

    function connect() {
      if (disposed) return;
      api
        .wsTicket({ kind: "board" })
        .then(({ ticket }) => {
          if (disposed) return;
          try {
            const params: Record<string, string> = { ticket };
            // Reconnect from the last applied cursor → precise events-after
            // replay; omit on the first connect (full-reload fallback path).
            if (lastCursor !== null) params.cursor = String(lastCursor);
            ws = new WebSocket(wsUrl("/ws/board", params));
          } catch {
            scheduleReconnect();
            return;
          }
          ws.onopen = () => {
            backoff = 1000; // reset on a successful connect
            setBoardLive(true);
            // Catch-up reload: cheap safety net that also covers silent
            // (eventless) state changes and the first-connect / no-cursor case.
            // Precise per-event replay arrives as messages below.
            setLiveTick((x) => x + 1);
          };
          ws.onmessage = (ev: MessageEvent) => {
            // Track the last board event cursor so the next reconnect requests
            // only events-after-cursor. Monotonic guard keeps duplicate / out-
            // of-order frames graceful (never rewinds the cursor).
            try {
              const msg = JSON.parse(typeof ev.data === "string" ? ev.data : "") as { cursor?: unknown };
              if (typeof msg.cursor === "number" && (lastCursor === null || msg.cursor > lastCursor)) {
                lastCursor = msg.cursor;
              }
            } catch {
              /* non-JSON frame — still a change signal */
            }
            setLiveTick((x) => x + 1);
          };
          ws.onclose = (ev: CloseEvent) => {
            if (disposed) return; // normal close from our own teardown (switch/unmount)
            setBoardLive(false);
            // 4401 = ws-ticket/auth rejected: reconnecting can't fix it (needs a
            // fresh session/reload), so stop the loop instead of hammering.
            if (ev.code === 4401) return;
            scheduleReconnect();
          };
          ws.onerror = () => {
            try {
              ws?.close();
            } catch {
              /* noop */
            }
          };
        })
        .catch(() => {
          scheduleReconnect();
        });
    }
    connect();
    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
      try {
        ws?.close();
      } catch {
        /* noop */
      }
    };
  }, [boardId, projectTick]);

  const selected = useMemo(
    () => nodes.find((n) => n.tmux_pane === selectedPane) ?? null,
    [nodes, selectedPane],
  );
  const liveCount = nodes.filter((n) => n.status === "running").length;

  const pickNode = (pane: string) => {
    setSelectedPane(pane);
    setView("terminal");
  };

  return (
    <div className="devroom">
      <header className="dr-top">
        <div className="dr-left">
          <div className="dr-brand">
            <GroveMark />
            <div className="dr-brand__text">
              <span className="dr-brand__title">{t("brand.title")}</span>
              <span className="dr-brand__sub">{t("brand.sub")}</span>
            </div>
          </div>
          <ProjectSwitcher
            projects={projects}
            current={project}
            canManage={!isViewer}
            onSwitch={switchProject}
            onProjectsChanged={() => void loadProjects()}
          />
        </div>

        <div className="dr-top__center">
          {boards.length > 0 && (
            <select
              className="dr-select dr-board-select"
              value={boardId ?? ""}
              onChange={(e) => setBoardId(e.target.value)}
              aria-label="board"
            >
              {boards.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          )}
          <div className="dr-tabs" role="tablist">
            <button
              type="button"
              data-view="board"
              className={cx("dr-tab", view === "board" && "is-active")}
              onClick={() => setView("board")}
            >
              {t("tab.board")}
            </button>
            <button
              type="button"
              data-view="team"
              className={cx("dr-tab", view === "team" && "is-active")}
              onClick={() => setView("team")}
            >
              {t("tab.team")}
            </button>
            <button
              type="button"
              data-view="terminal"
              className={cx("dr-tab", view === "terminal" && "is-active")}
              onClick={() => setView("terminal")}
            >
              {t("tab.terminal")}
            </button>
            <button
              type="button"
              data-view="integrations"
              className={cx("dr-tab", view === "integrations" && "is-active")}
              onClick={() => setView("integrations")}
            >
              {t("tab.integrations")}
            </button>
            <button
              type="button"
              data-view="exec"
              className={cx("dr-tab", view === "exec" && "is-active")}
              onClick={() => setView("exec")}
            >
              {t("tab.exec")}
            </button>
            <button
              type="button"
              data-view="cost"
              className={cx("dr-tab", view === "cost" && "is-active")}
              onClick={() => setView("cost")}
            >
              {t("tab.cost")}
            </button>
            <button
              type="button"
              data-view="ledger"
              className={cx("dr-tab", view === "ledger" && "is-active")}
              onClick={() => setView("ledger")}
            >
              {t("tab.ledger")}
            </button>
            <button
              type="button"
              data-view="agg"
              className={cx("dr-tab", view === "agg" && "is-active")}
              onClick={() => setView("agg")}
            >
              {t("tab.agg")}
            </button>
            <button
              type="button"
              data-view="handoff"
              className={cx("dr-tab", view === "handoff" && "is-active")}
              onClick={() => setView("handoff")}
            >
              {t("tab.handoff")}
            </button>
            <button
              type="button"
              data-view="connect"
              className={cx("dr-tab", view === "connect" && "is-active")}
              onClick={() => setView("connect")}
            >
              {t("tab.connect")}
            </button>
            <button
              type="button"
              data-view="auth"
              className={cx("dr-tab", view === "auth" && "is-active")}
              onClick={() => setView("auth")}
            >
              {t("tab.auth")}
            </button>
          </div>
        </div>

        <div className="dr-top__right">
          <div className="dr-stat">
            <span className="dr-stat__n is-live">{liveCount}</span>
            <span className="dr-stat__l">{t("stat.live")}</span>
          </div>
          <button type="button" className="dr-audit-btn" onClick={() => setAuditOpen(true)}>
            ⌗ {t("audit.open")}
          </button>
          <button type="button" className="dr-audit-btn dr-chain-btn" onClick={() => setChainOpen(true)}>
            ⛓ {t("chain.open")}
          </button>
          <button type="button" className="dr-audit-btn dr-inbox-btn" onClick={() => setInboxOpen(true)}>
            ⚑ {t("inbox.open")}
            {inboxCount > 0 && <span className="dr-inbox-btn__badge">{inboxCount}</span>}
          </button>
          <PresenceIndicator liveTick={liveTick} projectTick={projectTick} />
          <HealthDot />
          <span className={cx("dr-auth", AUTH_REQUIRED ? "is-secured" : "is-local")}>
            {AUTH_REQUIRED ? t("auth.secured") : t("auth.local")}
          </span>
          <div className="dr-lang" role="group" aria-label="language">
            <button
              type="button"
              className={cx("dr-lang__btn", lang === "ko" && "is-active")}
              data-lang="ko"
              onClick={() => setLang("ko")}
            >
              KO
            </button>
            <button
              type="button"
              className={cx("dr-lang__btn", lang === "en" && "is-active")}
              data-lang="en"
              onClick={() => setLang("en")}
            >
              EN
            </button>
          </div>
        </div>
      </header>

      <NodeStatusBar liveTick={liveTick} projectTick={projectTick} />

      <main className="dr-main">
        <NodeList nodes={nodes} selectedPane={selectedPane} onSelect={pickNode} boardLive={boardLive} />
        <section className="dr-stage">
          {view === "board" && boardId ? (
            <BoardView boardId={boardId} liveTick={liveTick} boardLive={boardLive} onOpenTask={setOpenTaskId} />
          ) : view === "board" ? (
            <div className="dr-stage__empty">{t("stage.noBoards")}</div>
          ) : view === "team" ? (
            <OrgChart
              boardId={boardId}
              liveTick={liveTick}
              projectTick={projectTick}
              onOpenTerminal={pickNode}
              onDelegated={() => setLiveTick((x) => x + 1)}
            />
          ) : view === "integrations" ? (
            <SlackPanel projectTick={projectTick} />
          ) : view === "exec" ? (
            <ExecutionPanel
              boardId={boardId}
              liveTick={liveTick}
              projectTick={projectTick}
              onChanged={() => setLiveTick((x) => x + 1)}
            />
          ) : view === "cost" ? (
            <CostPanel projectTick={projectTick} />
          ) : view === "ledger" ? (
            <LedgerPanel projectTick={projectTick} onChanged={() => setLiveTick((x) => x + 1)} />
          ) : view === "agg" ? (
            <AggregationPanel projectTick={projectTick} />
          ) : view === "handoff" ? (
            <HandoffPanel projectTick={projectTick} onAccepted={() => setLiveTick((x) => x + 1)} />
          ) : view === "connect" ? (
            <ConnectPanel
              projectTick={projectTick}
              initialJoinCode={joinCode}
              onJoined={() => setLiveTick((x) => x + 1)}
            />
          ) : view === "auth" ? (
            <AuthPanel />
          ) : (
            <TerminalPane node={selected} />
          )}
        </section>
      </main>

      <TaskDrawer
        taskId={openTaskId}
        boardId={boardId}
        onDelegated={() => setLiveTick((x) => x + 1)}
        onClose={() => setOpenTaskId(null)}
      />
      <AuditDrawer open={auditOpen} projectTick={projectTick} onClose={() => setAuditOpen(false)} />
      <ChainDrawer open={chainOpen} projectTick={projectTick} onClose={() => setChainOpen(false)} />
      <InboxDrawer
        open={inboxOpen}
        projectTick={projectTick}
        onAnswered={() => setLiveTick((x) => x + 1)}
        onClose={() => setInboxOpen(false)}
      />
      <OnboardingWizard
        projectCount={projects.length}
        onProjectReady={(name) => {
          void loadProjects();
          switchProject(name);
        }}
        onNavigate={(v) => setView(v)}
      />
    </div>
  );
}
