import { OmniError, type MappedUpdate, type RuntimeDescriptor } from "@omni-acp/protocol";

/**
 * The v1→v2 `session/update` map — all 29 rows of CONTRACTS.md §12.3.
 *
 * PURE, TOTAL and IDEMPOTENT: `mapUpdate(mapUpdate(x).payload).payload` is deep-equal to
 * `mapUpdate(x).payload` for every input, and an unrecognized kind comes back BY IDENTITY with
 * `payloadVersion: 1`. No rule may read a protocol version (F24) or an agent id (the
 * `descriptor-is-the-only-branch` guard) — the descriptor is the only branch.
 *
 * Owned by M1-WP-B.
 */
export function mapUpdate(
  _update: unknown,
  _descriptor: RuntimeDescriptor,
  _ids: { synth(prefix: string): string },
): MappedUpdate {
  throw new OmniError("internal", "unimplemented: M1-WP-B");
}
