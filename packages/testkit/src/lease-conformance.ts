import { OmniError, type Lease } from "@omni-acp/protocol";
import type { FakeClock } from "./fake-clock.js";

/**
 * D5's behaviour as ONE suite, run against the `Lease` OBJECT and against the HTTP SURFACE, so
 * the two cannot drift (CONTRACTS.md §16.4).
 *
 * That pairing is the point: a lease that is correct in core and permissive over HTTP is a lease
 * that does not exist, and a suite that only ever sees one of the two would never notice.
 *
 * Owned by M1-WP-D.
 */
export function runLeaseConformance(_name: string, _make: () => Lease, _clock: FakeClock): void {
  throw new OmniError("internal", "unimplemented: M1-WP-D");
}
