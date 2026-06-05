import { describe, expect, it, vi } from "vitest";

import type { MasterChatResponse } from "./api";

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
      proposal: null,
      feedback_route: null,
      operator_gate: { reason: "internal gate reason" },
      requires_confirmation: false,
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
      proposal: null,
      feedback_route: null,
      operator_gate: { reason: "internal gate reason" },
      requires_confirmation: false,
    };

    // No LLM text -> empty (caller treats as error/unavailable); the non-LLM
    // operator_gate.reason must NEVER be surfaced.
    expect(masterReplyText(response)).toBe("");
  });

  it("renders preview assistant text without falling back to proposal summary", async () => {
    vi.stubGlobal("window", {
      __GROVE_AUTH_REQUIRED__: false,
      __GROVE_SESSION_TOKEN__: "",
    });
    const { masterReplyText } = await import("./api");
    const response: MasterChatResponse = {
      conversation_id: "conv-1",
      request_id: "req-1",
      response_type: "preview",
      answer: { text: "LLM preview confirmation text" },
      proposal: {
        proposal_id: "assistant_1",
        summary: "deterministic proposal summary",
        payload: { confirmation_id: "assistant_1" },
      },
      feedback_route: null,
      operator_gate: null,
      requires_confirmation: true,
    };

    expect(masterReplyText(response)).toBe("LLM preview confirmation text");
  });

  it("extracts assistant confirmation ids from preview payloads", async () => {
    vi.stubGlobal("window", {
      __GROVE_AUTH_REQUIRED__: false,
      __GROVE_SESSION_TOKEN__: "",
    });
    const { masterConfirmationId } = await import("./api");
    const response: MasterChatResponse = {
      conversation_id: "conv-1",
      request_id: "req-1",
      response_type: "preview",
      answer: { text: "LLM preview confirmation text" },
      proposal: {
        proposal_id: "assistant_fallback",
        summary: "proposal summary",
        payload: {
          confirmation_id: "assistant_payload",
          confirm: { command: "confirm assistant_command", endpoint: "/api/master/chat/confirm" },
        },
      },
      feedback_route: null,
      operator_gate: null,
      requires_confirmation: true,
    };

    expect(masterConfirmationId(response)).toBe("assistant_payload");
  });
});
