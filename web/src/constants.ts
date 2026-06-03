// Board columns + small presentation helpers shared across components.

export const COLUMNS = [
  { key: "triage", label: "Triage" },
  { key: "todo", label: "Todo" },
  { key: "scheduled", label: "Scheduled" },
  { key: "ready", label: "Ready" },
  { key: "running", label: "Running" },
  { key: "blocked", label: "Blocked" },
  { key: "review", label: "Review" },
  { key: "done", label: "Done" },
] as const;

// Status -> CSS custom property name for accents (defined in styles.css).
export const STATUS_COLOR: Record<string, string> = {
  triage: "var(--slate)",
  todo: "var(--slate)",
  scheduled: "var(--amber)",
  ready: "var(--amber)",
  running: "var(--teal)",
  blocked: "var(--coral)",
  review: "var(--amber)",
  done: "var(--blue)",
};

export function statusColor(status: string): string {
  return STATUS_COLOR[status] ?? "var(--slate)";
}

export function agentGlyph(agent: string): string {
  const a = (agent || "").toLowerCase();
  if (a.includes("antigravity")) return "▲";
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
