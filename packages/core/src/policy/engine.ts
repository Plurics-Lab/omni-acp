import { OmniError } from "@omni-acp/protocol";
import type { PolicyCeiling, PolicyEngine, ResolvedPolicy } from "@omni-acp/protocol";

/**
 * D4's rule engine. PURE and TOTAL: the same subject in yields a deep-equal verdict out, a
 * thousand times over, with no clock and no I/O.
 *
 * It decides WHAT, never WHICH option id. Option selection stays in `permission-responder.ts`'s
 * `selectOption`, the one place D4 rules 1-6 live, and that separation is what makes it
 * structurally impossible for this package to break rule 3 (never select a persisted "always"
 * grant) by editing the engine.
 *
 * The `policy-never-names-an-option` guard enforces it BYTE-WISE over this whole directory —
 * comments included, with no comment-stripping pass — which is why the paragraph above spells
 * none of the five forbidden words (ruling M2-R16, settled by review follow-up 7). It is
 * demonstrated FAILING on a planted literal.
 *
 * There is deliberately no `title` / `name` matcher anywhere below it (F27): an agent's prose is
 * not a security predicate, and `no-agent-prose` forbids adding one.
 *
 * Owned by M2-B-WP-P.
 */
export function createPolicyEngine(_o: {
  policy: ResolvedPolicy;
  ceiling: PolicyCeiling | null;
  id: string;
}): PolicyEngine {
  throw new OmniError("internal", "unimplemented: M2-B-WP-P");
}
