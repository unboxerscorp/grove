import { describe, expect, test } from "vitest";

import {
  buildGroveContextPack,
  contextPackNodesFromContext,
  GROVE_CONTEXT_PACK_HEADER,
  prependGroveContextPack,
} from "./context-pack.js";

describe("buildGroveContextPack", () => {
  test("renders bounded redacted context for grove dispatches", () => {
    const pack = buildGroveContextPack({
      callerNode: "orch-master",
      maxBytes: 1_200,
      nodes: [
        {
          agent: "codex",
          name: "lead",
          parent: "grove-master",
          role: "Project lead token=xoxb-secret dev10:1.2",
        },
        {
          agent: "codex",
          group: "product",
          name: "maker",
          parent: "lead",
          role: "Implementation maker",
        },
      ],
      project: "dev10",
      projectLead: "lead",
      targetNode: "maker",
      targetRole: "Implementation maker",
    });

    expect(pack).toContain(GROVE_CONTEXT_PACK_HEADER);
    expect(pack).toContain("Caller node: orch-master");
    expect(pack).toContain("Project: dev10");
    expect(pack).toContain("Project lead: lead");
    expect(pack).toContain("Target node: maker");
    expect(pack).toContain("Target role: Implementation maker");
    expect(pack).toContain("lead -> maker");
    expect(pack).not.toContain("xoxb-secret");
    expect(pack).not.toContain("dev10:1.2");
    expect(Buffer.byteLength(pack, "utf8")).toBeLessThanOrEqual(1_200);
  });

  test("does not prepend twice", () => {
    const message = `${GROVE_CONTEXT_PACK_HEADER}\n\nOriginal message:\nhello`;

    expect(prependGroveContextPack(message, { project: "dev10" })).toBe(message);
  });

  test("includes registry-only visible nodes from a loaded context", () => {
    const nodes = contextPackNodesFromContext({
      byName: new Map(),
      config: {
        cwd: "/repo",
        defaults: { agent: "codex" },
        nodes: {
          maker: { agent: "codex", children: [], parent: "lead", role: "Maker" },
        },
        session: "dev10",
      },
      configPath: "/repo/grove.yaml",
      nodes: [
        {
          agent: "codex",
          children: [],
          cwd: "/repo",
          name: "maker",
          parent: "lead",
          role: "Maker",
        },
      ],
      registry: {
        cwd: "/repo",
        nodes: {
          reviewer: {
            agent: "codex",
            group: "review",
            name: "reviewer",
            parent: "lead",
            role: "Reviewer",
          },
        },
        session: "dev10",
        updatedAt: "2026-06-05T00:00:00.000Z",
      },
    });

    expect(nodes.map((node) => node.name)).toEqual(["maker", "reviewer"]);
  });
});
