import { useEffect, useMemo, useState } from "react";

import { api, AUTH_REQUIRED, wsUrl } from "./api";
import { BoardView } from "./components/BoardView";
import { NodeList } from "./components/NodeList";
import { OrgChart } from "./components/OrgChart";
import { TaskDrawer } from "./components/TaskDrawer";
import { TerminalPane } from "./components/TerminalPane";
import { cx } from "./constants";
import { useI18n } from "./i18n";
import type { Board, GroveNode } from "./types";

type View = "board" | "team" | "terminal";

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
  const [liveTick, setLiveTick] = useState(0);
  const [boardLive, setBoardLive] = useState(false);

  // Boards (pick the first by default).
  useEffect(() => {
    api
      .listBoards()
      .then((b) => {
        const list = Array.isArray(b) ? b : [];
        setBoards(list);
        setBoardId((prev) => prev ?? list[0]?.id ?? null);
      })
      .catch(() => setBoards([]));
  }, []);

  // Nodes (poll).
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
  }, []);

  // Board event-tail: snapshot is read by BoardView; this socket nudges it to
  // reload on each event (cursor-based tail handled server-side).
  useEffect(() => {
    if (!boardId) return;
    let disposed = false;
    let ws: WebSocket | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;

    function connect() {
      api
        .wsTicket()
        .then(({ ticket }) => {
          if (disposed) return;
          try {
            ws = new WebSocket(wsUrl("/ws/board", { ticket }));
          } catch {
            timer = setTimeout(connect, 3000);
            return;
          }
          ws.onopen = () => setBoardLive(true);
          ws.onmessage = () => setLiveTick((x) => x + 1);
          ws.onclose = () => {
            setBoardLive(false);
            if (!disposed) timer = setTimeout(connect, 3000);
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
          if (!disposed) timer = setTimeout(connect, 3000);
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
  }, [boardId]);

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
        <div className="dr-brand">
          <GroveMark />
          <div className="dr-brand__text">
            <span className="dr-brand__title">{t("brand.title")}</span>
            <span className="dr-brand__sub">{t("brand.sub")}</span>
          </div>
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
          </div>
        </div>

        <div className="dr-top__right">
          <div className="dr-stat">
            <span className="dr-stat__n is-live">{liveCount}</span>
            <span className="dr-stat__l">{t("stat.live")}</span>
          </div>
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

      <main className="dr-main">
        <NodeList nodes={nodes} selectedPane={selectedPane} onSelect={pickNode} boardLive={boardLive} />
        <section className="dr-stage">
          {view === "board" && boardId ? (
            <BoardView boardId={boardId} liveTick={liveTick} boardLive={boardLive} onOpenTask={setOpenTaskId} />
          ) : view === "board" ? (
            <div className="dr-stage__empty">{t("stage.noBoards")}</div>
          ) : view === "team" ? (
            <OrgChart boardId={boardId} liveTick={liveTick} onOpenTerminal={pickNode} />
          ) : (
            <TerminalPane node={selected} />
          )}
        </section>
      </main>

      <TaskDrawer taskId={openTaskId} onClose={() => setOpenTaskId(null)} />
    </div>
  );
}
