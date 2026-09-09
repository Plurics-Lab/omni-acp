import { OmniError } from "@omni-acp/protocol";
import type { InteractionStrategy, PermissionOption } from "@omni-acp/protocol";

export interface PolicyFixtureOptions {
  readonly offered: readonly PermissionOption[];
  readonly kind: string | null;
  readonly paths: readonly string[];
}

/**
 * D4's six hard rules, over a GENERATED `offered` array — a fixed 64-row table plus a seeded
 * shuffle, and no new dependency for either (Land exit criterion 7).
 *
 * Three degenerate arrays carry most of the value and are each a recorded failure rather than an
 * invented edge case: the EMPTY array; the unknown-kind-only array (D4 rule 6 — an agent that
 * invents a kind must not be able to land on a grant); and the `allow_always`-ONLY array, whose
 * correct answer is `-32603` and whose wrong answer is F26 — after one `allow_always` the engine
 * is never consulted again for that session and nothing on the wire says so.
 *
 * It runs against the ENGINE and still against `baselineInteractions`, so M2-B cannot narrow D4
 * by editing one of them.
 *
 * Owned by M2-B-WP-P.
 */
export function runPolicyConformance(
  _name: string,
  _make: (o: PolicyFixtureOptions) => InteractionStrategy,
): void {
  throw new OmniError("internal", "unimplemented: M2-B-WP-P");
}
