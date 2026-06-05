import type { GroveNode } from "./types";

const NON_LIVE_STATUSES = new Set(["dead", "error", "stale"]);

export function isLiveNode(node: Pick<GroveNode, "status" | "terminal_allowed" | "tmux_pane">): boolean {
  const status = node.status.trim().toLowerCase();
  return node.terminal_allowed !== false && Boolean(node.tmux_pane) && !NON_LIVE_STATUSES.has(status);
}

export function liveNodeCount(nodes: GroveNode[]): number {
  return nodes.filter(isLiveNode).length;
}
