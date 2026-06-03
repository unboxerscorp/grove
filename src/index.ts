// Public library API. The CLI (src/cli.ts) is the primary entry point, but the
// same primitives are exported here so grove can be driven programmatically.

export * from "./config.js";
export * from "./context.js";
export * from "./ops.js";
export * from "./rebind.js";
export * from "./registry.js";
export { getAdapter, codexAdapter, claudeAdapter } from "./adapters/index.js";
export type {
  AgentAdapter,
  Completion,
  DetectedSession,
  LaunchSpec,
} from "./adapters/types.js";
export { sleep, poll, parseDuration } from "./util/time.js";
