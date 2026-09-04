import type { RuntimeDescriptor } from "@omni-acp/protocol";
import { record, str, type Json } from "./json.js";
import { isV2Diff } from "./v2-shape.js";

/** The `_meta` key the v1 text is carried under, and the one `reduceTurn` reads (§12.5). */
export const V1_DIFF_META = "omni/v1Diff";

/**
 * The `diff` content block — the row DESIGN §6.1 cannot literally satisfy (CONTRACTS.md §12.5,
 * F19).
 *
 * ```
 * {type:"diff", path, oldText, newText}
 *   →  { type: "diff",
 *        changes: [{ operation: oldText == null ? "add" : "modify", path }],
 *        _meta: { …original _meta, "omni/v1Diff": { oldText, newText, fragment } } }
 * ```
 *
 * Three properties, each load-bearing:
 *
 *  - **Lossless.** v2's `Diff` is `{changes, patch?}` and has NO `oldText`/`newText` at all, so
 *    the naive rewrite throws the text away and `TurnResult.changes` becomes uncomputable.
 *    Carrying it under `_meta` keeps the M0 wire shape of `FileChange` unchanged.
 *  - **`patch` is NOT filled.** D8 guarantees `TurnResult.patch` is accurate or null, and a
 *    patch we cannot compare against the disk would be a third source of truth (ruling M1-R11).
 *    The verified vendor reconstruction ships separately, as `TurnResult.vendorPatch`.
 *  - **`fragment` comes from the DESCRIPTOR, never guessed.** F19: claude-acp widens the pair
 *    between updates (`"mode = slow"→"mode = fast"`, then `"mode = slow\nretries = 3"→…`), so a
 *    consumer that writes `newText` to `path` corrupts the file. Guessing this flag is the one
 *    mistake in this file that destroys user data.
 *
 * IDEMPOTENT: a block that is already v2 (`changes` present) is returned BY IDENTITY.
 *
 * Owned by M1-WP-B.
 */
export function mapDiffBlock(block: Json, descriptor: RuntimeDescriptor): Json {
  // Already v2 — including one we produced ourselves, which is what makes `map(map(x))` a no-op.
  if (isV2Diff(block)) return block;

  const path = str(block["path"]);
  const newText = str(block["newText"]);
  // Not a v1 diff we can read: forwarded untouched rather than half-translated. A block with no
  // `path`, or no readable `newText`, has nothing to say about a file, and inventing one is
  // worse than carrying it as-is.
  if (path === null || newText === null) return block;

  const oldText = str(block["oldText"]);
  const meta = record(block["_meta"]);

  const v1Diff: Record<string, unknown> = {
    oldText,
    newText,
    // The descriptor's quirk, verbatim. `false` for an unprobed agent is not a claim that the
    // text IS whole-file — it is the absence of the claim that it is not, which is the only
    // thing `DEFAULT_V1_PROFILE` may assert (§17.2).
    fragment: descriptor.quirks.diffIsFragment,
  };

  return {
    type: "diff",
    // The v1 field pair says nothing about deletes, moves or copies, so only the two operations
    // it can distinguish are ever produced. `oldText: null` is a CREATION on this wire (F19).
    changes: [{ operation: oldText === null ? "add" : "modify", path }],
    _meta: { ...(meta ?? {}), [V1_DIFF_META]: v1Diff },
  };
}

/** What `reduceTurn` reads back out. Kept here so the key and its shape have one owner. */
export interface V1DiffMeta {
  readonly oldText: string | null;
  readonly newText: string;
  readonly fragment: boolean;
}
