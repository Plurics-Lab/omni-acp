import { OmniError, type RuntimeDescriptor } from "@omni-acp/protocol";

/**
 * The `diff` content block — the row DESIGN §6.1 cannot literally satisfy (§12.5, F19).
 *
 * `changes` IS computable from the standard v1 fields; `patch` is NOT, so `TurnResult.patch`
 * stays null (D8) and a reconstructed vendor patch is surfaced separately as `vendorPatch`.
 * `FileChange.fragment` comes from the descriptor's `diffIsFragment` quirk and is never guessed:
 * treating a fragment as whole-file content corrupts the file.
 *
 * Owned by M1-WP-B.
 */
export function mapDiffBlock(
  _block: Readonly<Record<string, unknown>>,
  _descriptor: RuntimeDescriptor,
): Record<string, unknown> {
  throw new OmniError("internal", "unimplemented: M1-WP-B");
}
