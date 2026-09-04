import { OmniError, type RuntimeDescriptor } from "@omni-acp/protocol";

/**
 * `messageId`: PASS THROUGH, synthesize only when absent (§12.4).
 *
 * v1 types it optional and v2 requires it. A synthesized id is marked as such so a consumer can
 * tell it from the agent's own — F14 shows a replayed `messageId` is byte-identical to the live
 * one, which is what makes replay de-duplication possible AT ALL, and a fabricated id that looked
 * real would destroy that property.
 *
 * Owned by M1-WP-B.
 */
export function messageIdFor(
  _payload: Readonly<Record<string, unknown>>,
  _descriptor: RuntimeDescriptor,
  _ids: { synth(prefix: string): string },
): { readonly messageId: string | null; readonly synthesized: boolean } {
  throw new OmniError("internal", "unimplemented: M1-WP-B");
}
