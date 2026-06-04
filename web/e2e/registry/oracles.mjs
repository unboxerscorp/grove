// Oracle layer for the UI interaction harness.
//
//  - loadRegistry(): controls.json + ignore-list.json + button-inventory.json.
//  - coverageClosure(): the HARD coverage gate. Every enabled discovered control
//    must match a registry or ignore entry (view + classContains); the unmatched
//    set is a coverage-gap FAIL (ratchet). High-risk controls that are merely
//    "not clicked" still FAIL here if unregistered.
//  - assertRoleDenied(): the 2-axis viewer/role denial oracle (UI hidden/disabled
//    AND direct-API 403). Both axes must hold; either passing alone is NOT enough.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

export function loadRegistry() {
  const controls = JSON.parse(readFileSync(path.join(here, "controls.json"), "utf8"));
  const ignore = JSON.parse(readFileSync(path.join(here, "ignore-list.json"), "utf8"));
  const inventory = JSON.parse(readFileSync(path.join(here, "button-inventory.json"), "utf8"));
  return { controls, ignore, inventory };
}

function viewMatches(entryView, controlView) {
  if (!entryView || entryView === "*") return true;
  if (entryView === controlView) return true;
  // chrome controls are present in every view; allow a chrome entry to match a
  // control discovered under "chrome".
  return false;
}

function controlHasClass(control, classContains) {
  if (!classContains) return false;
  const classes = control.classes || [];
  return classes.includes(classContains) || control.compClass === classContains || classes.some((c) => c === classContains);
}

function matchEntry(control, entries) {
  return entries.find((e) => viewMatches(e.match?.view ?? e.view, control.view) && controlHasClass(control, e.match?.classContains));
}

/** The coverage ratchet: discovered-enabled ⊆ registry ∪ ignore, else FAIL. */
export function coverageClosure({ controls, ignore, inventory }) {
  const enabled = (inventory.controls || []).filter((c) => !c.disabled && c.role !== "(unreachable)");
  const unmapped = [];
  for (const c of enabled) {
    if (matchEntry(c, controls.controls)) continue;
    if (matchEntry(c, ignore.ignored)) continue;
    unmapped.push({ id: c.id, view: c.view, name: c.name, classes: c.classes, needs_stable_hook: !c.stableHook });
  }
  return {
    enabled: enabled.length,
    registered: controls.controls.length,
    ignored: ignore.ignored.length,
    unmapped,
    ok: unmapped.length === 0,
  };
}

/** Substitute {board}/{id}/{node}/{feature}/{name} placeholders in an api path. */
export function fillPath(template, vars) {
  return String(template).replace(/\{(\w+)\}/g, (_, k) => encodeURIComponent(vars[k] ?? "x"));
}

/**
 * 2-axis role-denial oracle for a control whose allowed_roles[role] is
 * "forbidden" or "hidden_or_disabled". Returns { ok, ui, api, detail }.
 *  - UI axis  : every matching control in the role's SPA is hidden OR disabled.
 *  - API axis : a direct request to expected_network returns 403 (locked).
 * `page` is a puppeteer Page already authenticated as `role`; `apiCall` issues a
 * direct request with the role's cookie/csrf (returns { status }).
 */
export async function assertRoleDenied({ page, control, expectation, apiCall, vars }) {
  // UI axis.
  const cls = control.match?.classContains;
  const ui = await page.evaluate((c) => {
    const els = Array.from(document.querySelectorAll(`[class~="${c}"], .${c}`));
    if (els.length === 0) return { hidden: true, count: 0 }; // not rendered = hidden
    const allBlocked = els.every((el) => {
      const r = el.getBoundingClientRect();
      const invisible = r.width === 0 || r.height === 0 || getComputedStyle(el).display === "none" || getComputedStyle(el).visibility === "hidden";
      const disabled = Boolean(el.disabled) || el.getAttribute("aria-disabled") === "true";
      return invisible || disabled;
    });
    return { hidden: allBlocked, count: els.length };
  }, cls);

  // API axis (backdoor): only meaningful for controls with a mutation endpoint.
  let api = { status: null, locked: null };
  if (control.expected_network && control.expected_network.method !== "GET") {
    const net = control.expected_network;
    const res = await apiCall(net.method, fillPath(net.path, vars), { mutation: true });
    api = { status: res.status, locked: res.status === 403 };
  } else {
    api = { status: null, locked: true, note: "no mutation endpoint (UI-only denial)" };
  }

  const expected = expectation; // "forbidden" | "hidden_or_disabled"
  const uiOk = ui.hidden === true;
  const apiOk = api.locked === true || (expected === "hidden_or_disabled" && api.status === null);
  return { ok: uiOk && apiOk, ui, api, detail: `ui.hidden=${ui.hidden}(${ui.count}) api=${api.status}` };
}
