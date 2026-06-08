import { useSyncExternalStore } from "react";

/**
 * Terminal node→grid drag-and-drop coordination + a pointer-based drag controller.
 *
 * The drag uses **Pointer Events** (not native HTML5 DnD) so it works uniformly
 * for mouse, touch, and pen — native HTML5 DnD never fires for touch input. The
 * controller lives here (a single source of truth) so NodeList (drag source) and
 * TerminalGrid (drop target, an app.tsx sibling) stay decoupled:
 *
 *   - NodeList calls `startPointerDrag()` on pointerdown of a draggable node.
 *   - The controller arms; once the pointer moves past a threshold it begins the
 *     drag (sets `draggingNode` → React renders the drop zones once), spawns a
 *     floating ghost, and on each move imperatively follows the pointer + marks
 *     the nearest drop zone `.is-over` (pure DOM — no React re-render, so the
 *     xterm cells never thrash mid-drag).
 *   - TerminalGrid registers a commit handler via `registerCommit()`; on
 *     pointerup over a zone the controller calls it with the zone's data-dropkey.
 *
 * Snapshot state (low-frequency, drives React) is only {gridMounted, activeNodes,
 * draggingNode}; the ghost position + hover highlight are DOM-only.
 */
interface TermDndState {
  gridMounted: boolean;
  activeNodes: string[];
  draggingNode: string | null;
  // When the active drag is a CELL reorder (cellbar drag), the cell being moved;
  // null for a node-list "add" drag. Lets the grid gate drop zones + dim the cell.
  moving: MoveRef | null;
}
interface MoveRef {
  rowId: string;
  cellId: string;
}

let state: TermDndState = { gridMounted: false, activeNodes: [], draggingNode: null, moving: null };
const listeners = new Set<() => void>();

function sameNames(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function set(patch: Partial<TermDndState>): void {
  const next = { ...state, ...patch };
  if (
    next.gridMounted === state.gridMounted &&
    next.draggingNode === state.draggingNode &&
    next.moving === state.moving &&
    sameNames(next.activeNodes, state.activeNodes)
  ) {
    return; // no real change -> keep snapshot ref stable (no re-render)
  }
  state = next;
  listeners.forEach((l) => l());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

// --- pointer drag controller -------------------------------------------------
type CommitFn = (dropKey: string, node: string, move: MoveRef | null) => void;
let commitFn: CommitFn | null = null;

interface DragSession {
  node: string;
  pointerId: number;
  startX: number;
  startY: number;
  started: boolean;
  ghost: HTMLDivElement | null;
  overEl: HTMLElement | null;
  overKey: string | null;
  move: MoveRef | null;
}
let drag: DragSession | null = null;
const DRAG_THRESHOLD = 6; // px before a press becomes a drag (vs a tap/select)

function clearOver(): void {
  if (drag?.overEl) drag.overEl.classList.remove("is-over");
  if (drag) {
    drag.overEl = null;
    drag.overKey = null;
  }
}

// Pick the drop zone nearest the pointer while it is over the grid area. Forgiving
// for both mouse and (fat-finger) touch — you drop near where you want it.
function updateTarget(x: number, y: number): void {
  if (!drag) return;
  const area = document.querySelector<HTMLElement>(".dr-termgrid__rows, .dr-termgrid__empty");
  if (!area) {
    clearOver();
    return;
  }
  const ar = area.getBoundingClientRect();
  const within = x >= ar.left && x <= ar.right && y >= ar.top && y <= ar.bottom;
  if (!within) {
    clearOver();
    return;
  }
  const zones = Array.from(document.querySelectorAll<HTMLElement>(".dr-termgrid [data-dropkey]"));
  let best: HTMLElement | null = null;
  let bestD = Infinity;
  for (const z of zones) {
    const r = z.getBoundingClientRect();
    const d = Math.hypot((r.left + r.right) / 2 - x, (r.top + r.bottom) / 2 - y);
    if (d < bestD) {
      bestD = d;
      best = z;
    }
  }
  if (!best) {
    clearOver();
  } else if (best !== drag.overEl) {
    clearOver();
    drag.overEl = best;
    drag.overKey = best.dataset.dropkey ?? null;
    best.classList.add("is-over");
  }
}

function onMove(e: PointerEvent): void {
  if (!drag || e.pointerId !== drag.pointerId) return;
  const x = e.clientX;
  const y = e.clientY;
  if (!drag.started) {
    if (Math.hypot(x - drag.startX, y - drag.startY) < DRAG_THRESHOLD) return;
    drag.started = true;
    set({ draggingNode: drag.node, moving: drag.move }); // -> grid renders drop zones
    const g = document.createElement("div");
    g.className = "dr-drag-ghost";
    g.textContent = drag.node;
    document.body.appendChild(g);
    drag.ghost = g;
  }
  e.preventDefault(); // once dragging, suppress scroll/text-selection
  if (drag.ghost) drag.ghost.style.transform = `translate(${x + 12}px, ${y + 12}px)`;
  updateTarget(x, y);
}

function teardown(): void {
  window.removeEventListener("pointermove", onMove);
  window.removeEventListener("pointerup", onUp);
  window.removeEventListener("pointercancel", onCancel);
  window.removeEventListener("keydown", onKey);
}

function finish(commit: boolean): void {
  teardown();
  const d = drag;
  drag = null;
  if (!d) return;
  if (commit && d.started && d.overKey && commitFn) commitFn(d.overKey, d.node, d.move);
  if (d.overEl) d.overEl.classList.remove("is-over");
  d.ghost?.remove();
  if (d.started) set({ draggingNode: null, moving: null });
}

function onUp(e: PointerEvent): void {
  if (drag && e.pointerId === drag.pointerId) finish(true);
}
function onCancel(e: PointerEvent): void {
  if (drag && e.pointerId === drag.pointerId) finish(false);
}
function onKey(e: KeyboardEvent): void {
  if (e.key === "Escape") finish(false);
}

export const termDnd = {
  setGridMounted(v: boolean): void {
    set(v ? { gridMounted: true } : { gridMounted: false, activeNodes: [], draggingNode: null, moving: null });
    if (!v) finish(false); // grid unmounted mid-drag -> cancel cleanly
  },
  setActiveNodes(names: string[]): void {
    set({ activeNodes: names });
  },
  registerCommit(fn: CommitFn | null): void {
    commitFn = fn;
  },
  // Begin a drag from a node (mouse/touch/pen). Arms first; the real drag only
  // starts once the pointer passes DRAG_THRESHOLD, so a plain tap stays a tap.
  startPointerDrag(
    node: string,
    clientX: number,
    clientY: number,
    pointerId: number,
    move: MoveRef | null = null,
  ): void {
    if (drag) finish(false);
    drag = {
      node,
      pointerId,
      startX: clientX,
      startY: clientY,
      started: false,
      ghost: null,
      overEl: null,
      overKey: null,
      move,
    };
    window.addEventListener("pointermove", onMove, { passive: false });
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
    window.addEventListener("keydown", onKey);
  },
};

export function useTermDnd(): TermDndState {
  return useSyncExternalStore(
    subscribe,
    () => state,
    () => state,
  );
}
