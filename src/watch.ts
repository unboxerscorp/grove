import { existsSync, watch, type FSWatcher } from "node:fs";
import { createHash } from "node:crypto";
import { basename } from "node:path";
import type { Context, NodeCtx } from "./context.js";
import { appendTurnEvent, type GroveTurnEvent } from "./events.js";
import { resolveTranscript } from "./ops.js";
import { eventsDir } from "./util/paths.js";

export interface ScanNodeOptions {
  eventLogDir?: string;
  transcript?: string;
  fromOffset?: number;
}

export interface ScanNodeResult {
  appended: boolean;
  nextOffset: number;
}

export interface TurnEventWatcher {
  watched: string[];
  stop(): void;
}

export interface StartTurnEventWatcherOptions {
  eventLogDir?: string;
  pollIntervalMs?: number;
  reloadContext?: () => Context;
  watchFile?: typeof watch;
}

const WATCH_POLL_INTERVAL_MS = 2500;

function stableNonce(parts: string[]): string {
  return createHash("sha256").update(parts.join("\0")).digest("hex");
}

function transcriptIdOf(ctx: Context, nc: NodeCtx, transcript: string): string {
  return (
    nc.adapter.sessionIdFromPath(transcript) ??
    ctx.registry.nodes[nc.node.name]?.sessionId ??
    basename(transcript, ".jsonl")
  );
}

function turnEventFromCompletion(
  ctx: Context,
  nc: NodeCtx,
  transcript: string,
  transcriptOffset: number,
  summary: string,
): GroveTurnEvent {
  const transcriptId = transcriptIdOf(ctx, nc, transcript);
  const marker = `completion@${transcriptOffset}`;
  const turnId = `${nc.node.name}:${transcriptId}:${transcriptOffset}`;
  const nonce = stableNonce(["turn.done", nc.node.name, transcriptId, String(transcriptOffset)]);
  return {
    schema: 1,
    type: "turn.done",
    node: nc.node.name,
    turnId,
    transcriptId,
    transcriptOffset,
    marker,
    ts: Date.now(),
    nonce,
    status: "done",
    summary,
  };
}

export function scanNodeForTurnEvent(
  ctx: Context,
  nc: NodeCtx,
  opts: ScanNodeOptions = {},
): ScanNodeResult {
  const transcript = opts.transcript ?? resolveTranscript(ctx, nc);
  if (!transcript) return { appended: false, nextOffset: opts.fromOffset ?? 0 };
  const fromOffset = opts.fromOffset ?? nc.adapter.size(transcript);

  const completion = nc.adapter.readCompletionSince(transcript, fromOffset);
  if (!completion.done) {
    return { appended: false, nextOffset: completion.offset };
  }

  const event = turnEventFromCompletion(
    ctx,
    nc,
    transcript,
    completion.offset,
    completion.text ?? "",
  );
  const appended = appendTurnEvent(
    opts.eventLogDir ?? eventsDir(ctx.config.session),
    event,
  );
  return { appended, nextOffset: completion.offset };
}

export function startTurnEventWatcher(
  ctx: Context,
  opts: StartTurnEventWatcherOptions = {},
): TurnEventWatcher {
  const eventLogDir = opts.eventLogDir ?? eventsDir(ctx.config.session);
  const pollIntervalMs = opts.pollIntervalMs ?? WATCH_POLL_INTERVAL_MS;
  const watchFile = opts.watchFile ?? watch;
  const watched: string[] = [];
  const offsets = new Map<string, number>();
  const watchers = new Map<string, { transcript: string; watcher?: FSWatcher }>();

  const scan = (nc: NodeCtx, transcript: string): void => {
    const key = nc.node.name;
    const result = scanNodeForTurnEvent(ctx, nc, {
      eventLogDir,
      transcript,
      fromOffset: offsets.get(key) ?? nc.adapter.size(transcript),
    });
    offsets.set(key, result.nextOffset);
  };

  const ensureNode = (latestCtx: Context, nc: NodeCtx): void => {
    const transcript = resolveTranscript(latestCtx, nc);
    if (!transcript || !existsSync(transcript)) return;

    const active = watchers.get(nc.node.name);
    if (active?.transcript !== transcript) {
      try {
        active?.watcher?.close();
      } catch {
        /* already closed */
      }
      const pending = latestCtx.registry.nodes[nc.node.name]?.pending;
      offsets.set(nc.node.name, pending?.fromOffset ?? nc.adapter.size(transcript));
      watchers.delete(nc.node.name);
    }

    scan(nc, transcript);

    if (watchers.has(nc.node.name)) return;
    if (!watched.includes(nc.node.name)) watched.push(nc.node.name);

    let watcher: FSWatcher | undefined;
    try {
      watcher = watchFile(transcript, { persistent: true }, () => {
        scan(nc, transcript);
      });
      watcher.on("error", () => {
        try {
          watcher?.close();
        } catch {
          /* already closed */
        }
        watchers.delete(nc.node.name);
      });
    } catch {
      watcher = undefined;
    }
    watchers.set(nc.node.name, { transcript, watcher });
  };

  const refresh = (latestCtx: Context): void => {
    for (const node of latestCtx.nodes) {
      const nc = latestCtx.byName.get(node.name);
      if (!nc) continue;
      ensureNode(latestCtx, nc);
    }
  };

  refresh(ctx);

  const poller = setInterval(() => {
    refresh(opts.reloadContext?.() ?? ctx);
  }, pollIntervalMs);

  return {
    watched,
    stop(): void {
      clearInterval(poller);
      for (const entry of watchers.values()) {
        try {
          entry.watcher?.close();
        } catch {
          /* already closed */
        }
      }
    },
  };
}
