import { OmniError } from "@omni-acp/protocol";
import type {
  PolicyCeiling,
  PolicySubject,
  PolicyVerdict,
  ResolvedPolicy,
} from "@omni-acp/protocol";

/**
 * The STATIC half of D4's ceiling, and it is deliberately INCOMPLETE (§20.5, ruling M2-R11).
 *
 * A ceiling is written in a coarser language than a rule — `maxAction`, `allowKinds`,
 * `denyKinds`, `pathRoots`, `commands`, `park` — because glob∩glob and regex∩regex containment is
 * undecidable, and a ceiling that LOOKS precise while being checked approximately is worse than
 * one that is honestly coarse. What this check IS: total, decidable, and refusing at CREATE time
 * with `403 policy_exceeds_ceiling` naming `{ceiling, offending}`, so the operator sees it where
 * they can act on it.
 *
 * Owned by M2-B-WP-P.
 */
export function assertWithinCeiling(_doc: ResolvedPolicy, _c: PolicyCeiling): void {
  throw new OmniError("internal", "unimplemented: M2-B-WP-P");
}

/**
 * The RUNTIME half, and what makes the pair SOUND rather than merely strict.
 *
 * `assertWithinCeiling` provably cannot catch every case — an inline `allow` on `path:["**"]`
 * under `pathRoots:["src"]` is the named example — so the verdict is clamped as it is produced,
 * and the clamp is NEVER SILENT: `PolicyVerdict.clamped` records `{from, by}` and a
 * `TurnWarning` says so on the turn. A ceiling that quietly narrowed an author's rule would be
 * indistinguishable from a rule that never fired.
 *
 * `deny` and `fail` rank EQUAL in `dominates`: neither grants, and a tie resolves to the policy.
 *
 * Owned by M2-B-WP-P.
 */
export function clampVerdict(
  _v: PolicyVerdict,
  _c: PolicyCeiling,
  _s: PolicySubject,
): PolicyVerdict {
  throw new OmniError("internal", "unimplemented: M2-B-WP-P");
}
