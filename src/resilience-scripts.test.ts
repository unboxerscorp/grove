import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

const tempRoots: string[] = [];

afterEach(() => {
  while (tempRoots.length > 0) {
    rmSync(tempRoots.pop()!, { force: true, recursive: true });
  }
});

function tempRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), "grove-resilience-"));
  tempRoots.push(root);
  return root;
}

function minimalSnapshot(root: string): string {
  const snapshot = path.join(root, "snapshot");
  const bundle = path.join(snapshot, "bundle");
  const empty = path.join(root, "empty-grove-home");
  mkdirSync(bundle, { recursive: true });
  mkdirSync(empty, { recursive: true });
  writeFileSync(
    path.join(bundle, "bundle.json"),
    JSON.stringify(
      {
        files: { project: "grove.project.json" },
        name: "alpha",
        schema: 1,
        type: "grove.project.bundle",
      },
      null,
      2,
    ) + "\n",
  );
  writeFileSync(
    path.join(bundle, "grove.project.json"),
    JSON.stringify({ name: "alpha", nodes: [], workspace: "." }, null, 2) + "\n",
  );
  const archive = path.join(snapshot, "dot-grove.tgz");
  const tar = spawnSync("tar", ["-czf", archive, "-C", empty, "."], {
    encoding: "utf8",
  });
  if (tar.status !== 0) {
    throw new Error(`tar failed: ${tar.stderr}`);
  }
  return snapshot;
}

describe("resilience restore live guards", () => {
  test("refuses the current live web port", () => {
    const root = tempRoot();
    const snapshot = minimalSnapshot(root);

    const proc = spawnSync(
      "bash",
      [
        "scripts/restore.sh",
        "--snapshot",
        snapshot,
        "--target-session",
        "alpha-restore",
        "--target-grove-home",
        path.join(root, "restore-home"),
        "--target-project-dir",
        path.join(root, "alpha-restore"),
        "--web-port",
        "8765",
      ],
      { cwd: process.cwd(), encoding: "utf8" },
    );

    expect(proc.status).not.toBe(0);
    expect(proc.stderr).toContain("refusing live web port 8765");
  });
});
