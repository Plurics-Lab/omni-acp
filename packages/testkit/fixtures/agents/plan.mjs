#!/usr/bin/env node
// Fixture agent: plan — Tier-2 (a real process, real ndJSON over real pipes).
//
// Covers the corpus gap the research README records first: **no `plan` update was emitted in two
// attempts**, because this build of claude-acp has no todo/plan tool. CONTRACTS.md §12.3 rows 7
// and 8 therefore have no real-agent ground truth, and this fixture is the only exercise they get.
//
// It emits, in this order:
//   1. v1 `plan` — `{sessionUpdate:"plan", entries:[…]}`                        (row 7)
//   2. v1 `plan` again, with a DIFFERENT entry set                              (row 7, upsert)
//   3. `plan_update` with a `{plan:{type:"items", planId, entries}}` body        (row 8's `=`)
//
// (1) and (2) are what pin `planId` being STABLE across the turn: two `plan` updates must upsert
// one plan rather than accumulate two.
//
// A CORRECTION TO §12.3 ROW 8, discovered by writing this fixture: the row says a `plan_update`
// whose `plan.type` is not a string is "a v1 agent using the v2 name loosely" and should be
// treated as row 7. That agent cannot exist on an SDK link. In SDK 1.4.0 the **v1** schema's
// `PlanUpdate` ALREADY requires `plan: PlanUpdateContent` — `{sessionUpdate:"plan_update",
// entries:[…]}` is not a v1 shape either, and the SDK's client DROPS IT SILENTLY, with no
// notification and nothing on stderr. `PLAN_EMIT_V2=0` sends that shape so the drop can be
// asserted rather than assumed; the map still handles it, because a non-SDK agent can put
// anything on a pipe (§12.2's "total"), and `map-rows.test.ts` covers it on the object.
//
// Env:
//   PLAN_STOP_REASON  overrides the stop reason (default "end_turn").
//   PLAN_EMIT_V2=0    send the `{entries}` body instead of the `{plan}` one — the shape a v1
//                     client silently drops.
//
// Launched as `process.execPath <this file>`, never through npx (CONTRACTS.md §6.3).
import * as acp from "@agentclientprotocol/sdk";
import { Readable, Writable } from "node:stream";

const stream = acp.ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin));
const STOP_REASON = process.env.PLAN_STOP_REASON ?? "end_turn";
const EMIT_V2 = process.env.PLAN_EMIT_V2 !== "0";

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
    const done = [entry("read the file", "completed"), entry("edit the file", "completed")];
    if (EMIT_V2) {
      // Row 8's `=`: the shape both schemas actually accept, and the one that arrives.
      await send({
        sessionUpdate: "plan_update",
        plan: { type: "items", planId: "agent-authored-plan", entries: done },
      });
    } else {
      // Row 8's "loosely" branch. SENT, and never received — the assertion is client-side.
      await send({ sessionUpdate: "plan_update", entries: done });
    }
    await send({
      sessionUpdate: "agent_message_chunk",
      messageId: "plan-msg-1",
      content: { type: "text", text: "done" },
    });
    return { stopReason: STOP_REASON };
  })
  .onNotification("session/cancel", () => {})
  .connect(stream);
