import { describe, expect, test, vi } from "vitest";

import type { Registry } from "../registry.js";
import {
  cmdDelegate,
  type DelegateDeps,
  type DelegateFetchInit,
  delegateTask,
  discoverWebUrl,
  isLoopbackWebUrl,
  renderDelegateJson,
  renderDelegateText,
} from "./delegate.js";

interface FetchCall {
  url: string;
  init: DelegateFetchInit;
}

function registry(): Registry {
  return {
    cwd: "/repo",
    nodes: {
      maker: {
        agent: "codex",
        name: "maker",
        role: "Maker",
        tmux_pane: "dev10:1.%5",
      },
    },
    session: "dev10",
    updatedAt: "2026-06-04T00:00:00.000Z",
  };
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
    statusText: status >= 200 && status < 300 ? "OK" : "Bad Gateway",
    text: async () => JSON.stringify(body),
  };
}

function deps(
  opts: {
    env?: NodeJS.ProcessEnv;
    fetchError?: Error;
    registry?: Registry | null;
    responseStatus?: number;
    webJson?: string;
  } = {},
): {
  calls: FetchCall[];
  deps: DelegateDeps;
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
          {
            assignee: "maker",
            id: "task-1",
            status: "ready",
            title: "Fix issue",
          },
          opts.responseStatus ?? 200,
        );
      },
      loadConfigSession: () => null,
      loadRegistry: () => opts.registry ?? registry(),
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

describe("isLoopbackWebUrl", () => {
  test("allows only loopback hosts by default", () => {
    expect(isLoopbackWebUrl("http://127.0.0.1:8765")).toBe(true);
    expect(isLoopbackWebUrl("http://localhost:8765")).toBe(true);
    expect(isLoopbackWebUrl("http://[::1]:8765")).toBe(true);
    expect(isLoopbackWebUrl("http://10.0.0.5:8765")).toBe(false);
    expect(isLoopbackWebUrl("https://example.com")).toBe(false);
  });
});

describe("discoverWebUrl", () => {
  test("prefers GROVE_WEB_URL over web.json and fallback", () => {
    const state = deps({
      env: { GROVE_WEB_URL: "http://127.0.0.1:9999" },
      webJson: JSON.stringify({ url: "http://127.0.0.1:8765" }),
    });

    expect(discoverWebUrl("dev10", state.deps)).toBe("http://127.0.0.1:9999");
    expect(state.readPaths).toEqual([]);
  });

  test("reads web.json url or port before using the fallback", () => {
    const withUrl = deps({ webJson: JSON.stringify({ url: "http://localhost:7777" }) });
    const withPort = deps({ webJson: JSON.stringify({ host: "127.0.0.1", port: 7778 }) });
    const fallback = deps();

    expect(discoverWebUrl("dev10", withUrl.deps)).toBe("http://localhost:7777");
    expect(discoverWebUrl("dev10", withPort.deps)).toBe("http://127.0.0.1:7778");
    expect(discoverWebUrl("dev10", fallback.deps)).toBe("http://127.0.0.1:8765");
  });
});

describe("delegateTask", () => {
  test("creates a ready board task assigned to an existing registry node", async () => {
    const state = deps({ env: { GROVE_WEB_URL: "http://127.0.0.1:9999" } });

    const result = await delegateTask(
      "maker",
      "Fix issue",
      { board: "default", body: "Run pnpm check:ts", session: "dev10" },
      state.deps,
    );

    expect(state.calls).toHaveLength(1);
    expect(state.calls[0]?.url).toBe("http://127.0.0.1:9999/api/boards/default/tasks");
    expect(state.calls[0]?.init.headers).toEqual({
      "Content-Type": "application/json",
      Origin: "http://127.0.0.1:9999",
      "X-Grove-Project": "dev10",
      "X-Grove-Session-Token": "token-123",
    });
    expect(state.calls[0]?.init.method).toBe("POST");
    const posted = JSON.parse(state.calls[0]?.init.body ?? "{}") as Record<string, unknown>;
    expect(posted).toEqual(
      expect.objectContaining({
        assignee: "maker",
        priority: 0,
        status: "ready",
        title: "Fix issue",
      }),
    );
    expect(String(posted["body"])).toContain("Original message:\nRun pnpm check:ts");
    expect(result.task["id"]).toBe("task-1");
    expect(result.node).toBe("maker");
  });

  test("prepends a grove context pack to delegated task bodies", async () => {
    const state = deps({ env: { GROVE_WEB_URL: "http://127.0.0.1:9999" } });

    await delegateTask(
      "maker",
      "Fix issue",
      { board: "default", body: "Run pnpm check:ts", session: "dev10" },
      state.deps,
    );

    const payload = JSON.parse(state.calls[0]?.init.body ?? "{}") as { body?: string };
    expect(payload.body).toContain("GROVE CONTEXT PACK");
    expect(payload.body).toContain("Caller node: grove delegate CLI");
    expect(payload.body).toContain("Project: dev10");
    expect(payload.body).toContain("Target node: maker");
    expect(payload.body).toContain("Target role: Maker");
    expect(payload.body).toContain("pane=dev10:1.%5");
    expect(payload.body).toContain("Original message:\nRun pnpm check:ts");
  });

  test("uses config session when --session is omitted", async () => {
    const state = deps({ env: { GROVE_WEB_URL: "http://127.0.0.1:9999" } });
    state.deps.loadConfigSession = () => "alpha";
    state.deps.loadRegistry = (session) => ({ ...registry(), session });

    await delegateTask("maker", "Fix issue", {}, state.deps);

    expect(state.calls[0]?.init.headers["X-Grove-Project"]).toBe("alpha");
    expect(state.readPaths).toContain("/home/tester/.grove/alpha/dashboard-token");
  });

  test("rejects unknown nodes before posting to grove-web", async () => {
    const state = deps();

    await expect(delegateTask("missing", "Fix issue", {}, state.deps)).rejects.toThrow(
      "node not found in registry: missing",
    );
    expect(state.calls).toEqual([]);
  });

  test("reports web connection failures with session guidance", async () => {
    const state = deps({ fetchError: new Error("connect ECONNREFUSED") });

    await expect(
      delegateTask("maker", "Fix issue", { session: "dev10" }, state.deps),
    ).rejects.toThrow("could not reach grove-web at http://127.0.0.1:8765 for session dev10");
  });

  test("reports non-2xx task creation failures", async () => {
    const state = deps({ responseStatus: 502 });

    await expect(
      delegateTask("maker", "Fix issue", { session: "dev10" }, state.deps),
    ).rejects.toThrow("grove-web task create failed");
  });

  test("rejects non-loopback web URLs before reading or sending the dashboard token", async () => {
    const state = deps({ env: { GROVE_WEB_URL: "http://10.0.0.5:8765" } });

    await expect(
      delegateTask("maker", "Fix issue", { session: "dev10" }, state.deps),
    ).rejects.toThrow("refusing to send dashboard token to non-loopback grove-web URL");

    expect(state.calls).toEqual([]);
    expect(state.readPaths).not.toContain("/home/tester/.grove/dev10/dashboard-token");
  });

  test("allows non-loopback web URLs with explicit opt-in and warns", async () => {
    const state = deps({ env: { GROVE_WEB_URL: "http://10.0.0.5:8765" } });

    await delegateTask("maker", "Fix issue", { allowRemote: true, session: "dev10" }, state.deps);

    expect(state.calls[0]?.url).toBe("http://10.0.0.5:8765/api/boards/default/tasks");
    expect(state.warnings).toEqual([
      "delegate sending dashboard token to non-loopback grove-web URL: http://10.0.0.5:8765",
    ]);
  });

  test("allows non-loopback web URLs with env opt-in and warns", async () => {
    const state = deps({
      env: { GROVE_DELEGATE_ALLOW_REMOTE: "1", GROVE_WEB_URL: "http://10.0.0.5:8765" },
    });

    await delegateTask("maker", "Fix issue", { session: "dev10" }, state.deps);

    expect(state.calls).toHaveLength(1);
    expect(state.warnings[0]).toContain("non-loopback grove-web URL");
  });

  test("renders text and JSON from the created task", async () => {
    const state = deps({ env: { GROVE_WEB_URL: "http://127.0.0.1:9999" } });
    const result = await delegateTask("maker", "Fix issue", {}, state.deps);

    expect(renderDelegateText(result)).toBe("delegated task-1 -> maker on default (dev10)");
    expect(JSON.parse(renderDelegateJson(result))).toEqual(result.task);
  });
});

describe("cmdDelegate", () => {
  test("prints created task JSON when requested", async () => {
    const state = deps({ env: { GROVE_WEB_URL: "http://127.0.0.1:9999" } });
    const writes: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
    });

    await cmdDelegate("maker", "Fix issue", { json: true }, state.deps);

    expect(JSON.parse(writes.join(""))).toEqual(
      expect.objectContaining({
        assignee: "maker",
        id: "task-1",
      }),
    );
  });
});
