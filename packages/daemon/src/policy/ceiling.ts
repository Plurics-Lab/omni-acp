import { OmniError } from "@omni-acp/protocol";
import type { PolicyCeiling, ResolvedDaemonConfig } from "@omni-acp/protocol";

/**
 * The token's ceiling, as a NAMED thing.
 *
 * `PolicySnapshot.ceiling` and `OmniErrorBody.policy.ceiling` both carry a name rather than the
 * document, so an operator reading a `403` or an audit row can say WHICH ceiling refused without
 * being handed a rule set to compare by eye.
 *
 * Owned by M2-B-WP-P.
 */
export function ceilingFor(
  _cfg: ResolvedDaemonConfig,
  _tokenId: string,
): { name: string; ceiling: PolicyCeiling } | null {
  throw new OmniError("internal", "unimplemented: M2-B-WP-P");
}
