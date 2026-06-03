import { useRef, useState } from "react";
import { createPortal } from "react-dom";

import { api } from "../api";
import type { LoadResult, Project } from "../api";
import { cx } from "../constants";
import { statusLabel, useI18n } from "../i18n";

const TEMPLATES = ["blank", "web", "research", "ops"];

function statusClass(status: string): string {
  switch (status) {
    case "running":
      return "is-running";
    case "error":
      return "is-error";
    case "done":
      return "is-done";
    default:
      return "is-idle";
  }
}

function basename(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

function NewProjectModal(props: { onCreated: (name: string) => void; onClose: () => void }) {
  const { onCreated, onClose } = props;
  const { t } = useI18n();
  const [name, setName] = useState("");
  const [template, setTemplate] = useState("");
  const [clone, setClone] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const nm = name.trim();
    if (!nm) return setError(t("proj.new.nameReq"));
    setBusy(true);
    setError(null);
    api
      .createProject({ name: nm, template: template || undefined, clone: clone.trim() || undefined })
      .then((p) => {
        setBusy(false);
        onCreated(p.name);
      })
      .catch(() => {
        setBusy(false);
        setError(t("proj.new.error"));
      });
  };

  return (
    <ProjModal title={t("proj.new.heading")} onClose={onClose} kind="new">
      <form className="proj-form" onSubmit={submit}>
        <label className="slack-field">
          <span className="slack-field__label">{t("proj.new.name")}</span>
          <input
            className="dr-input"
            name="projName"
            type="text"
            value={name}
            autoFocus
            spellCheck={false}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <label className="slack-field">
          <span className="slack-field__label">{t("proj.new.template")}</span>
          <select className="dr-select" name="template" value={template} onChange={(e) => setTemplate(e.target.value)}>
            <option value="">{t("proj.new.templateNone")}</option>
            {TEMPLATES.map((tpl) => (
              <option key={tpl} value={tpl}>
                {tpl}
              </option>
            ))}
          </select>
        </label>
        <label className="slack-field">
          <span className="slack-field__label">{t("proj.new.clone")}</span>
          <input
            className="dr-input"
            name="clone"
            type="text"
            placeholder={t("proj.new.clonePh")}
            value={clone}
            spellCheck={false}
            onChange={(e) => setClone(e.target.value)}
          />
        </label>
        {error && <div className="slack-field__err">{error}</div>}
        <div className="proj-form__actions">
          <button type="button" className="dr-btn dr-btn--ghost" onClick={onClose}>
            {t("proj.cancel")}
          </button>
          <button type="submit" className="dr-btn dr-btn--primary proj-new__submit" disabled={busy}>
            {busy ? t("proj.new.creating") : t("proj.new.create")}
          </button>
        </div>
      </form>
    </ProjModal>
  );
}

function LoadProjectModal(props: { onLoaded: (name: string) => void; onClose: () => void }) {
  const { onLoaded, onClose } = props;
  const { t } = useI18n();
  const [path, setPath] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<LoadResult | null>(null);

  const run = (e: React.FormEvent) => {
    e.preventDefault();
    const p = path.trim();
    if (!p) return;
    setBusy(true);
    setError(null);
    api
      .loadProject(p)
      .then((r) => {
        setBusy(false);
        setResult(r);
      })
      .catch(() => {
        setBusy(false);
        setError(t("proj.load.error"));
      });
  };

  const bucket = (label: string, items: string[], cls: string) => (
    <div className={cx("proj-result__bucket", cls)}>
      <span className="proj-result__k">
        {label} <span className="proj-result__n">{items.length}</span>
      </span>
      <span className="proj-result__items">{items.length ? items.join(", ") : "—"}</span>
    </div>
  );

  return (
    <ProjModal title={t("proj.load.heading")} onClose={onClose} kind="load">
      <form className="proj-form" onSubmit={run}>
        <label className="slack-field">
          <span className="slack-field__label">{t("proj.load.path")}</span>
          <input
            className="dr-input"
            name="loadPath"
            type="text"
            placeholder={t("proj.load.pathPh")}
            value={path}
            autoFocus
            spellCheck={false}
            onChange={(e) => setPath(e.target.value)}
          />
        </label>
        {error && <div className="slack-field__err">{error}</div>}
        {!result && (
          <div className="proj-form__actions">
            <button type="button" className="dr-btn dr-btn--ghost" onClick={onClose}>
              {t("proj.cancel")}
            </button>
            <button type="submit" className="dr-btn dr-btn--primary proj-load__submit" disabled={busy}>
              {busy ? t("proj.load.loading") : t("proj.load.run")}
            </button>
          </div>
        )}
      </form>

      {result && (
        <div className="proj-result">
          <div className={cx("proj-result__ok", result.ok ? "is-ok" : "is-bad")}>
            {result.ok ? `✓ ${t("proj.load.ok")}` : `! ${t("proj.load.notok")}`}
          </div>
          {bucket(t("proj.load.restored"), result.restored ?? [], "is-restored")}
          {bucket(t("proj.load.stale"), result.stale ?? [], "is-stale")}
          {bucket(t("proj.load.fresh"), result.fresh ?? [], "is-fresh")}
          <div className="proj-form__actions">
            <button type="button" className="dr-btn dr-btn--ghost" onClick={onClose}>
              {t("proj.cancel")}
            </button>
            <button
              type="button"
              className="dr-btn dr-btn--primary proj-load__switch"
              onClick={() => onLoaded(result.name || basename(path))}
            >
              {t("proj.load.switch")}
            </button>
          </div>
        </div>
      )}
    </ProjModal>
  );
}

function ProjModal(props: {
  title: string;
  kind: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  // Portal to body so the modal escapes the header's stacking context.
  return createPortal(
    <div className={cx("proj-modal", `is-${props.kind}`)}>
      <div className="proj-modal__scrim" onClick={props.onClose} />
      <div className="proj-modal__panel" role="dialog" aria-label={props.title}>
        <div className="proj-modal__title">{props.title}</div>
        {props.children}
      </div>
    </div>,
    document.body,
  );
}

export function ProjectSwitcher(props: {
  projects: Project[];
  current: string | null;
  onSwitch: (name: string) => void;
  onProjectsChanged: () => void;
}) {
  const { projects, current, onSwitch, onProjectsChanged } = props;
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [menuPos, setMenuPos] = useState({ left: 0, top: 0 });
  const [modal, setModal] = useState<null | "new" | "load">(null);
  const btnRef = useRef<HTMLButtonElement | null>(null);

  const cur = projects.find((p) => p.name === current) ?? null;

  const toggleMenu = () => {
    if (open) {
      setOpen(false);
      return;
    }
    const r = btnRef.current?.getBoundingClientRect();
    if (r) setMenuPos({ left: r.left, top: r.bottom + 8 });
    setOpen(true);
  };

  const pick = (name: string) => {
    setOpen(false);
    onSwitch(name);
  };
  const afterCreateOrLoad = (name: string) => {
    setModal(null);
    setOpen(false);
    onProjectsChanged();
    onSwitch(name);
  };

  return (
    <div className="proj-switcher">
      <button
        type="button"
        ref={btnRef}
        className={cx("proj-switcher__btn", open && "is-open")}
        onClick={toggleMenu}
      >
        <span className={cx("proj-switcher__dot", statusClass(cur?.status ?? ""))} />
        <span className="proj-switcher__name">{current ?? t("project.none")}</span>
        <span className="proj-switcher__chev">▾</span>
      </button>

      {open &&
        createPortal(
          <>
            <div className="proj-menu__scrim" onClick={() => setOpen(false)} />
            <div className="proj-menu" style={{ left: menuPos.left, top: menuPos.top }}>
            <div className="proj-menu__label">{t("project.list")}</div>
            <div className="proj-menu__list">
              {projects.map((p) => (
                <button
                  key={p.name}
                  type="button"
                  data-project={p.name}
                  className={cx("proj-item", p.name === current && "is-current")}
                  onClick={() => pick(p.name)}
                >
                  <span className={cx("proj-switcher__dot", statusClass(p.status))} />
                  <span className="proj-item__body">
                    <span className="proj-item__name">{p.name}</span>
                    <span className="proj-item__meta">
                      {p.workspace} · {t("project.nodes", { n: p.node_count })}
                    </span>
                  </span>
                  <span className="proj-item__status">{statusLabel(t, p.status)}</span>
                </button>
              ))}
            </div>
            <div className="proj-menu__divider" />
            <button type="button" className="proj-menu__action proj-menu__new" onClick={() => setModal("new")}>
              {t("project.new")}
            </button>
            <button type="button" className="proj-menu__action proj-menu__load" onClick={() => setModal("load")}>
              {t("project.load")}
            </button>
            </div>
          </>,
          document.body,
        )}

      {modal === "new" && <NewProjectModal onCreated={afterCreateOrLoad} onClose={() => setModal(null)} />}
      {modal === "load" && <LoadProjectModal onLoaded={afterCreateOrLoad} onClose={() => setModal(null)} />}
    </div>
  );
}
