import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { loadConfig } from "../config.js";
import { loadRegistry, type Registry } from "../registry.js";
import { warn } from "../util/log.js";
import { validateGroveName } from "../util/names.js";
import { sessionDir } from "../util/paths.js";

const DEFAULT_SESSION = "dev10";
const DEFAULT_BOARD = "default";
const FALLBACK_WEB_URL = "http://127.0.0.1:8765";

export interface DelegateInput {
  allowRemote?: boolean;
  body?: string;
  board?: string;
  config?: string;
  session?: string;
}

export interface DelegateResult {
  session: string;
  board: string;
  node: string;
  url: string;
  task: Record<string, unknown>;
}

export interface DelegateFetchInit {
  method: "POST";
  headers: Record<string, string>;
  body: string;
}

export interface DelegateFetchResponse {
  ok: boolean;
  status: number;
  statusText: string;
  text(): Promise<string>;
}

export type DelegateFetch = (
  url: string,
  init: DelegateFetchInit,
) => Promise<DelegateFetchResponse>;

export interface DelegateDeps {
  env: NodeJS.ProcessEnv;
  fetch: DelegateFetch;
  loadConfigSession(config?: string): string | null;
  loadRegistry(session: string): Registry | null;
  readText(file: string): string | null;
  sessionDir(session: string): string;
  warn(message: string): void;
}

const defaultDeps: DelegateDeps = {
  env: process.env,
  fetch: async (url, init) => fetch(url, init),
  loadConfigSession: optionalConfigSession,
  loadRegistry,
  readText(file) {
    return existsSync(file) ? readFileSync(file, "utf8") : null;
  },
  sessionDir,
  warn,
};

function trimmed(value: string | undefined): string | undefined {
  return value?.trim() || undefined;
}

function optionalConfigSession(config?: string): string | null {
  try {
    return loadConfig(config).config.session;
  } catch (error) {
    if (!config && error instanceof Error && error.message.startsWith("no grove.yaml found")) {
      return null;
    }
    throw error;
  }
}

function resolveSession(input: DelegateInput, deps: DelegateDeps): string {
  const session =
    trimmed(input.session) ??
    deps.loadConfigSession(input.config) ??
    trimmed(deps.env["GROVE_VIEWER_SESSION"]) ??
    DEFAULT_SESSION;
  return validateGroveName(session, "--session");
}

function tokenPathFor(dir: string): string {
  return path.join(dir, "dashboard-token");
}

function webJsonPathFor(dir: string): string {
  return path.join(dir, "web.json");
}

function normalizeBaseUrl(value: string): string {
  const url = new URL(value);
  return url.origin;
}

function isTruthyEnv(value: string | undefined): boolean {
  return ["1", "true", "yes"].includes(value?.trim().toLowerCase() ?? "");
}

function normalizedHostname(baseUrl: string): string {
  const hostname = new URL(baseUrl).hostname.toLowerCase();
  return hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
}

export function isLoopbackWebUrl(baseUrl: string): boolean {
  return new Set(["127.0.0.1", "localhost", "::1"]).has(normalizedHostname(baseUrl));
}

function assertRemoteAllowed(baseUrl: string, input: DelegateInput, deps: DelegateDeps): void {
  if (isLoopbackWebUrl(baseUrl)) return;
  if (input.allowRemote || isTruthyEnv(deps.env["GROVE_DELEGATE_ALLOW_REMOTE"])) {
    deps.warn(`delegate sending dashboard token to non-loopback grove-web URL: ${baseUrl}`);
    return;
  }
  throw new Error(
    `refusing to send dashboard token to non-loopback grove-web URL: ${baseUrl}; use --allow-remote or GROVE_DELEGATE_ALLOW_REMOTE=1 only for trusted endpoints`,
  );
}

function baseUrlFromWebJson(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const data = parsed as Record<string, unknown>;
  if (typeof data["url"] === "string" && data["url"].trim()) {
    return normalizeBaseUrl(data["url"].trim());
  }
  if (typeof data["port"] === "number" && Number.isInteger(data["port"])) {
    const host =
      typeof data["host"] === "string" && data["host"].trim() ? data["host"] : "127.0.0.1";
    return normalizeBaseUrl(`http://${host}:${data["port"]}`);
  }
  return null;
}

export function discoverWebUrl(session: string, deps: DelegateDeps = defaultDeps): string {
  const envUrl = trimmed(deps.env["GROVE_WEB_URL"]);
  if (envUrl) return normalizeBaseUrl(envUrl);

  const webJson = deps.readText(webJsonPathFor(deps.sessionDir(session)));
  if (webJson) {
    const discovered = baseUrlFromWebJson(webJson);
    if (discovered) return discovered;
  }

  return FALLBACK_WEB_URL;
}

function readToken(session: string, deps: DelegateDeps): { path: string; token: string } {
  const file = tokenPathFor(deps.sessionDir(session));
  const token = trimmed(deps.readText(file) ?? undefined);
  if (!token) {
    throw new Error(
      `dashboard token not found for session ${session}: expected ${file}; start grove-web --session ${session}`,
    );
  }
  return { path: file, token };
}

function assertNodeExists(session: string, node: string, deps: DelegateDeps): void {
  const registry = deps.loadRegistry(session);
  if (!registry) {
    throw new Error(`no registry found for session ${session}; run grove up or grove spawn first`);
  }
  if (!registry.nodes[node]) {
    const known = Object.keys(registry.nodes).join(", ") || "(none)";
    throw new Error(`node not found in registry: ${node}. known nodes: ${known}`);
  }
}

function parseTask(text: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Fall through to the uniform malformed response error below.
  }
  throw new Error("grove-web returned a malformed task response");
}

function errorSnippet(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 300);
}

export async function delegateTask(
  nodeName: string,
  titleInput: string,
  input: DelegateInput = {},
  deps: DelegateDeps = defaultDeps,
): Promise<DelegateResult> {
  const node = validateGroveName(nodeName.trim(), "node");
  const title = titleInput.trim();
  if (!title) throw new Error("delegate title is required");

  const session = resolveSession(input, deps);
  const board = validateGroveName(trimmed(input.board) ?? DEFAULT_BOARD, "--board");
  assertNodeExists(session, node, deps);

  const baseUrl = discoverWebUrl(session, deps);
  assertRemoteAllowed(baseUrl, input, deps);
  const { path: tokenPath, token } = readToken(session, deps);
  const endpoint = `${baseUrl}/api/boards/${encodeURIComponent(board)}/tasks`;
  const payload = {
    assignee: node,
    body: input.body ?? null,
    priority: 0,
    status: "ready",
    title,
  };

  let response: DelegateFetchResponse;
  try {
    response = await deps.fetch(endpoint, {
      body: JSON.stringify(payload),
      headers: {
        "Content-Type": "application/json",
        Origin: new URL(baseUrl).origin,
        "X-Grove-Project": session,
        "X-Grove-Session-Token": token,
      },
      method: "POST",
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `could not reach grove-web at ${baseUrl} for session ${session}; start grove-web --session ${session} or set GROVE_WEB_URL (${message})`,
    );
  }

  const responseText = await response.text();
  if (!response.ok) {
    const details = errorSnippet(responseText);
    throw new Error(
      `grove-web task create failed at ${endpoint} for session ${session} (HTTP ${response.status} ${response.statusText}; token ${tokenPath})${details ? `: ${details}` : ""}`,
    );
  }

  return {
    board,
    node,
    session,
    task: parseTask(responseText),
    url: baseUrl,
  };
}

export function renderDelegateText(result: DelegateResult): string {
  const id = typeof result.task["id"] === "string" ? result.task["id"] : "(unknown-task)";
  return `delegated ${id} -> ${result.node} on ${result.board} (${result.session})`;
}

export function renderDelegateJson(result: DelegateResult): string {
  return JSON.stringify(result.task, null, 2);
}

export async function cmdDelegate(
  node: string,
  title: string,
  opts: DelegateInput & { json?: boolean },
  deps: DelegateDeps = defaultDeps,
): Promise<void> {
  const result = await delegateTask(node, title, opts, deps);
  process.stdout.write(`${opts.json ? renderDelegateJson(result) : renderDelegateText(result)}\n`);
}
