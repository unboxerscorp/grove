// Board columns + small presentation helpers shared across components.

// v1.29 canonical workflow columns — the board renders the live workflow API's
// columns when available, falling back to these (same canonical keys). Order:
// ready → running → review → blocked → ask_human → done (done always shown). The
// "running" key matches the backend's stored vocabulary; its label stays "In Progress".
export const CANONICAL_COLUMNS = [
  { key: "ready", label: "Ready" },
  { key: "running", label: "In Progress" },
  { key: "review", label: "Review" },
  { key: "blocked", label: "Blocked" },
  { key: "ask_human", label: "Ask Human" },
  { key: "done", label: "Done" },
] as const;

// Kept for the add-task status dropdown default + any importer; canonical now.
export const COLUMNS = CANONICAL_COLUMNS;

// Virtual columns are DISPLAY-ONLY (derived server-side, e.g. ask_human = blocked
// + needs_human). They render as board columns but must NEVER be offered as a
// manual status target — the backend rejects a manual PATCH to them.
export const VIRTUAL_STATUS_KEYS = new Set<string>(["ask_human"]);

// Canonical columns minus virtual ones: the valid targets for a manual status
// change (on-card dropdown + task-drawer select) when no live workflow is known.
export const MANUAL_STATUS_COLUMNS = CANONICAL_COLUMNS.filter((c) => !VIRTUAL_STATUS_KEYS.has(c.key));

// Status -> CSS custom property name for accents (defined in styles.css).
export const STATUS_COLOR: Record<string, string> = {
  triage: "var(--slate)",
  todo: "var(--slate)",
  scheduled: "var(--amber)",
  ready: "var(--amber)",
  running: "var(--teal)",
  blocked: "var(--coral)",
  ask_human: "var(--coral)",
  review: "var(--amber)",
  done: "var(--blue)",
};

export function statusColor(status: string): string {
  return STATUS_COLOR[status] ?? "var(--slate)";
}

export function agentGlyph(agent: string): string {
  const a = (agent || "").toLowerCase();
  if (a.includes("antigravity") || a === "agy") return "▲";
  if (a.includes("claude")) return "◇";
  if (a.includes("codex")) return "▸";
  return "•";
}

export const AGENTS = ["claude", "codex", "antigravity"] as const;

export function initials(name: string): string {
  const parts = (name || "?").split(/[\s_./:-]+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "?") + (parts[1]?.[0] ?? "")).toUpperCase();
}

export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(" ");
}

/** Compact, locale-neutral "time ago" (e.g. "12s", "3m", "2h", "5d"). */
export function fmtAgo(ts?: string | number | null): string {
  if (ts === undefined || ts === null || ts === "") return "—";
  let ms: number;
  if (typeof ts === "number") ms = ts < 1e12 ? ts * 1000 : ts;
  else {
    const parsed = Date.parse(ts);
    if (Number.isNaN(parsed)) return String(ts);
    ms = parsed;
  }
  const s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}
