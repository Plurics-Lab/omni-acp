import { describe } from "vitest";
import { fakeClock, runEventLogConformance } from "@omni-acp/testkit";
import type { DaemonId, WorkerId } from "@omni-acp/protocol";
import { testEventLog } from "./fake-core.js";

/**
 * The daemon's suites drive the real registry and the real SSE writer against a test double of
 * WP-3's event log (see `fake-core.ts`). A double that quietly disagrees with the contract would
 * make every SSE assertion above it worthless, so it is held to the SAME exported suite M1's
 * SQLite driver must pass (CONTRACTS.md §8.1).
 */
describe("the daemon suite's event-log double", () => {
  runEventLogConformance("testEventLog", () =>
    testEventLog({
      workerId: `w_${"0".repeat(25)}1` as WorkerId,
      daemonId: `d_${"0".repeat(25)}1` as DaemonId,
      clock: fakeClock(),
      maxEvents: 10_000,
      subscriberQueueSize: 1_024,
    }),
  );
});
