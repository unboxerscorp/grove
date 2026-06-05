import { describe, expect, test } from "vitest";

import { expandRolePreset, listRolePresets, ROLE_PRESET_IDS } from "./role-presets.js";

describe("role presets", () => {
  test("defines every assigned node persona with the shared grove operating model", () => {
    expect(listRolePresets().map((preset) => preset.id)).toEqual([...ROLE_PRESET_IDS]);

    for (const id of ROLE_PRESET_IDS) {
      const expanded = expandRolePreset(id);
      expect(expanded.body).toContain("너는 ");
      expect(expanded.body).toContain("이며 GROVE 조직/업무방식을 따른다");
      expect(expanded.body).toContain("보드 task 중심");
    }
  });
});
