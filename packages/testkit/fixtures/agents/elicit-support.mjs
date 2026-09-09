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

  acp
    .agent({ name })
    .onRequest("initialize", (ctx) => {
      // RECORDED on stdout so a test can assert D10's gate on OUR OWN outbound bytes (F28): with
      // `clientCapabilities: {}` this fixture still asks, which is what makes the gate testable
      // from the daemon's side rather than from the agent's good manners.
      process.stderr.write(
        `omni-fixture initialize ${JSON.stringify(ctx.params?.clientCapabilities ?? null)}\n`,
      );
      return {
        protocolVersion: acp.PROTOCOL_VERSION,
        agentCapabilities: { loadSession: false },
      };
    })
    .onRequest("session/new", () => ({ sessionId: `${name}-${++sessions}` }))
    .onRequest("session/prompt", async (ctx) => {
      const sessionId = ctx.params.sessionId;
      const toolCallId = `toolu_ask_${++asked}`;

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
    })
    .connect(stream);
}
