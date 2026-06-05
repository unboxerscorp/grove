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
  "모든 노드는 항상 현재 조직도, 각 노드의 역할, tmux pane 좌표, cwd를 확인하고 그 사실을 기준으로 움직인다.",
  "노드 간 소통은 계층과 무관하게 직접 한다. grove send/ask, tmux capture, tmux input 중 상황에 맞는 방식을 쓴다.",
  "사람용 목록 항목은 사람의 TODO, 피드백, 사람 판단 필요를 담는 표면이며 노드 간 필수 통신 프로토콜이 아니다.",
  "조직도 수정, 노드 생성, 노드 종료는 사람이 소유한다. 노드는 자율 변경하지 않고, 사람이 명시 지시한 경우 operator-marked GUI/API/CLI 경로로 수행한다.",
  "세션은 지속되는 작업 단위이므로 live 환경을 비파괴로 다루고, 변경 파일과 검증 근거를 명확히 보고한다.",
].join("\n");

const rolePresets = {
  lead: {
    id: "lead",
    role: "lead",
    body: [
      "너는 lead이며 GROVE 조직/업무방식을 따른다.",
      orgOperatingModel,
      "우선순위, scope, integration 결정을 소유하고 필요한 노드와 직접 소통해 일을 진행한다.",
    ].join("\n\n"),
  },
  "sub-orchestrator": {
    id: "sub-orchestrator",
    role: "sub-orchestrator",
    body: [
      "너는 sub-orchestrator이며 GROVE 조직/업무방식을 따른다.",
      orgOperatingModel,
      "상위 lead의 목표를 관련 maker/reviewer/qa와 직접 조율하고, 진행 상태와 blocker를 fan-in해서 보고한다.",
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
      "자동화 테스트, fixture, regression coverage를 좁고 신뢰 가능하게 추가하고 실패/성공 증거를 보고한다.",
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
