import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import { z } from "zod";

import { loadContext, nodeOf } from "./context.js";
import { ask } from "./ops.js";

const DEFAULT_MODEL = "grove";
const DEFAULT_STICKY_SESSION_TTL_MS = 60 * 60 * 1000;
const DEFAULT_MAX_STICKY_SESSIONS = 1024;
const MAX_BODY_BYTES = 1024 * 1024;
const LEGACY_SESSION_HEADER = "x-legacy-session-id";

const ChatContentPartSchema = z
  .object({
    text: z.string().optional(),
    type: z.string().optional(),
  })
  .passthrough();

const ChatMessageSchema = z
  .object({
    content: z.union([z.string(), z.array(ChatContentPartSchema), z.null()]).optional(),
    role: z.string().min(1),
  })
  .passthrough();

const ChatCompletionRequestSchema = z
  .object({
    messages: z.array(ChatMessageSchema).min(1),
    model: z.string().optional(),
    stream: z.boolean().optional(),
  })
  .passthrough();

type ChatCompletionRequest = z.infer<typeof ChatCompletionRequestSchema>;
type ChatMessage = z.infer<typeof ChatMessageSchema>;

export interface GroveFacadeRuntime {
  runTurn(
    nodeName: string,
    prompt: string,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<string | null>;
}

export interface GroveChatServerOptions {
  defaultModel?: string;
  maxStickySessions?: number;
  nodeNames: string[];
  now?: () => number;
  nowMs?: () => number;
  runtime: GroveFacadeRuntime;
  stickyTtlMs?: number;
  timeoutMs: number;
}

export interface StickySessionPoolOptions {
  maxStickySessions?: number;
  nowMs?: () => number;
  stickyTtlMs?: number;
}

interface CompletionContext {
  created: number;
  id: string;
  model: string;
}

interface StickySessionEntry {
  lastUsedMs: number;
  nodeName: string;
}

export class StickySessionPool {
  private readonly maxStickySessions: number;
  private nextNode = 0;
  private readonly nowMs: () => number;
  private readonly sticky = new Map<string, StickySessionEntry>();
  private readonly stickyTtlMs: number;

  constructor(
    private readonly nodeNames: string[],
    opts: StickySessionPoolOptions = {},
  ) {
    if (nodeNames.length === 0) {
      throw new Error("serve requires at least one grove node");
    }
    this.maxStickySessions = opts.maxStickySessions ?? DEFAULT_MAX_STICKY_SESSIONS;
    this.nowMs = opts.nowMs ?? (() => Date.now());
    this.stickyTtlMs = opts.stickyTtlMs ?? DEFAULT_STICKY_SESSION_TTL_MS;
  }

  nodeFor(sessionId: string | null): string {
    const key = sessionId?.trim();
    if (!key) {
      return this.nextRoundRobinNode();
    }

    this.pruneExpired();
    const now = this.nowMs();
    const existing = this.sticky.get(key);
    if (existing) {
      this.sticky.delete(key);
      this.sticky.set(key, { ...existing, lastUsedMs: now });
      return existing.nodeName;
    }

    while (this.sticky.size >= this.maxStickySessions) {
      const oldest = this.sticky.keys().next().value;
      if (oldest === undefined) break;
      this.sticky.delete(oldest);
    }
    const nodeName = this.nextRoundRobinNode();
    this.sticky.set(key, { lastUsedMs: now, nodeName });
    return nodeName;
  }

  stickySize(): number {
    this.pruneExpired();
    return this.sticky.size;
  }

  private nextRoundRobinNode(): string {
    const nodeName = this.nodeNames[this.nextNode % this.nodeNames.length]!;
    this.nextNode += 1;
    return nodeName;
  }

  private pruneExpired(): void {
    const now = this.nowMs();
    for (const [key, entry] of this.sticky) {
      if (now - entry.lastUsedMs > this.stickyTtlMs) {
        this.sticky.delete(key);
      }
    }
  }
}

export function createDefaultGroveFacadeRuntime(config?: string): GroveFacadeRuntime {
  return {
    async runTurn(nodeName, prompt, timeoutMs, signal) {
      if (signal?.aborted) return null;
      const ctx = loadContext(config);
      const nc = nodeOf(ctx, nodeName);
      if (signal?.aborted) return null;
      return await ask(ctx, nc, prompt, timeoutMs);
    },
  };
}

export function createGroveChatServer(options: GroveChatServerOptions): Server {
  const facade = new GroveChatFacade(options);
  return createServer((req, res) => {
    facade.handle(req, res).catch((error: unknown) => {
      if (!res.headersSent) {
        writeJson(res, 500, {
          error: error instanceof Error ? error.message : String(error),
        });
        return;
      }
      res.end();
    });
  });
}

class GroveChatFacade {
  private readonly defaultModel: string;
  private readonly nodeQueues = new Map<string, Promise<void>>();
  private readonly now: () => number;
  private readonly pool: StickySessionPool;

  constructor(private readonly options: GroveChatServerOptions) {
    this.defaultModel = options.defaultModel ?? DEFAULT_MODEL;
    this.now = options.now ?? (() => Math.floor(Date.now() / 1000));
    this.pool = new StickySessionPool(options.nodeNames, {
      maxStickySessions: options.maxStickySessions,
      nowMs: options.nowMs,
      stickyTtlMs: options.stickyTtlMs,
    });
  }

  async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://grove.local");
    if (url.pathname !== "/v1/chat/completions") {
      writeJson(res, 404, { error: "not found" });
      return;
    }
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
      writeJson(res, 405, { error: "method not allowed" });
      return;
    }

    let rawRequest: unknown;
    try {
      rawRequest = await readJson(req);
    } catch (error) {
      if (error instanceof RequestBodyError) {
        writeJson(res, error.status, { error: error.message });
        return;
      }
      throw error;
    }

    const parsed = ChatCompletionRequestSchema.safeParse(rawRequest);
    if (!parsed.success) {
      writeJson(res, 400, { error: "invalid chat completion request" });
      return;
    }

    const request = parsed.data;
    const nodeName = this.pool.nodeFor(headerString(req.headers[LEGACY_SESSION_HEADER]));
    const context = {
      created: this.now(),
      id: `chatcmpl-grove-${randomUUID()}`,
      model: request.model ?? this.defaultModel,
    };

    if (request.stream === true) {
      await this.handleStream(req, res, nodeName, request, context);
      return;
    }

    await this.handleCompletion(res, nodeName, request, context);
  }

  private async handleCompletion(
    res: ServerResponse,
    nodeName: string,
    request: ChatCompletionRequest,
    context: CompletionContext,
  ): Promise<void> {
    const text = await this.runQueued(nodeName, () =>
      this.options.runtime.runTurn(
        nodeName,
        promptFromMessages(request.messages),
        this.options.timeoutMs,
      ),
    );
    if (text === null) {
      writeJson(res, 504, { error: "grove turn timed out" });
      return;
    }

    writeJson(res, 200, {
      choices: [
        {
          finish_reason: "stop",
          index: 0,
          message: {
            content: text,
            role: "assistant",
          },
        },
      ],
      created: context.created,
      id: context.id,
      model: context.model,
      object: "chat.completion",
    });
  }

  private async handleStream(
    req: IncomingMessage,
    res: ServerResponse,
    nodeName: string,
    request: ChatCompletionRequest,
    context: CompletionContext,
  ): Promise<void> {
    const abortController = new AbortController();
    let completed = false;
    const abort = (): void => {
      if (!completed) abortController.abort();
    };
    req.once("aborted", abort);
    res.once("close", abort);

    res.writeHead(200, {
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "Content-Type": "text/event-stream; charset=utf-8",
      "X-Accel-Buffering": "no",
    });
    writeSse(res, chunk(context, { role: "assistant" }, null));

    try {
      const text = await this.runQueued(
        nodeName,
        () =>
          this.options.runtime.runTurn(
            nodeName,
            promptFromMessages(request.messages),
            this.options.timeoutMs,
            abortController.signal,
          ),
        abortController.signal,
      );
      if (abortController.signal.aborted || !canWrite(res)) return;
      if (text !== null && text.length > 0) {
        writeSse(res, chunk(context, { content: text }, null));
      }
      writeSse(res, chunk(context, {}, text === null ? "length" : "stop"));
      writeSse(res, "[DONE]");
    } catch (error) {
      if (abortController.signal.aborted || !canWrite(res)) return;
      writeSse(res, {
        error: {
          message: error instanceof Error ? error.message : String(error),
          type: "grove_error",
        },
      });
      writeSse(res, chunk(context, {}, "stop"));
      writeSse(res, "[DONE]");
    } finally {
      req.off("aborted", abort);
      res.off("close", abort);
      completed = true;
      if (canWrite(res)) {
        res.end();
      }
    }
  }

  private async runQueued<T>(
    nodeName: string,
    task: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    const previous = this.nodeQueues.get(nodeName) ?? Promise.resolve();
    const result = (async (): Promise<T> => {
      await previous.catch(() => undefined);
      if (signal?.aborted) {
        throw new RequestAbortedError();
      }
      return await task();
    })();
    const cleanup = result.then(
      () => undefined,
      () => undefined,
    );
    this.nodeQueues.set(nodeName, cleanup);
    return await result;
  }
}

export function promptFromMessages(messages: ChatMessage[]): string {
  return messages
    .map((message) => {
      const content = contentText(message.content);
      return content ? `${message.role}: ${content}` : "";
    })
    .filter(Boolean)
    .join("\n");
}

function contentText(content: ChatMessage["content"]): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => part.text ?? "")
    .filter((text) => text.length > 0)
    .join("\n");
}

function chunk(
  context: CompletionContext,
  delta: Record<string, string>,
  finishReason: "length" | "stop" | null,
): object {
  return {
    choices: [
      {
        delta,
        finish_reason: finishReason,
        index: 0,
      },
    ],
    created: context.created,
    id: context.id,
    model: context.model,
    object: "chat.completion.chunk",
  };
}

function headerString(value: string | string[] | undefined): string | null {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value[0] ?? null;
  return null;
}

function writeJson(res: ServerResponse, status: number, body: object): void {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
  });
  res.end(`${JSON.stringify(body)}\n`);
}

function writeSse(res: ServerResponse, value: object | string): void {
  if (!canWrite(res)) return;
  const payload = typeof value === "string" ? value : JSON.stringify(value);
  res.write(`data: ${payload}\n\n`);
}

function canWrite(res: ServerResponse): boolean {
  return !res.destroyed && !res.writableEnded;
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const body = await readBody(req);
  if (!body.trim()) return {};
  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new RequestBodyError(400, "malformed JSON request body");
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let done = false;
    let size = 0;

    req.on("data", (chunk: Buffer) => {
      if (done) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        done = true;
        reject(new RequestBodyError(413, "request body too large"));
        req.resume();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (done) return;
      done = true;
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", (error) => {
      if (done) return;
      done = true;
      reject(error);
    });
  });
}

class RequestBodyError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

class RequestAbortedError extends Error {
  constructor() {
    super("request aborted");
  }
}
