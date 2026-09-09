import { describe, it } from "vitest";

/**
 * The idle watchdog against `stall-silent.mjs` and `stall-in-tool.mjs` under a fake clock.
 *
 * Owned by M2-A-WP-W.
 */

describe("idle watchdog (M2-A, DESIGN §7)", () => {
  it.todo("a silent stall trips silentMs and escalates into M1's existing cancel_timeout close");
  it.todo(
    "a stall with a tool call OPEN uses the LARGER toolMs budget and reports strandedToolCalls",
  );
  it.todo(
    "WorkerStatePayload.watchdog says which budget fired, so an operator tells a silent stall from a stuck tool without reading the log",
  );
});
