import { describe, it } from "vitest";

/**
 * M2-B-WP-P's acceptance script (docs/M2-PLAN.md §2), one `it.todo` per bullet.
 *
 * Owned by M2-B-WP-P.
 */

describe("M2-B-WP-P — policy rule engine, presets, policyCeiling enforced", () => {
  it.todo(
    "runPolicyConformance passes for the engine AND still for baselineInteractions, over a generated `offered` array (a fixed 64-row table plus a seeded shuffle, no new dependency), including the empty array, the unknown-kind-only array, and the allow_always-only array whose correct answer is -32603",
  );
  it.todo(
    "permission-responder.test.ts passes UNEDITED after selectOption is extracted, and the policy-never-names-an-option guard passes — demonstrated FAILING on a planted optionId literal",
  );
  it.todo(
    "DESIGN §4's four example rules are a literal table test with literal inputs and literal verdicts",
  );
  it.todo(
    "the §20.3 match table is complete: unknown kind -> default; a path-less call vs a `path` rule -> NO match; all-paths-must-match; a path-only rule is a LOAD error (M2-R17); a cmd clause on a tool_call subject is rejected at COMPILE (M2-R18); regexes anchored, length-capped and rejected on catastrophic backtracking; action-directional case folding",
  );
  it.todo(
    "toPolicySubject realpaths, resolves a NOT-YET-EXISTING file through its deepest existing ancestor, and a symlink into src/ does NOT satisfy src/**",
  );
  it.todo(
    'assertWithinCeiling is total and decidable and throws 403 policy_exceeds_ceiling with body.policy.{ceiling, offending}; clampVerdict catches a case the static check PROVABLY CANNOT (an inline allow on path:["**"] under pathRoots:["src"]) and stamps `clamped` PLUS a TurnWarning, never silently; the dominates table includes fail === deny and tie-resolves-to-policy',
  );
  it.todo(
    "the four presets load from YAML as DATA; readonly never allows edit/delete/execute (a property test over 10 000 generated subjects); its kind:read exfiltration hazard (F37) is documented in presets.ts with the citation and covered by readonly-contained",
  );
  it.todo(
    "extends resolves, cycles are a load error, preset (+) inline is inline-last-wins, and PolicySnapshot.sources names every layer in order",
  );
  it.todo(
    'alertOnUnpoliced produces TurnWarning{code:"unpoliced_tool_call"} for a listed kind that never reached the engine — claude 13\'s silent `ls -A` is the fixture (F40)',
  );
  it.todo(
    "every D4 hard rule has a test that WOULD FAIL if the invariant were removed, and the engine is pure: the same subject in yields a deep-equal verdict 1 000 times over a seeded table, with no clock and no I/O",
  );
});
