import { loadContext, nodeOf } from "../context.js";
import { resolveTranscript } from "../ops.js";

export async function cmdSession(
  name: string,
  opts: { config?: string },
): Promise<void> {
  const ctx = loadContext(opts.config);
  const nc = nodeOf(ctx, name);
  const rt = ctx.registry.nodes[name];
  const transcript = resolveTranscript(ctx, nc);
  console.log(
    JSON.stringify(
      {
        node: name,
        agent: nc.node.agent,
        sessionId: rt?.sessionId ?? nc.node.resume ?? null,
        transcript: transcript || null,
        bytes: transcript ? nc.adapter.size(transcript) : 0,
      },
      null,
      2,
    ),
  );
}
