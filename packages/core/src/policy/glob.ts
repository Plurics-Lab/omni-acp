import { OmniError } from "@omni-acp/protocol";

/**
 * A path glob, compiled once. PURE, and with NO new dependency — Land exit criterion 7.
 *
 * `**` crosses separators, `*` does not, and a RELATIVE pattern is a load error: a rule written
 * against `src/**` and matched against a realpath'd absolute would match nothing and look like it
 * worked, which is the failure mode a security rule can least afford.
 *
 * Owned by M2-B-WP-P.
 */
export function compileGlob(_pattern: string): (abs: string) => boolean {
  throw new OmniError("internal", "unimplemented: M2-B-WP-P");
}

/**
 * The non-wildcard HEAD of a pattern — everything before the first `*`, `?` or `[`.
 *
 * It is what makes `policyCeiling.pathRoots` decidable: glob∩glob containment is undecidable in
 * general, so the ceiling is checked by a literal prefix test on this, which is total and
 * honestly coarse rather than precise-looking and approximate (ruling M2-R11).
 *
 * Owned by M2-B-WP-P.
 */
export function globHead(_pattern: string): string {
  throw new OmniError("internal", "unimplemented: M2-B-WP-P");
}
