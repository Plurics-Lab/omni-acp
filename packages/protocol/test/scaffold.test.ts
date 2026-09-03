import { describe, expect, it } from "vitest";
import {
  ERROR_STATUS,
  EVENT_KINDS,
  M0_WORKER_STATES,
  OMNI_ERROR_CODES,
  OmniError,
  WORKER_STATES,
} from "@omni-acp/protocol";

/**
 * The scaffold's own smoke test: the package resolves through its `exports` map to the built
 * `dist` (D25), and the two tables that must be total at compile time are also total at runtime.
 * WP-1 owns everything past this point.
 */
describe("@omni-acp/protocol scaffold", () => {
  it("maps every error code to a status", () => {
    for (const code of OMNI_ERROR_CODES) {
      expect(typeof ERROR_STATUS[code]).toBe("number");
    }
    expect(Object.keys(ERROR_STATUS).sort()).toEqual([...OMNI_ERROR_CODES].sort());
  });

  it("constructs an OmniError carrying its status", () => {
    const e = new OmniError("worker_busy", "a turn is already live");
    expect(e).toBeInstanceOf(Error);
    expect(e.code).toBe("worker_busy");
    expect(e.status).toBe(409);
  });

  it("keeps M0's reachable worker states a subset of the wire-stable set", () => {
    for (const s of M0_WORKER_STATES) {
      expect(WORKER_STATES).toContain(s);
    }
    expect(EVENT_KINDS).toContain("omni.worker_state");
  });
});
