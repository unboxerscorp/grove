import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { writeFileAtomicSync } from "./atomic.js";
import { homedir } from "./paths.js";

export function codexConfigPath(): string {
  return path.join(homedir(), ".codex", "config.toml");
}

function quoteTomlKey(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function projectHeader(cwd: string): string {
  return `[projects."${quoteTomlKey(path.resolve(cwd))}"]`;
}

export function ensureCodexTrustedProject(cwd: string, configPath = codexConfigPath()): boolean {
  const header = projectHeader(cwd);
  const trustedLine = 'trust_level = "trusted"';
  const text = existsSync(configPath) ? readFileSync(configPath, "utf8") : "";
  const lines = text ? text.split("\n") : [];
  const sectionStart = lines.findIndex((line) => line.trim() === header);

  if (sectionStart < 0) {
    const prefix = text && !text.endsWith("\n") ? "\n" : "";
    const spacer = text && !text.endsWith("\n\n") ? "\n" : "";
    writeFileAtomicSync(configPath, `${text}${prefix}${spacer}${header}\n${trustedLine}\n`);
    return true;
  }

  let sectionEnd = sectionStart + 1;
  while (sectionEnd < lines.length && !lines[sectionEnd]!.trim().startsWith("[")) {
    sectionEnd += 1;
  }

  const trustIndex = lines.findIndex(
    (line, index) => index > sectionStart && index < sectionEnd && /^\s*trust_level\s*=/.test(line),
  );
  if (trustIndex >= 0) {
    if (lines[trustIndex]!.trim() === trustedLine) return false;
    lines[trustIndex] = trustedLine;
  } else {
    lines.splice(sectionStart + 1, 0, trustedLine);
  }

  writeFileAtomicSync(configPath, lines.join("\n"));
  return true;
}
