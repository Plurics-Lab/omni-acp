import { OmniError, type ClientRef, type Lease } from "@omni-acp/protocol";

/**
 * The M0 lease: `assertHolder()` never throws, `acquire()`/`release()` throw `bad_request`
 * naming M1. The interface exists now so that every call site already branches the way D5's
 * enforcement will require, and M1 is a swap rather than a rewrite.
 *
 * `holder` is the worker's creator (D5: the client that created the worker holds the lease).
 * It is reported truthfully today even though nothing is enforced against it, so that an M0
 * audit line and an M1 enforcement check read the same field.
 */
export function alwaysGrantedLease(holder: ClientRef): Lease {
  return {
    holder,

    /**
     * M0: never throws — D5's single-controller rule is M1 (CONTRACTS.md §2.3). The argument is
     * still taken, so every call site already passes the `ClientRef` M1 will compare against.
     */
    assertHolder(_who: ClientRef): void {
      // Intentionally empty; see the doc comment. Enforcement lands in M1.
    },

    /** CONTRACTS.md §9: an unimplemented feature is `bad_request` naming its milestone (D29). */
    acquire(_who: ClientRef, _opts?: { steal?: boolean }): void {
      throw new OmniError(
        "bad_request",
        "lease.acquire() is not implemented until M1 (D5); the worker's creator holds the lease",
      );
    },

    release(_who: ClientRef): void {
      throw new OmniError(
        "bad_request",
        "lease.release() is not implemented until M1 (D5); the worker's creator holds the lease",
      );
    },
  };
}
