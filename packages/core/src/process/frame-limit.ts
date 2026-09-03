import { OmniError } from "@omni-acp/protocol";

/** ndjson's one structural byte. */
const NEWLINE = 0x0a;

/**
 * A TransformStream between the child's stdout and `ndJsonStream`, erroring the stream when a
 * single ndjson frame exceeds `maxFrameBytes`. Without it, an agent that never emits a newline
 * is unbounded heap growth (CONTRACTS.md §11.3).
 *
 * Internal to WP-2; not part of CONTRACTS.md §5.
 *
 * Two properties make this a real bound rather than a late complaint:
 *
 *  - The offending chunk is NEVER enqueued. `ndJsonStream`'s own `LineBuffer` accumulates
 *    whatever reaches it until a newline arrives, so passing the chunk on and complaining
 *    afterwards would let the reader's buffer pass the bound we are enforcing.
 *  - A frame's length is counted across chunk boundaries (`pending`), because a 64 MiB frame
 *    arrives as a thousand 64 KiB reads and every one of them is individually small.
 *
 * The measured quantity is the frame's payload, newline excluded: exactly `maxFrameBytes` bytes
 * between two newlines is legal, one more is not.
 */
export function createFrameLimit(maxFrameBytes: number): TransformStream<Uint8Array, Uint8Array> {
  if (!Number.isInteger(maxFrameBytes) || maxFrameBytes <= 0) {
    throw new OmniError("bad_request", `maxFrameBytes must be a positive integer`, {
      detail: { maxFrameBytes },
    });
  }

  /** Bytes seen since the last newline — i.e. the length of the frame still being read. */
  let pending = 0;

  const overflow = (): OmniError =>
    new OmniError(
      "agent_error",
      `agent emitted an ndjson frame larger than maxFrameBytes (${String(maxFrameBytes)} bytes)`,
      { detail: { maxFrameBytes, pendingBytes: pending } },
    );

  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      let offset = 0;
      while (offset < chunk.length) {
        const nl = chunk.indexOf(NEWLINE, offset);
        if (nl === -1) {
          pending += chunk.length - offset;
          break;
        }
        pending += nl - offset;
        if (pending > maxFrameBytes) {
          controller.error(overflow());
          return;
        }
        pending = 0;
        offset = nl + 1;
      }
      if (pending > maxFrameBytes) {
        controller.error(overflow());
        return;
      }
      controller.enqueue(chunk);
    },
  });
}
