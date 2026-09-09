import { OmniError } from "@omni-acp/protocol";
import type { InteractionStrategy } from "@omni-acp/protocol";
import type { FakeClock } from "./fake-clock.js";

/**
 * The conformance suite EVERY `InteractionStrategy` must pass — `baselineInteractions` included.
 *
 * Running it against the baseline is the point, and it is what makes M2-PLAN §1.3's seam A more
 * than a hope: the wrapper preserves M1 by CONSTRUCTION, and this is where that claim is
 * executed. The companion golden asserts the baseline's envelopes are BYTE-IDENTICAL to M1's.
 *
 * The rows it must cover, each a fact rather than a taste: the two-envelope order (§7.4); D4 rules
 * 1-6 including the `-32603` on rule 4 and the never-invented option id on rule 1; `settleAll`
 * resolving every held promise before anything else reaches the wire (§19.8); and idempotency of
 * `settleAll`, because every teardown path calls it blindly.
 *
 * Owned by M2-A-WP-I.
 */
export function runInteractionConformance(
  _name: string,
  _make: () => InteractionStrategy,
  _clock: FakeClock,
): void {
  throw new OmniError("internal", "unimplemented: M2-A-WP-I");
}
