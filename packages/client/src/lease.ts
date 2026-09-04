import { OmniError, type LeaseSnapshot } from "@omni-acp/protocol";
import type { Transport } from "./transport.js";

/**
 * The SDK's view of D5's lease (CONTRACTS.md §5.7).
 *
 * `snapshot` is always present, because `holder: null` is a real, actionable state and not
 * "this daemon has no lease feature".
 *
 * The three verbs map one-to-one onto H17. A `423` comes back with `body.lease` naming the
 * holder and the epoch, which `transport.ts` parses into the thrown `OmniError` — so a client
 * that loses a race learns WHO holds the worker without a second round trip against a worker it
 * may no longer control.
 *
 * Owned by M1-WP-D.
 */
export interface WorkerLease {
  readonly snapshot: LeaseSnapshot;
  acquire(o?: { ttlMs?: number }): Promise<LeaseSnapshot>;
  release(): Promise<LeaseSnapshot>;
  steal(reason: string): Promise<LeaseSnapshot>;
}

export function createWorkerLease(
  _transport: Transport,
  _workerId: string,
  _snapshot: LeaseSnapshot,
): WorkerLease {
  throw new OmniError("internal", "unimplemented: M1-WP-D");
}
