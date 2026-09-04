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
 * The construction that makes that possible is Land-written and frozen (M1-PLAN §1.2, seam 2's
 * third verb): `new Worker(deps, { row })` seeds every record field from `row.snapshot` and, for
 * an already-`closed` row, pre-resolves the close with `row.closeResult`. So this body is a
 * `CreateWorkerDeps` assembly and one `new` — and `RehydrateDeps` below is WP-C's own type, free
 * to grow whatever a row plus the daemon's catalog cannot supply (the descriptor for
 * `row.agentId`, the normalizer, the responder, the limits).
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
