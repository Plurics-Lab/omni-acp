import { type LeaseSnapshot } from "@omni-acp/protocol";
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

/**
 * `snapshot` is a GETTER over the last answer this object saw, not the value it was constructed
 * with, and that is the whole design of this file.
 *
 * The epoch is a fencing token (§16.1 rule L7): the daemon bumps it on every acquire, steal and
 * expiry, and a client that sends a stale one is refused with a `423` **even when it is the
 * right client id**. A `WorkerLease` that froze the snapshot it was born with would hand its
 * caller a number that goes stale the first time the lease moves — which is to say, it would be
 * a fence that fires on its owner. Every successful verb here therefore replaces the cached
 * snapshot with the one the daemon just returned.
 *
 * It does NOT swallow a `423` and retry. A silent retry is exactly the "silently hijack the new
 * holder's turn" that the epoch exists to prevent; the error carries `body.lease`, so the caller
 * can see who took it and decide.
 */
export function createWorkerLease(
  transport: Transport,
  workerId: string,
  snapshot: LeaseSnapshot,
): WorkerLease {
  let current = snapshot;

  const post = async (op: string, body: unknown): Promise<LeaseSnapshot> => {
    current = await transport.request<LeaseSnapshot>(
      "POST",
      `/v1/workers/${workerId}/lease/${op}`,
      body,
    );
    return current;
  };

  return {
    get snapshot(): LeaseSnapshot {
      return current;
    },

    // `{}` rather than `undefined`: `transport.request` omits the body entirely when it is
    // `undefined`, and a POST with no body and no content-type is a shape the route has to
    // special-case. Sending the empty object keeps the SDK on the ordinary path.
    acquire: (o) => post("acquire", o?.ttlMs === undefined ? {} : { ttlMs: o.ttlMs }),

    release: () => post("release", {}),

    /**
     * `reason` is REQUIRED by this signature although the wire allows it to be absent (§5.7):
     * D5 says preemption is audited, and the SDK is where an audit line either gets written or
     * gets forgotten. A caller with nothing to say can pass a sentence saying so.
     */
    steal: (reason) => post("steal", { reason }),
  };
}
