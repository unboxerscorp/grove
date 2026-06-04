import fs from "fs";
import path from "path";
import { describe, expect, test } from "vitest";

import {
  type ButtonInventoryItem,
  checkCoverageGaps,
  DestructiveGuardSchema,
  filterKGreenAndRetries,
  type IgnoreItem,
  OracleClassSchema,
  validateLiveSafe,
} from "./ui-oracle.js";

interface ControlItem {
  id: string;
  oracle_class: string;
  live_safe: boolean;
  destructive_guard?: string;
}

interface ControlsFile {
  controls: ControlItem[];
}

describe("ui-oracle", () => {
  describe("controls.json validation", () => {
    test("single source vocabulary and live_safe rules", () => {
      const p = path.resolve(__dirname, "../web/e2e/registry/controls.json");
      const data = JSON.parse(fs.readFileSync(p, "utf-8")) as ControlsFile;

      const needsGuard = new Set(["state-change", "destructive", "external", "drag"]);

      for (const c of data.controls) {
        // Validate oracle class
        expect(() => OracleClassSchema.parse(c.oracle_class)).not.toThrow();

        // Validate destructive guard if present
        if (c.destructive_guard) {
          expect(() => DestructiveGuardSchema.parse(c.destructive_guard)).not.toThrow();
        }

        // Enforce live_safe rules
        if (needsGuard.has(c.oracle_class)) {
          expect(c.live_safe).toBe(false);
          expect(c.destructive_guard).toBeDefined();
        } else {
          expect(c.live_safe).toBe(true);
        }
      }
    });
  });

  describe("checkCoverageGaps", () => {
    test("fails if enabled high-risk unmapped controls are unregistered", () => {
      const inventory: Record<string, ButtonInventoryItem> = {
        "cmdk.item": { id: "cmdk.item", oracleClass: "nav", state: "enabled" },
        "chrome.lang": { id: "chrome.lang", oracleClass: "read-only", state: "enabled" },
        "chrome.authBadge": { id: "chrome.authBadge", oracleClass: "read-only", state: "enabled" },
        "exec.confirmYes": {
          id: "exec.confirmYes",
          oracleClass: "destructive",
          state: "enabled",
          side_effect: true,
        },
        "ledger.quotaYes": {
          id: "ledger.quotaYes",
          oracleClass: "state-change",
          state: "enabled",
          side_effect: true,
        },
        "cost.refresh": { id: "cost.refresh", oracleClass: "read-only", state: "enabled" },
        "handoff.previewBtn": {
          id: "handoff.previewBtn",
          oracleClass: "preview",
          state: "enabled",
        },
        "handoff.acceptYes": {
          id: "handoff.acceptYes",
          oracleClass: "external",
          state: "enabled",
          side_effect: true,
        },
        "routing.confirmYes": {
          id: "routing.confirmYes",
          oracleClass: "state-change",
          state: "enabled",
          side_effect: true,
        },
        "slack.test": {
          id: "slack.test",
          oracleClass: "external",
          state: "enabled",
          side_effect: true,
        },
        "slack.save": {
          id: "slack.save",
          oracleClass: "external",
          state: "enabled",
          side_effect: true,
        },
        "connect.reissue": {
          id: "connect.reissue",
          oracleClass: "external",
          state: "enabled",
          side_effect: true,
        },
        "connect.joinBtn": {
          id: "connect.joinBtn",
          oracleClass: "state-change",
          state: "enabled",
          side_effect: true,
        },
        "terminal.connect": {
          id: "terminal.connect",
          oracleClass: "external",
          state: "enabled",
          side_effect: true,
        },
        "terminal.send": {
          id: "terminal.send",
          oracleClass: "external",
          state: "enabled",
          side_effect: true,
        },
      };

      const result = checkCoverageGaps(inventory, new Set(), {});
      expect(result.fail).toBe(true);
      expect(result.unregisteredGaps).toEqual(Object.keys(inventory));
    });

    test("passes if enabled item is in registry", () => {
      const inventory: Record<string, ButtonInventoryItem> = {
        "btn-1": {
          id: "btn-1",
          oracleClass: "read-only",
          state: "enabled",
        },
      };

      const result = checkCoverageGaps(inventory, new Set(["btn-1"]), {});
      expect(result.fail).toBe(false);
      expect(result.unregisteredGaps).toEqual([]);
    });

    test("fails if ignore item is expired", () => {
      const inventory: Record<string, ButtonInventoryItem> = {
        "btn-1": {
          id: "btn-1",
          oracleClass: "read-only",
          state: "enabled",
        },
      };

      const ignoreList: Record<string, IgnoreItem> = {
        "btn-1": {
          expiry: "2020-01-01T00:00:00Z",
          owner: "test",
          reason: "flake",
        },
      };

      const result = checkCoverageGaps(
        inventory,
        new Set(),
        ignoreList,
        new Date("2026-06-05T00:00:00Z").getTime(),
      );
      expect(result.fail).toBe(true);
      expect(result.invalidIgnores).toEqual(["btn-1"]);
      expect(result.unregisteredGaps).toEqual(["btn-1"]);
    });

    test("passes if ignore item is valid and not expired", () => {
      const inventory: Record<string, ButtonInventoryItem> = {
        "btn-1": {
          id: "btn-1",
          oracleClass: "read-only",
          state: "enabled",
        },
      };

      const ignoreList: Record<string, IgnoreItem> = {
        "btn-1": {
          expiry: "2030-01-01T00:00:00Z",
          owner: "test",
          reason: "flake",
        },
      };

      const result = checkCoverageGaps(
        inventory,
        new Set(),
        ignoreList,
        new Date("2026-06-05T00:00:00Z").getTime(),
      );
      expect(result.fail).toBe(false);
      expect(result.invalidIgnores).toEqual([]);
      expect(result.unregisteredGaps).toEqual([]);
    });

    test("passes if item is disabled or hidden", () => {
      const inventory: Record<string, ButtonInventoryItem> = {
        "btn-1": {
          id: "btn-1",
          oracleClass: "read-only",
          state: "disabled",
        },
        "btn-2": {
          id: "btn-2",
          oracleClass: "read-only",
          state: "hidden",
        },
      };

      const result = checkCoverageGaps(inventory, new Set(), {});
      expect(result.fail).toBe(false);
      expect(result.unregisteredGaps).toEqual([]);
    });
  });

  describe("filterKGreenAndRetries", () => {
    test("removes items with runnerMetadata K-green or retryPass", () => {
      const inventory: Record<string, ButtonInventoryItem> = {
        "btn-1": {
          id: "btn-1",
          oracleClass: "nav",
          runnerMetadata: "K-green",
          state: "enabled",
        },
        "btn-2": {
          id: "btn-2",
          oracleClass: "copy",
          retryPass: true,
          state: "enabled",
        },
        "btn-3": {
          id: "btn-3",
          oracleClass: "local-toggle",
          state: "enabled",
        },
      };

      const filtered = filterKGreenAndRetries(inventory);
      expect(Object.keys(filtered)).toEqual(["btn-3"]);
    });
  });

  describe("validateLiveSafe", () => {
    test("fails if high risk controls like slack/node-send/terminal/handoff lack guard", () => {
      const inventory: Record<string, ButtonInventoryItem> = {
        "slack.test": {
          id: "slack.test",
          oracleClass: "external",
          side_effect: true,
          state: "enabled",
          // missing destructive_guard
        },
        "terminal.send": {
          id: "terminal.send",
          oracleClass: "external",
          side_effect: true,
          state: "enabled",
        },
      };

      const result = validateLiveSafe(inventory);
      expect(result.safe).toBe(false);
      expect(result.violations).toEqual(["slack.test", "terminal.send"]);
    });

    test("fails if state-change/destructive/external has side_effect=true but no destructive_guard", () => {
      const inventory: Record<string, ButtonInventoryItem> = {
        "btn-1": {
          id: "btn-1",
          oracleClass: "state-change",
          side_effect: true,
          state: "enabled",
        },
      };

      const result = validateLiveSafe(inventory);
      expect(result.safe).toBe(false);
      expect(result.violations).toEqual(["btn-1"]);
    });

    test("passes if guarded or no side effect", () => {
      const inventory: Record<string, ButtonInventoryItem> = {
        "btn-1": {
          destructive_guard: "mock-only",
          id: "btn-1",
          oracleClass: "state-change",
          side_effect: true,
          state: "enabled",
        },
        "btn-2": {
          id: "btn-2",
          oracleClass: "destructive",
          side_effect: false,
          state: "enabled",
        },
        "btn-3": {
          id: "btn-3",
          oracleClass: "nav",
          side_effect: true,
          state: "enabled",
        },
      };

      const result = validateLiveSafe(inventory);
      expect(result.safe).toBe(true);
      expect(result.violations).toEqual([]);
    });
  });
});
