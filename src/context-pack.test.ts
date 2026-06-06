import { describe, expect, test } from "vitest";

import {
  buildCompactGroveContextPack,
  buildGroveContextPack,
  collapseForeignProjects,
  type ContextPackNode,
  contextPackNodesFromContext,
  GROVE_CONTEXT_PACK_HEADER,
  prependGroveContextPack,
  resolveContextMode,
} from "./context-pack.js";

describe("buildGroveContextPack", () => {
  test("renders bounded redacted context for grove dispatches", () => {
    const pack = buildGroveContextPack({
      callerNode: "orch-master",
      maxBytes: 1_200,
      nodes: [
        {
          agent: "codex",
          cwd: "/repo/dev10",
          name: "lead",
          parent: "grove-master",
          role: "Project lead token=xoxb-secret dev10:1.2",
          tmuxPane: "dev10:1.2",
        },
        {
          agent: "codex",
          cwd: "/repo/dev10",
          group: "product",
          name: "maker",
          parent: "lead",
          role: "Implementation maker",
          tmuxPane: "dev10:1.3",
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
    expect(pack).toContain("pane=dev10:1.3");
    expect(pack).toContain("cwd=/repo/dev10");
    expect(pack).toContain("Human-facing list items are for human TODO");
    expect(pack).not.toContain("Board tasks are");
    expect(pack).not.toContain("xoxb-secret");
    expect(pack).toContain("dev10:1.2");
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
            cwd: "/repo",
            group: "review",
            name: "reviewer",
            parent: "lead",
            role: "Reviewer",
            tmux_pane: "dev10:2.0",
          },
        },
        session: "dev10",
        updatedAt: "2026-06-05T00:00:00.000Z",
      },
    });

    expect(nodes.map((node) => node.name)).toEqual(["maker", "reviewer"]);
  });

  test("carries work_instructions from a runtime node into the pack node", () => {
    const nodes = contextPackNodesFromContext({
      byName: new Map(),
      config: {
        cwd: "/repo",
        defaults: { agent: "codex" },
        nodes: {},
        session: "dev10",
      },
      configPath: "/repo/grove.yaml",
      nodes: [],
      registry: {
        cwd: "/repo",
        nodes: {
          maker: {
            agent: "codex",
            cwd: "/repo",
            name: "maker",
            parent: "lead",
            role: "Maker",
            work_instructions: "PR 머지 전 reviewer 승인 필수",
          },
        },
        session: "dev10",
        updatedAt: "2026-06-06T00:00:00.000Z",
      },
    });

    expect(nodes[0]?.workInstructions).toBe("PR 머지 전 reviewer 승인 필수");
  });
});

// The advisory work-instructions (작업지침) field. This block locks the
// behavior the advisor asked us to guarantee: byte-identical output when the
// field is unset, byte parity with the Python renderer when it is set, secret
// redaction, and a hard length cap. The PARITY_* fixtures below are duplicated
// verbatim in bridge/tests/test_context_pack.py — the two renderers MUST emit
// identical bytes for identical input or a node would receive a different
// prompt depending on the dispatch path (TS vs Python).
const PARITY_WORK_INSTRUCTIONS = "PR 머지 전 reviewer 승인 필수\n  여러 줄 가능";
const PARITY_PACK = [
  "GROVE CONTEXT PACK",
  "Caller node: lead",
  "Project: dev10",
  "Project lead: lead",
  "Target node: maker",
  "Target role: Builder",
  "Target work instructions (advisory): PR 머지 전 reviewer 승인 필수 여러 줄 가능",
  "Communication protocol: direct comms",
  "Visible org summary:",
  "- lead -> maker (codex; group=product; pane=dev10:1.3; cwd=/repo; role=Builder; work_instructions=PR 머지 전 reviewer 승인 필수)",
].join("\n");

describe("buildGroveContextPack work_instructions", () => {
  function maker(workInstructions?: string): ContextPackNode {
    return {
      agent: "codex",
      cwd: "/repo",
      group: "product",
      name: "maker",
      parent: "lead",
      role: "Builder",
      tmuxPane: "dev10:1.3",
      workInstructions,
    };
  }

  test("renders the advisory line + compact summary, byte-identical to the Python renderer", () => {
    const pack = buildGroveContextPack({
      callerNode: "lead",
      communicationProtocol: "direct comms",
      nodes: [maker(PARITY_WORK_INSTRUCTIONS)],
      project: "dev10",
      projectLead: "lead",
      targetNode: "maker",
      targetRole: "Builder",
      targetWorkInstructions: PARITY_WORK_INSTRUCTIONS,
    });

    expect(pack).toBe(PARITY_PACK);
  });

  test("is byte-identical to the un-instructed pack when work_instructions is unset", () => {
    const pack = buildGroveContextPack({
      callerNode: "lead",
      communicationProtocol: "direct comms",
      nodes: [maker()],
      project: "dev10",
      projectLead: "lead",
      targetNode: "maker",
      targetRole: "Builder",
    });

    expect(pack).not.toContain("work_instructions");
    expect(pack).not.toContain("(advisory)");
    expect(pack).toBe(
      [
        "GROVE CONTEXT PACK",
        "Caller node: lead",
        "Project: dev10",
        "Project lead: lead",
        "Target node: maker",
        "Target role: Builder",
        "Communication protocol: direct comms",
        "Visible org summary:",
        "- lead -> maker (codex; group=product; pane=dev10:1.3; cwd=/repo; role=Builder)",
      ].join("\n"),
    );
  });

  test("redacts secrets that appear inside work instructions", () => {
    const pack = buildGroveContextPack({
      project: "dev10",
      targetNode: "maker",
      targetWorkInstructions: "deploy with token=xoxb-deadbeef now",
    });

    expect(pack).not.toContain("xoxb-deadbeef");
    expect(pack).toContain("token=[redacted]");
  });

  test("caps pathologically long work instructions in the advisory line", () => {
    const pack = buildGroveContextPack({
      project: "dev10",
      targetNode: "maker",
      targetWorkInstructions: "a".repeat(600),
    });

    expect(pack).toContain(`Target work instructions (advisory): ${"a".repeat(500)}…`);
    expect(pack).not.toContain("a".repeat(501));
  });
});

// task_dd4: collapse OTHER projects to their lead node only in the visible org.
// Collapse is node-SELECTION, applied upstream of the renderer, so the locked
// renderer + PARITY fixtures stay byte-identical. The fixture + expected
// selection below are mirrored verbatim in bridge/tests/test_context_pack.py —
// the TS and Python filters MUST select the same nodes for the same input.
function cn(name: string, project: string, extra: Partial<ContextPackNode> = {}): ContextPackNode {
  return { agent: "claude", name, project, ...extra };
}

// Mixed multi-project org: home (dev10), shared control plane, and three foreign
// projects (alpha has a "lead"; delta has a root "delta-lead"; beta has none).
const COLLAPSE_FIXTURE: ContextPackNode[] = [
  cn("lead", "dev10"),
  cn("org-worker", "dev10", { parent: "lead" }),
  cn("grove-master", "control", { group: "master" }),
  cn("web", "control", { group: "services" }),
  cn("advisor", "control"),
  cn("lead", "alpha"),
  cn("alpha-worker", "alpha", { parent: "lead" }),
  cn("delta-lead", "delta"),
  cn("delta-worker", "delta", { parent: "delta-lead" }),
  cn("beta-worker", "beta"),
];
const COLLAPSE_EXPECTED = [
  "dev10/lead",
  "dev10/org-worker",
  "control/grove-master",
  "control/web",
  "control/advisor",
  "alpha/lead",
  "delta/delta-lead",
];

describe("collapseForeignProjects", () => {
  test("keeps every node unchanged when none are foreign (single-project no-op)", () => {
    const nodes = [cn("lead", "dev10"), cn("org-worker", "dev10", { parent: "lead" })];

    expect(collapseForeignProjects(nodes, "dev10")).toEqual(nodes);
  });

  test("treats nodes without a project as home (legacy single-project packs)", () => {
    const nodes: ContextPackNode[] = [
      { agent: "claude", name: "lead" },
      { agent: "claude", name: "maker" },
    ];

    expect(collapseForeignProjects(nodes, "dev10")).toEqual(nodes);
  });

  test("collapses foreign projects to their lead, keeps home + infra, drops lead-less foreign", () => {
    const result = collapseForeignProjects(COLLAPSE_FIXTURE, "dev10");

    expect(result.map((node) => `${node.project ?? ""}/${node.name}`)).toEqual(COLLAPSE_EXPECTED);
  });

  test("preserves the input order of the surviving nodes", () => {
    const result = collapseForeignProjects(COLLAPSE_FIXTURE, "dev10");
    const survivors = COLLAPSE_FIXTURE.filter((node) =>
      COLLAPSE_EXPECTED.includes(`${node.project ?? ""}/${node.name}`),
    );

    expect(result).toEqual(survivors);
  });

  test("the project field is render-inert — it never appears in the pack output", () => {
    const pack = buildGroveContextPack({
      callerNode: "lead",
      communicationProtocol: "direct comms",
      nodes: [
        {
          agent: "codex",
          cwd: "/repo",
          group: "product",
          name: "maker",
          parent: "lead",
          project: "dev10",
          role: "Builder",
          tmuxPane: "dev10:1.3",
        },
      ],
      project: "dev10",
      projectLead: "lead",
      targetNode: "maker",
      targetRole: "Builder",
    });

    expect(pack).not.toContain("project=");
    expect(pack).toBe(
      [
        "GROVE CONTEXT PACK",
        "Caller node: lead",
        "Project: dev10",
        "Project lead: lead",
        "Target node: maker",
        "Target role: Builder",
        "Communication protocol: direct comms",
        "Visible org summary:",
        "- lead -> maker (codex; group=product; pane=dev10:1.3; cwd=/repo; role=Builder)",
      ].join("\n"),
    );
  });
});

// Compact node-to-node pack (token-saving default for `grove send`/`grove ask`).
// COMPACT_PARITY_PACK is duplicated verbatim in bridge/tests/test_context_pack.py
// — the TS and Python compact builders MUST emit identical bytes for identical
// input, exactly like the full PARITY_PACK above.
const COMPACT_PARITY_WORK_INSTRUCTIONS = "PR 머지 전 reviewer 승인 필수\n  여러 줄 가능";
const COMPACT_PARITY_PACK = [
  "GROVE CONTEXT PACK (compact)",
  "Caller node: lead",
  "Project: dev10",
  "Target node: maker",
  "Target role: Builder",
  "Target work instructions (advisory): PR 머지 전 reviewer 승인 필수",
  "Visible org: 3 nodes — run `grove org --json` for the full tree; `grove task mine` for your tasks.",
].join("\n");

describe("buildCompactGroveContextPack", () => {
  function node(name: string): ContextPackNode {
    return { agent: "claude", name };
  }

  test("renders the compact pack, byte-identical to the Python renderer", () => {
    const pack = buildCompactGroveContextPack({
      callerNode: "lead",
      nodes: [node("lead"), node("maker"), node("reviewer")],
      project: "dev10",
      projectLead: "lead",
      targetNode: "maker",
      targetRole: "Builder",
      targetWorkInstructions: COMPACT_PARITY_WORK_INSTRUCTIONS,
    });

    expect(pack).toBe(COMPACT_PARITY_PACK);
  });

  test("starts with the GROVE CONTEXT PACK header so the no-duplicate-prepend guard still applies", () => {
    const pack = buildCompactGroveContextPack({
      nodes: [node("lead")],
      project: "dev10",
      targetNode: "maker",
    });

    expect(pack.startsWith(GROVE_CONTEXT_PACK_HEADER)).toBe(true);
  });

  test("omits role/work-instructions lines when unset and singularizes the node count", () => {
    const pack = buildCompactGroveContextPack({
      callerNode: "lead",
      nodes: [node("lead")],
      project: "dev10",
      targetNode: "maker",
    });

    expect(pack).not.toContain("Target role:");
    expect(pack).not.toContain("(advisory)");
    expect(pack).toContain("Visible org: 1 node — run `grove org --json`");
  });

  test("redacts secrets in the compact pack too", () => {
    const pack = buildCompactGroveContextPack({
      nodes: [node("lead")],
      project: "dev10",
      targetNode: "maker",
      targetWorkInstructions: "deploy token=xoxb-deadbeef now",
    });

    expect(pack).not.toContain("xoxb-deadbeef");
    expect(pack).toContain("token=[redacted]");
  });
});

describe("resolveContextMode", () => {
  const ENV = "GROVE_CONTEXT_MODE";
  function withEnv(value: string | undefined, fn: () => void): void {
    const prev = process.env[ENV];
    if (value === undefined) delete process.env[ENV];
    else process.env[ENV] = value;
    try {
      fn();
    } finally {
      if (prev === undefined) delete process.env[ENV];
      else process.env[ENV] = prev;
    }
  }

  test("explicit flag wins over env and fallback", () => {
    withEnv("compact", () => {
      expect(resolveContextMode("full", "compact")).toBe("full");
    });
  });

  test("env overrides the fallback when no explicit flag", () => {
    withEnv("none", () => {
      expect(resolveContextMode(undefined, "compact")).toBe("none");
    });
  });

  test("falls back when neither flag nor env is a valid mode", () => {
    withEnv("bogus", () => {
      expect(resolveContextMode("nonsense", "compact")).toBe("compact");
    });
    withEnv(undefined, () => {
      expect(resolveContextMode(undefined, "full")).toBe("full");
    });
  });
});
