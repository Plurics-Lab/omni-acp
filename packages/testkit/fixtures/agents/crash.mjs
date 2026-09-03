#!/usr/bin/env node
// Fixture agent: crash — Tier-2 (a real process, real ndJSON over real pipes).
//
// Answers the handshake, emits one chunk, then dies mid-prompt WITHOUT answering
// session/prompt. Proves crash classification (CONTRACTS.md §6.7) and §7.3's rule that a dead
// agent never produces a fabricated `idle`.
//
// Env: CRASH_EXIT_CODE (default 1), CRASH_DELAY_MS (default 25 — long enough for the chunk to
// reach the reader, short enough that no test waits on it).
import * as acp from "@agentclientprotocol/sdk";
import { Readable, Writable } from "node:stream";

const stream = acp.ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin));
const EXIT_CODE = Number(process.env.CRASH_EXIT_CODE ?? "1");
const DELAY_MS = Number(process.env.CRASH_DELAY_MS ?? "25");

let sessions = 0;

acp
  .agent({ name: "crash" })
  .onRequest("initialize", () => ({
    protocolVersion: acp.PROTOCOL_VERSION,
    agentCapabilities: { loadSession: false },
  }))
  .onRequest("session/new", () => ({ sessionId: `crash-${++sessions}` }))
  .onRequest("session/prompt", async (ctx) => {
    await ctx.client.notify("session/update", {
      sessionId: ctx.params.sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "about to crash" },
      },
    });
    process.stderr.write("crash.mjs: simulated fault, exiting mid-turn\n");
    setTimeout(() => process.exit(EXIT_CODE), DELAY_MS);
    // The prompt response never comes: that is the whole point of the fixture.
    return new Promise(() => {});
  })
  .onNotification("session/cancel", () => {})
  .connect(stream);
