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
//   HYBRID_SESSION_DIR=<dir>   where sessions are persisted so a LATER PROCESS can resume one.
//                              Default `<tmpdir>/omni-hybrid-sessions`; never the cwd, so a test
//                              that hands this agent `process.cwd()` does not write to the repo.
//   HYBRID_ASK=1               ALSO request `session/request_permission` for an `edit` tool call
//                              whose `locations[]` point inside the session's cwd, and swallow
//                              whatever comes back. It exists because this is the ONE fixture
//                              that implements a real resume, so it is the only one that can show
//                              what a woken worker's policy engine does — review finding V2/V8,
//                              where a restart silently left the engine unbuilt.
//
// RESUME (M1). This fixture already ADVERTISED `loadSession: true` and
// `sessionCapabilities.resume` — claude-acp's own handshake — while implementing neither, so
// every resume against it was a `-32601` and no hermetic agent in this repository could make a
// wake LAND. It now implements both spellings, and it implements them the way the corpus records
// the real agent behaving (research README findings 11-13, CONTRACTS.md §15.3-§15.4):
//
//   * the session is keyed by (sessionId, cwd) and persisted UNDER `HYBRID_SESSION_DIR`, so a
//     wake — which is a NEW PROCESS — can find it, and a resume from a FOREIGN cwd cannot;
//   * a resume for an id this cwd does not own answers `-32002 {message:"Resource not found:
//     <sessionId>"}` — F15's shape, which §15.4 classifies `unknown` / `cwd_mismatch` and
//     explicitly must NOT classify `rejected_permanent`;
//   * a resume that lands REPLAYS the stored transcript as `session/update` notifications
//     BETWEEN the request and its response (F16's exact, uninterleaved window), then answers
//     with the `session/new` body — the `loadReturnsBody` quirk, contrary to the v1 schema.
//
// Launched as `process.execPath <this file>`, never through npx (CONTRACTS.md §6.3).
import * as acp from "@agentclientprotocol/sdk";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Readable, Writable } from "node:stream";

const EOF_MARKER = process.env.HYBRID_EOF_MARKER ?? "";
const IGNORE_EOF = process.env.HYBRID_IGNORE_EOF === "1";
const FATAL_STDERR = process.env.HYBRID_FATAL_STDERR === "1";
const NEVER_ANSWER = process.env.HYBRID_NEVER_ANSWER === "1";
const RATE_LIMIT = process.env.HYBRID_RATE_LIMIT ?? "";
const ASK = process.env.HYBRID_ASK === "1";
const SESSION_DIR = process.env.HYBRID_SESSION_DIR ?? join(tmpdir(), "omni-hybrid-sessions");

// ── the session store: one small JSON file per session, keyed by id ──────────
//
// A wake is a NEW PROCESS, so an in-memory `Map` could never make a resume land — which is
// exactly why this fixture used to answer `-32601` and why no hermetic suite could prove
// §15.3. The file records the cwd the session was created in, and the resume path refuses a
// mismatch: that is what makes `resume-cwd-mismatch` reproducible without a real agent.

const sessionFile = (sessionId) => join(SESSION_DIR, `${encodeURIComponent(sessionId)}.json`);

const readSession = (sessionId) => {
  try {
    return JSON.parse(readFileSync(sessionFile(sessionId), "utf8"));
  } catch {
    return null;
  }
};

const writeSession = (session) => {
  try {
    mkdirSync(SESSION_DIR, { recursive: true });
    writeFileSync(sessionFile(session.sessionId), JSON.stringify(session), "utf8");
  } catch {
    // A store we cannot write is a session that cannot be resumed, which is a legitimate agent
    // and is classified as such. It is never a reason to fail the call the client actually made.
  }
};

/** F15's shape, verbatim: the code and the message a cwd mismatch produces on the real agent. */
const resourceNotFound = (sessionId) =>
  new acp.RequestError(-32002, `Resource not found: ${sessionId}`);

let keepAlive = null;
process.on("SIGTERM", () => {
  if (keepAlive !== null) clearInterval(keepAlive);
  process.exit(0);
});

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
  // …and staying alive takes WORK: with stdin at EOF the SDK connection closes and node's event
  // loop empties, so the process would exit 0 on its own and look cooperative. A live (not
  // unref'd) timer is what keeps stdout open, which is what the drain rung is waiting for.
  keepAlive = setInterval(() => {}, 1_000);
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

/**
 * The half of `session/new`'s answer a resume returns TOO.
 *
 * `loadReturnsBody` is the quirk (F18): `session/load` / `session/resume` come back with the
 * `session/new` body although the v1 schema types the result `null`. Sharing the literal is the
 * point — a resume that answered a DIFFERENT shape would be a second agent, not a resumed one.
 */
const SESSION_BODY = {
  modes: {
    currentModeId: "default",
    availableModes: [
      { id: "default", name: "Manual" },
      { id: "acceptEdits", name: "Accept edits" },
    ],
  },
  configOptions: CONFIG_OPTIONS,
};

/** Append the client's own prompt to the stored transcript, so a resume has something to replay. */
const remember = (sessionId, prompt) => {
  const session = readSession(sessionId);
  if (session === null) return;
  const text = (Array.isArray(prompt) ? prompt : [])
    .filter((block) => block !== null && typeof block === "object" && block.type === "text")
    .map((block) => String(block.text ?? ""))
    .join("");
  session.transcript.push({ role: "user", text });
  session.transcript.push({ role: "agent", text: "I could not read that file." });
  writeSession(session);
};

/**
 * `session/load` and `session/resume` (CONTRACTS.md §15.3).
 *
 * The refusal is the interesting half: an id this cwd does not own is `-32002 Resource not
 * found`, which §15.4 must classify `unknown` / `cwd_mismatch` with the pointer KEPT — never
 * `rejected_permanent`. The negative lock in `resume-classify.ts` exists for exactly this
 * message, and this fixture is what lets a hermetic suite produce it.
 *
 * The success half replays the transcript as `session/update` notifications and only THEN
 * resolves, so everything between the request and the response is replay — F16's window,
 * reproduced without a real agent.
 */
async function resume(ctx) {
  const sessionId = ctx.params.sessionId;
  const session = readSession(sessionId);
  if (session === null) throw resourceNotFound(sessionId);
  // The cwd check is the whole of `resumeRequiresSameCwd`: the real agent keys its sessions by
  // project directory, so the SAME live session is refused from a foreign cwd (F15).
  if (session.cwd !== null && ctx.params.cwd !== undefined && ctx.params.cwd !== session.cwd) {
    throw resourceNotFound(sessionId);
  }

  for (const entry of session.transcript) {
    await ctx.client.notify("session/update", {
      sessionId,
      update:
        entry.role === "user"
          ? {
              sessionUpdate: "user_message_chunk",
              content: { type: "text", text: entry.text },
            }
          : {
              sessionUpdate: "agent_message_chunk",
              // Stable across processes, like the real agent's (F14) — which is what makes
              // `resume.replay: "drop_duplicates"` conceivable at all.
              messageId: `hybrid-msg-1`,
              content: { type: "text", text: entry.text },
            },
    });
  }
  return { sessionId, ...SESSION_BODY };
}

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
  .onRequest("session/new", (ctx) => {
    // The id carries the pid and six random characters because sessions are persisted under ONE
    // shared directory: a bare counter would let two concurrently-running fixtures both mint
    // `hybrid-1` and then resume each other's transcript.
    const sessionId = `hybrid-${String(process.pid)}-${++sessions}-${randomBytes(3).toString("hex")}`;
    writeSession({ sessionId, cwd: ctx.params.cwd ?? null, transcript: [] });
    return { sessionId, ...SESSION_BODY };
  })
  // Both spellings, one implementation. F18 records ONE claude-acp process answering both, and a
  // client that walks a preference order has to find the same session behind either name.
  .onRequest("session/load", (ctx) => resume(ctx))
  .onRequest("session/resume", (ctx) => resume(ctx))
  .onRequest("session/prompt", async (ctx) => {
    const sessionId = ctx.params.sessionId;
    const send = (update) => ctx.client.notify("session/update", { sessionId, update });
    // What a later process would replay. Recorded BEFORE the turn runs, so a turn that never
    // finishes still leaves the question in the transcript — which is what the real agent does.
    remember(sessionId, ctx.params.prompt);

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

    if (ASK) {
      // A SECOND tool call, this one asking. `kind:"edit"` with a location inside the session's
      // own cwd is the subject a `src-edit`-shaped rule is written against, and the options are
      // the three claude-acp offers (F26's menu, minus nothing).
      const cwd = readSession(sessionId)?.cwd ?? process.cwd();
      await send({
        sessionUpdate: "tool_call",
        toolCallId: "hybrid-call-2",
        title: "Write notes.md",
        kind: "edit",
        status: "pending",
        locations: [{ path: join(cwd, "notes.md") }],
      });
      try {
        await ctx.client.request("session/request_permission", {
          sessionId,
          toolCall: {
            toolCallId: "hybrid-call-2",
            title: "Write notes.md",
            kind: "edit",
            locations: [{ path: join(cwd, "notes.md") }],
          },
          options: [
            { optionId: "allow-once", name: "Yes", kind: "allow_once" },
            { optionId: "allow-always", name: "Yes, always", kind: "allow_always" },
            { optionId: "reject", name: "No", kind: "reject_once" },
          ],
        });
      } catch {
        // A `-32603` is a legitimate answer (D4 rule 4) and this fixture is not the party that
        // decides what it means; the DECISION envelope is what a test reads.
      }
      await send({
        sessionUpdate: "tool_call_update",
        toolCallId: "hybrid-call-2",
        status: "completed",
      });
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
    return {
      stopReason: "end_turn",
      usage: { totalTokens: 30, inputTokens: 10, outputTokens: 20 },
    };
  })
  .onNotification("session/cancel", () => {
    // RECORDED, then ignored on purpose: a close-out ladder that reaches rung 4 must not be
    // rescued by a cooperative agent, or the rung after it never runs — and the mark is how a
    // test knows rung 4 was actually SENT rather than merely requested by the reducer.
    mark("cancel");
  })
  .connect(stream);
