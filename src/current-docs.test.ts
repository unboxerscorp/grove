import { readFileSync } from "node:fs";

import { describe, expect, test } from "vitest";

function doc(path: string): string {
  return readFileSync(path, "utf8");
}

describe("current design docs", () => {
  test("master node design reflects the live routed v2 model", () => {
    const masterNode = doc("docs/design/MASTER_NODE.md");

    expect(masterNode).toContain("Status: current v2 live model");
    expect(masterNode).toContain("Slack and web chat route to the live `grove-master` node");
    expect(masterNode).toContain("Human-facing list items are operator-visible records");
    expect(masterNode).not.toContain("## Phase-1 Scope");
    expect(masterNode).not.toContain("no `web_app.py` route registration");
    expect(masterNode).not.toContain(
      "Only read-only answers and proposal drafts belong in the first adapter",
    );
  });
});
