import { loadContext, nodeOf } from "../context.js";
import { recordPending, resolveTranscript, submitMessage } from "../ops.js";
import { color, info, warn } from "../util/log.js";
import { poll } from "../util/time.js";

const SUBMISSION_WRITE_TIMEOUT_MS = 8000;
const SUBMISSION_WRITE_INTERVAL_MS = 150;

export async function cmdSend(
  name: string,
  message: string,
  opts: { config?: string },
): Promise<void> {
  const ctx = loadContext(opts.config);
  const nc = nodeOf(ctx, name);
  // Capture the baseline before the response lands so a later `grove wait`
  // scans from here, not from wait-time.
  const before = nc.adapter.snapshot(nc.node.cwd);
  const transcript = resolveTranscript(ctx, nc);
  const fromOffset = transcript ? nc.adapter.size(transcript) : 0;
  await submitMessage(nc, message);

  const submitted = await poll(
    () => {
      if (transcript && nc.adapter.size(transcript) > fromOffset) {
        return { transcript, fromOffset };
      }
      const detected = nc.adapter.detectNew(nc.node.cwd, before);
      if (detected) {
        const prev = ctx.registry.nodes[nc.node.name] ?? {
          name: nc.node.name,
          agent: nc.node.agent,
        };
        ctx.registry.nodes[nc.node.name] = {
          ...prev,
          sessionId: detected.sessionId,
          transcript: detected.transcript,
        };
        return { transcript: detected.transcript, fromOffset: 0 };
      }
      return null;
    },
    {
      timeoutMs: SUBMISSION_WRITE_TIMEOUT_MS,
      intervalMs: SUBMISSION_WRITE_INTERVAL_MS,
      until: (value) => value !== null,
    },
  );

  const pending = submitted.value ?? (transcript ? { transcript, fromOffset } : null);
  if (!pending) {
    warn(`${name}: submission unconfirmed; no transcript resolved`);
    return;
  }

  recordPending(ctx, nc, pending.transcript, pending.fromOffset);
  if (!submitted.value) {
    info(`${name}: submission unconfirmed; pending recorded`);
  }
  info(`sent → ${color.bold(name)}`);
}
