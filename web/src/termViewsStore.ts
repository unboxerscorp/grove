import { useSyncExternalStore } from "react";

/**
 * Cross-component coordination slice for the terminal node→grid drag-and-drop.
 *
 * The full view/tab/persistence state lives in TerminalGrid's own useState — this
 * module only carries the small bits NodeList (the drag SOURCE, an app.tsx sibling
 * of TerminalGrid) needs to read, plus the in-flight drag identity both sides
 * read. Keeping it a tiny external store (useSyncExternalStore) means NodeList ↔
 * TerminalGrid share it without lifting state into app.tsx.
 *
 *   gridMounted  — true only while the terminal grid is mounted (terminal view
 *                  active); NodeList shows drag affordance only then.
 *   activeNodes  — node names present in the ACTIVE view; NodeList dims/locks these
 *                  (a node already in the current view is not draggable).
 *   draggingNode — the node name currently being dragged (set by NodeList on
 *                  dragstart, cleared on dragend); TerminalGrid reads it to render
 *                  drop zones + validity during dragover (dataTransfer is not
 *                  readable during dragover, only on drop).
 */
interface TermDndState {
  gridMounted: boolean;
  activeNodes: string[];
  draggingNode: string | null;
}

let state: TermDndState = { gridMounted: false, activeNodes: [], draggingNode: null };
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
    sameNames(next.activeNodes, state.activeNodes)
  ) {
    return; // no real change -> keep the snapshot ref stable (no re-render)
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

export const termDnd = {
  setGridMounted(v: boolean): void {
    // Leaving the terminal view also clears the published active set + any drag.
    set(v ? { gridMounted: true } : { gridMounted: false, activeNodes: [], draggingNode: null });
  },
  setActiveNodes(names: string[]): void {
    set({ activeNodes: names });
  },
  setDragging(node: string | null): void {
    set({ draggingNode: node });
  },
};

export function useTermDnd(): TermDndState {
  return useSyncExternalStore(subscribe, () => state, () => state);
}
