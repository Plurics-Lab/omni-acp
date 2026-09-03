#!/usr/bin/env node
// Fixture agent: echo — Tier-2 (a real process, real ndJSON over real pipes).
//
// Two agent_message_chunks then {stopReason:"end_turn"}, no permission request. This is the
// happy path over real pipes: if it fails, the failure is in the transport, not the logic.
//
// Launched as `process.execPath <this file>`, never through npx (CONTRACTS.md §6.3).
import * as acp from "@agentclientprotocol/sdk";
import { Readable, Writable } from "node:stream";

// F6: ndJsonStream(output, input) — first what WE write (our stdout), then what we read.
const stream = acp.ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin));

let sessions = 0;

/** The prompt's text blocks, joined — so "echo" means it. */
function promptText(params) {
  const blocks = Array.isArray(params?.prompt) ? params.prompt : [];
  return blocks
    .filter((b) => b && b.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join(" ");
}

acp
  .agent({ name: "echo" })
  .onRequest("initialize", () => ({
    protocolVersion: acp.PROTOCOL_VERSION,
    agentCapabilities: { loadSession: false },
  }))
  .onRequest("session/new", () => ({ sessionId: `echo-${++sessions}` }))
  .onRequest("session/prompt", async (ctx) => {
    const sessionId = ctx.params.sessionId;
    await ctx.client.notify("session/update", {
      sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "echo: " },
      },
    });
    await ctx.client.notify("session/update", {
      sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: promptText(ctx.params) },
      },
    });
    return { stopReason: "end_turn" };
  })
  .onNotification("session/cancel", () => {})
  .connect(stream);
