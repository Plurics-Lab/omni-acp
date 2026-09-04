import type { Clock, DaemonId, EventLog, WorkerId } from "@omni-acp/protocol";
import { createEventLogCore } from "./log-core.js";

export interface MemoryEventLogOptions {
  readonly workerId: WorkerId;
  readonly daemonId: DaemonId;
  readonly clock: Clock;
  readonly maxEvents: number;
  readonly subscriberQueueSize: number;
}

/**
 * The in-memory ring of CONTRACTS.md §8 — now a THIN WRAPPER over `log-core.ts`.
 *
 * §14.1 is explicit that this is what the M1 move must look like: every subtlety this file used
 * to hold — fan-out, bounded subscriber queues, overflow, re-entrancy, the two-phase
 * enqueue-then-deliver — moved into `event-log/log-core.ts` VERBATIM so that both drivers sit
 * on identical behaviour, and "its behaviour and every existing test are unchanged" is the
 * acceptance criterion for the move. Hence a wrapper and not a re-implementation: the only
 * difference between a memory log and a persisted one is whether an `EventStore` was passed.
 *
 * `persistent` is therefore `false` and `flush()` a no-op here, which is the memory driver's
 * honest answer to `GET /v1/info.persistence` and `WorkerSnapshot.persistence`: nothing it holds
 * survives a restart, and there is nothing to commit (§6.6's honesty rule).
 */
export function createMemoryEventLog(o: MemoryEventLogOptions): EventLog {
  return createEventLogCore({
    workerId: o.workerId,
    daemonId: o.daemonId,
    clock: o.clock,
    maxEvents: o.maxEvents,
    queueSize: o.subscriberQueueSize,
  });
}
