#!/usr/bin/env node
// Fixture agent: slow — Tier-2 (a real process, real ndJSON over real pipes).
//
// Never answers session/prompt and IGNORES session/cancel, so `cancel()` must escalate
// (CONTRACTS.md §6.5) rather than be rescued by a cooperative agent.
//
// Env: SLOW_HANDSHAKE=1 also withholds the `initialize` response, which is the handshake-budget
// (504 agent_timeout) mode.
import * as acp from "@agentclientprotocol/sdk";
import { Readable, Writable } from "node:stream";

const stream = acp.ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin));
const SLOW_HANDSHAKE = process.env.SLOW_HANDSHAKE === "1";

const never = () => new Promise(() => {});
let sessions = 0;

acp
  .agent({ name: "slow" })
  .onRequest("initialize", () =>
    SLOW_HANDSHAKE
      ? never()
      : {
          protocolVersion: acp.PROTOCOL_VERSION,
          agentCapabilities: { loadSession: false },
        },
  )
  .onRequest("session/new", () => ({ sessionId: `slow-${++sessions}` }))
  .onRequest("session/prompt", async (ctx) => {
    await ctx.client.notify("session/update", {
      sessionId: ctx.params.sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "working on it, indefinitely" },
      },
    });
    return never();
  })
  .onNotification("session/cancel", () => {
    // Deliberately ignored. A cooperative agent would resolve the prompt with
    // {stopReason:"cancelled"}; this one forces the caller down the escalation ladder.
  })
  .connect(stream);
