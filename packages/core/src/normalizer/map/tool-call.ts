import type { Json } from "./json.js";

/**
 * `tool_call` → `tool_call_update`: a RENAME OF THE DISCRIMINANT AND NOTHING ELSE (F23).
 *
 * No defaulting, no field synthesis, no merging. v1's `ToolCall.title` is required and v2's
 * `ToolCallUpdate.title` is optional, so the rename is total in the direction we need it;
 * `reduceTurn`'s `upsertToolCall` already folds both kinds and already implements "an absent
 * field means unchanged", so merging HERE would make the event stream a materialized view and
 * break `?since=` (CONTRACTS.md §12.1, ruling M1-R13):
 *
 *   an update carrying only `{toolCallId, sessionUpdate, _meta}` — 8 of the 36 recorded
 *   `tool_call_update`s have exactly that shape — has to be storable AS ITSELF, or a client
 *   reconnecting mid-tool-call sees a different history than one connected throughout.
 *
 * Key ORDER is preserved (the rename writes the same key), so the mapped payload serializes as
 * closely to the agent's bytes as a rewrite can.
 *
 * Owned by M1-WP-B.
 */
export function mapToolCall(payload: Json): Json {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(payload)) {
    out[key] = key === "sessionUpdate" ? "tool_call_update" : payload[key];
  }
  // A payload that somehow lacked the discriminant still gets one: this function is only
  // reached from the row that matched on it, and an object without it is not a rename.
  out["sessionUpdate"] = "tool_call_update";
  return out;
}
