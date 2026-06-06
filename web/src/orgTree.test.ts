import { describe, expect, it } from "vitest";

import { buildNodeListRows } from "./orgTree";
import type { GroveNode } from "./types";

function node(name: string, parent: string | null = null): GroveNode {
  return { name, agent: "claude", tmux_pane: `p:${name}`, session_id: "", status: "running", parent };
}

function service(name: string, parent: string | null = null): GroveNode {
  return { ...node(name, parent), kind: "service" };
}

describe("buildNodeListRows", () => {
  // The node list must nest by the SAME server-authoritative children/roots the
  // org chart uses (OrgChart calls buildOrgTree(nodes, childrenMap, rootList)),
  // not by raw parent pointers — otherwise the two views diverge (task_2149).
  it("nests by server children/roots so the order/depth matches the org chart", () => {
    const nodes = [node("A"), node("B", "A"), node("C", "A")];
    // Server says C lives UNDER B (depth 2), even though C.parent === "A".
    const childrenMap = { A: ["B"], B: ["C"] };
    const roots = ["A"];

    const rows = buildNodeListRows(nodes, childrenMap, roots);

    expect(rows.map((r) => [r.node.name, r.depth, r.section])).toEqual([
      ["A", 0, "tree"],
      ["B", 1, "tree"],
      ["C", 2, "tree"],
    ]);
  });

  // Reproduces the bug: without the server children/roots the same nodes fall
  // back to parent-pointer depth, so C sits at depth 1 — diverging from the
  // org chart's depth 2 above. Passing the inputs is what fixes the divergence.
  it("diverges from the org chart when server children/roots are omitted (parent-only)", () => {
    const nodes = [node("A"), node("B", "A"), node("C", "A")];

    const rows = buildNodeListRows(nodes);

    expect(rows.map((r) => [r.node.name, r.depth])).toEqual([
      ["A", 0],
      ["B", 1],
      ["C", 1],
    ]);
  });

  // Background service nodes are pulled out of the tree into a separate
  // services section at depth 0 (the d91f015 "separate bg services" contract),
  // regardless of where the server tree would otherwise place them.
  it("lists background service nodes in a separate services section at depth 0", () => {
    const nodes = [node("A"), service("web", "A")];

    const rows = buildNodeListRows(nodes, { A: ["web"] }, ["A"]);

    expect(rows.map((r) => [r.node.name, r.depth, r.section])).toEqual([
      ["A", 0, "tree"],
      ["web", 0, "services"],
    ]);
  });
});
