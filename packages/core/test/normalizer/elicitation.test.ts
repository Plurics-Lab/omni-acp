import { describe, it } from "vitest";

/**
 * `mapElicitation` / `buildElicitationContent` against transcripts `12` and `13` — the two
 * recorded `elicitation/create` exchanges, which are the only ground truth either function has.
 *
 * Owned by M2-A-WP-I.
 */

describe("mapElicitation (§5.8.9, F29/F30)", () => {
  it.todo(
    "reads the FLAT scope fields — sessionId and toolCallId sit in params, not under `scope` (F29)",
  );
  it.todo("folds oneOf[].const AND enum into `options`, in wire order (F30)");
  it.todo("pairs question_0_custom to question_0 through _meta._askUserQuestionCustomAnswer (F30)");
  it.todo("is idempotent: mapping a mapped request twice is deep-equal to mapping it once");
  it.todo("rejects a nested `scope` with a NAMED error rather than silently mis-parsing it");
});
