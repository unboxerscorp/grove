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

  "tab.team": "팀",
  "org.title": "조직도",
  "org.subtitle": "{n}개 노드 · {g}개 그룹",
  "org.addNode": "+ 노드 추가",
  "org.groups": "그룹",
  "org.openTerminal": "터미널",
  "org.info": "정보",
  "org.loadError": "조직도를 불러오지 못했습니다",
  "org.empty": "노드가 없습니다 — 노드를 추가해 시작하세요",
  "org.delegEdges": "위임 흐름",
  "org.delegLegend": "위임 엣지 — 누가 누구에게 작업을 위임했는지 (점선·화살표 방향)",
  "org.delegEmpty": "최근 위임 기록 없음",
  "org.delegEdge": "{from} → {to} · 위임 {n}회",

  "node.heading": "새 노드",
  "node.name": "이름 (필수)",
  "node.agent": "에이전트",
  "node.role": "역할 (선택)",
  "node.parent": "부모",
  "node.parentNone": "(루트)",
  "node.group": "그룹 (선택)",
  "node.window": "윈도우 (선택)",
  "node.create": "생성",
  "node.creating": "생성 중…",
  "node.cancel": "취소",
  "node.createError": "노드를 생성하지 못했습니다",
  "node.nameRequired": "이름을 입력하세요",

  "node.fact.role": "역할",
  "node.fact.group": "그룹",
  "node.fact.agent": "에이전트",
  "node.fact.pane": "페인",
  "node.fact.session": "세션",
  "node.fact.parent": "부모",
  "node.fact.children": "자식",
  "node.fact.status": "상태",
  "node.assign": "작업 부여",
  "node.assignTitle": "작업 제목 (필수)",
  "node.assignSubmit": "부여",
  "node.assigned": "부여됨",
  "node.assignError": "작업을 부여하지 못했습니다",
  "node.noBoard": "보드가 없어 부여할 수 없습니다",

  "drag.reparent": "「{target}」의 하위로",
  "drag.group": "「{target}」과 같은 그룹",
  "drag.ungroup": "그룹에서 나감",
  "drag.invalid": "여기엔 놓을 수 없음",
  "org.cutParent": "부모 연결 끊기",
  "org.detach": "부모 끊기",

  "delegate.action": "위임",
  "delegate.heading": "작업 위임",
  "delegate.title": "작업 제목",
  "delegate.body": "설명 (선택)",
  "delegate.submit": "위임",
  "delegate.submitting": "위임 중…",
  "delegate.titleRequired": "제목을 입력하세요",
  "delegate.error": "위임에 실패했습니다",

  "tab.integrations": "연동",
  "slack.title": "Slack 연동",
  "slack.flow": "① manifest 다운로드 → ② Slack에서 앱 생성·설치 → ③ 토큰 2개 입력·저장 → ④ 소켓 연결 확인",
  "slack.manifest.title": "① 봇 manifest",
  "slack.manifest.desc": "이 파일을 api.slack.com에 업로드해 앱을 생성하세요.",
  "slack.manifest.download": "manifest 다운로드",
  "slack.manifest.downloading": "내려받는 중…",
  "slack.manifest.error": "manifest를 받지 못했습니다",
  "slack.tokens.title": "③ 토큰",
  "slack.tokens.app": "App 토큰 (xapp-)",
  "slack.tokens.bot": "Bot 토큰 (xoxb-)",
  "slack.tokens.appErr": "App 토큰은 xapp- 로 시작해야 합니다",
  "slack.tokens.botErr": "Bot 토큰은 xoxb- 로 시작해야 합니다",
  "slack.tokens.required": "토큰을 입력하세요",
  "slack.tokens.edit": "수정",
  "slack.mapping.title": "④ 기본 채널·노드",
  "slack.mapping.channel": "기본 채널",
  "slack.mapping.channelPh": "#채널 또는 채널 ID",
  "slack.mapping.node": "기본 노드",
  "slack.mapping.nodeNone": "(선택 안 함)",
  "slack.save": "저장",
  "slack.saving": "저장 중…",
  "slack.saveError": "저장하지 못했습니다",
  "slack.status.title": "연결 상태",
  "slack.status.not_configured": "미설정",
  "slack.status.tokens_saved": "토큰 저장됨",
  "slack.status.bot_auth_ok": "봇 인증됨",
  "slack.status.socket_connected": "소켓 연결됨",
  "slack.status.lastEvent": "마지막 이벤트",
  "slack.status.lastError": "마지막 오류",
  "slack.test": "테스트",
  "slack.testing": "테스트 중…",
  "slack.threads": "ask-human 스레드 보기 ↗",

  "project.none": "프로젝트 없음",
  "project.list": "프로젝트",
  "project.nodes": "{n}개 노드",
  "project.new": "+ 새 프로젝트",
  "project.load": "기존 프로젝트 불러오기",
  "proj.new.heading": "새 프로젝트",
  "proj.new.name": "이름 (필수)",
  "proj.new.template": "템플릿",
  "proj.new.templateNone": "(기본)",
  "proj.new.clone": "gh repo 클론 (선택)",
  "proj.new.clonePh": "owner/repo 또는 URL",
  "proj.new.create": "생성",
  "proj.new.creating": "생성 중…",
  "proj.new.error": "프로젝트를 생성하지 못했습니다",
  "proj.new.nameReq": "이름을 입력하세요",
  "proj.load.heading": "기존 프로젝트 불러오기",
  "proj.load.path": "폴더 경로",
  "proj.load.pathPh": "~/dev/내-프로젝트",
  "proj.load.run": "불러오기",
  "proj.load.loading": "불러오는 중…",
  "proj.load.error": "불러오지 못했습니다",
  "proj.load.restored": "복원됨",
  "proj.load.stale": "오래됨(stale)",
  "proj.load.fresh": "신규(fresh)",
  "proj.load.ok": "무결성 OK",
  "proj.load.notok": "문제 발견",
  "proj.load.switch": "이 프로젝트로 전환",
  "proj.cancel": "취소",

  "tab.auth": "인증",
  "auth.title": "개발도구 인증",
  "auth.refresh": "새로고침",
  "auth.refreshing": "새로고침 중…",
  "auth.loadError": "인증 상태를 불러오지 못했습니다",
  "auth.authed": "인증됨",
  "auth.notAuthed": "미인증",
  "auth.login": "로그인",
  "auth.loginUrl": "로그인 ↗",
  "auth.hintLabel": "이 명령을 실행하세요",
  "auth.copy": "복사",
  "auth.copied": "복사됨",

  "node.description": "설명 (선택)",

  "status.nodes": "노드 상태",
  "status.stale": "멈춤",
  "status.total": "전체",
  "health.ok": "서버 정상",
  "health.degraded": "보드 저하",
  "health.down": "서버 응답 없음",
  "health.pending": "확인 중",

  "status.detail": "상세",
  "status.dead": "종료",
  "status.lastSeen": "마지막 확인",
  "status.inferred": "추정",
  "status.reason": "사유",

  "audit.open": "감사",
  "audit.title": "감사 로그",
  "audit.filterAction": "액션 필터",
  "audit.filterNode": "노드 필터",
  "audit.empty": "이벤트 없음",
  "audit.more": "더 보기",
  "audit.loading": "불러오는 중…",
  "audit.loadError": "감사 로그를 불러오지 못했습니다",

  "tab.cost": "비용",
  "cost.title": "비용 · 크레딧",
  "cost.note": "에이전트 타입별 토큰·비용 집계입니다. 추정값은 표시되며 사실로 간주하지 마세요.",
  "cost.refresh": "새로고침",
  "cost.refreshing": "새로고침 중…",
  "cost.loadError": "비용 정보를 불러오지 못했습니다",
  "cost.forbidden": "권한 없음 — 팀 뷰어는 비용을 볼 수 없습니다",
  "cost.empty": "비용 데이터 없음",
  "cost.tokens": "토큰",
  "cost.cost": "비용",
  "cost.credit": "크레딧",
  "cost.total": "합계",
  "cost.unknown": "알 수 없음",
  "cost.estimate": "추정",
  "cost.estimateHint": "추정값 — 실측이 아닌 추정/유추된 수치입니다",
  "cost.creditUnknown": "알 수 없음 (추정하지 않음)",
  "cost.legendEstimate": "= 추정/유추값 (실측 아님)",
  "cost.source.registry": "레지스트리",
  "cost.source.run_metadata": "실행 기록",
  "cost.source.transcript": "트랜스크립트",
  "cost.source.estimate": "추정",
  "cost.source.none": "없음",
  "cost.source.mixed": "혼합",
  "cost.source.server": "서버",
  "cost.conf.explicit": "확정",
  "cost.conf.partial": "부분",
  "cost.conf.inferred": "유추",
  "cost.conf.unknown": "알 수 없음",
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

  "tab.team": "Team",
  "org.title": "Org chart",
  "org.subtitle": "{n} nodes · {g} groups",
  "org.addNode": "+ Add node",
  "org.groups": "Groups",
  "org.openTerminal": "Terminal",
  "org.info": "Info",
  "org.loadError": "failed to load org",
  "org.empty": "no nodes yet — add one to begin",
  "org.delegEdges": "Delegation",
  "org.delegLegend": "Delegation edges — who delegated work to whom (dashed, arrow = direction)",
  "org.delegEmpty": "no recent delegations",
  "org.delegEdge": "{from} → {to} · delegated {n}×",

  "node.heading": "New node",
  "node.name": "Name (required)",
  "node.agent": "Agent",
  "node.role": "Role (optional)",
  "node.parent": "Parent",
  "node.parentNone": "(root)",
  "node.group": "Group (optional)",
  "node.window": "Window (optional)",
  "node.create": "Create",
  "node.creating": "Creating…",
  "node.cancel": "Cancel",
  "node.createError": "failed to create node",
  "node.nameRequired": "name is required",

  "node.fact.role": "role",
  "node.fact.group": "group",
  "node.fact.agent": "agent",
  "node.fact.pane": "pane",
  "node.fact.session": "session",
  "node.fact.parent": "parent",
  "node.fact.children": "children",
  "node.fact.status": "status",
  "node.assign": "Assign task",
  "node.assignTitle": "Task title (required)",
  "node.assignSubmit": "Assign",
  "node.assigned": "Assigned",
  "node.assignError": "failed to assign task",
  "node.noBoard": "no board to assign to",

  "drag.reparent": "into {target}",
  "drag.group": "same group as {target}",
  "drag.ungroup": "leave group",
  "drag.invalid": "can't drop here",
  "org.cutParent": "detach from parent",
  "org.detach": "detach",

  "delegate.action": "delegate",
  "delegate.heading": "Delegate task",
  "delegate.title": "Task title",
  "delegate.body": "Description (optional)",
  "delegate.submit": "Delegate",
  "delegate.submitting": "Delegating…",
  "delegate.titleRequired": "Title is required",
  "delegate.error": "Delegation failed",

  "tab.integrations": "Integrations",
  "slack.title": "Slack integration",
  "slack.flow": "① Download manifest → ② Create & install the app on Slack → ③ Enter & save both tokens → ④ Confirm socket connected",
  "slack.manifest.title": "① Bot manifest",
  "slack.manifest.desc": "Upload this file to api.slack.com to create the app.",
  "slack.manifest.download": "Download manifest",
  "slack.manifest.downloading": "Downloading…",
  "slack.manifest.error": "failed to fetch manifest",
  "slack.tokens.title": "③ Tokens",
  "slack.tokens.app": "App token (xapp-)",
  "slack.tokens.bot": "Bot token (xoxb-)",
  "slack.tokens.appErr": "App token must start with xapp-",
  "slack.tokens.botErr": "Bot token must start with xoxb-",
  "slack.tokens.required": "enter a token",
  "slack.tokens.edit": "edit",
  "slack.mapping.title": "④ Default channel & node",
  "slack.mapping.channel": "Default channel",
  "slack.mapping.channelPh": "#channel or channel ID",
  "slack.mapping.node": "Default node",
  "slack.mapping.nodeNone": "(none)",
  "slack.save": "Save",
  "slack.saving": "Saving…",
  "slack.saveError": "failed to save",
  "slack.status.title": "Connection status",
  "slack.status.not_configured": "not configured",
  "slack.status.tokens_saved": "tokens saved",
  "slack.status.bot_auth_ok": "bot authed",
  "slack.status.socket_connected": "socket connected",
  "slack.status.lastEvent": "last event",
  "slack.status.lastError": "last error",
  "slack.test": "Test",
  "slack.testing": "Testing…",
  "slack.threads": "View ask-human threads ↗",

  "project.none": "no project",
  "project.list": "Projects",
  "project.nodes": "{n} nodes",
  "project.new": "+ New project",
  "project.load": "Load existing project",
  "proj.new.heading": "New project",
  "proj.new.name": "Name (required)",
  "proj.new.template": "Template",
  "proj.new.templateNone": "(default)",
  "proj.new.clone": "Clone gh repo (optional)",
  "proj.new.clonePh": "owner/repo or URL",
  "proj.new.create": "Create",
  "proj.new.creating": "Creating…",
  "proj.new.error": "failed to create project",
  "proj.new.nameReq": "name is required",
  "proj.load.heading": "Load existing project",
  "proj.load.path": "Folder path",
  "proj.load.pathPh": "~/dev/my-project",
  "proj.load.run": "Load",
  "proj.load.loading": "Loading…",
  "proj.load.error": "failed to load",
  "proj.load.restored": "restored",
  "proj.load.stale": "stale",
  "proj.load.fresh": "fresh",
  "proj.load.ok": "integrity OK",
  "proj.load.notok": "issues found",
  "proj.load.switch": "Switch to this project",
  "proj.cancel": "Cancel",

  "tab.auth": "Auth",
  "auth.title": "Dev tool auth",
  "auth.refresh": "Refresh",
  "auth.refreshing": "Refreshing…",
  "auth.loadError": "failed to load auth status",
  "auth.authed": "authed",
  "auth.notAuthed": "not authed",
  "auth.login": "Log in",
  "auth.loginUrl": "Log in ↗",
  "auth.hintLabel": "Run this command",
  "auth.copy": "Copy",
  "auth.copied": "Copied",

  "node.description": "Description (optional)",

  "status.nodes": "Node status",
  "status.stale": "stale",
  "status.total": "total",
  "health.ok": "server ok",
  "health.degraded": "board degraded",
  "health.down": "server down",
  "health.pending": "checking",

  "status.detail": "Detail",
  "status.dead": "dead",
  "status.lastSeen": "last seen",
  "status.inferred": "inferred",
  "status.reason": "reason",

  "audit.open": "Audit",
  "audit.title": "Audit log",
  "audit.filterAction": "filter action",
  "audit.filterNode": "filter node",
  "audit.empty": "no events",
  "audit.more": "Load more",
  "audit.loading": "Loading…",
  "audit.loadError": "failed to load audit log",

  "tab.cost": "Cost",
  "cost.title": "Cost · Credit",
  "cost.note": "Token & cost rollup per agent type. Estimated values are flagged — don't read them as facts.",
  "cost.refresh": "Refresh",
  "cost.refreshing": "Refreshing…",
  "cost.loadError": "failed to load cost",
  "cost.forbidden": "No access — team viewers can't see cost",
  "cost.empty": "no cost data",
  "cost.tokens": "Tokens",
  "cost.cost": "Cost",
  "cost.credit": "Credit",
  "cost.total": "Total",
  "cost.unknown": "unknown",
  "cost.estimate": "est.",
  "cost.estimateHint": "Estimated — inferred/estimated, not measured",
  "cost.creditUnknown": "unknown (not estimated)",
  "cost.legendEstimate": "= estimated/inferred (not measured)",
  "cost.source.registry": "registry",
  "cost.source.run_metadata": "run metadata",
  "cost.source.transcript": "transcript",
  "cost.source.estimate": "estimate",
  "cost.source.none": "none",
  "cost.source.mixed": "mixed",
  "cost.source.server": "server",
  "cost.conf.explicit": "explicit",
  "cost.conf.partial": "partial",
  "cost.conf.inferred": "inferred",
  "cost.conf.unknown": "unknown",
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
