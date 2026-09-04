import {
  OmniError,
  type ProbeSummary,
  type RuntimeDescriptor,
  type RuntimeOverlay,
} from "@omni-acp/protocol";

/**
 * builtin ⊕ config overlay ⊕ probe, in that order, with `source` recording which layers ran
 * (CONTRACTS.md §17.2). Falls back to `DEFAULT_V1_PROFILE` when `builtin` is null; NEVER throws
 * for a missing layer, and rejects an illegal merged result (`stream:false, store:true`).
 *
 * Owned by M1-WP-E.
 */
export function resolveDescriptor(
  _builtin: RuntimeDescriptor | null,
  _overlay: RuntimeOverlay,
  _probe: ProbeSummary | null,
): RuntimeDescriptor {
  throw new OmniError("internal", "unimplemented: M1-WP-E");
}
