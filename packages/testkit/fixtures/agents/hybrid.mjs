#!/usr/bin/env node
// Fixture agent: hybrid — Tier-2 (a real process, real ndJSON over real pipes).
//
// The F24 fixture: a v1/v2 HYBRID, which is what the only real agent actually is. It answers
// `initialize` with `protocolVersion: 1` while already emitting `usage_update` and
// `config_option_update` and already returning `configOptions` from `session/new` — so a mapper
// that switched on a version number would mangle it, and one that is idempotent per field will
// not. It also covers the corpus's last gap: a tool call that **fails on its own merits** rather
// than by a denied permission (research README, "Known gaps").
//
// One turn emits, in order:
//   1. `config_option_update` — ALREADY v2 (§12.3 row 12 is `=`, and must stay `=`)
//   2. `tool_call`            — v1, with a `_meta` this fixture owns
//   3. `usage_update`         — v1-and-v2 at once, with a vendor `_meta` block
//   4. `tool_call_update`     — status `failed`, `rawOutput` in prose we never parse
//   5. `agent_message_chunk`  — with a real `messageId`, so nothing is synthesized
//
// Env knobs, each pinned by `fixture-agents.test.ts`:
//   HYBRID_EOF_MARKER=<path>   append a line to this file for each ladder rung the agent can
//                              SEE — `eof` when stdin closes (§13.2 rung 2) and `cancel` when
//                              `session/cancel` arrives (rung 4). This is how a test observes the
//                              ladder from the agent's side rather than from our own reducer.
//   HYBRID_IGNORE_EOF=1        record the EOF but do NOT exit, so stdout never ends and the
//                              ladder has to walk past the drain rung instead of short-circuiting.
//   HYBRID_FATAL_STDERR=1      write one COMPLETE fatal line to stderr mid-turn (§13.4's fourth
//                              signal, which is a whole line or it is nothing).
//   HYBRID_NEVER_ANSWER=1      never resolve `session/prompt`, so a close-out ladder has a LIVE
//                              turn to walk. `session/cancel` is still ignored.
//   HYBRID_RATE_LIMIT=<status> put `{status}` in `usage_update._meta` under this fixture's own
//                              pointer, so the descriptor's `rate_limit` extension has something
//                              to resolve. Default: none.
//
// Launched as `process.execPath <this file>`, never through npx (CONTRACTS.md §6.3).
import * as acp from "@agentclientprotocol/sdk";
import { appendFileSync } from "node:fs";
import { PassThrough, Readable, Writable } from "node:stream";

const EOF_MARKER = process.env.HYBRID_EOF_MARKER ?? "";
const IGNORE_EOF = process.env.HYBRID_IGNORE_EOF === "1";
const FATAL_STDERR = process.env.HYBRID_FATAL_STDERR === "1";
const NEVER_ANSWER = process.env.HYBRID_NEVER_ANSWER === "1";
const RATE_LIMIT = process.env.HYBRID_RATE_LIMIT ?? "";

// stdin is piped through a PassThrough rather than handed straight to `Readable.toWeb`, so the
// `end` event still reaches us: observing stdin EOF is the whole point of EOF_MARKER, and a
// stream the web adapter has taken ownership of no longer reports it here.
const stdin = new PassThrough();
process.stdin.pipe(stdin);
const mark = (what) => {
  if (EOF_MARKER !== "") appendFileSync(EOF_MARKER, `${what}\n`);
};

process.stdin.on("end", () => {
  mark("eof");
  // Exit on stdin EOF like every ACP agent: it is the cooperative rung of §6.5's ladder, and it
  // is what makes the drain rung's `stdoutEnded` arrive. IGNORE_EOF is the uncooperative agent,
  // which is the only way a test reaches rung 4.
  if (!IGNORE_EOF) process.exit(0);
});

const stream = acp.ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(stdin));

let sessions = 0;

const CONFIG_OPTIONS = [
  {
    id: "mode",
    name: "Mode",
    description: "Session permission mode",
    category: "mode",
    type: "select",
    currentValue: "default",
    options: [
      { value: "default", name: "Manual" },
      { value: "acceptEdits", name: "Accept edits" },
    ],
  },
];

const never = () => new Promise(() => {});

acp
  .agent({ name: "hybrid" })
  .onRequest("initialize", () => ({
    // v1 on the wire…
    protocolVersion: acp.PROTOCOL_VERSION,
    agentCapabilities: {
      loadSession: true,
      promptCapabilities: { image: true, embeddedContext: true },
      sessionCapabilities: { close: {}, list: {}, resume: {} },
    },
  }))
  // …and v2 in the body: `configOptions` is a v2 field on a v1 `session/new` response (F24).
  .onRequest("session/new", () => ({
    sessionId: `hybrid-${++sessions}`,
    modes: {
      currentModeId: "default",
      availableModes: [
        { id: "default", name: "Manual" },
        { id: "acceptEdits", name: "Accept edits" },
      ],
    },
    configOptions: CONFIG_OPTIONS,
  }))
  .onRequest("session/prompt", async (ctx) => {
    const sessionId = ctx.params.sessionId;
    const send = (update) => ctx.client.notify("session/update", { sessionId, update });

    await send({ sessionUpdate: "config_option_update", configOptions: CONFIG_OPTIONS });
    await send({
      sessionUpdate: "tool_call",
      toolCallId: "hybrid-call-1",
      title: "Read missing.txt",
      kind: "read",
      status: "pending",
      rawInput: { path: "missing.txt" },
      locations: [],
      _meta: { "hybrid.test/tool": "Read" },
    });
    await send({
      sessionUpdate: "usage_update",
      used: 1_234,
      size: 200_000,
      ...(RATE_LIMIT === ""
        ? {}
        : { _meta: { "hybrid.test/rateLimit": { status: RATE_LIMIT, utilization: 0.9 } } }),
    });

    if (FATAL_STDERR) {
      // ONE COMPLETE LINE. §13.4's stderr signal keys on a whole line precisely because a
      // partial one can match a pattern that the full line would not.
      process.stderr.write("FATAL: hybrid fixture cannot continue\n");
    }

    // A tool that failed ON ITS OWN MERITS — no permission was ever requested, so `verdict`
    // must reach "partial" through the STATUS ENUM and not through anything we denied.
    await send({
      sessionUpdate: "tool_call_update",
      toolCallId: "hybrid-call-1",
      status: "failed",
      rawOutput: "ENOENT: no such file or directory, open 'missing.txt'",
      _meta: { "hybrid.test/tool": "Read" },
    });
    await send({
      sessionUpdate: "agent_message_chunk",
      messageId: "hybrid-msg-1",
      content: { type: "text", text: "I could not read that file." },
    });

    if (NEVER_ANSWER) return never();
    return { stopReason: "end_turn", usage: { totalTokens: 30, inputTokens: 10, outputTokens: 20 } };
  })
  .onNotification("session/cancel", () => {
    // RECORDED, then ignored on purpose: a close-out ladder that reaches rung 4 must not be
    // rescued by a cooperative agent, or the rung after it never runs — and the mark is how a
    // test knows rung 4 was actually SENT rather than merely requested by the reducer.
    mark("cancel");
  })
  .connect(stream);
