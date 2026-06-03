// Tiny i18n layer. Korean is the default; a KO/EN toggle (persisted in
// localStorage) lets the user switch. All UI strings live in the maps below so
// nothing user-facing is hardcoded in components.
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";

export type Lang = "ko" | "en";

const STORAGE_KEY = "grove.lang";

type Dict = Record<string, string>;

const KO: Dict = {
  "brand.title": "개발실",
  "brand.sub": "grove · 실시간 콕핏",
  "tab.board": "보드",
  "tab.terminal": "터미널",
  "stat.live": "실시간",
  "auth.secured": "보안",
  "auth.local": "로컬",
  "stage.noBoards": "사용 가능한 보드가 없습니다",

  "nodes.title": "노드",
  "nodes.live": "{live}/{total} 실시간",
  "nodes.filter": "노드 필터…",
  "nodes.noMatch": "일치 항목 없음",
  "nodes.none": "온라인 노드 없음",

  "status.running": "실행 중",
  "status.idle": "대기",
  "status.error": "오류",
  "status.done": "완료",
  "status.triage": "분류",
  "status.todo": "할 일",
  "status.scheduled": "예약",
  "status.ready": "준비",
  "status.blocked": "차단",
  "status.review": "검토",

  "term.readOnly": "읽기 전용",
  "term.streamed": "{x} 수신",
  "term.empty": "노드를 선택하면 터미널이 붙습니다",
  "term.noNode": "선택된 노드 없음",
  "term.authError": "[세션 만료 — 페이지를 새로고침하세요]",
  "term.paneError": "[페인을 사용할 수 없습니다]",
  "conn.connecting": "연결 중",
  "conn.live": "실시간",
  "conn.reconnecting": "재연결",
  "conn.error": "오류",

  "board.title": "보드",
  "board.count": "{n}개 작업",
  "board.allStatuses": "전체 상태",
  "board.assignee": "담당자…",
  "board.loadError": "작업을 불러오지 못했습니다",
  "board.empty": "—",

  "add.open": "+ 추가",
  "add.heading": "새 작업",
  "add.title": "제목 (필수)",
  "add.body": "본문 (선택)",
  "add.assignee": "담당자 (선택)",
  "add.status": "상태",
  "add.priority": "우선순위",
  "add.submit": "추가",
  "add.cancel": "취소",
  "add.error": "작업을 추가하지 못했습니다",
  "add.titleRequired": "제목을 입력하세요",
  "priority.low": "낮음",
  "priority.normal": "보통",
  "priority.high": "높음",

  "drawer.loading": "불러오는 중…",
  "drawer.loadError": "작업을 불러오지 못했습니다",
  "drawer.close": "닫기",
  "fact.assignee": "담당자",
  "fact.tenant": "테넌트",
  "drawer.runs": "실행",
  "drawer.comments": "댓글",
  "drawer.noRuns": "아직 실행 없음",
  "drawer.noComments": "댓글 없음",
};

const EN: Dict = {
  "brand.title": "Dev Room",
  "brand.sub": "grove · live cockpit",
  "tab.board": "Board",
  "tab.terminal": "Terminal",
  "stat.live": "live",
  "auth.secured": "secured",
  "auth.local": "local",
  "stage.noBoards": "no boards available",

  "nodes.title": "Nodes",
  "nodes.live": "{live}/{total} live",
  "nodes.filter": "filter nodes…",
  "nodes.noMatch": "no match",
  "nodes.none": "no nodes online",

  "status.running": "running",
  "status.idle": "idle",
  "status.error": "error",
  "status.done": "done",
  "status.triage": "triage",
  "status.todo": "todo",
  "status.scheduled": "scheduled",
  "status.ready": "ready",
  "status.blocked": "blocked",
  "status.review": "review",

  "term.readOnly": "read-only",
  "term.streamed": "{x} received",
  "term.empty": "Select a node to attach to its terminal.",
  "term.noNode": "no node selected",
  "term.authError": "[session expired — reload the page]",
  "term.paneError": "[pane not available]",
  "conn.connecting": "connecting",
  "conn.live": "live",
  "conn.reconnecting": "reconnecting",
  "conn.error": "error",

  "board.title": "Board",
  "board.count": "{n} tasks",
  "board.allStatuses": "all statuses",
  "board.assignee": "assignee…",
  "board.loadError": "failed to load tasks",
  "board.empty": "—",

  "add.open": "+ Add",
  "add.heading": "New task",
  "add.title": "Title (required)",
  "add.body": "Body (optional)",
  "add.assignee": "Assignee (optional)",
  "add.status": "Status",
  "add.priority": "Priority",
  "add.submit": "Add",
  "add.cancel": "Cancel",
  "add.error": "failed to add task",
  "add.titleRequired": "title is required",
  "priority.low": "low",
  "priority.normal": "normal",
  "priority.high": "high",

  "drawer.loading": "loading…",
  "drawer.loadError": "failed to load task",
  "drawer.close": "close",
  "fact.assignee": "assignee",
  "fact.tenant": "tenant",
  "drawer.runs": "Runs",
  "drawer.comments": "Comments",
  "drawer.noRuns": "no runs yet",
  "drawer.noComments": "no comments",
};

const STRINGS: Record<Lang, Dict> = { ko: KO, en: EN };

export type TFn = (key: string, vars?: Record<string, string | number>) => string;

interface I18n {
  lang: Lang;
  setLang: (l: Lang) => void;
  t: TFn;
}

const I18nContext = createContext<I18n | null>(null);

function initialLang(): Lang {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v === "ko" || v === "en") return v;
  } catch {
    /* storage unavailable */
  }
  return "ko";
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(initialLang);

  const setLang = useCallback((l: Lang) => {
    setLangState(l);
    try {
      localStorage.setItem(STORAGE_KEY, l);
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    try {
      document.documentElement.lang = lang;
    } catch {
      /* ignore */
    }
  }, [lang]);

  const t = useCallback<TFn>(
    (key, vars) => {
      let s = STRINGS[lang][key] ?? EN[key] ?? key;
      if (vars) {
        for (const [k, v] of Object.entries(vars)) {
          s = s.replace(new RegExp(`\\{${k}\\}`, "g"), String(v));
        }
      }
      return s;
    },
    [lang],
  );

  const value = useMemo<I18n>(() => ({ lang, setLang, t }), [lang, setLang, t]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18n {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error("useI18n must be used within I18nProvider");
  return ctx;
}

/** Localise a status/column key, falling back to the raw value if unmapped. */
export function statusLabel(t: TFn, status: string): string {
  const key = `status.${status}`;
  const s = t(key);
  return s === key ? status : s;
}
