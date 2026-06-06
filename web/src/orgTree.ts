import type { GroveNode } from "./types";

export interface OrgTree<N extends GroveNode> {
  treeNodes: N[];
  serviceNodes: N[];
  roots: string[];
  names: string[];
  childrenOf: (name: string) => string[];
  rows: Array<{ node: N; depth: number }>;
}

export function isBgServiceNode(node: Pick<GroveNode, "kind">): boolean {
  return node.kind === "service";
}

export function buildOrgTree<N extends GroveNode>(
  nodes: N[],
  childrenMap: Record<string, string[]> = {},
  rootList: string[] = [],
): OrgTree<N> {
  const serviceNodes = nodes.filter(isBgServiceNode);
  const treeNodes = nodes.filter((node) => !isBgServiceNode(node));
  const byName = new Map(treeNodes.map((node) => [node.name, node]));

  const childrenByName = new Map<string, string[]>();
  for (const node of treeNodes) {
    const explicit = childrenMap[node.name] ?? node.children ?? [];
    const names = explicit.filter((child) => byName.has(child) && !isBgServiceNode(byName.get(child)!));
    if (names.length > 0) childrenByName.set(node.name, names);
  }
  for (const node of treeNodes) {
    const parent = node.parent ?? "";
    if (!parent || !byName.has(parent) || isBgServiceNode(node)) continue;
    const list = childrenByName.get(parent) ?? [];
    if (!list.includes(node.name)) {
      list.push(node.name);
      childrenByName.set(parent, list);
    }
  }

  const roots = rootList.filter((name) => byName.has(name));
  if (roots.length === 0) {
    for (const node of treeNodes) {
      const parent = node.parent ?? "";
      if (!parent || !byName.has(parent)) roots.push(node.name);
    }
  }

  const rows: Array<{ node: N; depth: number }> = [];
  const seen = new Set<string>();
  const childrenOf = (name: string): string[] => childrenByName.get(name) ?? [];
  const visit = (name: string, depth: number) => {
    const node = byName.get(name);
    if (!node || seen.has(name)) return;
    seen.add(name);
    rows.push({ node, depth });
    for (const child of childrenOf(name)) visit(child, depth + 1);
  };
  for (const root of roots) visit(root, 0);
  for (const node of treeNodes) visit(node.name, 0);

  return {
    treeNodes,
    serviceNodes,
    roots,
    names: treeNodes.map((node) => node.name),
    childrenOf,
    rows,
  };
}

export interface NodeListRow<N extends GroveNode> {
  node: N;
  depth: number;
  section: "tree" | "services";
}

/**
 * Ordered rows for the node list rail: the org tree (honoring the same
 * server-authoritative childrenMap/roots the OrgChart feeds buildOrgTree)
 * followed by background service nodes in their own flat section. Passing the
 * server children/roots is what keeps the list's indentation in lockstep with
 * the org chart — omitting them falls back to raw parent pointers and diverges.
 */
export function buildNodeListRows<N extends GroveNode>(
  nodes: N[],
  childrenMap: Record<string, string[]> = {},
  roots: string[] = [],
): Array<NodeListRow<N>> {
  const tree = buildOrgTree(nodes, childrenMap, roots);
  return [
    ...tree.rows.map((row) => ({ ...row, section: "tree" as const })),
    ...tree.serviceNodes.map((node) => ({ node, depth: 0, section: "services" as const })),
  ];
}
