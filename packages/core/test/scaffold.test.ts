import { describe, expect, it } from "vitest";
import * as core from "@omni-acp/core";

/**
 * `exports-are-stable` in embryo: the frozen barrel resolves through the built `dist` and every
 * factory the work packages are supposed to fill in is actually reachable by name.
 *
 * This file is SCAFFOLD-OWNED and frozen (M0-PLAN.md §3), because it is the one scaffold test
 * that spans work packages: it names factories WP-2, WP-3 and WP-4 each own. It therefore
 * asserts export SHAPE only — never `throws unimplemented` — so that the first work package to
 * land a real body does not turn a file it may not edit red (review R1).
 */
describe("@omni-acp/core scaffold", () => {
  it("exports every M0 factory", () => {
    for (const name of [
      "createPlatformOps",
      "runUtility",
      "createSupervisor",
      "createMemoryEventLog",
      "createNormalizer",
      "openAcpLink",
      "createBaselineResponder",
      "alwaysGrantedLease",
      "createWorker",
    ] as const) {
      expect(typeof core[name], name).toBe("function");
    }
  });
});
