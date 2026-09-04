import { OmniError, type Lease, type LeaseOptions } from "@omni-acp/protocol";

/**
 * D5's real lease (§16): acquire / release / steal with a fencing EPOCH, a TTL that cannot fire
 * mid-turn, implicit acquire of an unheld lease, release on hibernate, `omni.lease` audit
 * envelopes, and a `423 lease_held` body that names the holder.
 *
 * SEAM 3 (M1-PLAN §1.2): `Worker.prompt()` and `Worker.cancel()` ALREADY call
 * `lease.assertHolder(who)` as their first statement (F22), so enforcement is a change to the
 * FACTORY the registry passes in and touches zero core worker files. That is M0's DI paying off,
 * and it is said out loud so nobody helpfully adds an interface.
 *
 * Owned by M1-WP-D.
 */
export function createLease(_o: LeaseOptions): Lease {
  throw new OmniError("internal", "unimplemented: M1-WP-D");
}
