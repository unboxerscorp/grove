import { describe, expect, test } from "vitest";

import { GroveProjectFileSchema } from "./project-file.js";

describe("GroveProjectFileSchema", () => {
  test("round-trips valid project file JSON", () => {
    const valid = {
      name: "test-project",
      created_at: "2026-06-03T00:00:00.000Z",
      updated_at: "2026-06-03T00:00:00.000Z",
      workspace: "./relative/path",
      nodes: [
        {
          name: "lead",
          agent: "claude",
          role: "Lead",
          description: "Leads the project",
        },
      ],
    };
    const parsed = GroveProjectFileSchema.parse(valid);
    expect(parsed).toEqual(valid);
  });

  test("rejects invalid JSON", () => {
    const invalid = {
      name: "test",
      // missing created_at, updated_at
      workspace: ".",
      nodes: [],
    };
    expect(() => GroveProjectFileSchema.parse(invalid)).toThrow();
  });

  test("allows relative and absolute paths for workspace", () => {
    const base = {
      name: "test-project",
      created_at: "2026-06-03T00:00:00.000Z",
      updated_at: "2026-06-03T00:00:00.000Z",
      nodes: [],
    };
    expect(GroveProjectFileSchema.parse({ ...base, workspace: "./relative" }).workspace).toBe(
      "./relative",
    );
    expect(GroveProjectFileSchema.parse({ ...base, workspace: "../relative" }).workspace).toBe(
      "../relative",
    );
    expect(GroveProjectFileSchema.parse({ ...base, workspace: "/absolute" }).workspace).toBe(
      "/absolute",
    );
  });
});
