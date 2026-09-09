#!/usr/bin/env node
// Fixture agent: stall-silent — Tier-2 (a real process, real ndJSON over real pipes).
//
// ONE update, then silence, and no tool call is ever opened: the shape DESIGN §7's `silentMs`
// budget measures. `session/prompt` never resolves on its own, so the only thing that can end
// the turn is the idle watchdog.
//
// It IGNORES `session/cancel` by default, which is what forces the watchdog's fire to walk M1's
// existing escalation all the way to `close("cancel_timeout")` (§21.5). With
// STALL_COOPERATIVE=1 it answers the cancel with `{stopReason:"cancelled"}` instead, so the
// other half of the ladder — a turn that settles as `cancelled` — is reachable from the same
// fixture.
//
// Env:
//   STALL_COOPERATIVE=1  resolve the prompt with stopReason "cancelled" on session/cancel
//   STALL_TEXT=<s>       the one chunk's text (default "thinking")
import * as acp from "@agentclientprotocol/sdk";
import { Readable, Writable } from "node:stream";

const stream = acp.ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin));
const COOPERATIVE = process.env.STALL_COOPERATIVE === "1";
const TEXT = process.env.STALL_TEXT ?? "thinking";

let sessions = 0;
/** Resolves the in-flight prompt, when there is one and we are cooperative. */
let settle = null;

acp
  .agent({ name: "stall-silent" })
  .onRequest("initialize", () => ({
    protocolVersion: acp.PROTOCOL_VERSION,
    agentCapabilities: { loadSession: false },
  }))
  .onRequest("session/new", () => ({ sessionId: `stall-silent-${++sessions}` }))
  .onRequest("session/prompt", async (ctx) => {
    await ctx.client.notify("session/update", {
      sessionId: ctx.params.sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: TEXT },
      },
    });
    // Silence. No tool call, no second chunk, no response.
    return new Promise((resolve) => {
      settle = resolve;
    });
  })
  .onNotification("session/cancel", () => {
    if (!COOPERATIVE || settle === null) return;
    const resolve = settle;
    settle = null;
    resolve({ stopReason: "cancelled" });
  })
  .connect(stream);
