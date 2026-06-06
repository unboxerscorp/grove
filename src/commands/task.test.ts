import { describe, expect, test, vi } from "vitest";

import {
  cmdTask,
  cmdTaskList,
  discoverTaskWebUrl,
  isLoopbackTaskWebUrl,
  listTasks,
  renderTaskJson,
  renderTaskListJson,
  renderTaskListText,
  renderTaskText,
  statusForTaskAction,
  type TaskAction,
  type TaskDeps,
  type TaskFetchInit,
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
