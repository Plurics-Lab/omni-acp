import { describe, expect, it } from "vitest";
import * as core from "@omni-acp/core";

/**
 * `exports-are-stable` in embryo: the frozen barrel resolves through the built `dist` and every
 * factory the work packages are supposed to fill in is actually reachable by name.
 */
describe("@omni-acp/core scaffold", () => {
  it("exports every M0 factory", () => {
    for (const name of [
      "createPlatformOps",
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

  it("throws a typed unimplemented error until its work package lands", () => {
    expect(() => core.createPlatformOps()).toThrow(/unimplemented: WP-2/);
  });
});
