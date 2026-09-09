import { OmniError } from "@omni-acp/protocol";
import type { ScriptedAgent } from "../scripted-agent.js";

/**
 * The EXACT claude-acp v1 elicitation shape, from transcript `12` — and every detail of it is
 * load-bearing, which is why it is a fixture rather than a hand-written object in one test:
 *
 *  - the scope fields are FLAT in `params` (F29), not nested under `scope`;
 *  - the choices are `oneOf[].const`, NOT `enum` (F30);
 *  - the paired `question_0_custom` property carries the
 *    `_meta._askUserQuestionCustomAnswer.{questionId, isCustomAnswer}` marker;
 *  - there is NO `required` array;
 *  - and the whole thing is MIRRORED as an `AskUserQuestion` tool call (F32).
 *
 * A fixture that got this wrong would make every M2-A test agree with a shape no agent sends.
 *
 * Owned by M2-A-WP-I.
 */
export interface ElicitationQuestion {
  /** The property name the schema uses. Transcript `12` numbers them `question_0`, `question_1`. */
  readonly id: string;
  readonly choices: readonly string[];
  /** The question's own heading. Transcript `12`'s is `"File name"`. */
  readonly title?: string;
  /** Set false to omit the paired `_custom` slot — the "no free text offered" shape. */
  readonly custom?: boolean;
}

export interface ElicitationScriptOptions {
  readonly message: string;
  readonly questions: readonly ElicitationQuestion[];
  /**
   * The `toolCallId` shared by the request and its `AskUserQuestion` mirror (F32) — the join a
   * consumer uses, and the reason the same interaction is never counted twice.
   */
  readonly toolCallId?: string;
  /** Emit the tool-call mirror before asking. Default true, because claude-acp always does. */
  readonly mirror?: boolean;
}

/**
 * `params.requestedSchema`, byte for byte in transcript `12`'s shape.
 *
 * Module-private: §5.8.10 pins `@omni-acp/testkit`'s surface to `elicitationScript` alone, and
 * `exports-are-stable` fails the build on a name that leaked. A consumer that needs these bytes
 * gets them by reading what `elicitationScript` actually sent.
 */
function elicitationSchema(questions: readonly ElicitationQuestion[]): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  for (const q of questions) {
    properties[q.id] = {
      type: "string",
      title: q.title ?? "File name",
      // F30: `oneOf` with a `const` per choice. NOT `enum` — a reader that knows only `enum` sees
      // every question as unconstrained free text and routes every answer to the custom slot.
      oneOf: q.choices.map((c) => ({
        const: c,
        title: c,
        description: `A file called ${c}`,
      })),
    };
    if (q.custom === false) continue;
    properties[`${q.id}_custom`] = {
      type: "string",
      title: "Other",
      description: "Type your own answer instead of choosing an option above (optional).",
      // THE marker. A schema parse strips it, and the agent then reads whichever property the
      // client filled — which is how transcript `12` created `omni-choice.txt` instead of the
      // selected `notes.md` (F30, §19.3).
      _meta: { _askUserQuestionCustomAnswer: { questionId: q.id, isCustomAnswer: true } },
    };
  }
  // No `required` array: neither recorded elicitation carried one (F29).
  return { type: "object", properties };
}

/** `params`, flat (F29) — the whole object the agent puts on the wire. Module-private, as above. */
function elicitationParams(
  o: ElicitationScriptOptions,
  sessionId: string,
): Record<string, unknown> {
  return {
    mode: "form",
    // F29: FLAT. A type that models the scope as a nested object parses nothing a real
    // claude-acp sends.
    sessionId,
    toolCallId: o.toolCallId ?? "toolu_ask_1",
    message: o.message,
    requestedSchema: elicitationSchema(o.questions),
  };
}

export function elicitationScript(
  a: ScriptedAgent,
  q: ElicitationScriptOptions,
): Promise<{ action: string; content?: Record<string, unknown> }> {
  if (q.questions.length === 0) {
    throw new OmniError("bad_request", "elicitationScript needs at least one question");
  }
  const sessionId = a.sessionIds.at(-1);
  if (sessionId === undefined) {
    throw new OmniError("internal", "elicitationScript: no session yet — call session/new first");
  }
  const toolCallId = q.toolCallId ?? "toolu_ask_1";

  const ask = async (): Promise<{ action: string; content?: Record<string, unknown> }> => {
    if (q.mirror !== false) {
      // F32: the SAME interaction also appears as a `tool_call`, `kind:"other"`, with
      // `_meta.claudeCode.toolName: "AskUserQuestion"`. `TurnResult.interactions` and
      // `TurnResult.toolCalls` are folded separately and neither feeds the other.
      await a.emitToolCall({
        _meta: { claudeCode: { toolName: "AskUserQuestion" } },
        toolCallId,
        rawInput: {},
        status: "pending",
        title: "Asking for your input",
        kind: "other",
        content: [],
      });
    }
    const answer = await a.request("elicitation/create", elicitationParams(q, sessionId));
    if ("error" in answer) {
      throw new OmniError(
        "agent_error",
        `elicitation/create was refused with ${String(answer.error)}`,
      );
    }
    const result = answer.result;
    const record =
      typeof result === "object" && result !== null ? (result as Record<string, unknown>) : {};
    const action = typeof record["action"] === "string" ? record["action"] : "decline";
    const content = record["content"];
    return {
      action,
      ...(typeof content === "object" && content !== null
        ? { content: content as Record<string, unknown> }
        : {}),
    };
  };

  return ask();
}
