import { describe, expect, test } from "vitest";

import {
  buildGroveContextPack,
  type ContextPackNode,
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
