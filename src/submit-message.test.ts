import { afterEach, describe, expect, test, vi } from "vitest";

import { antigravityAdapter } from "./adapters/antigravity.js";
import type { NodeCtx } from "./context.js";
import { nonEmptyAgentInput, submitMessage } from "./ops.js";
import { capturePane, sendEnter, sendLiteral } from "./tmux.js";
import { sleep } from "./util/time.js";

vi.mock("./tmux.js", () => ({
  capturePane: vi.fn(async () => ""),
  sendEnter: vi.fn(async () => undefined),
  sendLiteral: vi.fn(async () => undefined),
}));

vi.mock("./util/time.js", () => ({
  poll: vi.fn(),
  sleep: vi.fn(async () => undefined),
  waitForChangeOrTimeout: vi.fn(),
}));

afterEach(() => {
  vi.mocked(capturePane).mockReset();
  vi.mocked(capturePane).mockResolvedValue("");
  vi.mocked(sendEnter).mockReset();
  vi.mocked(sendLiteral).mockReset();
  vi.mocked(sleep).mockReset();
});

describe("submitMessage", () => {
  test("submits antigravity turns with settled bracketed paste and a second Enter", async () => {
    const sequence: string[] = [];
    vi.mocked(sendLiteral).mockImplementation(async (_addr, text) => {
      sequence.push(`literal:${text}`);
    });
    vi.mocked(sleep).mockImplementation(async (ms) => {
      sequence.push(`sleep:${ms}`);
    });
    vi.mocked(sendEnter).mockImplementation(async () => {
      sequence.push("enter");
    });
    const nc: NodeCtx = {
      adapter: antigravityAdapter,
      addr: "dev10:1.%5",
      node: {
        agent: "antigravity",
        children: [],
        cwd: "/repo",
        name: "agy",
      },
    };

    await submitMessage(nc, "ship it");

    expect(sequence[0]).toContain("GROVE CONTEXT PACK");
    expect(sequence[0]).toContain("Target node: agy");
    expect(sequence[0]).toContain("Original message:\nship it");
    expect(sequence[0]?.startsWith("literal:\u001b[200~")).toBe(true);
    expect(sequence[0]?.endsWith("ship it\u001b[201~")).toBe(true);
    expect(sequence.slice(1)).toEqual(["sleep:220", "enter", "sleep:260", "enter"]);
  });

  test("refuses to inject when an agent prompt already has human input", async () => {
    vi.mocked(capturePane).mockResolvedValue(
      ["• Working", "", "› Explain this codebase", "", "  gpt-5.5 xhigh · ~/dev/grove"].join("\n"),
    );
    const nc: NodeCtx = {
      adapter: antigravityAdapter,
      addr: "dev10:0.0",
      node: {
        agent: "antigravity",
        children: [],
        cwd: "/repo",
        name: "grove-master",
      },
    };

    await expect(submitMessage(nc, "node message")).rejects.toThrow(
      "target pane has unsent prompt input",
    );

    expect(sendLiteral).not.toHaveBeenCalled();
    expect(sendEnter).not.toHaveBeenCalled();
  });

  test("detects non-empty agent prompt input without flagging an empty prompt", () => {
    expect(nonEmptyAgentInput("› Explain this codebase\n")).toBe("Explain this codebase");
    expect(nonEmptyAgentInput("❯ keep monitoring\n")).toBe("keep monitoring");
    expect(nonEmptyAgentInput("› \n  gpt-5.5 xhigh")).toBeNull();
  });

  test("only considers the latest agent prompt input", () => {
    expect(
      nonEmptyAgentInput(
        [
          "❯ GROVE CONTEXT PACK (compact)",
          "  Original message:",
          "  안녕",
          "⏺ 안녕하세요",
          "",
          "────────────────────────────────",
          "❯\u00a0",
          "────────────────────────────────",
          "  ⏵⏵ bypass permissions on",
        ].join("\n"),
      ),
    ).toBeNull();
  });

  test("does not treat dim auto-suggested prompt text as real input", () => {
    expect(
      nonEmptyAgentInput("\u001b[1m›\u001b[0m \u001b[2mExplain this codebase\u001b[0m"),
    ).toBeNull();
    expect(nonEmptyAgentInput("❯\u00a0\u001b[7mk\u001b[0;2meep monitoring\u001b[0m")).toBeNull();
  });
});
