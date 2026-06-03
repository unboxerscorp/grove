import { useEffect } from "react";
import type { RefObject } from "react";

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Minimal dialog focus management for modal panels (role="dialog"):
 *   - on open, move focus into the panel (first focusable, else the panel),
 *   - trap Tab/Shift+Tab so focus cycles within the panel,
 *   - restore focus to the previously-focused element on close.
 *
 * The panel element should carry tabIndex={-1} so it can receive the fallback
 * focus. Escape-to-close is handled by each drawer separately.
 */
export function useFocusTrap(active: boolean, panelRef: RefObject<HTMLElement | null>) {
  useEffect(() => {
    if (!active) return;
    const panel = panelRef.current;
    if (!panel) return;

    const prev = document.activeElement as HTMLElement | null;

    const focusable = () =>
      Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => el.offsetParent !== null);

    (focusable()[0] ?? panel).focus();

    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Tab") return;
      const els = focusable();
      if (els.length === 0) {
        e.preventDefault();
        panel.focus();
        return;
      }
      const first = els[0]!;
      const last = els[els.length - 1]!;
      const act = document.activeElement;
      if (e.shiftKey && (act === first || !panel.contains(act))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (act === last || !panel.contains(act))) {
        e.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      prev?.focus?.();
    };
  }, [active, panelRef]);
}
