import { OmniError, type EventLog, type PersistedEventLogOptions } from "@omni-acp/protocol";

/**
 * The write-through durable log: the ring in front (F11), an `EventStore.put` behind it, and
 * `append()` still SYNCHRONOUS and still the sole assigner of `seq` (§14.1, §8.2).
 *
 * A `put` that throws DEGRADES — `WorkerSnapshot.persistence` becomes `"degraded"` and
 * `GET /v1/info.persistence.writeFailures` counts it — and never throws into `append`, never
 * skips a `seq`, and still delivers to every subscriber (§14.3). The log in RAM stays correct;
 * what is lost is the promise that a restart can read it back, and we say so rather than
 * pretending.
 *
 * Owned by M1-WP-A.
 */
export function createPersistedEventLog(_o: PersistedEventLogOptions): EventLog {
  throw new OmniError("internal", "unimplemented: M1-WP-A");
}
