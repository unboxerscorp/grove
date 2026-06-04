import { z } from "zod";

export const OracleClassSchema = z.enum([
  "read-only",
  "nav",
  "local-toggle",
  "copy",
  "preview",
  "state-change",
  "external",
  "destructive",
  "drag",
]);

export type OracleClass = z.infer<typeof OracleClassSchema>;

export const ButtonStateSchema = z.enum(["enabled", "disabled", "hidden"]);

export const DestructiveGuardSchema = z.enum(["confirm-cancel-only", "mock-only", "isolated-only"]);

export const ButtonInventoryItemSchema = z.object({
  id: z.string(),
  state: ButtonStateSchema,
  oracleClass: OracleClassSchema,
  side_effect: z.boolean().optional(),
  destructive_guard: DestructiveGuardSchema.optional(),
  runnerMetadata: z.string().optional(),
  retryPass: z.boolean().optional(),
});

export type ButtonInventoryItem = z.infer<typeof ButtonInventoryItemSchema>;

export const IgnoreItemSchema = z.object({
  reason: z.string().min(1),
  owner: z.string().min(1),
  expiry: z.string().refine((val) => !isNaN(Date.parse(val)), {
    message: "Invalid date string for expiry",
  }),
});

export type IgnoreItem = z.infer<typeof IgnoreItemSchema>;

export interface CoverageGapResult {
  fail: boolean;
  unregisteredGaps: string[];
  invalidIgnores: string[];
}

export function checkCoverageGaps(
  inventory: Record<string, ButtonInventoryItem>,
  registry: Set<string>,
  ignoreList: Record<string, IgnoreItem>,
  nowMs: number = Date.now(),
): CoverageGapResult {
  const unregisteredGaps: string[] = [];
  const invalidIgnores: string[] = [];

  for (const [id, item] of Object.entries(inventory)) {
    if (item.state === "enabled") {
      const ignored = ignoreList[id];
      let isEffectivelyIgnored = false;

      if (ignored) {
        if (!ignored.owner || !ignored.reason) {
          invalidIgnores.push(id);
        } else {
          const expiryMs = Date.parse(ignored.expiry);
          if (nowMs > expiryMs) {
            invalidIgnores.push(id);
          } else {
            isEffectivelyIgnored = true;
          }
        }
      }

      if (!registry.has(id) && !isEffectivelyIgnored) {
        unregisteredGaps.push(id);
      }
    }
  }

  return {
    fail: unregisteredGaps.length > 0 || invalidIgnores.length > 0,
    invalidIgnores,
    unregisteredGaps,
  };
}

export function filterKGreenAndRetries(
  inventory: Record<string, ButtonInventoryItem>,
): Record<string, ButtonInventoryItem> {
  const filtered: Record<string, ButtonInventoryItem> = {};
  for (const [id, item] of Object.entries(inventory)) {
    if (item.runnerMetadata === "K-green" || item.retryPass === true) {
      continue;
    }
    filtered[id] = item;
  }
  return filtered;
}

export interface LiveSafeResult {
  safe: boolean;
  violations: string[];
}

export function validateLiveSafe(inventory: Record<string, ButtonInventoryItem>): LiveSafeResult {
  const violations: string[] = [];
  const needsGuard = new Set(["state-change", "destructive", "external"]);

  for (const [id, item] of Object.entries(inventory)) {
    if (item.state === "enabled" && needsGuard.has(item.oracleClass)) {
      if (item.side_effect === true && !item.destructive_guard) {
        violations.push(id);
      }
    }
  }

  return {
    safe: violations.length === 0,
    violations,
  };
}
