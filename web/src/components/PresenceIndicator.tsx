import { useEffect, useState } from "react";

import { api } from "../api";
import type { Presence } from "../api";
import { cx } from "../constants";
import { useI18n } from "../i18n";

function roleClass(role?: string): string {
  switch ((role ?? "").toLowerCase()) {
    case "admin":
      return "is-admin";
    case "operator":
      return "is-operator";
    case "viewer":
      return "is-viewer";
    default:
      return "is-member";
  }
}

/**
 * Header presence indicator: who is currently viewing this project. Team auth →
 * member chips (name + role-coloured dot); local-token → "anonymous N". Reads
 * GET /api/presence (project-scoped via the shared client headers), re-scoped on
 * projectTick and refreshed on liveTick + a short poll. Only name/role are
 * surfaced — no member id / secret ever reaches the DOM.
 */
export function PresenceIndicator({ liveTick, projectTick }: { liveTick: number; projectTick: number }) {
  const { t } = useI18n();
  const [presence, setPresence] = useState<Presence | null>(null);

  useEffect(() => {
    let alive = true;
    const load = () =>
      api
        .getPresence()
        .then((p) => {
          if (alive) setPresence(p);
        })
        .catch(() => {
          /* keep last */
        });
    void load();
    const id = setInterval(() => void load(), 4000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [liveTick, projectTick]);

  if (!presence) return null;

  const viewers = presence.viewers ?? [];
  const members = viewers.filter((v) => typeof v.name === "string" && v.name);
  const anon =
    presence.anonymous_count ??
    viewers.filter((v) => v.kind === "anonymous").reduce((s, v) => s + (v.count ?? 1), 0);

  return (
    <div className="dr-presence" role="status" aria-label={t("presence.label")} title={t("presence.label")}>
      <svg className="dr-presence__icon" viewBox="0 0 24 24" width={15} height={15} aria-hidden="true">
        <circle cx={9} cy={8} r={3} fill="none" stroke="currentColor" strokeWidth={1.5} />
        <path d="M3.5 19a5.5 5.5 0 0 1 11 0" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" />
        <path d="M16 5.5a3 3 0 0 1 0 5M18 19a5.5 5.5 0 0 0-3-4.9" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" />
      </svg>
      {members.length > 0 ? (
        <span className="dr-presence__members">
          {members.map((m) => (
            <span
              key={m.name}
              data-member={m.name}
              className={cx("dr-presence__chip", roleClass(m.role))}
              title={`${m.name} · ${m.role ?? ""}`}
            >
              <span className="dr-presence__dot" aria-hidden="true" />
              {m.name}
            </span>
          ))}
        </span>
      ) : (
        <span className="dr-presence__anon" data-anon={anon}>
          {anon > 0 ? t("presence.anonymous", { n: anon }) : t("presence.none")}
        </span>
      )}
    </div>
  );
}
