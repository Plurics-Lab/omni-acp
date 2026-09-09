import { OmniError } from "@omni-acp/protocol";
import type { PolicyRule, PolicySubject } from "@omni-acp/protocol";

/**
 * One rule against one subject. PURE, and the whole of §20.3's table.
 *
 * The clauses that are easy to get subtly wrong, and what they must do:
 *
 *  - an UNKNOWN `kind` matches NOTHING but the literal `["*"]` — D4 rule 6, lifted from the
 *    responder to the matcher, so an agent that invents a tool kind cannot land on an `allow`;
 *  - a `path` clause matches only when `subject.paths` is NON-EMPTY **and every entry matches**.
 *    F38 proves `locations[]` under-reports, so "no paths" is not "no files touched", and an
 *    unlisted second path must never be able to launder the first;
 *  - a path-LESS call against a `path` rule is NO MATCH, never a match by vacuity;
 *  - a `cmd` clause on a `tool_call` subject is rejected at COMPILE, because F38 leaves it
 *    nothing to match on;
 *  - regexes are ANCHORED for the author, length-capped, and refused at load if they backtrack
 *    catastrophically.
 *
 * Owned by M2-B-WP-P.
 */
export function matchRule(_rule: PolicyRule, _s: PolicySubject): boolean {
  throw new OmniError("internal", "unimplemented: M2-B-WP-P");
}
