import type { PolicyCeiling, ResolvedDaemonConfig } from "@omni-acp/protocol";

/**
 * The token's ceiling, as a NAMED thing.
 *
 * `PolicySnapshot.ceiling` and `OmniErrorBody.policy.ceiling` both carry a name rather than the
 * document, so an operator reading a `403` or an audit row can say WHICH ceiling refused without
 * being handed a rule set to compare by eye.
 *
 * A ceiling is written INLINE on `TokenConfig.policyCeiling`, so it has no name of its own and
 * the name is derived from the only thing that identifies it: the token it belongs to. That is
 * also the thing an operator needs, since the fix is always "edit this token's ceiling".
 *
 * Owned by M2-B-WP-P.
 */
export function ceilingFor(
  cfg: ResolvedDaemonConfig,
  tokenId: string,
): { name: string; ceiling: PolicyCeiling } | null {
  const token = cfg.tokens.find((t) => t.id === tokenId);
  if (token === undefined) return null;
  const ceiling = token.policyCeiling;
  if (ceiling === null || ceiling === undefined) return null;
  return { name: `token:${tokenId}`, ceiling };
}
