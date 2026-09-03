import {
  OmniError,
  type Clock,
  type DaemonId,
  type EventLog,
  type WorkerId,
} from "@omni-acp/protocol";

export interface MemoryEventLogOptions {
  readonly workerId: WorkerId;
  readonly daemonId: DaemonId;
  readonly clock: Clock;
  readonly maxEvents: number;
  readonly subscriberQueueSize: number;
}

/**
 * The in-memory ring of CONTRACTS.md §8.
 *
 * Three properties carry the whole design and none of them are negotiable:
 *  1. `append()` is SYNCHRONOUS and is the sole assigner of `seq` — an async append lets two
 *     concurrent turns interleave into a non-monotonic log, which is exactly the corruption
 *     `?since=` cannot recover from.
 *  2. envelopes are frozen at append, so two subscribers cannot see different history.
 *  3. `subscribe()` replays and attaches the live tail in ONE synchronous critical section,
 *     so no event can slip between the two.
 *
 * `head`/`tail`/`read` are synchronous for a second reason: M1's `node:sqlite` driver is
 * `DatabaseSync`, and `runEventLogConformance()` is the suite it must pass verbatim.
 */
export function createMemoryEventLog(o: MemoryEventLogOptions): EventLog {
  throw new OmniError("internal", "unimplemented: WP-3 (event-log.createMemoryEventLog)");
}
