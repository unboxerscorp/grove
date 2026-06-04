import { useEffect, useRef, useState } from "react";

import { api } from "../api";
import { cx } from "../constants";
import { useI18n } from "../i18n";
import { useFocusTrap } from "../useFocusTrap";
import { GroveMark } from "./GroveMark";

// Bumped suffix ("v3") so a re-introduced/extended wizard can re-show once even
// for users who dismissed the previous one.
const SEEN_KEY = "grove.onboarded.v3";
const STEPS = ["welcome", "project", "board", "node", "setup"] as const;

function hasSeen(): boolean {
  try {
    return localStorage.getItem(SEEN_KEY) === "1";
  } catch {
    return false;
  }
}
function markSeen(): void {
  try {
    localStorage.setItem(SEEN_KEY, "1");
  } catch {
    /* storage unavailable — wizard simply re-shows next time */
  }
}

/**
 * First-run onboarding wizard. Shows once (localStorage flag) on first visit /
 * when there are no projects; skippable at any step and never re-shown after it
 * is dismissed or finished. Step 2 reuses the ProjectSwitcher new/load APIs
 * (api.createProject / api.loadProject); import has no backend yet so it is
 * surfaced as guidance. Renders as an overlay above the (already-live) dashboard.
 */
export function OnboardingWizard(props: {
  openKey: number;
  projectCount: number;
  onProjectReady: (name: string) => void;
  onNavigate: (view: "board" | "team" | "auth") => void;
}) {
  const { openKey, projectCount, onProjectReady, onNavigate } = props;
  const { t } = useI18n();
  // Show on first visit OR when there are no projects yet (and not yet seen).
  const [visible, setVisible] = useState(() => !hasSeen());
  const [step, setStep] = useState(0);
  const panelRef = useRef<HTMLElement | null>(null);
  useFocusTrap(visible, panelRef);

  // Project step (reused new/load flow).
  const [name, setName] = useState("");
  const [path, setPath] = useState("");
  const [busy, setBusy] = useState(false);
  const [projMsg, setProjMsg] = useState<string | null>(null);
  const [projErr, setProjErr] = useState<string | null>(null);

  const dismiss = () => {
    markSeen();
    setVisible(false);
  };

  useEffect(() => {
    if (!visible) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") dismiss();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [visible]);

  useEffect(() => {
    if (openKey <= 0) return;
    setStep(0);
    setVisible(true);
  }, [openKey]);

  const createProject = () => {
    const nm = name.trim();
    if (!nm || busy) return;
    setBusy(true);
    setProjErr(null);
    setProjMsg(null);
    api
      .createProject({ name: nm })
      .then((p) => {
        setBusy(false);
        setProjMsg(t("onb.project.created", { name: p.name }));
        onProjectReady(p.name);
        setStep(2); // advance to the node step
      })
      .catch(() => {
        setBusy(false);
        setProjErr(t("onb.project.error"));
      });
  };

  const loadProject = () => {
    const p = path.trim();
    if (!p || busy) return;
    setBusy(true);
    setProjErr(null);
    setProjMsg(null);
    api
      .loadProject(p)
      .then((r) => {
        setBusy(false);
        setProjMsg(t("onb.project.loaded"));
        onProjectReady(r.name || p);
        setStep(2);
      })
      .catch(() => {
        setBusy(false);
        setProjErr(t("onb.project.error"));
      });
  };

  if (!visible) return null;

  const last = step === STEPS.length - 1;

  return (
    <div className="onb-wizard" role="dialog" aria-modal="true" aria-label={t("onb.title")}>
      <div className="onb-wizard__scrim" />
      <aside className="onb-wizard__panel" tabIndex={-1} ref={panelRef}>
        <header className="onb-wizard__head">
          <span className="onb-wizard__brand">
            <GroveMark size={20} />
            {t("onb.title")}
          </span>
          <button type="button" className="onb-skip" onClick={dismiss}>
            {t("onb.skip")}
          </button>
        </header>

        <ol className="onb-stepper" aria-hidden="true">
          {STEPS.map((s, i) => (
            <li key={s} className={cx("onb-stepper__dot", i === step && "is-active", i < step && "is-done")} />
          ))}
        </ol>

        <div className="onb-step" data-step={step}>
          {step === 0 && (
            <>
              <h2 className="onb-title">{t("onb.welcome.title")}</h2>
              <p className="onb-body">{t("onb.welcome.body")}</p>
            </>
          )}

          {step === 1 && (
            <>
              <h2 className="onb-title">{t("onb.project.title")}</h2>
              <p className="onb-body">{t("onb.project.body")}</p>
              <div className="onb-proj">
                <div className="onb-proj__row">
                  <input
                    className="dr-input onb-proj-name"
                    name="onbProjName"
                    type="text"
                    placeholder={t("onb.project.namePh")}
                    value={name}
                    spellCheck={false}
                    onChange={(e) => setName(e.target.value)}
                  />
                  <button
                    type="button"
                    className="dr-btn dr-btn--primary onb-proj-create"
                    disabled={busy || !name.trim()}
                    onClick={createProject}
                  >
                    {t("onb.project.create")}
                  </button>
                </div>
                <div className="onb-proj__row">
                  <input
                    className="dr-input onb-proj-path"
                    name="onbProjPath"
                    type="text"
                    placeholder={t("onb.project.pathPh")}
                    value={path}
                    spellCheck={false}
                    onChange={(e) => setPath(e.target.value)}
                  />
                  <button
                    type="button"
                    className="dr-btn dr-btn--ghost onb-proj-load"
                    disabled={busy || !path.trim()}
                    onClick={loadProject}
                  >
                    {t("onb.project.load")}
                  </button>
                </div>
                <p className="onb-import-note">{t("onb.project.import")}</p>
                {projMsg && <div className="onb-proj__ok">✓ {projMsg}</div>}
                {projErr && <div className="onb-proj__err">{projErr}</div>}
                {projectCount > 0 && <p className="onb-proj__hint">{t("onb.project.existing", { n: projectCount })}</p>}
              </div>
            </>
          )}

          {step === 2 && (
            <>
              <h2 className="onb-title">{t("onb.board.title")}</h2>
              <p className="onb-body">{t("onb.board.body")}</p>
              <button
                type="button"
                className="dr-btn dr-btn--primary onb-goto-board"
                onClick={() => {
                  onNavigate("board");
                  setStep(3);
                }}
              >
                {t("onb.board.cta")} ↗
              </button>
            </>
          )}

          {step === 3 && (
            <>
              <h2 className="onb-title">{t("onb.node.title")}</h2>
              <p className="onb-body">{t("onb.node.body")}</p>
              <button
                type="button"
                className="dr-btn dr-btn--primary onb-goto-team"
                onClick={() => {
                  onNavigate("team");
                  setStep(4);
                }}
              >
                {t("onb.node.cta")} ↗
              </button>
            </>
          )}

          {step === 4 && (
            <>
              <h2 className="onb-title">{t("onb.setup.title")}</h2>
              <p className="onb-body">{t("onb.setup.body")}</p>
              <button
                type="button"
                className="dr-btn dr-btn--ghost onb-goto-auth"
                onClick={() => {
                  onNavigate("auth");
                  dismiss();
                }}
              >
                {t("onb.setup.cta")} ↗
              </button>
            </>
          )}
        </div>

        <footer className="onb-wizard__foot">
          <button
            type="button"
            className="dr-btn dr-btn--ghost onb-back"
            disabled={step === 0}
            onClick={() => setStep((s) => Math.max(0, s - 1))}
          >
            {t("onb.back")}
          </button>
          {last ? (
            <button type="button" className="dr-btn dr-btn--primary onb-finish" onClick={dismiss}>
              {t("onb.finish")}
            </button>
          ) : (
            <button
              type="button"
              className="dr-btn dr-btn--primary onb-next"
              onClick={() => setStep((s) => Math.min(STEPS.length - 1, s + 1))}
            >
              {t("onb.next")}
            </button>
          )}
        </footer>
      </aside>
    </div>
  );
}
