import { describe, expect, test } from "vitest";

import { expandRolePreset, listRolePresets, ROLE_PRESET_IDS } from "./role-presets.js";

describe("role presets", () => {
  test("defines every assigned node persona with the shared grove operating model", () => {
    expect(listRolePresets().map((preset) => preset.id)).toEqual([...ROLE_PRESET_IDS]);

    for (const id of ROLE_PRESET_IDS) {
      const expanded = expandRolePreset(id);
      expect(expanded.body).toContain("너는 ");
      expect(expanded.body).toContain("이며 GROVE 조직/업무방식을 따른다");
      expect(expanded.body).toContain("노드 간 소통은 계층과 무관하게 직접 한다");
      expect(expanded.body).toContain("사람이 명시 지시한 경우");
      expect(expanded.body).toContain("사람용 목록 항목");
      expect(expanded.body).toContain("프로젝트는 계속 추가될 수 있으므로");
      expect(expanded.body).toContain("compact context");
      expect(expanded.body).not.toContain("보드 task");
    }
  });
});
