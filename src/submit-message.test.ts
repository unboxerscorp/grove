import { afterEach, describe, expect, test, vi } from "vitest";

import { antigravityAdapter } from "./adapters/antigravity.js";
import type { NodeCtx } from "./context.js";
import { submitMessage } from "./ops.js";
import { sendEnter, sendLiteral } from "./tmux.js";
import { sleep } from "./util/time.js";

vi.mock("./tmux.js", () => ({
  sendEnter: vi.fn(async () => undefined),
  sendLiteral: vi.fn(async () => undefined),
}));

vi.mock("./util/time.js", () => ({
  poll: vi.fn(),
  sleep: vi.fn(async () => undefined),
  waitForChangeOrTimeout: vi.fn(),
}));

afterEach(() => {
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

    expect(sequence).toEqual([
      "literal:\u001b[200~ship it\u001b[201~",
      "sleep:220",
      "enter",
      "sleep:260",
      "enter",
    ]);
  });
});
