import { OmniError } from "@omni-acp/protocol";
import type { Clock, InteractionStrategy, PermissionResponder } from "@omni-acp/protocol";

/**
 * M1's `PermissionResponder`, WRAPPED — not widened, not reimplemented (M2-PLAN §1.3 seam A).
 *
 * `InteractionStrategy` supersedes `PermissionResponder` by containing it, so every M1 behaviour
 * is preserved BY CONSTRUCTION rather than by care: the same `decide` call, the same two
 * envelopes in the same order, the same `-32603` on D4 rule 4, and `clientCapabilities: {}`
 * because D10 declares elicitation only under `onUnresolved:"park"` and this strategy never parks.
 *
 * The body it must reproduce is `worker.ts`'s `#baselinePermission`, which is where M1's code
 * still lives at the Land step. `runInteractionConformance` is run against BOTH, and the
 * byte-identical-envelopes golden is WP-I's acceptance bullet 1 — the point being that "M1 still
 * works" is proved, not asserted.
 *
 * Owned by M2-A-WP-I.
 */
export function baselineInteractions(_r: PermissionResponder, _clock: Clock): InteractionStrategy {
  throw new OmniError("internal", "unimplemented: M2-A-WP-I");
}
