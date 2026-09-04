import { describe, it } from "vitest";

/** M1-WP-B's acceptance bullets, one `it.todo` each (M1-PLAN §2, WP-B). */
describe("M1-WP-B — the full v1->v2 map, the close-out ladder, the turn projection", () => {
  it.todo(
    "every row of §12.3 has a hand-written test with LITERAL input and LITERAL expected output — never captured from the implementation",
  );
  it.todo(
    "all 216 recorded updates pass the eight properties of §12.7(b): total, idempotent, `_meta` survives BY IDENTITY, no tool_call/plan/current_mode_update survives, isCustom false, content blocks checked recursively",
  );
  it.todo(
    "messageId is synthesized 0 times across the claude-acp corpus (86/86 chunks pass through) and correctly for thought.mjs",
  );
  it.todo(
    "mapDiffBlock produces a patch `git apply --check` accepts for the recorded edit AND the recorded creation; TurnResult.patch stays null and it appears only as vendorPatch",
  );
  it.todo(
    "mapPermissionRequest is idempotent, never reshapes options, preserves an unknown kind, and the responder refuses an optionId the agent did not offer (corpus 09)",
  );
  it.todo(
    "the forced ladder drives rungs 1->5 in order under fakeClock(), with a usage_update mid-rung ordered BEFORE idle (the corpus 06 shape)",
  );
  it.todo(
    "the ladder runs END-TO-END through a real Worker on a scripted agent: close_stdin observed by the fixture, drained from the process's own stdout EOF, a fatalStderr line promoted to omni.error before idle",
  );
  it.todo(
    "ALL M0 turn-lifecycle unit tests pass unmodified — the six M0 arms keep their semantics",
  );
  it.todo(
    "verdict never depends on agent prose; `no-agent-prose` and `descriptor-is-the-only-branch` pass and are each demonstrated FAILING on a planted violation",
  );
  it.todo(
    "the eight named golden cases of §12.8 are green; the six generated envelope goldens pass `corpus:emit --check`; the .expected.json files are hand-written",
  );
  it.todo(
    "reduceTurn is still pure, still deterministic, still de-duplicates by (workerId, seq), and now SKIPS replay:true envelopes",
  );
});
