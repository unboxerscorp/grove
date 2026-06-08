import { describe, expect, test, vi } from "vitest";

import {
  cmdTask,
  cmdTaskList,
  cmdTaskMine,
  discoverTaskWebUrl,
  isExecutorExcluded,
  isLoopbackTaskWebUrl,
  listAllProjectTasks,
  listMyTasks,
  listTasks,
  matchSelfNode,
  type NodeRow,
  renderAllProjectsTaskListText,
  renderTaskJson,
  renderTaskListJson,
  renderTaskListText,
  renderTaskMineText,
  renderTaskText,
  statusForTaskAction,
  type TaskAction,
  type TaskDeps,
  type TaskFetchInit,
  type TaskMineDeps,
  updateTaskStatus,
} from "./task.js";

interface FetchCall {
  url: string;
  init: TaskFetchInit;
}

function response(
  body: Record<string, unknown>,
  status = 200,
): {
  ok: boolean;
  status: number;
  statusText: string;
  text(): Promise<string>;
} {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 409 ? "Conflict" : status >= 200 && status < 300 ? "OK" : "Bad Gateway",
    text: async () => JSON.stringify(body),
  };
}

function deps(
  opts: {
    env?: NodeJS.ProcessEnv;
    fetchError?: Error;
    responseBody?: Record<string, unknown>;
    responseStatus?: number;
    webJson?: string;
  } = {},
): {
  calls: FetchCall[];
  deps: TaskDeps;
  readPaths: string[];
  warnings: string[];
} {
  const calls: FetchCall[] = [];
  const readPaths: string[] = [];
  const warnings: string[] = [];
  return {
    calls,
    deps: {
      env: opts.env ?? {},
      fetch: async (url, init) => {
        calls.push({ init, url });
        if (opts.fetchError) throw opts.fetchError;
        return response(
          opts.responseBody ?? {
            id: "task_1",
            status: "running",
          },
          opts.responseStatus ?? 200,
        );
      },
      loadConfigSession: () => null,
      readText: (file) => {
        readPaths.push(file);
        if (file.endsWith("dashboard-token")) return "token-123\n";
        if (file.endsWith("web.json")) return opts.webJson ?? null;
        return null;
      },
      sessionDir: (session) => `/home/tester/.grove/${session}`,
      warn: (message) => {
        warnings.push(message);
      },
    },
    readPaths,
    warnings,
  };
}

describe("task status mapping", () => {
  test("maps CLI task verbs to board statuses", () => {
    const cases: Array<[TaskAction, string]> = [
      ["start", "running"],
      ["review", "review"],
      ["done", "done"],
      ["block", "blocked"],
      ["ask-human", "ask_human"],
    ];

    for (const [action, status] of cases) {
      expect(statusForTaskAction(action)).toBe(status);
    }
  });
});

describe("task web discovery", () => {
  test("matches delegate loopback policy and web URL discovery", () => {
    expect(isLoopbackTaskWebUrl("http://127.0.0.1:8765")).toBe(true);
    expect(isLoopbackTaskWebUrl("http://localhost:8765")).toBe(true);
    expect(isLoopbackTaskWebUrl("http://[::1]:8765")).toBe(true);
    expect(isLoopbackTaskWebUrl("http://10.0.0.5:8765")).toBe(false);

    const state = deps({
      env: { GROVE_WEB_URL: "http://127.0.0.1:9999" },
      webJson: JSON.stringify({ url: "http://127.0.0.1:8765" }),
    });
    expect(discoverTaskWebUrl("dev10", state.deps)).toBe("http://127.0.0.1:9999");
    expect(state.readPaths).toEqual([]);
  });

  test("reads web.json before using the fallback", () => {
    const withUrl = deps({ webJson: JSON.stringify({ url: "http://localhost:7777" }) });
    const withPort = deps({ webJson: JSON.stringify({ host: "127.0.0.1", port: 7778 }) });
    const fallback = deps();

    expect(discoverTaskWebUrl("dev10", withUrl.deps)).toBe("http://localhost:7777");
    expect(discoverTaskWebUrl("dev10", withPort.deps)).toBe("http://127.0.0.1:7778");
    expect(discoverTaskWebUrl("dev10", fallback.deps)).toBe("http://127.0.0.1:8765");
  });
});

describe("updateTaskStatus", () => {
  test("patches task status with auth headers and transition payload", async () => {
    const state = deps({ env: { GROVE_WEB_URL: "http://127.0.0.1:9999" } });

    const result = await updateTaskStatus(
      "start",
      "task_1",
      {
        board: "platform",
        comment: "starting work",
        fromStatus: "ready",
        idempotencyKey: "idem-1",
        reviewer: "reviewer",
        runId: "run-1",
        session: "dev10",
      },
      state.deps,
    );

    expect(state.calls).toHaveLength(1);
    expect(state.calls[0]).toEqual({
      init: {
        body: state.calls[0]?.init.body,
        headers: {
          "Content-Type": "application/json",
          Origin: "http://127.0.0.1:9999",
          "X-Grove-Project": "dev10",
          "X-Grove-Session-Token": "token-123",
        },
        method: "PATCH",
      },
      url: "http://127.0.0.1:9999/api/tasks/task_1/status",
    });
    expect(JSON.parse(state.calls[0]?.init.body ?? "{}")).toEqual({
      board: "platform",
      comment: "starting work",
      from_status: "ready",
      idempotency_key: "idem-1",
      reviewer: "reviewer",
      run_id: "run-1",
      status: "running",
    });
    expect(result.status).toBe("running");
    expect(result.task["id"]).toBe("task_1");
  });

  test("uses config session when --session is omitted", async () => {
    const state = deps({ env: { GROVE_WEB_URL: "http://127.0.0.1:9999" } });
    state.deps.loadConfigSession = () => "alpha";

    await updateTaskStatus("done", "task_1", {}, state.deps);

    expect(state.calls[0]?.init.headers["X-Grove-Project"]).toBe("alpha");
    expect(state.readPaths).toContain("/home/tester/.grove/alpha/dashboard-token");
  });

  test("targets another project with --project while authing with the host token", async () => {
    const state = deps({ env: { GROVE_WEB_URL: "http://127.0.0.1:9999" } });

    await updateTaskStatus(
      "start",
      "task_1",
      { fromStatus: "ready", project: "base-web-admin", session: "dev10" },
      state.deps,
    );

    // X-Grove-Project follows the target project; token + board come from the host session.
    expect(state.calls[0]?.init.headers["X-Grove-Project"]).toBe("base-web-admin");
    expect(state.calls[0]?.init.headers["X-Grove-Session-Token"]).toBe("token-123");
    expect(state.readPaths).toContain("/home/tester/.grove/dev10/dashboard-token");
    const body = JSON.parse(state.calls[0]?.init.body ?? "{}") as { board?: string };
    expect(body.board).toBe("base-web-admin");
  });

  test("--host-session overrides the auth session for a cross-project transition", async () => {
    const state = deps({ env: { GROVE_WEB_URL: "http://127.0.0.1:9999" } });

    await updateTaskStatus(
      "done",
      "task_1",
      { hostSession: "dev10", project: "base-web-admin" },
      state.deps,
    );

    expect(state.calls[0]?.init.headers["X-Grove-Project"]).toBe("base-web-admin");
    expect(state.readPaths).toContain("/home/tester/.grove/dev10/dashboard-token");
  });

  test("rejects non-loopback web URLs before reading or sending the dashboard token", async () => {
    const state = deps({ env: { GROVE_WEB_URL: "http://10.0.0.5:8765" } });

    await expect(
      updateTaskStatus("done", "task_1", { session: "dev10" }, state.deps),
    ).rejects.toThrow("refusing to send dashboard token to non-loopback grove-web URL");

    expect(state.calls).toEqual([]);
    expect(state.readPaths).not.toContain("/home/tester/.grove/dev10/dashboard-token");
  });

  test("allows non-loopback web URLs with explicit opt-in and warns", async () => {
    const state = deps({ env: { GROVE_WEB_URL: "http://10.0.0.5:8765" } });

    await updateTaskStatus("review", "task_1", { allowRemote: true, session: "dev10" }, state.deps);

    expect(state.calls[0]?.url).toBe("http://10.0.0.5:8765/api/tasks/task_1/status");
    expect(state.warnings).toEqual([
      "task command sending dashboard token to non-loopback grove-web URL: http://10.0.0.5:8765",
    ]);
  });

  test("reports 409 status conflicts with server detail", async () => {
    const state = deps({
      responseBody: { detail: "from_status mismatch" },
      responseStatus: 409,
    });

    await expect(
      updateTaskStatus("done", "task_1", { fromStatus: "running", session: "dev10" }, state.deps),
    ).rejects.toThrow("grove-web task status conflict");
    await expect(
      updateTaskStatus("done", "task_1", { fromStatus: "running", session: "dev10" }, state.deps),
    ).rejects.toThrow("from_status mismatch");
  });

  test("reports web connection failures with session guidance", async () => {
    const state = deps({ fetchError: new Error("connect ECONNREFUSED") });

    await expect(
      updateTaskStatus("block", "task_1", { session: "dev10" }, state.deps),
    ).rejects.toThrow("could not reach grove-web at http://127.0.0.1:8765 for session dev10");
  });

  test("renders text and JSON from the updated task", async () => {
    const state = deps({
      env: { GROVE_WEB_URL: "http://127.0.0.1:9999" },
      responseBody: { id: "task_1", status: "ask_human" },
    });
    const result = await updateTaskStatus("ask-human", "task_1", {}, state.deps);

    expect(renderTaskText(result)).toBe("task task_1 -> ask_human on default (dev10)");
    expect(JSON.parse(renderTaskJson(result))).toEqual(result.task);
  });
});

describe("listTasks", () => {
  test("gets human-facing items with auth headers and filters", async () => {
    const state = deps({
      env: { GROVE_WEB_URL: "http://127.0.0.1:9999" },
      responseBody: [
        {
          assignee: "grove-master",
          id: "task_1",
          status: "running",
          title: "Canonical audit",
        },
      ] as unknown as Record<string, unknown>,
    });

    const result = await listTasks(
      {
        assignee: "grove-master",
        board: "dev10",
        session: "dev10",
        status: "running",
      },
      state.deps,
    );

    expect(state.calls).toHaveLength(1);
    expect(state.calls[0]).toEqual({
      init: {
        headers: {
          Origin: "http://127.0.0.1:9999",
          "X-Grove-Project": "dev10",
          "X-Grove-Session-Token": "token-123",
        },
        method: "GET",
      },
      url: "http://127.0.0.1:9999/api/boards/dev10/tasks?status=running&assignee=grove-master",
    });
    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0]?.["id"]).toBe("task_1");
  });

  test("renders listed human-facing items as text and JSON", async () => {
    const result = {
      board: "dev10",
      session: "dev10",
      tasks: [
        {
          assignee: "grove-master",
          id: "task_1",
          status: "running",
          title: "Canonical audit",
        },
      ],
      url: "http://127.0.0.1:8765",
    };

    expect(renderTaskListText(result)).toBe("task_1 [running] grove-master: Canonical audit");
    expect(JSON.parse(renderTaskListJson(result))).toEqual(result.tasks);
    expect(renderTaskListText({ ...result, tasks: [] })).toBe(
      "no human-facing items on dev10 (dev10)",
    );
  });
});

describe("cmdTask", () => {
  test("prints updated task JSON when requested", async () => {
    const state = deps({ env: { GROVE_WEB_URL: "http://127.0.0.1:9999" } });
    const writes: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
    });

    await cmdTask("done", "task_1", { json: true }, state.deps);

    expect(JSON.parse(writes.join(""))).toEqual(
      expect.objectContaining({
        id: "task_1",
        status: "running",
      }),
    );
  });
});

describe("cmdTaskList", () => {
  test("prints listed task JSON when requested", async () => {
    const state = deps({
      env: { GROVE_WEB_URL: "http://127.0.0.1:9999" },
      responseBody: [{ id: "task_1", status: "running" }] as unknown as Record<string, unknown>,
    });
    const writes: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
    });

    await cmdTaskList({ board: "dev10", json: true, session: "dev10" }, state.deps);

    expect(JSON.parse(writes.join(""))).toEqual([
      expect.objectContaining({
        id: "task_1",
        status: "running",
      }),
    ]);
  });
});

function mineDeps(
  opts: {
    env?: NodeJS.ProcessEnv;
    fetchError?: Error;
    nodes?: NodeRow[];
    paneAddr?: string | null;
    responseBody?: Record<string, unknown>;
    responseStatus?: number;
    webJson?: string;
  } = {},
): {
  calls: FetchCall[];
  deps: TaskMineDeps;
  readPaths: string[];
  warnings: string[];
} {
  const base = deps(opts);
  return {
    ...base,
    deps: {
      ...base.deps,
      currentPaneAddr: async () => opts.paneAddr ?? null,
      listNodes: () => opts.nodes ?? [],
    },
  };
}

describe("isExecutorExcluded", () => {
  test("excludes service, audit, and master group nodes (incl chat-master)", () => {
    expect(isExecutorExcluded({ group: "services", name: "web" })).toBe(true);
    expect(isExecutorExcluded({ group: "services", name: "slack" })).toBe(true);
    expect(isExecutorExcluded({ group: "audit", name: "whip" })).toBe(true);
    expect(isExecutorExcluded({ group: "master", name: "grove-master" })).toBe(true);
    expect(isExecutorExcluded({ group: "master", name: "chat-master" })).toBe(true);
  });

  test("excludes service-kind, advisor, and jester nodes", () => {
    expect(isExecutorExcluded({ kind: "service", name: "some-service" })).toBe(true);
    expect(isExecutorExcluded({ name: "advisor" })).toBe(true);
    expect(isExecutorExcluded({ name: "jester" })).toBe(true);
  });

  test("includes lead and worker executor nodes", () => {
    expect(isExecutorExcluded({ group: "lead", name: "lead" })).toBe(false);
    expect(isExecutorExcluded({ group: "workers", name: "task-worker" })).toBe(false);
  });
});

describe("matchSelfNode", () => {
  const rows: NodeRow[] = [
    { group: "workers", name: "task-worker", tmuxPane: "dev10:2.5" },
    { group: "services", kind: "service", name: "web", tmuxPane: "dev10:1.0" },
  ];

  test("prefers an explicit node name", () => {
    expect(matchSelfNode(rows, { explicitNode: "web" })).toEqual({
      group: "services",
      kind: "service",
      name: "web",
    });
  });

  test("returns a name-only self for an explicit unknown node", () => {
    expect(matchSelfNode(rows, { explicitNode: "ghost" })).toEqual({ name: "ghost" });
  });

  test("resolves the current pane to its node", () => {
    expect(matchSelfNode(rows, { paneAddr: "dev10:2.5" })).toEqual({
      group: "workers",
      name: "task-worker",
    });
  });

  test("returns null when neither explicit nor pane resolves", () => {
    expect(matchSelfNode(rows, { paneAddr: "dev10:9.9" })).toBeNull();
    expect(matchSelfNode(rows, {})).toBeNull();
  });
});

describe("listMyTasks", () => {
  test("is a no-op for excluded nodes and never calls grove-web", async () => {
    const state = mineDeps({
      nodes: [{ group: "services", kind: "service", name: "web", tmuxPane: "dev10:1.0" }],
      paneAddr: "dev10:1.0",
    });

    const result = await listMyTasks({ session: "dev10" }, state.deps);

    expect(result.resolved).toBe(true);
    expect(result.excluded).toBe(true);
    expect(result.node).toBe("web");
    expect(result.tasks).toEqual([]);
    expect(state.calls).toEqual([]);
  });

  test("reports unresolved when the current node cannot be identified", async () => {
    const state = mineDeps({
      nodes: [{ group: "workers", name: "task-worker", tmuxPane: "dev10:2.5" }],
      paneAddr: "dev10:9.9",
    });

    const result = await listMyTasks({ session: "dev10" }, state.deps);

    expect(result.resolved).toBe(false);
    expect(result.excluded).toBe(false);
    expect(state.calls).toEqual([]);
  });

  test("lists only ready/running items for an executor, board defaults to the session", async () => {
    const state = mineDeps({
      env: { GROVE_WEB_URL: "http://127.0.0.1:9999" },
      nodes: [{ group: "workers", name: "task-worker", tmuxPane: "dev10:2.5" }],
      paneAddr: "dev10:2.5",
      responseBody: [
        { assignee: "task-worker", id: "t1", status: "ready", title: "do A" },
        { assignee: "task-worker", id: "t2", status: "running", title: "do B" },
        { assignee: "task-worker", id: "t3", status: "done", title: "old" },
        { assignee: "task-worker", id: "t4", status: "blocked", title: "stuck" },
      ] as unknown as Record<string, unknown>,
    });

    const result = await listMyTasks({ session: "dev10" }, state.deps);

    expect(result.node).toBe("task-worker");
    expect(result.excluded).toBe(false);
    expect(result.resolved).toBe(true);
    expect(state.calls).toHaveLength(1);
    expect(state.calls[0]?.url).toBe(
      "http://127.0.0.1:9999/api/boards/dev10/tasks?assignee=task-worker",
    );
    expect(result.tasks.map((task) => task["id"])).toEqual(["t1", "t2"]);
  });

  test("honors an explicit --node override", async () => {
    const state = mineDeps({
      env: { GROVE_WEB_URL: "http://127.0.0.1:9999" },
      nodes: [{ group: "lead", name: "lead", tmuxPane: "dev10:2.0" }],
      responseBody: [] as unknown as Record<string, unknown>,
    });

    const result = await listMyTasks(
      { board: "dev10", node: "lead", session: "dev10" },
      state.deps,
    );

    expect(result.node).toBe("lead");
    expect(state.calls[0]?.url).toBe("http://127.0.0.1:9999/api/boards/dev10/tasks?assignee=lead");
  });
});

describe("cmdTaskMine", () => {
  test("prints an executor-only notice for excluded nodes", async () => {
    const state = mineDeps({
      nodes: [{ name: "advisor", tmuxPane: "dev10:0.2" }],
      paneAddr: "dev10:0.2",
    });
    const writes: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
    });

    await cmdTaskMine({ session: "dev10" }, state.deps);

    expect(writes.join("")).toContain("executor-only");
    expect(state.calls).toEqual([]);
  });

  test("prints assigned ready/running items as JSON when requested", async () => {
    const state = mineDeps({
      env: { GROVE_WEB_URL: "http://127.0.0.1:9999" },
      nodes: [{ group: "workers", name: "task-worker", tmuxPane: "dev10:2.5" }],
      paneAddr: "dev10:2.5",
      responseBody: [
        { assignee: "task-worker", id: "t1", status: "ready", title: "do A" },
      ] as unknown as Record<string, unknown>,
    });
    const writes: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
    });

    await cmdTaskMine({ json: true, session: "dev10" }, state.deps);

    const parsed = JSON.parse(writes.join("")) as { node: string; tasks: unknown[] };
    expect(parsed.node).toBe("task-worker");
    expect(parsed.tasks).toHaveLength(1);
  });
});

describe("renderTaskMineText", () => {
  test("renders unresolved, excluded, empty, and populated states", () => {
    expect(
      renderTaskMineText({
        board: "dev10",
        excluded: false,
        node: "",
        resolved: false,
        session: "dev10",
        tasks: [],
      }),
    ).toContain("could not determine the current grove node");

    expect(
      renderTaskMineText({
        board: "dev10",
        excluded: true,
        node: "advisor",
        resolved: true,
        session: "dev10",
        tasks: [],
      }),
    ).toContain("executor-only");

    expect(
      renderTaskMineText({
        board: "dev10",
        excluded: false,
        node: "task-worker",
        resolved: true,
        session: "dev10",
        tasks: [],
      }),
    ).toBe("no ready or running items assigned to task-worker on dev10 (dev10).");

    expect(
      renderTaskMineText({
        board: "dev10",
        excluded: false,
        node: "task-worker",
        resolved: true,
        session: "dev10",
        tasks: [{ id: "t1", status: "ready", title: "do A" }],
      }),
    ).toBe("ready/running items assigned to task-worker on dev10 (dev10):\nt1 [ready] do A");
  });
});

function allProjectsDeps(opts: {
  projects: string[];
  byProject: Record<string, { body?: unknown; status?: number }>;
  env?: NodeJS.ProcessEnv;
}): {
  calls: FetchCall[];
  deps: TaskDeps & { listProjects: () => string[] };
} {
  const calls: FetchCall[] = [];
  return {
    calls,
    deps: {
      env: opts.env ?? { GROVE_WEB_URL: "http://127.0.0.1:9999" },
      fetch: async (url, init) => {
        calls.push({ init, url });
        const match = /\/api\/boards\/([^/?]+)\/tasks/.exec(url);
        const project = match?.[1] ? decodeURIComponent(match[1]) : "";
        const entry = opts.byProject[project] ?? { body: [] };
        return response((entry.body ?? []) as Record<string, unknown>, entry.status ?? 200);
      },
      listProjects: () => opts.projects,
      loadConfigSession: () => null,
      readText: (file) => (file.endsWith("dashboard-token") ? "token-123\n" : null),
      sessionDir: (session) => `/home/tester/.grove/${session}`,
      warn: () => {},
    },
  };
}

describe("listAllProjectTasks", () => {
  test("aggregates across projects with the host token and a per-project X-Grove-Project", async () => {
    const { calls, deps } = allProjectsDeps({
      byProject: {
        "base-inbrain-server": { body: [] },
        "base-web-admin": { body: [{ assignee: "win4", id: "t2", status: "running", title: "B" }] },
        dev10: { body: [{ assignee: "lead", id: "t1", status: "ready", title: "A" }] },
      },
      projects: ["dev10", "base-web-admin", "base-inbrain-server"],
    });

    const result = await listAllProjectTasks({ session: "dev10" }, deps);

    expect(result.projects).toEqual(["dev10", "base-web-admin", "base-inbrain-server"]);
    expect(result.tasks.map((task) => [task["project"], task["id"]])).toEqual([
      ["dev10", "t1"],
      ["base-web-admin", "t2"],
    ]);
    expect(result.errors).toEqual([]);
    for (const call of calls) {
      expect(call.init.headers["X-Grove-Session-Token"]).toBe("token-123");
    }
    expect(calls.map((call) => call.init.headers["X-Grove-Project"])).toEqual([
      "dev10",
      "base-web-admin",
      "base-inbrain-server",
    ]);
  });

  test("records per-project errors and still returns other projects", async () => {
    const { deps } = allProjectsDeps({
      byProject: {
        "base-web-admin": { body: { detail: "missing or invalid session token" }, status: 401 },
        dev10: { body: [{ id: "t1", status: "ready", title: "A" }] },
      },
      projects: ["dev10", "base-web-admin"],
    });

    const result = await listAllProjectTasks({ session: "dev10" }, deps);

    expect(result.tasks.map((task) => task["id"])).toEqual(["t1"]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.project).toBe("base-web-admin");
  });

  test("passes status and assignee filters to every project query", async () => {
    const { calls, deps } = allProjectsDeps({
      byProject: { dev10: { body: [] } },
      projects: ["dev10"],
    });

    await listAllProjectTasks({ assignee: "lead", session: "dev10", status: "ready" }, deps);

    expect(calls[0]?.url).toContain("status=ready");
    expect(calls[0]?.url).toContain("assignee=lead");
  });
});

describe("renderAllProjectsTaskListText", () => {
  test("renders project-tagged rows and error markers", () => {
    const text = renderAllProjectsTaskListText({
      errors: [{ detail: "HTTP 401", project: "p2" }],
      hostSession: "dev10",
      projects: ["dev10", "p2"],
      tasks: [{ assignee: "lead", id: "t1", project: "dev10", status: "ready", title: "A" }],
      url: "http://127.0.0.1:9999",
    });

    expect(text).toContain("dev10 t1 [ready] lead: A");
    expect(text).toContain("! p2: HTTP 401");
  });

  test("notes an empty cross-project result", () => {
    expect(
      renderAllProjectsTaskListText({
        errors: [],
        hostSession: "dev10",
        projects: ["a", "b"],
        tasks: [],
        url: "http://127.0.0.1:9999",
      }),
    ).toBe("no items across 2 project(s)");
  });
});
