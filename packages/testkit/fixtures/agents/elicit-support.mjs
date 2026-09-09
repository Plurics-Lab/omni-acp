// Shared shape for the four `elicit-*` fixtures — Tier-2 (a real process, real ndJSON over real
// pipes), and every byte of the schema below is transcript `12`'s.
//
//  - the scope fields are FLAT in `params` (F29), never nested under `scope`;
//  - the choices are `oneOf[].const`, NOT `enum` (F30);
//  - the paired `<id>_custom` property carries the
//    `_meta._askUserQuestionCustomAnswer.{questionId, isCustomAnswer}` marker;
//  - there is NO `required` array;
//  - and the request is MIRRORED as an `AskUserQuestion` tool call, `kind:"other"` (F32).
//
// A fixture that got this wrong would make every M2-A test agree with a shape no agent sends.
//
// Launched as `process.execPath <this file>`, never through npx (CONTRACTS.md §6.3).
// Owned by M2-A-WP-I.
import * as acp from "@agentclientprotocol/sdk";
import { Readable, Writable } from "node:stream";

/** One question -> TWO schema properties (F30). */
export function schemaFor(questions) {
  const properties = {};
  for (const q of questions) {
    properties[q.id] = {
      type: "string",
      title: q.title ?? "File name",
      oneOf: q.choices.map((c) => ({ const: c, title: c, description: `A file called ${c}` })),
    };
    if (q.custom === false) continue;
    properties[`${q.id}_custom`] = {
      type: "string",
      title: "Other",
      description: "Type your own answer instead of choosing an option above (optional).",
      _meta: { _askUserQuestionCustomAnswer: { questionId: q.id, isCustomAnswer: true } },
    };
  }
  return { type: "object", properties };
}

/**
 * Builds the agent.
 *
 * `onAnswer(answer, ctx)` decides what happens after the client replies; returning a stopReason
 * ends the turn. `neverResolves: true` issues the request and never settles the prompt — the ONLY
 * way to test `parkTimeoutAction`, because the corpus answered both elicitations in ~1 ms.
 */
export function elicitAgent({ name, questions, message, neverResolves = false, onAnswer }) {
  const stream = acp.ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin));
  let sessions = 0;
  let asked = 0;
  /** What the CLIENT declared on the most recent `initialize`. Echoed into the turn below. */
  let declared = null;
  /**
   * `OMNI_FIXTURE_RESUMABLE=1` advertises a resume spelling, so the worker may be hibernated and
   * woken (M1-R15) — which is the only way to observe F42's wake-path declaration end to end.
   */
  const resumable = process.env.OMNI_FIXTURE_RESUMABLE === "1";

  const app = acp
    .agent({ name })
    .onRequest("initialize", (ctx) => {
      // RECORDED, because F28's whole finding is that the AGENT branches on these bytes and
      // `initialize`'s `agentCapabilities` says nothing about elicitation either way — so our own
      // declaration is the only record of why an agent asked in prose. A real claude-acp honours
      // the gate; this fixture deliberately does NOT, so that ruling M2-R15's "asks anyway ⇒
      // decline" arm is reachable at all.
      declared = ctx.params?.clientCapabilities ?? null;
      process.stderr.write(`omni-fixture initialize ${JSON.stringify(declared)}\n`);
      return {
        protocolVersion: acp.PROTOCOL_VERSION,
        agentCapabilities: resumable
          ? { loadSession: true, sessionCapabilities: { resume: {}, close: {} } }
          : { loadSession: false },
      };
    })
    .onRequest("session/new", () => ({ sessionId: `${name}-${++sessions}` }))
    .onRequest("session/prompt", async (ctx) => {
      const sessionId = ctx.params.sessionId;
      const toolCallId = `toolu_ask_${++asked}`;

      // The declaration, echoed into the LOG, so a test asserts D10's gate on our own outbound
      // bytes rather than on the fixture's good manners or on a stderr tail.
      await ctx.client.notify("session/update", {
        sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: `omni-declared:${JSON.stringify(declared)}` },
        },
      });

      // F32: the mirror, first and always.
      await ctx.client.notify("session/update", {
        sessionId,
        update: {
          _meta: { claudeCode: { toolName: "AskUserQuestion" } },
          toolCallId,
          sessionUpdate: "tool_call",
          rawInput: {},
          status: "pending",
          title: "Asking for your input",
          kind: "other",
          content: [],
        },
      });

      let answer;
      try {
        answer = await ctx.client.request("elicitation/create", {
          mode: "form",
          sessionId,
          toolCallId,
          message,
          requestedSchema: schemaFor(questions),
        });
      } catch (e) {
        // The client refused. F31: the tool call still completes — accept and decline are
        // indistinguishable in this stream, which is why the DAEMON records the outcome.
        answer = { action: "decline", _error: String(e?.code ?? e) };
      }

      process.stderr.write(`omni-fixture answer ${JSON.stringify(answer)}\n`);

      await ctx.client.notify("session/update", {
        sessionId,
        update: {
          _meta: { claudeCode: { toolName: "AskUserQuestion" } },
          toolCallId,
          sessionUpdate: "tool_call_update",
          status: "completed",
          rawOutput:
            answer?.action === "accept"
              ? `The user answered: ${JSON.stringify(answer.content ?? {})}`
              : "The user did not answer the questions.",
        },
      });

      if (typeof onAnswer === "function") await onAnswer(answer, { ctx, sessionId });
      // `neverResolves` is checked AFTER the answer so the request is genuinely outstanding for
      // the whole park: a fixture that hung before asking would test nothing.
      if (neverResolves) return new Promise(() => {});
      return { stopReason: "end_turn" };
    })
    .onNotification("session/cancel", () => {
      // Deliberately inert: the escalation ladder is only reachable if nobody answers, and
      // §19.8's ordering claim is observed by the CLIENT sending the cancel.
    });

  if (resumable) {
    app.onRequest("session/resume", (ctx) => ({ sessionId: ctx.params?.sessionId ?? "resumed" }));
    app.onRequest("session/close", () => ({}));
  }

  app.connect(stream);
}
