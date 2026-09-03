import { describe, expect, it } from "vitest";
import { runEventLogConformance } from "@omni-acp/testkit";
import { referenceEventLog } from "./support/reference-event-log.js";

/**
 * Runs the exported conformance suite against a reference implementation, so that WP-3 (and
 * M1's SQLite driver) receive a suite that is known to be satisfiable and internally
 * consistent rather than a wish list.
 */
runEventLogConformance("reference (testkit self-check)", () => referenceEventLog());

describe("runEventLogConformance", () => {
  it("also holds for a log small enough to evict", () => {
    // Ring eviction raises `tail`; the suite is written so both cases pass, and this asserts
    // the evicting case is genuinely exercised rather than accidentally skipped.
    const log = referenceEventLog({ maxEvents: 8 });
    for (let i = 0; i < 20; i++) {
      log.append({
        kind: "omni.error",
        payloadVersion: 2,
        payload: { code: "internal", message: `m${i}` },
      });
    }
    expect(log.head).toBe(20);
    expect(log.tail).toBe(13);
    expect(log.read(0)[0]?.seq).toBe(13);
    log.close();
  });
});
