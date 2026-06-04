import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { cx } from "../constants";
import { useI18n } from "../i18n";
import { useFocusTrap } from "../useFocusTrap";

export interface PaletteCommand {
  id: string; // "view:<v>" | "drawer:<d>" — also used as a search keyword
  name: string; // raw english id (always searchable, language-independent)
  label: string;
  group: string;
  icon: string;
  run: () => void; // NAVIGATION ONLY — routes to a view/drawer, never mutates
}

/** Subsequence fuzzy match: every query char appears in order (case-insensitive). */
function fuzzy(query: string, text: string): boolean {
  if (!query) return true;
  const q = query.toLowerCase();
  const hay = text.toLowerCase();
  let i = 0;
  for (let c = 0; c < hay.length && i < q.length; c++) {
    if (hay[c] === q[i]) i++;
  }
  return i === q.length;
}

/**
 * Command palette (Cmd/Ctrl-K) layered over the left sidebar. Lists every view +
 * drawer, fuzzy-filterable, with keyboard nav (↑/↓/Enter/Esc). Selecting an entry
 * routes to that view/drawer — it is NAVIGATION-ONLY and performs no mutation
 * (real actions stay behind the existing gated UI). a11y: role=dialog + listbox,
 * focus trap + restore (useFocusTrap), Esc to close.
 */
export function CommandPalette({
  open,
  onClose,
  commands,
}: {
  open: boolean;
  onClose: () => void;
  commands: PaletteCommand[];
}) {
  const { t } = useI18n();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  useFocusTrap(open, panelRef);

  useEffect(() => {
    if (open) {
      setQuery("");
      setActive(0);
    }
  }, [open]);

  const filtered = useMemo(
    () => commands.filter((c) => fuzzy(query.trim(), `${c.label} ${c.group} ${c.name} ${c.id}`)),
    [commands, query],
  );

  // keep the active index in range as the filter narrows
  useEffect(() => {
    setActive((a) => (filtered.length === 0 ? 0 : Math.min(a, filtered.length - 1)));
  }, [filtered.length]);

  // scroll the active option into view
  useEffect(() => {
    listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
  }, [active, query, open]);

  if (!open) return null;

  const run = (cmd?: PaletteCommand) => {
    if (!cmd) return;
    cmd.run(); // navigation only
    onClose();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => (filtered.length ? Math.min(a + 1, filtered.length - 1) : 0));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      run(filtered[active]);
    }
  };

  return createPortal(
    <div className="cmdk" role="presentation">
      <div className="cmdk__scrim" onClick={onClose} aria-hidden="true" />
      <div
        className="cmdk__panel"
        role="dialog"
        aria-modal="true"
        aria-label={t("cmdk.title")}
        tabIndex={-1}
        ref={panelRef}
        onKeyDown={onKeyDown}
      >
        <input
          className="cmdk__input"
          type="text"
          role="combobox"
          aria-expanded="true"
          aria-controls="cmdk-list"
          aria-autocomplete="list"
          placeholder={t("cmdk.placeholder")}
          value={query}
          spellCheck={false}
          autoComplete="off"
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(0);
          }}
        />
        <div className="cmdk__list" id="cmdk-list" role="listbox" aria-label={t("cmdk.title")} ref={listRef}>
          {filtered.length === 0 ? (
            <div className="cmdk__empty">{t("cmdk.empty")}</div>
          ) : (
            filtered.map((c, i) => (
              <button
                key={c.id}
                type="button"
                role="option"
                aria-selected={i === active}
                data-cmd={c.id}
                className={cx("cmdk__item", i === active && "is-active")}
                onMouseEnter={() => setActive(i)}
                onClick={() => run(c)}
              >
                <span className="cmdk__icon" aria-hidden="true">{c.icon}</span>
                <span className="cmdk__label">{c.label}</span>
                <span className="cmdk__group">{c.group}</span>
              </button>
            ))
          )}
        </div>
        <div className="cmdk__hint" aria-hidden="true">↑↓ · Enter · Esc</div>
      </div>
    </div>,
    document.body,
  );
}
