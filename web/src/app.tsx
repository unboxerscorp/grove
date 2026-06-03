import { useCallback, useEffect, useMemo, useState } from "react";

import { api, AUTH_REQUIRED, setProject, wsUrl } from "./api";
import type { Project } from "./api";
import { BoardView } from "./components/BoardView";
import { NodeList } from "./components/NodeList";
import { AuditDrawer } from "./components/AuditDrawer";
import { AuthPanel } from "./components/AuthPanel";
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

type View = "board" | "team" | "terminal" | "integrations" | "auth";

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
  const [view, setView] = useState<View>("board");
  const [openTaskId, setOpenTaskId] = useState<string | null>(null);
  const [auditOpen, setAuditOpen] = useState(false);
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

  // Board event-tail: a single-use ws-ticket (carrying the current project via
  // the X-Grove-Session-Token/X-Grove-Project headers) is minted, then the
  // socket connects with ?ticket= so the backend can bind it to the active
  // project. Re-runs on projectTick too, so switching project (and initial
  // adoption, where boardId is unchanged) reconnects with a fresh project-bound
  // ticket. Reconnects use exponential backoff (capped); a 4401 close (auth
  // rejected) stops the loop — a reload is needed, not a retry storm.
  useEffect(() => {
    if (!boardId) return;
    let disposed = false;
    let ws: WebSocket | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let backoff = 1000;

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
            ws = new WebSocket(wsUrl("/ws/board", { ticket }));
          } catch {
            scheduleReconnect();
            return;
          }
          ws.onopen = () => {
            backoff = 1000; // reset on a successful connect
            setBoardLive(true);
            // Catch-up: re-request the board snapshot on every (re)connect so
            // events missed while the socket was down are reflected immediately
            // (no cursor bookkeeping needed). Harmless on the first connect.
            setLiveTick((x) => x + 1);
          };
          ws.onmessage = () => setLiveTick((x) => x + 1);
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
            <OrgChart boardId={boardId} liveTick={liveTick} projectTick={projectTick} onOpenTerminal={pickNode} />
          ) : view === "integrations" ? (
            <SlackPanel projectTick={projectTick} />
          ) : view === "auth" ? (
            <AuthPanel />
          ) : (
            <TerminalPane node={selected} />
          )}
        </section>
      </main>

      <TaskDrawer taskId={openTaskId} onClose={() => setOpenTaskId(null)} />
      <AuditDrawer open={auditOpen} projectTick={projectTick} onClose={() => setAuditOpen(false)} />
    </div>
  );
}
