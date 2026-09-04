import { OmniError } from "@omni-acp/protocol";

/**
 * `tool_call` → `tool_call_update`: a RENAME OF THE DISCRIMINANT AND NOTHING ELSE (F23).
 *
 * `reduceTurn`'s `upsertToolCall` already folds both kinds and already implements "an absent
 * field means unchanged", so merging here would make the event stream a materialized view and
 * break `?since=` (§12.1, ruling M1-R13).
 *
 * Owned by M1-WP-B.
 */
export function mapToolCall(_payload: Readonly<Record<string, unknown>>): Record<string, unknown> {
  throw new OmniError("internal", "unimplemented: M1-WP-B");
}
