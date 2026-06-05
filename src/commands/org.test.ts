import { describe, expect, test } from "vitest";

import type { AgentAdapter } from "../adapters/types.js";
import { GroveConfigSchema, type ResolvedNode, resolveNodes } from "../config.js";
import type { Context, NodeCtx } from "../context.js";
import type { NodeRuntime } from "../registry.js";
import { buildOrg, renderOrgJson, renderOrgText } from "./org.js";

function adapter(agent: ResolvedNode["agent"]): AgentAdapter {
  return {
    name: agent,
    label: agent,
    submit: "enter",
    readyPattern: /ready/,
    launchCommand: () => agent,
    transcriptForSession: () => "",
    snapshot: () => new Map<string, number>(),
    detectNew: () => null,
    sessionIdFromPath: () => null,
    size: () => 0,
    readCompletionSince: () => ({ done: false, offset: 0 }),
    readLast: () => null,
  };
}

function makeContext(runtimeNodes: Record<string, NodeRuntime>): Context {
  const nodes: ResolvedNode[] = [
    {
      agent: "claude",
      children: ["maker"],
      cwd: "/tmp/grove",
      description: "Coordinates the team",
      group: "core",
      name: "lead",
      role: "Lead",
    },
    {
      agent: "codex",
      children: [],
      cwd: "/tmp/grove",
      description: "Builds TypeScript changes",
      group: "core",
      name: "maker",
      parent: "lead",
      role: "Builder",
    },
    {
      agent: "antigravity",
      children: [],
      cwd: "/tmp/grove",
      group: "observability",
      name: "viewer",
      role: "Viewer",
    },
  ];
  const byName = new Map<string, NodeCtx>();
  for (const node of nodes) {
    byName.set(node.name, {
      node,
      adapter: adapter(node.agent),
      addr: `dev10:${node.name}`,
    });
  }
  return {
    byName,
    config: {
      cwd: "/tmp/grove",
      defaults: { agent: "codex" },
      nodes: {
        lead: {
          agent: "claude",
          children: ["maker"],
          description: "Coordinates the team",
          group: "core",
          role: "Lead",
        },
        maker: {
          agent: "codex",
          children: [],
          description: "Builds TypeScript changes",
          group: "core",
          parent: "lead",
          role: "Builder",
        },
        viewer: {
          agent: "antigravity",
          children: [],
          group: "observability",
          role: "Viewer",
        },
      },
      session: "dev10",
    },
    configPath: "/tmp/grove/grove.yaml",
    nodes,
    registry: {
      cwd: "/tmp/grove",
      nodes: runtimeNodes,
      session: "dev10",
      updatedAt: "2026-06-03T00:00:00.000Z",
    },
  };
}

describe("team graph config", () => {
  test("round-trips parent, children, role, and group through config resolution", () => {
    const config = GroveConfigSchema.parse({
      cwd: "/tmp/grove",
      nodes: {
        lead: {
          agent: "claude",
          children: ["maker"],
          description: "Coordinates the team",
          group: "core",
          role: "Lead",
        },
        maker: {
          agent: "codex",
          description: "Builds TypeScript changes",
          group: "core",
          role: "Builder",
        },
      },
      session: "dev10",
    });

    expect(resolveNodes(config)).toEqual([
      expect.objectContaining({
        children: ["maker"],
        description: "Coordinates the team",
        group: "core",
        name: "lead",
        role: "Lead",
      }),
      expect.objectContaining({
        children: [],
        group: "core",
        name: "maker",
        parent: "lead",
        role: "Builder",
      }),
    ]);
  });
});

describe("org rendering", () => {
  test("renders a text hierarchy and grouped membership from registry team fields", () => {
    const ctx = makeContext({
      lead: {
        agent: "claude",
        children: ["maker"],
        description: "Coordinates the team",
        group: "core",
        name: "lead",
        role: "Lead",
      },
      maker: {
        agent: "codex",
        children: [],
        description: "Builds TypeScript changes",
        group: "core",
        name: "maker",
        parent: "lead",
        role: "Builder",
      },
      viewer: {
        agent: "antigravity",
        children: [],
        group: "observability",
        name: "viewer",
        role: "Viewer",
      },
    });

    expect(renderOrgText(buildOrg(ctx, null))).toBe(
      [
        "dev10",
        "grove-master [codex] GROVE MASTER — governs all projects; project leads are children",
        "  lead [claude] Lead",
        "    cwd: /tmp/grove",
        "    description: Coordinates the team",
        "    maker [codex] Builder",
        "      cwd: /tmp/grove",
        "      description: Builds TypeScript changes",
        "    viewer [antigravity] Viewer",
        "      cwd: /tmp/grove",
        "",
        "groups",
        "master: grove-master",
        "core: lead, maker",
        "observability: viewer",
      ].join("\n"),
    );
  });

  test("emits stable JSON and derives children from parent links", () => {
    const ctx = makeContext({
      lead: {
        agent: "claude",
        children: [],
        description: "Coordinates the team",
        group: "core",
        name: "lead",
        role: "Lead",
      },
      maker: {
        agent: "codex",
        children: [],
        description: "Builds TypeScript changes",
        group: "core",
        name: "maker",
        parent: "lead",
        role: "Builder",
      },
    });

    const org = buildOrg(ctx, null);

    expect(JSON.parse(renderOrgJson(org))).toEqual({
      groups: { master: ["grove-master"], core: ["lead", "maker"] },
      nodes: [
        {
          agent: "codex",
          children: ["lead"],
          cwd: "",
          group: "master",
          name: "grove-master",
          parent: "",
          role: "GROVE MASTER — governs all projects; project leads are children",
          session_id: "",
          status: "",
          tmux_pane: "",
        },
        {
          agent: "claude",
          children: ["maker"],
          cwd: "/tmp/grove",
          description: "Coordinates the team",
          group: "core",
          name: "lead",
          parent: "grove-master",
          role: "Lead",
          session_id: "",
          status: "",
          tmux_pane: "",
        },
        {
          agent: "codex",
          children: [],
          cwd: "/tmp/grove",
          description: "Builds TypeScript changes",
          group: "core",
          name: "maker",
          parent: "lead",
          role: "Builder",
          session_id: "",
          status: "",
          tmux_pane: "",
        },
      ],
      roots: ["grove-master"],
      session: "dev10",
    });
  });

  test("exposes runtime cwd, tmux pane, status, and session id", () => {
    const ctx = makeContext({
      lead: {
        agent: "claude",
        children: ["maker"],
        cwd: "/repo/dev10",
        group: "core",
        name: "lead",
        role: "Lead",
        sessionId: "lead-session",
        status: "active",
        tmux_pane: "dev10:1.0",
      },
      maker: {
        agent: "codex",
        children: [],
        cwd: "/repo/dev10/packages/app",
        group: "core",
        name: "maker",
        parent: "lead",
        role: "Builder",
        sessionId: "maker-session",
        status: "running",
        tmux_pane: "dev10:1.1",
      },
    });

    const org = buildOrg(ctx, null);
    const parsed = JSON.parse(renderOrgJson(org)) as { nodes: OrgJsonNode[] };
    const nodes = new Map(parsed.nodes.map((node) => [node.name, node]));
    const text = renderOrgText(org);

    expect(nodes.get("lead")).toEqual(
      expect.objectContaining({
        cwd: "/repo/dev10",
        session_id: "lead-session",
        status: "active",
        tmux_pane: "dev10:1.0",
      }),
    );
    expect(nodes.get("maker")).toEqual(
      expect.objectContaining({
        cwd: "/repo/dev10/packages/app",
        session_id: "maker-session",
        status: "running",
        tmux_pane: "dev10:1.1",
      }),
    );
    expect(text).toContain("pane: dev10:1.0");
    expect(text).toContain("cwd: /repo/dev10");
    expect(text).toContain("pane: dev10:1.1");
    expect(text).toContain("cwd: /repo/dev10/packages/app");
  });
});

type OrgJsonNode = {
  name: string;
};
