#!/usr/bin/env node
// Fixture agent: noisy — Tier-2 (a real process, real ndJSON over real pipes).
//
// One oversized ndJSON frame, a flood of stderr, and an optional mid-turn exit. Drives the
// frame limiter (`maxFrameBytes` -> protocol_error + kill), the UTF-8-safe stderr tail ring,
// and the crash classifier.
//
// Env: NOISY_FRAME_BYTES (default 65536 — a test sets `maxFrameBytes` BELOW this),
//      NOISY_STDERR_BYTES (default 1 MiB), NOISY_EXIT_MID_TURN=1 (exit 3 instead of answering).
import * as acp from "@agentclientprotocol/sdk";
import { Readable, Writable } from "node:stream";

const stream = acp.ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin));

const FRAME_BYTES = Number(process.env.NOISY_FRAME_BYTES ?? String(64 * 1024));
const STDERR_BYTES = Number(process.env.NOISY_STDERR_BYTES ?? String(1024 * 1024));
const EXIT_MID_TURN = process.env.NOISY_EXIT_MID_TURN === "1";

let sessions = 0;

function floodStderr() {
  // Line-oriented and multibyte, so the tail's rune-boundary truncation is actually exercised.
  const line = `${"ノイズ".repeat(20)}\n`;
  const chunk = line.repeat(64);
  const size = Buffer.byteLength(chunk);
  for (let written = 0; written < STDERR_BYTES; written += size) {
    process.stderr.write(chunk);
  }
}

acp
  .agent({ name: "noisy" })
  .onRequest("initialize", () => ({
    protocolVersion: acp.PROTOCOL_VERSION,
    agentCapabilities: { loadSession: false },
  }))
  .onRequest("session/new", () => ({ sessionId: `noisy-${++sessions}` }))
  .onRequest("session/prompt", async (ctx) => {
    floodStderr();
    await ctx.client.notify("session/update", {
      sessionId: ctx.params.sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "x".repeat(FRAME_BYTES) },
      },
    });
    if (EXIT_MID_TURN) {
      setTimeout(() => process.exit(3), 25);
      return new Promise(() => {});
    }
    return { stopReason: "end_turn" };
  })
  .onNotification("session/cancel", () => {})
  .connect(stream);
