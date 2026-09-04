import type { PersistedEventLogOptions } from "@omni-acp/protocol";
import { createEventLogCore, type EventLogCore } from "./log-core.js";

/**
 * The write-through durable log: the ring in front (F11), an `EventStore.put` behind it, and
 * `append()` still SYNCHRONOUS and still the sole assigner of `seq` (§14.1, §8.2).
 *
 * It is deliberately a four-line composition over `createEventLogCore`. The alternative — a
 * second log implementation that "also" persists — would put the fan-out, the overflow policy
 * and the re-entrancy guard in two places, and the SQLite driver has to pass M0's conformance
 * suite VERBATIM, object-identity assertion included. Sharing the core is what makes that
 * automatic rather than a re-derivation.
 *
 * A `put` that throws DEGRADES — `persistence` becomes `"degraded"` and
 * `GET /v1/info.persistence.writeFailures` counts it — and never throws into `append`, never
 * skips a `seq`, and still delivers to every subscriber (§14.3). The log in RAM stays correct;
 * what is lost is the promise that a restart can read it back, and we say so rather than
 * pretending.
 *
 * Owned by M1-WP-A.
 */
export function createPersistedEventLog(o: PersistedEventLogOptions): EventLogCore {
  return createEventLogCore({
    ...o,
    maxEvents: o.maxEvents ?? o.config.maxEventsPerWorker,
    queueSize: o.queueSize ?? o.config.subscriberQueueSize,
    /**
     * §14.4, and this is the single most dangerous line in M1. The head is restored from the
     * STORE, which answers `max(durable head_seq, max(seq))` — never `max(seq)` alone, which is
     * `NULL ⇒ 0` once retention has evicted every row and would restart a live worker's log at
     * seq 1 while clients hold cursors in the thousands.
     */
    startSeq: o.startSeq ?? o.store.headOf(o.workerId),
  });
}
