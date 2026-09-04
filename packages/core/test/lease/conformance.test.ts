import { describe } from "vitest";
import { LeaseConfig, type WorkerId } from "@omni-acp/protocol";
import { fakeClock, runLeaseConformance } from "@omni-acp/testkit";
import { createLease } from "@omni-acp/core";

/**
 * §16.4's suite against the `Lease` OBJECT. The very same suite runs against the HTTP surface in
 * `packages/daemon/test/http/lease.test.ts`, which is what makes "the two cannot drift" a fact
 * rather than an intention.
 */
describe("createLease", () => {
  const clock = fakeClock();
  let n = 0;
  runLeaseConformance(
    "createLease",
    () =>
      createLease({
        // A distinct worker id per lease, so a snapshot that leaked between two of them would
        // show up as a mismatched `workerId` rather than as a passing test.
        workerId: `w_${String(++n).padStart(26, "0")}` as WorkerId,
        clock,
        config: LeaseConfig.parse({}),
      }),
    clock,
  );
});
