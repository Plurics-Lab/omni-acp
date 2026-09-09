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
export function elicitationScript(
  _a: ScriptedAgent,
  _q: { message: string; questions: readonly { id: string; choices: readonly string[] }[] },
): Promise<{ action: string; content?: Record<string, unknown> }> {
  throw new OmniError("internal", "unimplemented: M2-A-WP-I");
}
