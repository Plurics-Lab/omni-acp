import { OmniError } from "@omni-acp/protocol";

/**
 * A TransformStream between the child's stdout and `ndJsonStream`, erroring the stream when a
 * single ndjson frame exceeds `maxFrameBytes`. Without it, an agent that never emits a newline
 * is unbounded heap growth (CONTRACTS.md §11.3).
 *
 * Internal to WP-2; not part of CONTRACTS.md §5.
 */
export function createFrameLimit(maxFrameBytes: number): TransformStream<Uint8Array, Uint8Array> {
  throw new OmniError("internal", "unimplemented: WP-2 (process.createFrameLimit)");
}
