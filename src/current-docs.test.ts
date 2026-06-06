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

  test("auth and project lifecycle design reflects the live routed auth model", () => {
    const authAndProjects = doc("docs/design/AUTH_AND_PROJECTS.md");

    expect(authAndProjects).toContain("Status: current v2 live auth and project lifecycle model");
    expect(authAndProjects).toContain("Team-auth mode is implemented in the bridge and web UI");
    expect(authAndProjects).toContain(
      "Shared access is implemented as default-off one-time join codes",
    );
    expect(authAndProjects).not.toContain("Phase 1 is design and new-module scaffolding only");
    expect(authAndProjects).not.toContain("no `web_app.py` route registration");
    expect(authAndProjects).not.toContain("no `app.tsx` or frontend core wiring");
    expect(authAndProjects).not.toContain(
      "The phase-1 bridge module, `grove_bridge.auth`, defines typed auth interfaces",
    );
  });

  test("legacy team auth design is clearly marked as historical", () => {
    const teamAuth = doc("docs/DESIGN_team_auth.md");

    expect(teamAuth).toContain("Status: historical v1.2 design");
    expect(teamAuth).toContain(
      "Current live auth is documented in `docs/design/AUTH_AND_PROJECTS.md`",
    );
    expect(teamAuth).not.toContain("상태: v1.2 설계안. 구현은 후속 작업에서 진행한다.");
  });
});
