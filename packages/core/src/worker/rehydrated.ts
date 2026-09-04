import {
  OmniError,
  type Clock,
  type EventLog,
  type IdGen,
  type Lease,
  type Logger,
  type SessionStrategy,
  type Supervisor,
  type WorkerHandle,
  type WorkerRow,
} from "@omni-acp/protocol";

export interface RehydrateDeps {
  readonly supervisor: Supervisor;
  readonly session: SessionStrategy;
  readonly lease: Lease;
  readonly clock: Clock;
  readonly ids: IdGen;
  readonly logger: Logger;
}

/**
 * A `WorkerHandle` with NO process, built over a persisted row and its log (§14.8).
 *
 * It shares the SAME `Worker` class, constructed in a non-`starting` initial state. A second
 * class would give `close()` / `wake()` / `snapshot()` two implementations each, and the second
 * one is exactly where the "DELETE after a restart returns a different body" bug lives — which
 * is why `CloseResult` is persisted and replayed byte-for-byte rather than recomputed (§15.6).
 *
 * Owned by M1-WP-C.
 */
export function createRehydratedWorker(
  _row: WorkerRow,
  _log: EventLog,
  _deps: RehydrateDeps,
): WorkerHandle {
  throw new OmniError("internal", "unimplemented: M1-WP-C");
}
