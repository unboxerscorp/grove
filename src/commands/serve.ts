import { loadContext } from "../context.js";
import { createDefaultGroveFacadeRuntime, createGroveChatServer } from "../serve.js";
import { color, info } from "../util/log.js";
import { parseDuration } from "../util/time.js";

export interface ServeCommandOptions {
  config?: string;
  host?: string;
  port?: string;
  timeout?: string;
}

const CHAT_COMPLETIONS_PATH = "/v1/chat/completions";
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

function parsePort(value: string | undefined): number {
  const port = Number.parseInt(value ?? "8787", 10);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`invalid port: ${value ?? "8787"}`);
  }
  return port;
}

function trimmed(value: string | undefined): string | undefined {
  return value?.trim() || undefined;
}

function hostForUrl(host: string): string {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

function endpointUrl(host: string, port: number): string {
  return `http://${hostForUrl(host)}:${port}${CHAT_COMPLETIONS_PATH}`;
}

function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(host.toLowerCase());
}

export function resolveServeHost(opts: ServeCommandOptions): string {
  const host = trimmed(opts.host);
  const bindHost = host ?? "127.0.0.1";
  if (isLoopbackHost(bindHost)) return bindHost;
  throw new Error(
    `refusing to bind unauthenticated chat-completions facade to non-loopback host "${bindHost}". Use grove-web/bridge for dashboard sharing.`,
  );
}

function printServeAccess(bindHost: string, port: number, nodeNames: string[]): void {
  info(
    `serving OpenAI-compatible chat completions on ${color.cyan(
      endpointUrl(bindHost, port),
    )} for ${nodeNames.map((nodeName) => color.bold(nodeName)).join(", ")}`,
  );
}

export async function cmdServe(nodes: string[], opts: ServeCommandOptions): Promise<void> {
  const ctx = loadContext(opts.config);
  const known = new Set(ctx.nodes.map((node) => node.name));
  const nodeNames = nodes.length > 0 ? nodes : ctx.nodes.map((node) => node.name);
  for (const nodeName of nodeNames) {
    if (!known.has(nodeName)) {
      throw new Error(`unknown node "${nodeName}". known nodes: ${[...known].join(", ")}`);
    }
  }

  const port = parsePort(opts.port);
  const host = resolveServeHost(opts);
  const timeoutMs = parseDuration(opts.timeout, 30 * 60_000);
  const server = createGroveChatServer({
    nodeNames,
    runtime: createDefaultGroveFacadeRuntime(opts.config),
    timeoutMs,
  });

  await new Promise<void>((resolve) => {
    server.listen(port, host, resolve);
  });
  printServeAccess(host, port, nodeNames);

  await new Promise<void>((resolve) => {
    const stop = (): void => {
      server.close(() => {
        resolve();
      });
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
}
