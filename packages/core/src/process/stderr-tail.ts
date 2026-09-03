import { OmniError, type StderrTail } from "@omni-acp/protocol";

/** The write end of the tail ring. Internal to WP-2; not part of CONTRACTS.md §5. */
export interface StderrTailSink extends StderrTail {
  write(chunk: Uint8Array): void;
}

/**
 * A fixed-size stderr ring whose truncation lands on a UTF-8 rune boundary, whose
 * `snapshot()` hides an incomplete trailing rune, and whose `finalize()` flushes a
 * newline-less last line — which is usually the crash reason (multica `acp_terminal.go`).
 */
export function createStderrTail(o: { maxBytes: number }): StderrTailSink {
  throw new OmniError("internal", "unimplemented: WP-2 (process.createStderrTail)");
}
