import type { ExtensionPath } from "@omni-acp/protocol";

/**
 * RFC-6901 JSON-pointer resolution, with RFC-6901's escapes and nothing else.
 *
 * `~1` is "/" and `~0` is "~", and they are unescaped in that order — the reverse order would
 * turn `~01` into "/" instead of "~1", which is the classic RFC-6901 bug. The empty pointer is
 * the whole document, which is what makes `{pointer: ""}` a legal way for a descriptor to promote
 * an agent's entire `_meta` block.
 *
 * Returns `undefined` for anything that does not resolve. A vendor field that is not there is
 * NORMAL — most updates carry no `_meta` at all — so the miss is a value, never a throw.
 */
export function readPointer(document: unknown, pointer: string): unknown {
  if (pointer === "") return document;
  if (!pointer.startsWith("/")) return undefined;

  let cursor: unknown = document;
  for (const raw of pointer.slice(1).split("/")) {
    const key = raw.replaceAll("~1", "/").replaceAll("~0", "~");
    if (Array.isArray(cursor)) {
      // RFC-6901 array indices are decimal with no leading zeros; "-" (past the end) never
      // resolves on a read.
      if (!/^(0|[1-9][0-9]*)$/.test(key)) return undefined;
      const index = Number(key);
      if (index >= cursor.length) return undefined;
      cursor = cursor[index];
      continue;
    }
    if (typeof cursor !== "object" || cursor === null) return undefined;
    // `Object.hasOwn` rather than `in`: a pointer of `/constructor` or `/__proto__` must read a
    // field the agent actually sent, never something off `Object.prototype`.
    if (!Object.hasOwn(cursor, key)) return undefined;
    cursor = (cursor as Record<string, unknown>)[key];
  }
  return cursor;
}

/**
 * Read a descriptor-registered vendor field out of an update's `_meta` by RFC-6901 pointer
 * (CONTRACTS.md §17.3, §12.5). `~1` escapes a "/" inside a key. Returns `undefined` when the
 * pointer does not resolve — a missing vendor field is normal, not an error.
 *
 * Owned by M1-WP-E.
 */
export function readExtension(meta: unknown, path: ExtensionPath): unknown {
  return readPointer(meta, path.pointer);
}
