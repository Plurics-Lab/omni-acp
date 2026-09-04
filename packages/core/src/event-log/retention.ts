import {
  OmniError,
  type PersistenceHandle,
  type RetentionInput,
  type RetentionPlan,
  type RetentionReport,
} from "@omni-acp/protocol";

/**
 * §14.5's THREE bounds, which are constantly confused, enumerated once:
 *
 *  1. the RAM ring (`maxEventsPerWorker`) — bounds MEMORY only, and never deletes a durable row;
 *  2. a per-worker durable row cap (`maxPersistedEventsPerWorker`), 0 = unbounded;
 *  3. 7 days after CLOSE (`retentionDays`, DESIGN §12).
 *
 * A LIVE or HIBERNATED worker is never aged out. `tail` tells the truth after every sweep.
 *
 * `planRetention` is PURE and table-tested; `runRetention` applies one plan, raising `tail_seq`
 * in the SAME transaction as the DELETE — a raise that lands separately is a window in which the
 * log reports rows it no longer has.
 *
 * Owned by M1-WP-A.
 */
export function planRetention(_o: RetentionInput): RetentionPlan {
  throw new OmniError("internal", "unimplemented: M1-WP-A");
}

export function runRetention(_h: PersistenceHandle, _p: RetentionPlan): RetentionReport {
  throw new OmniError("internal", "unimplemented: M1-WP-A");
}
