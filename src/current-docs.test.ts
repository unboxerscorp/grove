import { readdirSync, readFileSync } from "node:fs";

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
    expect(masterNode).toContain("grove-master -> lead@dev10");
    expect(masterNode).toContain("lead@dev10 -> jester");
    expect(masterNode).toContain("GROVE MASTER -> project lead -> selected project nodes");
    expect(masterNode).toContain("## Node Communication Transport");
    expect(masterNode).toContain("Before writing to a human-facing target pane");
    expect(masterNode).toContain("durable `slack_chat_queue`");
    expect(masterNode).toContain("live request/reply surface today");
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

  test("legacy master design is clearly marked as historical", () => {
    const legacyMaster = doc("docs/V1_MASTER_DESIGN.md");

    expect(legacyMaster).toContain("Status: historical v1 master design");
    expect(legacyMaster).toMatch(
      /Current live master-node behavior is\s+>\s+documented in `docs\/design\/MASTER_NODE\.md`/,
    );
    expect(legacyMaster).toContain("Slack and web");
    expect(legacyMaster).toContain("human-facing list items only");
  });

  test("legacy v1 roadmap and brainstorm docs are clearly historical", () => {
    const legacyRoadmaps = readdirSync("docs").filter((name) => /^ROADMAP_v1\.\d+\.md$/.test(name));
    const legacyBrainstorms = readdirSync("docs").filter((name) =>
      /^V1[._].*BRAINSTORM\.md$/.test(name),
    );

    expect(legacyRoadmaps.length).toBeGreaterThan(0);
    expect(legacyBrainstorms.length).toBeGreaterThan(0);
    for (const name of legacyRoadmaps) {
      const body = doc(`docs/${name}`);
      expect(body).toContain("Status: historical v1 roadmap");
      expect(body).not.toContain("autonomous build in progress");
    }
    for (const name of legacyBrainstorms) {
      const body = doc(`docs/${name}`);
      expect(body).toContain("Status: historical v1 brainstorm");
    }
  });

  test("grove agent skill surfaces use item wording", () => {
    const generated = doc("scripts/generate_grove_skills.py");
    const harness = doc("skills-src/grove-harness/SKILL.md");

    expect(`${generated}\n${harness}`).toContain("human-facing item");
    expect(`${generated}\n${harness}`).not.toContain("human-facing task");
    expect(harness).not.toContain("Human task API");
  });

  test("README examples use item ids for human-facing list commands", () => {
    const readme = doc("README.md");

    expect(readme).toContain("grove task ask-human <item_id>");
    expect(readme).not.toContain("grove task ask-human task_123");
  });

  test("README describes the current cockpit product surface", () => {
    const readme = doc("README.md");

    expect(readme).toContain("web cockpit");
    expect(readme).not.toContain("dev-room web SPA");
    expect(readme).not.toContain("Web dev-room SPA");
    expect(readme).not.toContain("dev-room list access");
    expect(readme).not.toContain("one project, one tmux session, one");
  });

  test("web README describes the current cockpit and item model", () => {
    const webReadme = doc("web/README.md");

    expect(webReadme).toContain("Grove web cockpit");
    expect(webReadme).toContain("human-facing items");
    expect(webReadme).not.toContain("Grove Dev Room");
    expect(webReadme).not.toContain("kanban board");
    expect(webReadme).not.toContain("task detail");
    expect(webReadme).not.toContain("dev-room SPA");
  });

  test("web metadata describes the current cockpit model", () => {
    const webMetadata = [
      doc("web/index.html"),
      doc("web/package.json"),
      doc("web/build.mjs"),
      doc("web/src/styles.css"),
      doc("web/src/i18n.tsx"),
      doc("web/mock/index.html"),
    ].join("\n");

    expect(webMetadata).toContain("cockpit");
    expect(webMetadata).not.toContain("Grove Dev Room");
    expect(webMetadata).not.toContain("Dev Room SPA");
    expect(webMetadata).not.toContain("dev room · live cockpit");
    expect(webMetadata).not.toContain("grove is a dev room");
  });

  test("bridge web startup copy describes the current cockpit model", () => {
    const bridgeWeb = doc("bridge/src/grove_bridge/web_app.py");

    expect(bridgeWeb).toContain('FastAPI(title="grove cockpit")');
    expect(bridgeWeb).not.toContain("Grove dev-room web server");
    expect(bridgeWeb).not.toContain("Grove dev-room is starting.");
    expect(bridgeWeb).not.toContain("Run the grove dev-room web server.");
  });
});
