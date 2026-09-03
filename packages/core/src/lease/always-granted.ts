import { OmniError, type ClientRef, type Lease } from "@omni-acp/protocol";

/**
 * The M0 lease: `assertHolder()` never throws, `acquire()`/`release()` throw `bad_request`
 * naming M1. The interface exists now so that every call site already branches the way D5's
 * enforcement will require, and M1 is a swap rather than a rewrite.
 */
export function alwaysGrantedLease(holder: ClientRef): Lease {
  throw new OmniError("internal", "unimplemented: WP-4 (lease.alwaysGrantedLease)");
}
