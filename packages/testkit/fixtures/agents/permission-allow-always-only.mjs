#!/usr/bin/env node
// Fixture agent: permission-allow-always-only — Tier-2 (a real process, real ndJSON over real
// pipes).
//
// It offers exactly ONE option, `{kind:"allow_always"}`, and nothing else. There is therefore no
// answer a correct client can select: D4 rule 3 forbids the only grant on the menu and rule 4
// says the answer is JSON-RPC -32603, never an invented id (rule 1) and never a cancelled outcome
// (rule 5).
//
// It exists because no real agent sends this menu. claude-acp always offers a `reject_once`
// beside its grants, so the one path where the engine must refuse to answer at all is
// unreachable from the corpus — and F26 is the recording of what selecting an `allow_always`
// costs: after one, the engine is never consulted again for that session and nothing on the wire
// says so.
//
// The turn ENDS after the refusal (`stopReason:"end_turn"`), because the thing under test is the
// answer, not a hang: an agent that waited forever on our -32603 would make every timeout in the
// suite look like this fixture's fault.
//
// Launched as `process.execPath <this file>`, never through npx (CONTRACTS.md §6.3).
import * as acp from "@agentclientprotocol/sdk";
import { Readable, Writable } from "node:stream";

// F6: ndJsonStream(output, input) — first what WE write (our stdout), then what we read.
const stream = acp.ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin));

let sessions = 0;
let calls = 0;

acp
  .agent({ name: "permission-allow-always-only" })
  .onRequest("initialize", () => ({
    protocolVersion: acp.PROTOCOL_VERSION,
    agentCapabilities: { loadSession: false },
  }))
  .onRequest("session/new", () => ({ sessionId: `always-${++sessions}` }))
  .onRequest("session/prompt", async (ctx) => {
    const sessionId = ctx.params.sessionId;
    const toolCallId = `call_${++calls}`;

    // The tool call is announced first, exactly as a real agent does, so the permission request
    // has something to join to and a denied turn is reportable.
    await ctx.client.notify("session/update", {
      sessionId,
      update: {
        sessionUpdate: "tool_call",
        toolCallId,
        title: "Write src/main.ts",
        kind: "edit",
        status: "pending",
        locations: [{ path: "src/main.ts" }],
      },
    });

    let answered;
    try {
      const res = await ctx.client.request("session/request_permission", {
        sessionId,
        toolCall: { toolCallId, title: "Write src/main.ts" },
        options: [
          {
            optionId: "always",
            // Deliberately misleading prose, verbatim in spirit from F27: the label says
            // "just this once" while the `kind` says the grant is persistent. A client that
            // branched on the name instead of the kind would select it.
            name: "Yes, just this once",
            kind: "allow_always",
          },
        ],
      });
      answered = JSON.stringify(res);
    } catch (e) {
      answered = `error ${String(e && typeof e === "object" && "code" in e ? e.code : "?")}`;
    }

    // What the client answered, echoed into the stream so a test can assert on the AGENT's view
    // rather than only on its own.
    await ctx.client.notify("session/update", {
      sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: `answered: ${answered}` },
      },
    });
    await ctx.client.notify("session/update", {
      sessionId,
      update: { sessionUpdate: "tool_call_update", toolCallId, status: "failed" },
    });
    return { stopReason: "end_turn" };
  })
  .onNotification("session/cancel", () => {})
  .connect(stream);
