import type { CompatCase } from "./support.js";

/**
 * Compat cases for the idle watchdog's dual budget and `strandedToolCalls`.
 *
 * EMPTY at the M2 Land step, and empty rather than throwing on purpose: `runner.ts` enumerates
 * every case at load, so a factory that threw would take the whole compat suite — including M1's
 * thirteen green cases — with it. An empty list is the honest "this work package has recorded no
 * case yet", and `OMNI_COMPAT_REQUIRE=1` still turns an empty SELECTION into a failure.
 *
 * Every case added here must declare what it `requires`, so an agent that cannot do it is
 * SKIPPED with a printed source and a reason rather than silently passed — and the suite refuses
 * to assert an `unverified` descriptor row at all.
 *
 * Owned by M2-A-WP-W.
 */
export function watchdogCases(): readonly CompatCase[] {
  return [];
}
