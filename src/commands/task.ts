import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { loadConfig } from "../config.js";
import { warn } from "../util/log.js";
import { validateGroveName } from "../util/names.js";
import { sessionDir } from "../util/paths.js";

const DEFAULT_SESSION = "dev10";
const DEFAULT_BOARD = "default";
const FALLBACK_WEB_URL = "http://127.0.0.1:8765";

const TASK_STATUS_BY_ACTION = {
  "ask-human": "ask_human",
  block: "blocked",
  done: "done",
  review: "review",
  start: "running",
} as const;

export type TaskAction = keyof typeof TASK_STATUS_BY_ACTION;

export interface TaskInput {
  allowRemote?: boolean;
  board?: string;
  comment?: string;
  config?: string;
  fromStatus?: string;
  idempotencyKey?: string;
  reviewer?: string;
  runId?: string;
  session?: string;
}

export interface TaskTransitionResult {
  session: string;
  board: string;
  taskId: string;
  status: string;
  url: string;
  task: Record<string, unknown>;
}

export interface TaskFetchInit {
  method: "PATCH";
  headers: Record<string, string>;
  body: string;
}

export interface TaskFetchResponse {
  ok: boolean;
  status: number;
  statusText: string;
  text(): Promise<string>;
}

export type TaskFetch = (url: string, init: TaskFetchInit) => Promise<TaskFetchResponse>;

export interface TaskDeps {
  env: NodeJS.ProcessEnv;
  fetch: TaskFetch;
  loadConfigSession(config?: string): string | null;
  readText(file: string): string | null;
  sessionDir(session: string): string;
  warn(message: string): void;
}

const defaultDeps: TaskDeps = {
  env: process.env,
  fetch: async (url, init) => fetch(url, init),
  loadConfigSession: optionalConfigSession,
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

function resolveSession(input: TaskInput, deps: TaskDeps): string {
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

export function isLoopbackTaskWebUrl(baseUrl: string): boolean {
  return new Set(["127.0.0.1", "localhost", "::1"]).has(normalizedHostname(baseUrl));
}

function assertRemoteAllowed(baseUrl: string, input: TaskInput, deps: TaskDeps): void {
  if (isLoopbackTaskWebUrl(baseUrl)) return;
  if (input.allowRemote || isTruthyEnv(deps.env["GROVE_TASK_ALLOW_REMOTE"])) {
    deps.warn(`task command sending dashboard token to non-loopback grove-web URL: ${baseUrl}`);
    return;
  }
  throw new Error(
    `refusing to send dashboard token to non-loopback grove-web URL: ${baseUrl}; use --allow-remote or GROVE_TASK_ALLOW_REMOTE=1 only for trusted endpoints`,
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

export function discoverTaskWebUrl(session: string, deps: TaskDeps = defaultDeps): string {
  const envUrl = trimmed(deps.env["GROVE_WEB_URL"]);
  if (envUrl) return normalizeBaseUrl(envUrl);

  const webJson = deps.readText(webJsonPathFor(deps.sessionDir(session)));
  if (webJson) {
    const discovered = baseUrlFromWebJson(webJson);
    if (discovered) return discovered;
  }

  return FALLBACK_WEB_URL;
}

function readToken(session: string, deps: TaskDeps): { path: string; token: string } {
  const file = tokenPathFor(deps.sessionDir(session));
  const token = trimmed(deps.readText(file) ?? undefined);
  if (!token) {
    throw new Error(
      `dashboard token not found for session ${session}: expected ${file}; start grove-web --session ${session}`,
    );
  }
  return { path: file, token };
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

function statusPayload(status: string, board: string, input: TaskInput): Record<string, unknown> {
  const payload: Record<string, unknown> = { board, status };
  const fromStatus = trimmed(input.fromStatus);
  const runId = trimmed(input.runId);
  const idempotencyKey = trimmed(input.idempotencyKey);
  const reviewer = trimmed(input.reviewer);
  const comment = trimmed(input.comment);
  if (fromStatus) payload["from_status"] = fromStatus;
  if (runId) payload["run_id"] = runId;
  if (idempotencyKey) payload["idempotency_key"] = idempotencyKey;
  if (reviewer) payload["reviewer"] = reviewer;
  if (comment) payload["comment"] = comment;
  return payload;
}

export function statusForTaskAction(action: TaskAction): string {
  return TASK_STATUS_BY_ACTION[action];
}

export async function updateTaskStatus(
  action: TaskAction,
  taskIdInput: string,
  input: TaskInput = {},
  deps: TaskDeps = defaultDeps,
): Promise<TaskTransitionResult> {
  const taskId = validateGroveName(taskIdInput.trim(), "task_id");
  const status = statusForTaskAction(action);
  const session = resolveSession(input, deps);
  const board = validateGroveName(trimmed(input.board) ?? DEFAULT_BOARD, "--board");
  const baseUrl = discoverTaskWebUrl(session, deps);
  assertRemoteAllowed(baseUrl, input, deps);
  const { path: tokenPath, token } = readToken(session, deps);
  const endpoint = `${baseUrl}/api/tasks/${encodeURIComponent(taskId)}/status`;

  let response: TaskFetchResponse;
  try {
    response = await deps.fetch(endpoint, {
      body: JSON.stringify(statusPayload(status, board, input)),
      headers: {
        "Content-Type": "application/json",
        Origin: new URL(baseUrl).origin,
        "X-Grove-Project": session,
        "X-Grove-Session-Token": token,
      },
      method: "PATCH",
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
    const kind = response.status === 409 ? "task status conflict" : "task status update failed";
    throw new Error(
      `grove-web ${kind} at ${endpoint} for session ${session} (HTTP ${response.status} ${response.statusText}; token ${tokenPath})${details ? `: ${details}` : ""}`,
    );
  }

  return {
    board,
    session,
    status,
    task: parseTask(responseText),
    taskId,
    url: baseUrl,
  };
}

export function renderTaskText(result: TaskTransitionResult): string {
  const actualStatus = result.task["status"];
  const status = typeof actualStatus === "string" ? actualStatus : result.status;
  return `task ${result.taskId} -> ${status} on ${result.board} (${result.session})`;
}

export function renderTaskJson(result: TaskTransitionResult): string {
  return JSON.stringify(result.task, null, 2);
}

export async function cmdTask(
  action: TaskAction,
  taskId: string,
  opts: TaskInput & { json?: boolean },
  deps: TaskDeps = defaultDeps,
): Promise<void> {
  const result = await updateTaskStatus(action, taskId, opts, deps);
  process.stdout.write(`${opts.json ? renderTaskJson(result) : renderTaskText(result)}\n`);
}
