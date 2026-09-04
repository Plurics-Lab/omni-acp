#!/usr/bin/env node
// Fixture agent: mode — Tier-2 (a real process, real ndJSON over real pipes).
//
// Covers the third corpus gap: `session/set_mode` on claude-acp produced the **v2**
// `config_option_update` instead of a v1 `current_mode_update`, so §12.3 row 11 has no v1-side
// sample from the only real agent available.
//
// This one is deliberately the OTHER shape:
//   * `session/new` returns `modes: {currentModeId, availableModes:[{id,name,description}]}`,
//     which is the catalogue row 11 cannot build the select from;
//   * `session/prompt` emits a v1 `current_mode_update` — twice, so the mapper's output is
//     exercised on a mode change and not only on the first one;
//   * `session/set_mode` is answered `{}` and echoed as another `current_mode_update`.
//
// Env:
//   MODE_NO_MODES=1   `session/new` returns NO `modes`, which is §12.3 row 11's honest
//                     `options: []` branch — the one that must not invent a catalogue.
//
// Launched as `process.execPath <this file>`, never through npx (CONTRACTS.md §6.3).
import * as acp from "@agentclientprotocol/sdk";
import { Readable, Writable } from "node:stream";

const stream = acp.ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin));
const NO_MODES = process.env.MODE_NO_MODES === "1";

let sessions = 0;
let currentModeId = "default";

const MODES = {
  currentModeId: "default",
  availableModes: [
    { id: "default", name: "Manual", description: "Always ask before making changes" },
    { id: "acceptEdits", name: "Accept edits", description: "Automatically accept file edits" },
    { id: "plan", name: "Plan", description: "Create a plan before making changes" },
  ],
};

acp
  .agent({ name: "mode" })
  .onRequest("initialize", () => ({
    protocolVersion: acp.PROTOCOL_VERSION,
    agentCapabilities: { loadSession: false },
  }))
  .onRequest("session/new", () => ({
    sessionId: `mode-${++sessions}`,
    ...(NO_MODES ? {} : { modes: MODES }),
  }))
  .onRequest("session/set_mode", async (ctx) => {
    currentModeId = ctx.params.modeId;
    await ctx.client.notify("session/update", {
      sessionId: ctx.params.sessionId,
      update: { sessionUpdate: "current_mode_update", currentModeId },
    });
    return {};
  })
  .onRequest("session/prompt", async (ctx) => {
    const sessionId = ctx.params.sessionId;
    const send = (update) => ctx.client.notify("session/update", { sessionId, update });

    await send({ sessionUpdate: "current_mode_update", currentModeId });
    currentModeId = "acceptEdits";
    await send({ sessionUpdate: "current_mode_update", currentModeId });
    await send({
      sessionUpdate: "agent_message_chunk",
      messageId: "mode-msg-1",
      content: { type: "text", text: `mode is ${currentModeId}` },
    });
    return { stopReason: "end_turn" };
  })
  .onNotification("session/cancel", () => {})
  .connect(stream);
