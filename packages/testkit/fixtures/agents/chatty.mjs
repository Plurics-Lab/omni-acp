#!/usr/bin/env node
// Fixture agent: chatty — Tier-2 (a real process, real ndJSON over real pipes).
//
// Emits one chunk AFTER it has already returned {stopReason:"end_turn"}. That is v1's fuzzy
// turn boundary (L5), and it is what the Normalizer's quiet window exists for: the test asserts
// seq(late chunk) < seq(idle), which fails the moment the quiet window is removed
// (CONTRACTS.md §7.2).
//
// Env: CHATTY_AFTER_MS (default 400 — comfortably inside the 5s hard cap, comfortably outside
// the 250ms quiet window, so the deadline is genuinely extended once).
import * as acp from "@agentclientprotocol/sdk";
import { Readable, Writable } from "node:stream";

const stream = acp.ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin));
const AFTER_MS = Number(process.env.CHATTY_AFTER_MS ?? "400");

let sessions = 0;

acp
  .agent({ name: "chatty" })
  .onRequest("initialize", () => ({
    protocolVersion: acp.PROTOCOL_VERSION,
    agentCapabilities: { loadSession: false },
  }))
  .onRequest("session/new", () => ({ sessionId: `chatty-${++sessions}` }))
  .onRequest("session/prompt", async (ctx) => {
    const sessionId = ctx.params.sessionId;
    const say = (text) =>
      ctx.client.notify("session/update", {
        sessionId,
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
      });

    await say("the answer, ");
    const late = setTimeout(() => {
      void say("and its tail arriving after the response.").catch(() => {});
    }, AFTER_MS);
    // Unref'd: stdin keeps the loop alive, so if the caller closes stdin first the process
    // exits instead of writing to a pipe nobody is reading.
    late.unref?.();
    return { stopReason: "end_turn" };
  })
  .onNotification("session/cancel", () => {})
  .connect(stream);
