#!/usr/bin/env node
// Fixture agent: thought — Tier-2 (a real process, real ndJSON over real pipes).
//
// Covers two corpus gaps at once (research README, "Known gaps"):
//   * `agent_thought_chunk` is never emitted at the default effort, so §12.3 row 3 has no
//     real-agent sample;
//   * every recorded chunk carries a `messageId`, so §12.4's SYNTHESIS path — the half that only
//     runs when the field is absent — has no real-agent sample either.
//
// The emission order is the whole point, because §12.4 groups id-less chunks "as one message per
// contiguous run, which is the only grouping the wire supports":
//
//   1. thought, NO id      \
//   2. thought, NO id       >  one contiguous run -> ONE synthesized id
//   3. message, NO id         -> a kind change -> a DIFFERENT synthesized id
//   4. thought, NO id         -> back to thought -> a THIRD id (the run was broken)
//   5. thought, WITH id       -> passed through untouched, never overwritten
//
// Env: THOUGHT_STOP_REASON overrides the stop reason (default "end_turn").
//
// Launched as `process.execPath <this file>`, never through npx (CONTRACTS.md §6.3).
import * as acp from "@agentclientprotocol/sdk";
import { Readable, Writable } from "node:stream";

const stream = acp.ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin));
const STOP_REASON = process.env.THOUGHT_STOP_REASON ?? "end_turn";

let sessions = 0;

acp
  .agent({ name: "thought" })
  .onRequest("initialize", () => ({
    protocolVersion: acp.PROTOCOL_VERSION,
    agentCapabilities: { loadSession: false },
  }))
  .onRequest("session/new", () => ({ sessionId: `thought-${++sessions}` }))
  .onRequest("session/prompt", async (ctx) => {
    const sessionId = ctx.params.sessionId;
    const send = (update) => ctx.client.notify("session/update", { sessionId, update });
    const text = (t) => ({ type: "text", text: t });

    await send({ sessionUpdate: "agent_thought_chunk", content: text("let me think. ") });
    await send({ sessionUpdate: "agent_thought_chunk", content: text("still thinking. ") });
    await send({ sessionUpdate: "agent_message_chunk", content: text("the answer is 4. ") });
    await send({ sessionUpdate: "agent_thought_chunk", content: text("second thoughts. ") });
    await send({
      sessionUpdate: "agent_thought_chunk",
      messageId: "thought-from-the-agent",
      content: text("and this one is mine."),
    });
    return { stopReason: STOP_REASON };
  })
  .onNotification("session/cancel", () => {})
  .connect(stream);
