import { describe, expect, it } from "vitest";
import { runEventLogConformance, tmpPersistence } from "@omni-acp/testkit";
import { OmniError } from "@omni-acp/protocol";
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

describe("tmpPersistence", () => {
  it("refuses to run without its factories, and says exactly why", async () => {
    // `@omni-acp/testkit` depends on `@omni-acp/protocol` and nothing else (CONTRACTS.md §3.1),
    // and `@omni-acp/core` dev-depends on THIS package — so the import that would let the
    // harness open a database on its own is both forbidden and a cycle. Re-implementing
    // `openPersistence` here would give `runEventLogPersistenceConformance` a SECOND SQLite
    // driver to pass instead of the shipped one, which is the one thing a conformance suite
    // must never do. So the package under test injects its own, and calling it bare is a loud
    // error rather than a harness that silently proves nothing.
    //
    // `@omni-acp/core`'s `test/event-log/m1-acceptance.test.ts` is where the injected form runs
    // §14.11's ten items against the real driver.
    const bare = tmpPersistence as unknown as () => Promise<unknown>;
    let thrown: unknown = null;
    try {
      await bare();
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(OmniError);
    expect((thrown as OmniError).code).toBe("internal");
    expect((thrown as OmniError).message).toContain("openPersistence");
    expect((thrown as OmniError).message).toContain("§3.1");
  });
});
