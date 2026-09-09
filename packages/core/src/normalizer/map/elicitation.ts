import { OmniError } from "@omni-acp/protocol";
import type { ElicitationField, MappedElicitationRequest } from "@omni-acp/protocol";

/**
 * `elicitation/create` params → a shape a route and a UI can address. PURE, TOTAL, IDEMPOTENT.
 *
 * Three recorded facts decide every line of it, and none of them is guessable from the v1 schema:
 *
 *  - **F29, the scope is FLAT.** `sessionId` and `toolCallId` sit directly in `params`, not under
 *    a `scope` object. A fixture that nests them is REJECTED with a named error rather than
 *    silently mis-parsed, because a mis-parse here produces an interaction with no scope at all.
 *  - **F30, `oneOf[].const` and `enum` are both real.** claude-acp sends `oneOf`; a reader that
 *    knows only `enum` sees every question as unconstrained free text.
 *  - **F30 again, the `_custom` pairing.** `_meta._askUserQuestionCustomAnswer.{questionId,
 *    isCustomAnswer}` is what marks `question_0_custom` as the free-text twin of `question_0`.
 *    Filling BOTH made the agent use the custom value and create `omni-choice.txt` instead of
 *    `notes.md`. That file name is the regression test's name.
 *
 * A schema this cannot understand yields `fields: []` with every property in `unmodelled`, which
 * makes `answer` impossible and `deny`/`cancel` still possible — instead of a form that lies
 * about itself.
 *
 * Owned by M2-A-WP-I.
 */
export function mapElicitation(_params: unknown): MappedElicitationRequest {
  throw new OmniError("internal", "unimplemented: M2-A-WP-I");
}

/**
 * The F30 rule in one function: EXACTLY ONE property per questionId reaches the wire, and WHICH
 * one is decided by whether the value is one of the schema's own consts.
 *
 * Answering both members of a question group is `bad_request` — the SDK never sends both, and the
 * daemon re-checks, because the agent reads the custom slot in preference and a client that filled
 * both would silently get the other answer.
 *
 * Owned by M2-A-WP-I.
 */
export function buildElicitationContent(
  _fields: readonly ElicitationField[],
  _answers: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  throw new OmniError("internal", "unimplemented: M2-A-WP-I");
}
