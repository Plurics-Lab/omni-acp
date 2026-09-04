import {
  OmniError,
  type ClientRef,
  type LeaseSnapshot,
  type ResolvedLeaseConfig,
} from "@omni-acp/protocol";

/**
 * The PURE half of §16.1's rules L1–L7 — who may act, who may steal, and when a fencing epoch is
 * stale — separated from the stateful `Lease` so the table can be tested with no clock and no
 * worker.
 *
 * L3: `DELETE` requires the lease OR `role:"admin"`. L4: `clientId: null` means "the token's
 * default client". L5: the first gated call on an UNHELD lease acquires it implicitly — a worker
 * nobody controls should not 423 the first client that reaches for it. L7: a present-and-stale
 * `Omni-Lease-Epoch` is a 423 even from the right client id.
 *
 * Owned by M1-WP-D.
 */
export function mayAct(
  _lease: LeaseSnapshot,
  _who: ClientRef,
  _o: { admin: boolean; epoch?: number },
): boolean {
  throw new OmniError("internal", "unimplemented: M1-WP-D");
}

export function maySteal(
  _lease: LeaseSnapshot,
  _who: ClientRef,
  _o: { admin: boolean; nowMs: number; lastUseMs: number; config: ResolvedLeaseConfig },
): boolean {
  throw new OmniError("internal", "unimplemented: M1-WP-D");
}
