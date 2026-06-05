import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";

import { antigravityAdapter } from "../adapters/antigravity.js";
import { claudeAdapter } from "../adapters/claude.js";
import { codexAdapter } from "../adapters/codex.js";
import type { AgentAdapter } from "../adapters/types.js";
import type { AgentType, ResolvedNode } from "../config.js";
import type { Context, NodeCtx } from "../context.js";
import type { Registry } from "../registry.js";
import { ROLE_PRESET_VERSION } from "../role-presets.js";
import { cmdSpawn, renderSpawnJson, renderSpawnText, type SpawnDeps, spawnNode } from "./spawn.js";

const cwdStack: string[] = [];

afterEach(() => {
  while (cwdStack.length > 0) {
    process.chdir(cwdStack.pop()!);
  }
  vi.restoreAllMocks();
});

function adapter(agent: AgentType): AgentAdapter {
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

function makeContext(registry: Registry): Context {
  const lead: ResolvedNode = {
    agent: "claude",
    children: [],
    cwd: "/repo",
    group: "core",
    name: "lead",
    role: "Lead",
  };
  return {
    byName: new Map([
      [
        "lead",
        {
          addr: "dev10:lead",
          adapter: adapter("claude"),
          node: lead,
        },
      ],
    ]),
    config: {
      cwd: "/repo",
      defaults: { agent: "codex" },
      nodes: { lead: { agent: "claude", children: [], group: "core", role: "Lead" } },
      session: "dev10",
    },
    configPath: "/repo/grove.yaml",
    nodes: [lead],
    registry,
  };
}

function registry(): Registry {
  return {
    cwd: "/repo",
    nodes: {
      lead: {
        agent: "claude",
        children: [],
        group: "core",
        name: "lead",
        role: "Lead",
      },
    },
    session: "dev10",
    updatedAt: "2026-06-03T00:00:00.000Z",
  };
}

function deps(opts: { bindTranscript?: boolean } = {}): {
  deps: SpawnDeps;
  guardSessions: string[];
  launched: NodeCtx[];
  paneRequests: Parameters<SpawnDeps["createPane"]>[0][];
  saves: number;
} {
  const guardSessions: string[] = [];
  const launched: NodeCtx[] = [];
  const paneRequests: Parameters<SpawnDeps["createPane"]>[0][] = [];
  let saves = 0;
  return {
    deps: {
      createPane: async (request) => {
        paneRequests.push(request);
        return "dev10:2.0";
      },
      getAdapter: (agent) => adapter(agent),
      launchNode: async (ctx, nc) => {
        launched.push(nc);
        ctx.registry.nodes[nc.node.name] = {
          agent: nc.node.agent,
          children: [],
          cwd: nc.node.cwd,
          description: nc.node.description,
          group: nc.node.group,
          name: nc.node.name,
          parent: nc.node.parent,
          role: nc.node.role,
          sessionId: opts.bindTranscript ? "session-new" : undefined,
          transcript: opts.bindTranscript ? "/repo/transcript.jsonl" : undefined,
        };
      },
      saveRegistry: () => {
        saves += 1;
      },
      preserveActiveWindow: async (session, fn) => {
        guardSessions.push(session);
        return fn();
      },
    },
    get saves() {
      return saves;
    },
    guardSessions,
    launched,
    paneRequests,
  };
}

describe("spawn agent launch commands", () => {
  test("keeps codex and claude on their existing TUI launch path and agy on -i", () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "grove-spawn-agy-test-"));
    try {
      expect(codexAdapter.launchCommand({ cwd, initialPrompt: "Role" })).toBe("codex");
      expect(claudeAdapter.launchCommand({ cwd, initialPrompt: "Role" })).toBe("claude");
      expect(codexAdapter.launchCommand({ cwd, model: "gpt;rm", resumeId: "abc$(x)" })).toBe(
        "codex resume 'abc$(x)'",
      );
      expect(claudeAdapter.launchCommand({ cwd, model: "sonnet;rm", resumeId: "abc$(x)" })).toBe(
        "claude --resume 'abc$(x)' --model 'sonnet;rm'",
      );
      expect(antigravityAdapter.launchCommand({ cwd, initialPrompt: "Role" })).toContain(
        "agy -i 'Role'",
      );
    } finally {
      rmSync(cwd, { force: true, recursive: true });
    }
  });
});

describe("spawnNode", () => {
  test("runs without grove.yaml when explicit spawn flags provide the node identity", async () => {
    const temp = mkdtempSync(path.join(tmpdir(), "grove-spawn-no-config-"));
    cwdStack.push(process.cwd());
    process.chdir(temp);
    const cwd = process.cwd();
    const state = deps({ bindTranscript: true });
    const writes: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
    });

    await expect(
      cmdSpawn(
        {
          agent: "claude",
          json: true,
          name: "probe",
          operator: true,
          role: "x",
          session: "spawn-no-config",
        },
        state.deps,
      ),
    ).resolves.not.toThrow();

    expect(state.paneRequests).toEqual([
      {
        cwd,
        name: "probe",
        session: "spawn-no-config",
        window: undefined,
      },
    ]);
    expect(JSON.parse(writes.join(""))).toEqual(
      expect.objectContaining({
        agent: "claude",
        name: "probe",
        pane: "dev10:2.0",
        role: "x",
        session: "spawn-no-config",
      }),
    );
    rmSync(temp, { force: true, recursive: true });
  });

  test("allows role to be omitted when name and agent are provided", async () => {
    const ctx = makeContext(registry());
    const state = deps();

    const result = await spawnNode(
      ctx,
      {
        agent: "codex",
        name: "probe",
        operatorManaged: true,
      },
      state.deps,
    );

    expect(state.launched[0]?.node.role).toBe("");
    expect(result.role).toBe("");
  });

  test("uses the target registry cwd when --cwd is omitted", async () => {
    const reg = registry();
    reg.cwd = "/project/workspace";
    const ctx = makeContext(reg);
    const state = deps();

    const result = await spawnNode(
      ctx,
      {
        agent: "codex",
        name: "workspace-maker",
        operatorManaged: true,
      },
      state.deps,
    );

    expect(state.paneRequests[0]?.cwd).toBe("/project/workspace");
    expect(state.launched[0]?.node.cwd).toBe("/project/workspace");
    expect(ctx.registry.nodes["workspace-maker"]?.cwd).toBe("/project/workspace");
    expect(result.cwd).toBe("/project/workspace");
  });

  test("uses explicit --cwd before registry cwd while preserving role preset expansion", async () => {
    const reg = registry();
    reg.cwd = "/project/workspace";
    const ctx = makeContext(reg);
    const state = deps({ bindTranscript: true });

    const result = await spawnNode(
      ctx,
      {
        agent: "codex",
        cwd: "/other/workspace",
        name: "explicit-maker",
        operatorManaged: true,
        rolePreset: "maker-py",
      },
      state.deps,
    );

    expect(state.paneRequests[0]?.cwd).toBe("/other/workspace");
    expect(state.launched[0]?.node.cwd).toBe("/other/workspace");
    expect(state.launched[0]?.node.role).toContain("너는 Python/backend maker이며");
    expect(ctx.registry.nodes["explicit-maker"]?.cwd).toBe("/other/workspace");
    expect(ctx.registry.nodes["explicit-maker"]?.rolePreset).toBe("maker-py");
    expect(result.cwd).toBe("/other/workspace");
    expect(result.rolePreset).toBe("maker-py");
  });

  test("expands role presets into the launch prompt and persists preset metadata", async () => {
    const ctx = makeContext(registry());
    const state = deps({ bindTranscript: true });

    const result = await spawnNode(
      ctx,
      {
        agent: "codex",
        name: "py-maker",
        operatorManaged: true,
        parent: "lead",
        rolePreset: "maker-py",
      },
      state.deps,
    );

    expect(state.launched[0]?.node.role).toContain(
      "너는 Python/backend maker이며 GROVE 조직/업무방식을 따른다",
    );
    expect(state.launched[0]?.node.role).toContain("노드 간 소통은 계층과 무관하게 직접 한다");
    expect(state.launched[0]?.node.role).toContain("사람이 명시 지시한 경우");
    const runtime = ctx.registry.nodes["py-maker"];
    expect(runtime?.role).toContain("너는 Python/backend maker이며");
    expect(runtime?.rolePreset).toBe("maker-py");
    expect(runtime?.rolePresetVersion).toBe(ROLE_PRESET_VERSION);
    expect(result.role).toContain("너는 Python/backend maker이며");
    expect(result.rolePreset).toBe("maker-py");
    expect(result.rolePresetVersion).toBe(ROLE_PRESET_VERSION);
  });

  test("allows explicit role text to override a selected preset body", async () => {
    const ctx = makeContext(registry());
    const state = deps({ bindTranscript: true });

    const result = await spawnNode(
      ctx,
      {
        agent: "codex",
        name: "custom-maker",
        operatorManaged: true,
        role: "Custom role text",
        rolePreset: "maker-py",
      },
      state.deps,
    );

    expect(state.launched[0]?.node.role).toBe("Custom role text");
    const runtime = ctx.registry.nodes["custom-maker"];
    expect(runtime?.role).toBe("Custom role text");
    expect(runtime?.rolePreset).toBe("maker-py");
    expect(runtime?.rolePresetVersion).toBe(ROLE_PRESET_VERSION);
    expect(result.role).toBe("Custom role text");
    expect(result.rolePreset).toBe("maker-py");
  });

  test("rejects unknown role preset ids before launching a pane", async () => {
    const ctx = makeContext(registry());
    const state = deps({ bindTranscript: true });

    await expect(
      spawnNode(
        ctx,
        {
          agent: "codex",
          name: "bad-preset",
          operatorManaged: true,
          rolePreset: "unknown",
        },
        state.deps,
      ),
    ).rejects.toThrow('unsupported role preset "unknown"');

    expect(state.paneRequests).toEqual([]);
    expect(state.launched).toEqual([]);
  });

  test("creates a detached pane, launches with role, and registers team fields", async () => {
    const ctx = makeContext(registry());
    const state = deps({ bindTranscript: true });

    const result = await spawnNode(
      ctx,
      {
        agent: "codex",
        description: "Owns implementation tasks",
        group: "core",
        name: "maker",
        operatorManaged: true,
        parent: "lead",
        role: "Builder",
      },
      state.deps,
    );

    expect(state.paneRequests).toEqual([
      {
        cwd: "/repo",
        name: "maker",
        session: "dev10",
        window: undefined,
      },
    ]);
    expect(state.launched[0]?.addr).toBe("dev10:2.0");
    expect(state.launched[0]?.node).toEqual(
      expect.objectContaining({
        agent: "codex",
        description: "Owns implementation tasks",
        group: "core",
        name: "maker",
        parent: "lead",
        role: "Builder",
      }),
    );
    expect(ctx.registry.nodes.maker).toEqual(
      expect.objectContaining({
        agent: "codex",
        children: [],
        description: "Owns implementation tasks",
        group: "core",
        name: "maker",
        parent: "lead",
        role: "Builder",
        cwd: "/repo",
        sessionId: "session-new",
        tmux_pane: "dev10:2.0",
        transcript: "/repo/transcript.jsonl",
      }),
    );
    expect(ctx.registry.nodes.lead?.children).toEqual(["maker"]);
    expect(state.guardSessions).toEqual(["dev10"]);
    expect(result).toEqual(
      expect.objectContaining({
        agent: "codex",
        cwd: "/repo",
        description: "Owns implementation tasks",
        name: "maker",
        pane: "dev10:2.0",
        transcriptDetected: true,
      }),
    );
    expect(state.saves).toBe(1);
  });

  test("can write to a project registry while launching in a shared tmux session", async () => {
    const reg = registry();
    reg.session = "alpha";
    const ctx = makeContext(reg);
    ctx.config.session = "alpha";
    const state = deps({ bindTranscript: true });

    const result = await spawnNode(
      ctx,
      {
        agent: "codex",
        name: "maker",
        operatorManaged: true,
        parent: "lead",
        role: "Builder",
        session: "alpha",
        tmuxSession: "dev10",
        window: "alpha",
      },
      state.deps,
    );

    expect(state.paneRequests).toEqual([
      {
        cwd: "/repo",
        name: "maker",
        session: "dev10",
        window: "alpha",
      },
    ]);
    expect(state.guardSessions).toEqual(["dev10"]);
    expect(ctx.registry.session).toBe("alpha");
    expect(ctx.registry.nodes.maker).toEqual(
      expect.objectContaining({
        cwd: "/repo",
        name: "maker",
        parent: "lead",
        tmux_pane: "dev10:2.0",
      }),
    );
    expect(result).toEqual(
      expect.objectContaining({
        name: "maker",
        pane: "dev10:2.0",
        session: "alpha",
        tmuxSession: "dev10",
      }),
    );
  });

  test("splits a requested window and reports a rebind hint when transcript detection is late", async () => {
    const ctx = makeContext(registry());
    const state = deps();

    const result = await spawnNode(
      ctx,
      {
        agent: "antigravity",
        name: "viewer",
        operatorManaged: true,
        role: "Viewer",
        window: "lead",
      },
      state.deps,
    );

    expect(state.paneRequests).toEqual([
      {
        cwd: "/repo",
        name: "viewer",
        session: "dev10",
        window: "lead",
      },
    ]);
    expect(ctx.registry.nodes.viewer).toEqual(
      expect.objectContaining({
        agent: "antigravity",
        children: [],
        cwd: "/repo",
        name: "viewer",
        role: "Viewer",
        tmux_pane: "dev10:2.0",
      }),
    );
    expect(result.transcriptDetected).toBe(false);
    expect(result.rebindHint).toContain("grove rebind");
  });

  test("renders text and JSON summaries", () => {
    const result = {
      agent: "codex" as const,
      cwd: "/repo",
      description: "Owns implementation tasks",
      group: "core",
      name: "maker",
      pane: "dev10:2.0",
      parent: "lead",
      rebindHint: undefined,
      role: "Builder",
      session: "dev10",
      sessionId: "session-new",
      transcript: "/repo/transcript.jsonl",
      transcriptDetected: true,
    };

    expect(renderSpawnText(result)).toContain("maker [codex]");
    expect(renderSpawnText(result)).toContain("description: Owns implementation tasks");
    expect(renderSpawnText(result)).toContain("pane: dev10:2.0");
    expect(JSON.parse(renderSpawnJson(result))).toEqual(result);
  });
});
