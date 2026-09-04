import {
  OmniError,
  type ClientRef,
  type Lease,
  type LeaseEventPayload,
  type LeaseSnapshot,
  type WorkerId,
} from "@omni-acp/protocol";

/**
 * The permissive lease: `assertHolder()` always grants, every mutating call is `bad_request`
 * naming the work package that implements it.
 *
 * M1 KEEPS it (CONTRACTS.md §5.7) for in-process callers and fixtures — a library embedder
 * running `createDaemon({listen:null})` has exactly one controller by construction, and a unit
 * test that wants to exercise a Worker should not have to model D5 to do it. The enforcing
 * implementation is `createLease` (`lease/lease.ts`, M1-WP-D).
 *
 * `holder` is reported truthfully so an audit line and an enforcement check read the same field.
 */
export function alwaysGrantedLease(holder: ClientRef, workerId?: WorkerId): Lease {
  const snapshot = (): LeaseSnapshot => ({
    // A lease is per worker; a caller that did not name one gets the sentinel rather than a
    // fabricated id, because `LeaseSnapshot.workerId` is a claim about which worker is held.
    workerId: workerId ?? ("w_unknown" as WorkerId),
    holder: { tokenId: holder.tokenId, clientId: holder.clientId },
    // Epoch 0 = "never contested". A fencing check against this lease can therefore only ever
    // pass on 0, which is the honest reading of a lease that is never taken away.
    epoch: 0,
    expiresAt: null,
    acquiredAt: null,
    pinned: false,
  });

  const unimplemented = (what: string): never => {
    // CONTRACTS.md §9 / D29: an unimplemented feature is `bad_request` naming its milestone.
    throw new OmniError(
      "bad_request",
      `lease.${what}() is not implemented by alwaysGrantedLease (M1-WP-D owns D5 enforcement); ` +
        `the worker's creator holds the lease`,
    );
  };

  return {
    holder,
    epoch: 0,
    snapshot,

    /** Always grants — including a different client, and including a stale fencing epoch. */
    assertHolder(_who: ClientRef, _opts?: { epoch?: number }): LeaseSnapshot {
      return snapshot();
    },

    acquire(_who: ClientRef, _opts?: { ttlMs?: number }): LeaseSnapshot {
      return unimplemented("acquire");
    },

    release(_who: ClientRef): LeaseSnapshot {
      return unimplemented("release");
    },

    steal(_who: ClientRef, _opts: { reason: string | null; admin: boolean }): LeaseSnapshot {
      return unimplemented("steal");
    },

    /** Nothing can expire, so pinning is a no-op and the un-pin is too. */
    pinExpiry(): () => void {
      return () => {};
    },

    releaseForHibernate(): LeaseSnapshot {
      return snapshot();
    },

    /** Nothing ever changes, so no callback can ever fire. */
    onChange(_cb: (e: LeaseEventPayload) => void): () => void {
      return () => {};
    },

    close(): void {
      // Nothing to release: there is no timer and no subscriber.
    },
  };
}
