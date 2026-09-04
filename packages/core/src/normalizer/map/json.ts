/**
 * The map's whole dependency surface: plain-JSON accessors and an RFC-6901 pointer.
 *
 * Everything here is TOTAL — no input, however malformed, may make a mapping rule throw
 * (CONTRACTS.md §12.2) — and PURE: no `node:*`, no `Date`, no `Math.random`, which is what the
 * `normalizer-is-pure` guard (§10.2) asserts over this directory.
 */

export type Json = Readonly<Record<string, unknown>>;

/** A plain object, or null. Arrays are NOT records: `payload["content"]` may legally be either. */
export function record(v: unknown): Json | null {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Json) : null;
}

export function str(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

export function arr(v: unknown): readonly unknown[] | null {
  return Array.isArray(v) ? (v as readonly unknown[]) : null;
}

export function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** `true` when the key is present, whatever its value — "absent" and "null" differ in v1. */
export function has(o: Json, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(o, key);
}

/**
 * RFC-6901, rooted at `root`. `~1` is a literal "/" in a key and `~0` a literal "~", which is
 * how the claude-acp rate-limit pointer `/_claude~1rateLimit` names the key `_claude/rateLimit`.
 *
 * Returns `undefined` for a pointer that does not resolve — never throws, because the pointer
 * comes from a descriptor an operator may have typed by hand (§17.1).
 */
export function resolvePointer(root: unknown, pointer: string): unknown {
  if (pointer === "") return root;
  if (!pointer.startsWith("/")) return undefined;
  let current: unknown = root;
  for (const raw of pointer.slice(1).split("/")) {
    const key = raw.replaceAll("~1", "/").replaceAll("~0", "~");
    const object = record(current);
    if (object === null || !has(object, key)) return undefined;
    current = object[key];
  }
  return current;
}

/**
 * Structural equality over JSON values. Used only by tests-facing helpers and by the idempotency
 * checks the map performs on itself; key ORDER is deliberately ignored because two payloads that
 * differ only in key order are the same payload on the wire.
 */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, i) => deepEqual(item, b[i]));
  }
  const ra = record(a);
  const rb = record(b);
  if (ra === null || rb === null) return false;
  const ka = Object.keys(ra);
  const kb = Object.keys(rb);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => has(rb, k) && deepEqual(ra[k], rb[k]));
}
