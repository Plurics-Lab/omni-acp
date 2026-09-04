import {
  OmniError,
  type Clock,
  type Logger,
  type RuntimeDescriptor,
  type SessionStrategy,
} from "@omni-acp/protocol";

/**
 * SEAM 2 (M1-PLAN §1.2). After M1, `Worker` never names `initialize`, `session/new`,
 * `session/load` or `session/resume` again: it holds a `SessionStrategy` and calls `open()` on
 * create and `reopen()` on wake.
 *
 * That is what lets the resume work package and the daemon work package own disjoint files while
 * `worker.ts` is edited exactly ONCE, by the Land step, and then frozen.
 *
 * Owned by M1-WP-C.
 */
export function createSessionStrategy(_o: {
  descriptor: RuntimeDescriptor;
  clock: Clock;
  logger: Logger;
}): SessionStrategy {
  throw new OmniError("internal", "unimplemented: M1-WP-C");
}
