#!/usr/bin/env node
// Fixture agent: plan — Tier-2 (a real process, real ndJSON over real pipes).
//
// Covers the corpus gap the research README records first: **no `plan` update was emitted in two
// attempts**, because this build of claude-acp has no todo/plan tool. CONTRACTS.md §12.3 rows 7
// and 8 therefore have no real-agent ground truth, and this fixture is the only exercise they get.
//
// It emits BOTH shapes, in this order:
//   1. v1 `plan` — `{sessionUpdate:"plan", entries:[…]}`                        (row 7)
//   2. v1 `plan` again, with a DIFFERENT entry set                              (row 7, upsert)
//   3. a v1-shaped `plan_update` — the v2 NAME over the v1 body                 (row 8's fallback)
//   4. a v2 `plan_update` — `{plan:{type:"items", planId, entries}}`             (row 8's `=`)
//
// (1) and (2) are what pin `planId` being STABLE across the turn: two `plan` updates must upsert
// one plan rather than accumulate two.
//
// Env: PLAN_STOP_REASON overrides the stop reason (default "end_turn").
//
// Launched as `process.execPath <this file>`, never through npx (CONTRACTS.md §6.3).
import * as acp from "@agentclientprotocol/sdk";
import { Readable, Writable } from "node:stream";

const stream = acp.ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin));
const STOP_REASON = process.env.PLAN_STOP_REASON ?? "end_turn";

let sessions = 0;

const entry = (content, status) => ({ content, priority: "medium", status });

acp
  .agent({ name: "plan" })
  .onRequest("initialize", () => ({
    protocolVersion: acp.PROTOCOL_VERSION,
    agentCapabilities: { loadSession: false },
  }))
  .onRequest("session/new", () => ({ sessionId: `plan-${++sessions}` }))
  .onRequest("session/prompt", async (ctx) => {
    const sessionId = ctx.params.sessionId;
    const send = (update) => ctx.client.notify("session/update", { sessionId, update });

    await send({
      sessionUpdate: "plan",
      entries: [entry("read the file", "pending"), entry("edit the file", "pending")],
    });
    await send({
      sessionUpdate: "plan",
      entries: [entry("read the file", "completed"), entry("edit the file", "in_progress")],
    });
    // The v2 name over a v1 body: an agent that adopted the new spelling loosely.
    await send({
      sessionUpdate: "plan_update",
      entries: [entry("read the file", "completed"), entry("edit the file", "completed")],
    });
    // …and the genuine v2 shape, which the map must leave alone.
    await send({
      sessionUpdate: "plan_update",
      plan: {
        type: "items",
        planId: "agent-authored-plan",
        entries: [entry("read the file", "completed"), entry("edit the file", "completed")],
      },
    });
    await send({
      sessionUpdate: "agent_message_chunk",
      messageId: "plan-msg-1",
      content: { type: "text", text: "done" },
    });
    return { stopReason: STOP_REASON };
  })
  .onNotification("session/cancel", () => {})
  .connect(stream);
