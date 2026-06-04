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
import { CommandPalette } from "./components/CommandPalette";
import type { PaletteCommand } from "./components/CommandPalette";
import { ConnectPanel } from "./components/ConnectPanel";
import { CostPanel } from "./components/CostPanel";
import { ExecutionPanel } from "./components/ExecutionPanel";
import { HandoffPanel } from "./components/HandoffPanel";
import { InsightsPanel } from "./components/InsightsPanel";
import { RoutingPanel } from "./components/RoutingPanel";
import { TrendPanel } from "./components/TrendPanel";
import { LedgerPanel } from "./components/LedgerPanel";
import { HealthDot } from "./components/HealthDot";
import { NodeStatusBar } from "./components/NodeStatusBar";
import { OrgChart } from "./components/OrgChart";
import { ProjectSwitcher } from "./components/ProjectSwitcher";
import { SlackPanel } from "./components/SlackPanel";
import { TaskDrawer } from "./components/TaskDrawer";
import { TerminalPane } from "./components/TerminalPane";
import { MasterChat } from "./components/MasterChat";
import { GroveMark } from "./components/GroveMark";
import { cx } from "./constants";
import { useI18n } from "./i18n";
import type { GroveNode } from "./types";

type View = "board" | "team" | "terminal" | "integrations" | "exec" | "cost" | "ledger" | "insights" | "trend" | "agg" | "handoff" | "connect" | "routing" | "auth";

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

// Left-sidebar navigation (V24-W1): the old top tab strip became too crowded, so
// every panel/drawer now lives in a grouped, collapsible left sidebar. Items keep
// their legacy hook classes (`dr-tab[data-view]` for view panels; dr-audit-btn /
// dr-chain-btn / dr-inbox-btn for the drawers) so existing wiring is unchanged —
// only their position moved. Groups: Work, Ops, Comms, Cross-room, Audit, Cost,
// Setup.
type NavItem =
  | { kind: "view"; view: View; labelKey: string; icon: string }
  | { kind: "drawer"; drawer: "audit" | "chain" | "inbox"; labelKey: string; icon: string };
const NAV_GROUPS: { id: string; labelKey: string; items: NavItem[] }[] = [
  {
    id: "work",
    labelKey: "nav.group.work",
    items: [
      { kind: "view", view: "board", labelKey: "tab.board", icon: "▤" },
      { kind: "view", view: "team", labelKey: "tab.team", icon: "⊚" },
      { kind: "view", view: "terminal", labelKey: "tab.terminal", icon: "❯" },
    ],
  },
  {
    id: "ops",
    labelKey: "nav.group.ops",
    items: [
      { kind: "view", view: "exec", labelKey: "tab.exec", icon: "▶" },
      { kind: "view", view: "ledger", labelKey: "tab.ledger", icon: "▦" },
      { kind: "view", view: "trend", labelKey: "tab.trend", icon: "↗" },
      { kind: "view", view: "insights", labelKey: "tab.insights", icon: "◍" },
    ],
  },
  {
    id: "comms",
    labelKey: "nav.group.comms",
    items: [
      { kind: "view", view: "integrations", labelKey: "tab.integrations", icon: "#" },
      { kind: "view", view: "connect", labelKey: "tab.connect", icon: "⚯" },
      { kind: "view", view: "routing", labelKey: "tab.routing", icon: "⤳" },
      { kind: "drawer", drawer: "inbox", labelKey: "inbox.open", icon: "⚑" },
    ],
  },
  {
    id: "crossroom",
    labelKey: "nav.group.crossroom",
    items: [
      { kind: "view", view: "agg", labelKey: "tab.agg", icon: "⊞" },
      { kind: "view", view: "handoff", labelKey: "tab.handoff", icon: "⇄" },
    ],
  },
  {
    id: "audit",
    labelKey: "nav.group.audit",
    items: [
      { kind: "drawer", drawer: "audit", labelKey: "audit.open", icon: "⌗" },
      { kind: "drawer", drawer: "chain", labelKey: "chain.open", icon: "⛓" },
    ],
  },
  {
    id: "cost",
    labelKey: "nav.group.cost",
    items: [{ kind: "view", view: "cost", labelKey: "tab.cost", icon: "$" }],
  },
  {
    id: "setup",
    labelKey: "nav.group.setup",
    items: [{ kind: "view", view: "auth", labelKey: "tab.auth", icon: "⛨" }],
  },
];
const DRAWER_CLASS: Record<"audit" | "chain" | "inbox", string> = {
  audit: "dr-audit-btn",
  chain: "dr-chain-btn",
  inbox: "dr-inbox-btn",
};

export function App() {
  const { t, lang, setLang } = useI18n();
  // The project's single board, addressed by the "default" alias (resolves to
  // project.board server-side). Constant — never derived from /api/boards list[0].
  const boardId = "default";
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
  // Left sidebar: mobile drawer open + per-group collapse (all expanded default).
  const [navOpen, setNavOpen] = useState(false);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(() => new Set());
  const [tutorialOpenKey, setTutorialOpenKey] = useState(0);
  const toggleGroup = (id: string) =>
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  // Navigate then close the mobile drawer (no-op when already closed on desktop).
  const onNav = (fn: () => void) => {
    fn();
    setNavOpen(false);
  };
  const openDrawer = (d: "audit" | "chain" | "inbox") => {
    if (d === "audit") setAuditOpen(true);
    else if (d === "chain") setChainOpen(true);
    else setInboxOpen(true);
  };
  const drawerOpen = (d: "audit" | "chain" | "inbox") =>
    d === "audit" ? auditOpen : d === "chain" ? chainOpen : inboxOpen;

  // Command palette (Cmd/Ctrl-K): navigation-only jump to any view/drawer.
  const [paletteOpen, setPaletteOpen] = useState(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((o) => !o);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  // Every sidebar view/drawer as a palette command — routing only, no mutation.
  const paletteCommands: PaletteCommand[] = NAV_GROUPS.flatMap((g) =>
    g.items.map((it) => {
      const name = it.kind === "view" ? it.view : it.drawer;
      return {
        id: `${it.kind}:${name}`,
        name,
        label: t(it.labelKey),
        group: t(g.labelKey),
        icon: it.icon,
        run: it.kind === "view" ? () => onNav(() => setView(it.view)) : () => onNav(() => openDrawer(it.drawer)),
      };
    }),
  );

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
    setSelectedPane(null);
    setProjectTick((x) => x + 1);
    setLiveTick((x) => x + 1);
  }, []);

  // 1 project = 1 board: the dashboard always targets the active project's single
  // board via the "default" alias — the backend (_resolve_board_id) maps it to
  // project.board for both reads and writes. No /api/boards list[0] (which sorts
  // slug-ASC and would pick the wrong board); context switching is per-project.

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
          <button
            type="button"
            className="dr-hamburger"
            aria-label={t("nav.menu")}
            aria-expanded={navOpen}
            onClick={() => setNavOpen((o) => !o)}
          >
            ☰
          </button>
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
          {/* 1 project = 1 board (v1.27): no board picker — the dashboard shows the
              project's single board; context switching is per-project. */}
        </div>

        {/* Minimal top bar: command palette / presence / health / auth / language. */}
        <div className="dr-top__right">
          <button
            type="button"
            className="cmdk-trigger"
            onClick={() => setPaletteOpen(true)}
            aria-label={t("cmdk.open")}
            aria-keyshortcuts="Meta+K Control+K"
            title={t("cmdk.open")}
          >
            <span className="cmdk-trigger__icon" aria-hidden="true">⌘K</span>
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

      <div className="dr-body">
        {navOpen && <div className="dr-nav-scrim" onClick={() => setNavOpen(false)} aria-hidden="true" />}
        <aside className={cx("dr-sidebar", navOpen && "is-open")} aria-label={t("nav.label")}>
          <div className="dr-sidebar__stat">
            <span className="dr-stat__n is-live">{liveCount}</span>
            <span className="dr-stat__l">{t("stat.live")}</span>
          </div>
          <nav className="dr-sidebar__nav" role="navigation" aria-label={t("nav.label")}>
            {NAV_GROUPS.map((g) => {
              const collapsed = collapsedGroups.has(g.id);
              return (
                <div className={cx("dr-navgroup", collapsed && "is-collapsed")} key={g.id} data-group={g.id}>
                  <button
                    type="button"
                    className="dr-navgroup__head"
                    aria-expanded={!collapsed}
                    onClick={() => toggleGroup(g.id)}
                  >
                    <span className="dr-navgroup__label">{t(g.labelKey)}</span>
                    <span className="dr-navgroup__chev" aria-hidden="true">
                      {collapsed ? "▸" : "▾"}
                    </span>
                  </button>
                  {!collapsed && (
                    <div className="dr-navgroup__items">
                      {g.items.map((it) =>
                        it.kind === "view" ? (
                          <button
                            key={it.view}
                            type="button"
                            data-view={it.view}
                            className={cx("dr-navitem dr-tab", view === it.view && "is-active")}
                            onClick={() => onNav(() => setView(it.view))}
                          >
                            <span className="dr-navitem__icon" aria-hidden="true">{it.icon}</span>
                            <span className="dr-navitem__label">{t(it.labelKey)}</span>
                          </button>
                        ) : (
                          <button
                            key={it.drawer}
                            type="button"
                            className={cx("dr-navitem", DRAWER_CLASS[it.drawer], drawerOpen(it.drawer) && "is-active")}
                            onClick={() => onNav(() => openDrawer(it.drawer))}
                          >
                            <span className="dr-navitem__icon" aria-hidden="true">{it.icon}</span>
                            <span className="dr-navitem__label">{t(it.labelKey)}</span>
                            {it.drawer === "inbox" && inboxCount > 0 && (
                              <span className="dr-inbox-btn__badge">{inboxCount}</span>
                            )}
                          </button>
                        ),
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </nav>
          <div className="dr-sidebar__foot">
            <button
              type="button"
              className="dr-tutorial-btn"
              onClick={() => {
                setTutorialOpenKey((x) => x + 1);
                setNavOpen(false);
              }}
            >
              <span className="dr-tutorial-btn__icon" aria-hidden="true">?</span>
              <span className="dr-tutorial-btn__label">{t("nav.tutorial")}</span>
            </button>
          </div>
        </aside>

        <div className="dr-content">
          <NodeStatusBar liveTick={liveTick} projectTick={projectTick} />

          <main className="dr-main">
            <NodeList nodes={nodes} selectedPane={selectedPane} onSelect={pickNode} boardLive={boardLive} />
            <section className="dr-stage">
          {view === "board" && boardId ? (
            <BoardView boardId={boardId} liveTick={liveTick} projectTick={projectTick} boardLive={boardLive} onOpenTask={setOpenTaskId} />
          ) : view === "board" ? (
            <div className="dr-stage__empty">{t("stage.noBoards")}</div>
          ) : view === "team" ? (
            <OrgChart
              boardId={boardId}
              liveTick={liveTick}
              projectTick={projectTick}
              onOpenTerminal={pickNode}
              onDelegated={() => setLiveTick((x) => x + 1)}
              onSwitchProject={switchProject}
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
          ) : view === "insights" ? (
            <InsightsPanel projectTick={projectTick} />
          ) : view === "trend" ? (
            <TrendPanel projectTick={projectTick} />
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
          ) : view === "routing" ? (
            <RoutingPanel projectTick={projectTick} />
          ) : view === "auth" ? (
            <AuthPanel />
          ) : (
            <TerminalPane node={selected} />
          )}
        </section>
          </main>
        </div>
      </div>

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
      {/* Mount fresh per open so query/selection always start clean. */}
      {paletteOpen && (
        <CommandPalette open onClose={() => setPaletteOpen(false)} commands={paletteCommands} />
      )}
      <OnboardingWizard
        openKey={tutorialOpenKey}
        projectCount={projects.length}
        onProjectReady={(name) => {
          void loadProjects();
          switchProject(name);
        }}
        onNavigate={(v) => setView(v)}
      />
      {/* Floating operator-only chat to the project-master (bottom-right). */}
      <MasterChat />
    </div>
  );
}
