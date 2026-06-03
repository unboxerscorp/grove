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

function parsePort(value: string | undefined): number {
  const port = Number.parseInt(value ?? "8787", 10);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`invalid port: ${value ?? "8787"}`);
  }
  return port;
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

  const host = opts.host ?? "127.0.0.1";
  const port = parsePort(opts.port);
  const timeoutMs = parseDuration(opts.timeout, 30 * 60_000);
  const server = createGroveChatServer({
    nodeNames,
    runtime: createDefaultGroveFacadeRuntime(opts.config),
    timeoutMs,
  });

  await new Promise<void>((resolve) => {
    server.listen(port, host, resolve);
  });
  info(
    `serving OpenAI-compatible chat completions on ${color.cyan(
      `http://${host}:${port}/v1/chat/completions`,
    )} for ${nodeNames.map((nodeName) => color.bold(nodeName)).join(", ")}`,
  );

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
