import { OmniError } from "@omni-acp/protocol";

/**
 * The content digest for §14.6's side table.
 *
 * F13: `available_commands_update` is 87.8 % of all update bytes across the corpus and carries
 * exactly TWO distinct payloads in 23 notifications. Ruling M1-R3: stream it in full, store it by
 * content digest, and NEVER store-but-do-not-stream — an envelope withheld from the live tail but
 * present in `?since=` makes two subscribers disagree about the log.
 *
 * Owned by M1-WP-B (the digest) and consumed by M1-WP-A (the side table).
 */
export function payloadDigest(_payload: unknown): string {
  throw new OmniError("internal", "unimplemented: M1-WP-B");
}
