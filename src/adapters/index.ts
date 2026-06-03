import type { AgentType } from "../config.js";
import { antigravityAdapter } from "./antigravity.js";
import { claudeAdapter } from "./claude.js";
import { codexAdapter } from "./codex.js";
import type { AgentAdapter } from "./types.js";

const ADAPTERS: Record<AgentType, AgentAdapter> = {
  antigravity: antigravityAdapter,
  codex: codexAdapter,
  claude: claudeAdapter,
};

export function getAdapter(agent: AgentType): AgentAdapter {
  const a = ADAPTERS[agent];
  if (!a) throw new Error(`no adapter for agent type: ${agent}`);
  return a;
}

export type { AgentAdapter, Completion, DetectedSession, LaunchSpec } from "./types.js";
export { antigravityAdapter, claudeAdapter, codexAdapter };
