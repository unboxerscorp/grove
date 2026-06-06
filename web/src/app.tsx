import { useCallback, useEffect, useMemo, useState } from "react";

import { api, AUTH_REQUIRED, setProject, wsUrl } from "./api";
import type { Project } from "./api";
import { BoardView } from "./components/BoardView";
import { NodeList } from "./components/NodeList";
import { InboxDrawer } from "./components/InboxDrawer";
import { PresenceIndicator } from "./components/PresenceIndicator";
import { AuthPanel } from "./components/AuthPanel";
import { HealthDot } from "./components/HealthDot";
import { NodeStatusBar } from "./components/NodeStatusBar";
import { OrgChart } from "./components/OrgChart";
import { ProjectSwitcher } from "./components/ProjectSwitcher";
import { TaskDrawer } from "./components/TaskDrawer";
import { TerminalPane } from "./components/TerminalPane";
import { MasterChat } from "./components/MasterChat";
import { GroveMark } from "./components/GroveMark";
import { cx } from "./constants";
import { useI18n } from "./i18n";
import { liveNodeCount } from "./nodeLive";
import type { GroveNode } from "./types";

type View = "board" | "team" | "terminal" | "auth";

function terminalCandidate(node: GroveNode): boolean {
  return node.terminal_allowed !== false && Boolean(node.tmux_pane);
}

function terminalPriority(node: GroveNode): number {
  if (node.name === "grove-master") return 0;
  if (node.name === "lead") return 1;
  if (node.name.startsWith("lead@")) return 2;
  if (!node.parent) return 3;
  if (node.name === "root") return 4;
  return 5;
}

function preferredTerminalPane(nodes: GroveNode[]): string | null {
  const candidates = nodes.filter(terminalCandidate);
  candidates.sort((a, b) => terminalPriority(a) - terminalPriority(b));
  return candidates[0]?.tmux_pane ?? null;
}

// Left-sidebar navigation. The live cockpit defaults to the MVP operator
// surfaces: task list, org chart, terminal, and setup for chat/node controls.
// Admin/diagnostic panels remain addressable for compatibility, but they do not
// crowd the default remote UI.
type NavItem = { kind: "view"; view: View; labelKey: string; icon: string };
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
    id: "setup",
    labelKey: "nav.group.setup",
    items: [{ kind: "view", view: "auth", labelKey: "tab.auth", icon: "⚙" }],
  },
];

export function App() {
  const { t, lang, setLang } = useI18n();
  // The project's single board, addressed by the "default" alias (resolves to
  // project.board server-side). Constant — never derived from /api/boards list[0].
  const boardId = "default";
  const [nodes, setNodes] = useState<GroveNode[]>([]);
  // Server-authoritative tree shape from /api/org, fed to the NodeList so its
  // indentation matches the OrgChart (both call buildOrgTree with the same
  // childrenMap/roots). Additive: the `nodes` set above stays sourced from
  // /api/nodes — this only carries the tree edges, not the node set (task_2149).
  const [orgChildren, setOrgChildren] = useState<Record<string, string[]>>({});
  const [orgRoots, setOrgRoots] = useState<string[]>([]);
  const [selectedPane, setSelectedPane] = useState<string | null>(null);
  const [view, setView] = useState<View>("board");
  // Current member role: member null (local-token) = operator; only a team
  // "viewer" loses project-create + share. Re-confirmed on navigation / refresh.
  const [isViewer, setIsViewer] = useState(false);
  const [openTaskId, setOpenTaskId] = useState<string | null>(null);
  const [inboxOpen, setInboxOpen] = useState(false);
  const [inboxCount, setInboxCount] = useState(0);
  const [liveTick, setLiveTick] = useState(0);
  const [boardLive, setBoardLive] = useState(false);
  const [projects, setProjects] = useState<Project[]>([]);
  const [project, setActiveProject] = useState<string | null>(null);
  const [masterChatOpenSignal, setMasterChatOpenSignal] = useState(0);
  // Bumped on project switch to re-scope boards + nodes to the new project.
  const [projectTick, setProjectTick] = useState(0);
  // Left sidebar: mobile drawer open + per-group collapse (all expanded default).
  const [navOpen, setNavOpen] = useState(false);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(() => new Set());
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
  const openInbox = () => setInboxOpen(true);

  const loadProjects = useCallback(
    () =>
      api
        .listProjects()
        .then(async (list) => {
          const ps = Array.isArray(list) ? list : [];
          setProjects(ps);
          // Default context on first load: prefer the backend session's project
          // (/api/status.project — fetched with no header here, so it resolves to
          // the server default) over a blind alphabetical ps[0], so the operator
          // lands on the intended project's board rather than an empty base-*
          // board. Fall back to ps[0] when status is unavailable.
          let def: string | null = ps[0]?.name ?? null;
          try {
            const sp = (await api.getStatus())?.project ?? null;
            if (sp && ps.some((p) => p.name === sp)) def = sp;
          } catch {
            /* status unavailable — keep the ps[0] fallback */
          }
          setActiveProject((prev) => {
            if (prev) return prev;
            if (def) {
              setProject(def);
              setProjectTick((x) => x + 1);
            }
            return def;
          });
        })
        .catch(() => setProjects([])),
    [],
  );

  useEffect(() => {
    void loadProjects();
  }, [loadProjects]);

  // Role for control-gating (project create + share). Re-confirmed on navigation
  // and live updates so role changes take effect without a full page reload.
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

  // Keep the decision count fresh for hidden compatibility hooks and future
  // badges without reintroducing the decision drawer into the default nav.
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

  const switchProject = useCallback((name: string) => {
    setProject(name); // api header
    setActiveProject(name);
    setSelectedPane(null);
    // Project-scope continuity: an open detail drawer / decision inbox belongs to
    // the previous project's scope — close them so no stale, wrong-scope item lingers.
    setOpenTaskId(null);
    setInboxOpen(false);
    setProjectTick((x) => x + 1);
    setLiveTick((x) => x + 1);
  }, []);
  const openMasterChat = useCallback(() => setMasterChatOpenSignal((x) => x + 1), []);

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

  // Org tree edges (re-scoped per project; poll). Mirrors the nodes effect but
  // hits /api/org for the server-authoritative children/roots so the NodeList
  // indents identically to the OrgChart (task_2149). Failure keeps last edges.
  useEffect(() => {
    let alive = true;
    const load = () =>
      api
        .getOrg()
        .then((o) => {
          if (!alive) return;
          setOrgChildren(o.children ?? {});
          setOrgRoots(o.roots ?? []);
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

  // List event-tail: a single-use ws-ticket (carrying the current project via
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
  const defaultTerminalPane = useMemo(() => preferredTerminalPane(nodes), [nodes]);
  const liveCount = liveNodeCount(nodes);

  useEffect(() => {
    if (view !== "terminal") return;
    if (selected && selected.terminal_allowed !== false) return;
    if (defaultTerminalPane && defaultTerminalPane !== selectedPane) setSelectedPane(defaultTerminalPane);
  }, [defaultTerminalPane, selected, selectedPane, view]);

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

        {/* Minimal top bar: presence / health / auth / language. */}
        <div className="dr-top__right">
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
                      {g.items.map((it) => (
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
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
            {/* Decision inbox: the answer flow for ask-human / feedback items. */}
            <button
              type="button"
              className="dr-navitem dr-tab dr-navitem--inbox"
              onClick={() => onNav(openInbox)}
            >
              <span className="dr-navitem__icon" aria-hidden="true">✉</span>
              <span className="dr-navitem__label">{t("inbox.open")}</span>
              {inboxCount > 0 && <span className="dr-col__n">{inboxCount}</span>}
            </button>
          </nav>
        </aside>

        <div className="dr-content">
          <NodeStatusBar liveTick={liveTick} projectTick={projectTick} />

          <main className="dr-main">
            <NodeList
              nodes={nodes}
              selectedPane={selectedPane}
              onSelect={pickNode}
              boardLive={boardLive}
              childrenMap={orgChildren}
              roots={orgRoots}
            />
            <section className="dr-stage">
              {view === "board" && boardId && project ? (
                <BoardView
                  boardId={boardId}
                  nodes={nodes}
                  liveTick={liveTick}
                  projectTick={projectTick}
                  boardLive={boardLive}
                  project={project}
                  onOpenTask={setOpenTaskId}
                />
              ) : view === "board" ? (
                // Project not adopted yet: hold the board until a project (and its
                // X-Grove-Project header) is set, so the first fetch never falls
                // back to the server-default project's board.
                <div className="dr-stage__empty">{t("stage.loading")}</div>
              ) : view === "team" ? (
                <OrgChart
                  liveTick={liveTick}
                  projectTick={projectTick}
                  onOpenTerminal={pickNode}
                  onOpenMasterChat={openMasterChat}
                  onSwitchProject={switchProject}
                />
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
        projectTick={projectTick}
        onChanged={() => setLiveTick((x) => x + 1)}
        onClose={() => setOpenTaskId(null)}
      />
      <InboxDrawer
        open={inboxOpen}
        projectTick={projectTick}
        onAnswered={() => setLiveTick((x) => x + 1)}
        onClose={() => setInboxOpen(false)}
      />
      {/* Floating chat to GROVE MASTER (bottom-right). */}
      <MasterChat openSignal={masterChatOpenSignal} />
    </div>
  );
}
