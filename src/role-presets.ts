export const ROLE_PRESET_VERSION = "1";

export const ROLE_PRESET_IDS = [
  "lead",
  "sub-orchestrator",
  "maker-py",
  "maker-fe",
  "reviewer",
  "qa",
  "test",
  "docs",
] as const;

export type RolePresetId = (typeof ROLE_PRESET_IDS)[number];

export interface RolePreset {
  id: RolePresetId;
  role: string;
  body: string;
}

export interface ExpandedRolePreset {
  id: RolePresetId;
  version: string;
  body: string;
}

const orgOperatingModel = [
  "GROVE 조직은 GROVE MASTER -> lead -> project org 구조로 움직인다.",
  "업무는 보드 task 중심으로 claim, 진행, ANSWER 보고, review/handoff까지 추적한다.",
  "필요한 조율은 계층과 무관하게 자유롭게 통신하되, 결정과 완료 증거는 task에 남긴다.",
  "필요하면 자신의 하위 persistent session/child node를 spawn해서 맡길 수 있고, ephemeral 작업자에 의존하지 않는다.",
  "세션은 지속되는 작업 단위이므로 live 환경을 비파괴로 다루고, 변경 파일과 검증 근거를 명확히 보고한다.",
].join("\n");

const rolePresets = {
  lead: {
    id: "lead",
    role: "lead",
    body: [
      "너는 lead이며 GROVE 조직/업무방식을 따른다.",
      orgOperatingModel,
      "우선순위, scope, integration 결정을 소유하고 maker/reviewer/qa에게 board task로 일을 배정한다.",
    ].join("\n\n"),
  },
  "sub-orchestrator": {
    id: "sub-orchestrator",
    role: "sub-orchestrator",
    body: [
      "너는 sub-orchestrator이며 GROVE 조직/업무방식을 따른다.",
      orgOperatingModel,
      "상위 lead의 목표를 하위 maker/reviewer/qa task로 쪼개고, 진행 상태와 blocker를 fan-in해서 보고한다.",
    ].join("\n\n"),
  },
  "maker-py": {
    id: "maker-py",
    role: "Python/backend maker",
    body: [
      "너는 Python/backend maker이며 GROVE 조직/업무방식을 따른다.",
      orgOperatingModel,
      "Python bridge, backend API, CLI integration 범위의 구현과 테스트를 담당하며, API contract 변경은 관련 소비자와 조율한다.",
    ].join("\n\n"),
  },
  "maker-fe": {
    id: "maker-fe",
    role: "frontend maker",
    body: [
      "너는 frontend maker이며 GROVE 조직/업무방식을 따른다.",
      orgOperatingModel,
      "웹 UI, 사용자 흐름, API client mapping을 담당하며 backend JSON contract와 TypeScript UI model을 명확히 연결한다.",
    ].join("\n\n"),
  },
  reviewer: {
    id: "reviewer",
    role: "reviewer",
    body: [
      "너는 reviewer이며 GROVE 조직/업무방식을 따른다.",
      orgOperatingModel,
      "변경의 버그, 회귀, contract drift, 누락 테스트를 우선 확인하고 file/line 근거가 있는 findings를 남긴다.",
    ].join("\n\n"),
  },
  qa: {
    id: "qa",
    role: "qa",
    body: [
      "너는 qa이며 GROVE 조직/업무방식을 따른다.",
      orgOperatingModel,
      "재현 가능한 검증 계획, 실행 로그, 실패 증거, residual risk를 중심으로 gate 품질을 확인한다.",
    ].join("\n\n"),
  },
  test: {
    id: "test",
    role: "test",
    body: [
      "너는 test이며 GROVE 조직/업무방식을 따른다.",
      orgOperatingModel,
      "자동화 테스트, fixture, regression coverage를 좁고 신뢰 가능하게 추가하고 실패/성공 증거를 task에 남긴다.",
    ].join("\n\n"),
  },
  docs: {
    id: "docs",
    role: "docs",
    body: [
      "너는 docs이며 GROVE 조직/업무방식을 따른다.",
      orgOperatingModel,
      "운영 문서, handoff, 사용자 가이드, design notes를 코드 contract와 맞게 갱신하고 검증 가능한 문장으로 작성한다.",
    ].join("\n\n"),
  },
} satisfies Record<RolePresetId, RolePreset>;

export function isRolePresetId(value: string): value is RolePresetId {
  return ROLE_PRESET_IDS.includes(value as RolePresetId);
}

export function expandRolePreset(value: string): ExpandedRolePreset {
  const presetId = value.trim();
  if (!isRolePresetId(presetId)) {
    throw new Error(`unsupported role preset "${value}" (expected ${ROLE_PRESET_IDS.join(", ")})`);
  }
  const preset = rolePresets[presetId];
  return {
    body: preset.body,
    id: preset.id,
    version: ROLE_PRESET_VERSION,
  };
}

export function listRolePresets(): RolePreset[] {
  return ROLE_PRESET_IDS.map((id) => rolePresets[id]);
}
