import { afterEach, describe, expect, it, vi } from "vitest";

import type { MasterChatResponse } from "./api";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("masterReplyText", () => {
  it("renders denied assistant text from answer before operator gate reason", async () => {
    vi.stubGlobal("window", {
      __GROVE_AUTH_REQUIRED__: false,
      __GROVE_SESSION_TOKEN__: "",
    });
    const { masterReplyText } = await import("./api");
    const response: MasterChatResponse = {
      conversation_id: "conv-1",
      request_id: "req-1",
      response_type: "denied",
      answer: { text: "LLM natural denial text" },
      feedback_route: null,
      operator_gate: { reason: "internal gate reason" },
    };

    expect(masterReplyText(response)).toBe("LLM natural denial text");
  });

  it("never falls back to operator_gate.reason when denied has no answer text", async () => {
    vi.stubGlobal("window", {
      __GROVE_AUTH_REQUIRED__: false,
      __GROVE_SESSION_TOKEN__: "",
    });
    const { masterReplyText } = await import("./api");
    const response: MasterChatResponse = {
      conversation_id: "conv-1",
      request_id: "req-1",
      response_type: "denied",
      answer: null,
      feedback_route: null,
      operator_gate: { reason: "internal gate reason" },
    };

    // No LLM text -> empty (caller treats as error/unavailable); the non-LLM
    // operator_gate.reason must NEVER be surfaced.
    expect(masterReplyText(response)).toBe("");
  });

});

describe("node termination API", () => {
  type FetchResult = {
    json(): Promise<unknown>;
    ok: boolean;
  };

  function stubBrowser(): void {
    vi.stubGlobal("window", {
      __GROVE_AUTH_REQUIRED__: false,
      __GROVE_SESSION_TOKEN__: "tok",
      location: { host: "127.0.0.1:8765", pathname: "/", protocol: "http:" },
    });
  }

  function mockFetch(body: unknown) {
    return vi.fn<(path: string, init?: RequestInit) => Promise<FetchResult>>(async () => ({
      json: async () => body,
      ok: true,
    }));
  }

  it("posts caller-owned terminate preview requests to the node terminate endpoint", async () => {
    stubBrowser();
    const fetchMock = mockFetch({ confirmed: false, confirmation_id: "confirm-1", node: "child" });
    vi.stubGlobal("fetch", fetchMock);
    const { api, setProject } = await import("./api");
    setProject("sample");

    await api.terminateNode("child", { caller: "lead" });

    const [path, init] = fetchMock.mock.calls[0]!;
    expect(path).toBe("/api/nodes/child/terminate");
    expect(init).toMatchObject({ credentials: "same-origin", method: "POST" });
    expect(init?.headers).toMatchObject({
      "Content-Type": "application/json",
      "X-Grove-Project": "sample",
      "X-Grove-Session-Token": "tok",
    });
    expect(JSON.parse(String(init?.body))).toEqual({ caller: "lead" });
  });

  it("posts explicit operator override for operator terminate requests", async () => {
    stubBrowser();
    const fetchMock = mockFetch({ confirmed: false, confirmation_id: "confirm-2", node: "stray" });
    vi.stubGlobal("fetch", fetchMock);
    const { api } = await import("./api");

    await api.terminateNode("stray", { operatorOverride: true });

    const [, init] = fetchMock.mock.calls[0]!;
    expect(JSON.parse(String(init?.body))).toEqual({ operator_override: true });
  });

  it("posts matching confirmation ids for confirmed terminate requests", async () => {
    stubBrowser();
    const fetchMock = mockFetch({ confirmed: true, confirmation_id: "confirm-3", node: "stray" });
    vi.stubGlobal("fetch", fetchMock);
    const { api } = await import("./api");

    await api.terminateNode("stray", {
      operatorOverride: true,
      confirm: true,
      confirmationId: "confirm-3",
    });

    const [, init] = fetchMock.mock.calls[0]!;
    expect(JSON.parse(String(init?.body))).toEqual({
      confirm: true,
      confirmation_id: "confirm-3",
      operator_override: true,
    });
  });

  it("PATCHes editable advisory fields (work_instructions/description) to the node endpoint", async () => {
    stubBrowser();
    const fetchMock = mockFetch({ name: "worker" });
    vi.stubGlobal("fetch", fetchMock);
    const { api, setProject } = await import("./api");
    setProject("sample");

    await api.patchNode("worker", { work_instructions: "Focus on G7", description: "edited" });

    const [path, init] = fetchMock.mock.calls[0]!;
    expect(path).toBe("/api/nodes/worker");
    expect(init).toMatchObject({ credentials: "same-origin", method: "PATCH" });
    expect(JSON.parse(String(init?.body))).toEqual({
      work_instructions: "Focus on G7",
      description: "edited",
    });
  });
});
