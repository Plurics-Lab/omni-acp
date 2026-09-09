#!/usr/bin/env node
// Fixture agent: stall-in-tool — Tier-2 (a real process, real ndJSON over real pipes).
//
// Opens ONE `tool_call{status:"pending"}`, never terminalizes it, and never speaks again: F36's
// shape on both real agents. claude `16` leaves its Bash call `"pending"` and codex `08` leaves
// its shell call `"in_progress"`; NEITHER ever sends `completed`, `failed` or `cancelled` for it,
// even after `session/cancel`. That is why `toolMs` is a BUDGET and not a suspension, and why
// `TurnResult.strandedToolCalls` reports the call rather than synthesizing a status (M2-R8).
//
// It sends three SPARSE `tool_call_update`s after the open — content only, no `status` — exactly
// as claude `16` does, so a fold that treated a sparse update as an open/close is caught here.
//
// Env:
//   STALL_COOPERATIVE=1  resolve the prompt with stopReason "cancelled" on session/cancel
//   STALL_STATUS=<s>     the opening status (default "pending"; codex's half is "in_progress")
//   STALL_TOOL_ID=<s>    the toolCallId (default "stall_call_1")
import * as acp from "@agentclientprotocol/sdk";
import { Readable, Writable } from "node:stream";

const stream = acp.ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin));
const COOPERATIVE = process.env.STALL_COOPERATIVE === "1";
const STATUS = process.env.STALL_STATUS ?? "pending";
const TOOL_ID = process.env.STALL_TOOL_ID ?? "stall_call_1";

let sessions = 0;
let settle = null;

acp
  .agent({ name: "stall-in-tool" })
  .onRequest("initialize", () => ({
    protocolVersion: acp.PROTOCOL_VERSION,
    agentCapabilities: { loadSession: false },
  }))
  .onRequest("session/new", () => ({ sessionId: `stall-in-tool-${++sessions}` }))
  .onRequest("session/prompt", async (ctx) => {
    const send = (update) =>
      ctx.client.notify("session/update", { sessionId: ctx.params.sessionId, update });

    await send({
      sessionUpdate: "tool_call",
      toolCallId: TOOL_ID,
      status: STATUS,
      title: "Terminal",
      kind: "execute",
      rawInput: {},
      content: [],
    });
    // claude `16`'s three sparse updates: the title and the input are widened, the STATUS is
    // never re-sent. Absent means unchanged, so the call stays open across all three.
    await send({ sessionUpdate: "tool_call_update", toolCallId: TOOL_ID, title: "sleep 30" });
    await send({
      sessionUpdate: "tool_call_update",
      toolCallId: TOOL_ID,
      rawInput: { command: "sleep 30" },
    });
    await send({
      sessionUpdate: "tool_call_update",
      toolCallId: TOOL_ID,
      content: [{ type: "content", content: { type: "text", text: "sleep 30" } }],
    });

    // Silence, forever, with the call still open.
    return new Promise((resolve) => {
      settle = resolve;
    });
  })
  .onNotification("session/cancel", () => {
    // F36: no terminal update is sent even here. The call is stranded, and saying so is the
    // whole point of the fixture.
    if (!COOPERATIVE || settle === null) return;
    const resolve = settle;
    settle = null;
    resolve({ stopReason: "cancelled" });
  })
  .connect(stream);
