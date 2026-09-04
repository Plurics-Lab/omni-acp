import { record } from "./json.js";
import { sha256Hex } from "./sha256.js";

/**
 * The content digest for §14.6's side table.
 *
 * F13: `available_commands_update` is 87.8 % of all update bytes across the corpus and carries
 * exactly TWO distinct payloads in 23 notifications. Ruling M1-R3: stream it in full, store it by
 * content digest, and NEVER store-but-do-not-stream — an envelope withheld from the live tail but
 * present in `?since=` makes two subscribers disagree about the log.
 *
 * Owned by M1-WP-B (the digest) and consumed by M1-WP-A (the side table).
 *
 * The serialization is CANONICAL — object keys sorted, no whitespace — because the digest is a
 * content address: two payloads that differ only in key order are the same slash-command
 * catalogue, and hashing `JSON.stringify` directly would store it twice. §14.6's obligation
 * ("`read(0)` after a digest round-trip must be deep-equal to what was appended") is about the
 * REHYDRATED payload, which the side table stores verbatim; only the KEY is canonicalized.
 *
 * TOTAL: a cyclic or non-JSON payload digests its own diagnostic string rather than throwing,
 * because a throw here would lose an envelope the log is contractually required to keep.
 */
export function payloadDigest(payload: unknown): string {
  return sha256Hex(canonicalize(payload));
}

function canonicalize(v: unknown): string {
  return stringify(v, new Set());
}

function stringify(v: unknown, seen: Set<object>): string {
  if (v === null) return "null";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") return Number.isFinite(v) ? JSON.stringify(v) : "null";
  if (typeof v === "string") return JSON.stringify(v);
  if (typeof v !== "object") return "null"; // undefined, function, symbol: JSON has no term
  if (seen.has(v)) return '"<cycle>"';
  seen.add(v);
  try {
    if (Array.isArray(v)) return `[${v.map((item) => stringify(item, seen)).join(",")}]`;
    const o = record(v);
    if (o === null) return "null";
    const keys = Object.keys(o).sort();
    const body = keys
      .filter((k) => o[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${stringify(o[k], seen)}`)
      .join(",");
    return `{${body}}`;
  } finally {
    seen.delete(v);
  }
}
