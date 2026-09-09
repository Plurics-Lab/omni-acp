import { OmniError } from "@omni-acp/protocol";
import type { InteractionDeps, InteractionStrategy } from "@omni-acp/protocol";

/**
 * The real `InteractionStrategy`: D10's ONE lifecycle over both agent→client requests.
 *
 * It differs from `baselineInteractions` in exactly ONE place — it consults an injected
 * `decide: (subject) => PolicyVerdict`, defaulting to
 * `() => ({action: onUnresolved, rule: "m2:onUnresolved", source: "default", clamped: null})`.
 *
 * That default is the whole of M2-PLAN §1.3's seam A: it is why M2-A-WP-I and M2-B-WP-P are
 * file-disjoint and can land in either order, and why M2-A ships with no policy engine at all —
 * with none, this strategy parks, denies or fails exactly as `CreateWorkerRequest.onUnresolved`
 * asked it to, and the engine is a later narrowing rather than a prerequisite.
 *
 * Owned by M2-A-WP-I.
 */
export function createInteractionStrategy(_o: InteractionDeps): InteractionStrategy {
  throw new OmniError("internal", "unimplemented: M2-A-WP-I");
}
