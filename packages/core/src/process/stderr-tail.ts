import { OmniError, type StderrTail } from "@omni-acp/protocol";

/** The write end of the tail ring. Internal to WP-2; not part of CONTRACTS.md §5. */
export interface StderrTailSink extends StderrTail {
  write(chunk: Uint8Array): void;
}

const NEWLINE = 0x0a;
const CARRIAGE_RETURN = 0x0d;

/** True for a UTF-8 continuation byte (10xxxxxx) — never the start of a rune. */
function isContinuation(byte: number): boolean {
  return (byte & 0xc0) === 0x80;
}

/** How many bytes the rune led by `byte` occupies. 1 for an invalid lead, so scans terminate. */
function runeLength(byte: number): number {
  if (byte < 0x80) return 1;
  if ((byte & 0xe0) === 0xc0) return 2;
  if ((byte & 0xf0) === 0xe0) return 3;
  if ((byte & 0xf8) === 0xf0) return 4;
  return 1;
}

/** First index at or after `from` that begins a rune. */
function forwardToRuneStart(buf: Buffer, from: number): number {
  let i = from;
  while (i < buf.length && isContinuation(buf[i] ?? 0)) i += 1;
  return i;
}

/**
 * Length of the longest prefix of `buf` that contains no partially-arrived trailing rune.
 *
 * A pipe read can split a multi-byte rune across two `write()` calls; surfacing that suffix as
 * U+FFFD would put a permanent replacement character into a crash diagnostic, so it is hidden
 * until its remaining bytes arrive (multica `acp_terminal.go` `snapshot`).
 */
function withoutPartialTail(buf: Buffer): number {
  for (let i = buf.length - 1; i >= 0 && buf.length - i <= 4; i -= 1) {
    const byte = buf[i] ?? 0;
    if (isContinuation(byte)) continue;
    return runeLength(byte) > buf.length - i ? i : buf.length;
  }
  return buf.length;
}

const DECODER = new TextDecoder("utf-8");

/**
 * A fixed-size stderr ring whose truncation lands on a UTF-8 rune boundary, whose
 * `snapshot()` hides an incomplete trailing rune, and whose `finalize()` flushes a
 * newline-less last line — which is usually the crash reason (multica `acp_terminal.go`).
 *
 * The ring is a BYTE budget, not a character budget: `stderrTailBytes` bounds memory, and a
 * string slice would happily cut a surrogate pair in half.
 *
 * The line splitter carries its own bound. A tail ring caps what `snapshot()` holds, but the
 * pending line of an agent that writes a megabyte without a newline would otherwise grow without
 * limit next to it; past `maxBytes` the head of that line is kept and the rest dropped until the
 * newline arrives, so one pathological line costs at most one more ring.
 */
export function createStderrTail(o: { maxBytes: number }): StderrTailSink {
  const maxBytes = o.maxBytes;
  if (!Number.isInteger(maxBytes) || maxBytes <= 0) {
    throw new OmniError("bad_request", `stderrTailBytes must be a positive integer`, {
      detail: { maxBytes },
    });
  }

  let ring: Buffer = Buffer.alloc(0);
  let line: Buffer = Buffer.alloc(0);
  /** Set when the current line hit `maxBytes`: its tail is discarded, not buffered. */
  let lineTruncated = false;
  const listeners = new Set<(line: string) => void>();

  const emit = (bytes: Buffer): void => {
    // CRLF: the carriage return belongs to the framing, not to the line. Windows agents write it
    // and a listener comparing against a literal string should not have to know that.
    const end =
      bytes.length > 0 && bytes[bytes.length - 1] === CARRIAGE_RETURN
        ? bytes.length - 1
        : bytes.length;
    const text = DECODER.decode(bytes.subarray(0, end));
    for (const cb of [...listeners]) cb(text);
  };

  const pushLineBytes = (bytes: Buffer): void => {
    if (lineTruncated) return;
    const room = maxBytes - line.length;
    if (bytes.length <= room) {
      line = Buffer.concat([line, bytes]);
      return;
    }
    // Keep the head — a diagnostic's reason is at its start — trimmed to a rune boundary so the
    // emitted line never ends in half a character.
    const kept = Buffer.concat([line, bytes.subarray(0, room)]);
    line = kept.subarray(0, withoutPartialTail(kept));
    lineTruncated = true;
  };

  return {
    write(chunk: Uint8Array): void {
      const bytes = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);

      // ── the tail ring ────────────────────────────────────────────────────
      const grown = Buffer.concat([ring, bytes]);
      if (grown.length <= maxBytes) {
        ring = grown;
      } else {
        // Truncation is advanced FORWARD to the next rune start, so the ring never begins with
        // a dangling continuation byte (CONTRACTS.md §6.4, stderr row).
        ring = grown.subarray(forwardToRuneStart(grown, grown.length - maxBytes));
      }

      // ── the line splitter ────────────────────────────────────────────────
      let offset = 0;
      for (;;) {
        const nl = bytes.indexOf(NEWLINE, offset);
        if (nl === -1) break;
        pushLineBytes(bytes.subarray(offset, nl));
        emit(line);
        line = Buffer.alloc(0);
        lineTruncated = false;
        offset = nl + 1;
      }
      if (offset < bytes.length) pushLineBytes(bytes.subarray(offset));
    },

    snapshot(): string {
      return DECODER.decode(ring.subarray(0, withoutPartialTail(ring)));
    },

    onLine(cb: (line: string) => void): () => void {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },

    /**
     * Idempotent because it EMPTIES the pending line rather than latching a flag: calling it
     * twice cannot emit the same bytes twice, and a caller that finalizes on `exit` — before the
     * pipe has drained — does not lose the line that arrives afterwards. A latched flag makes
     * the second call a no-op, which is the same thing right up until the crash reason is the
     * part that arrived late.
     */
    finalize(): void {
      if (line.length === 0) return;
      const last = line;
      line = Buffer.alloc(0);
      lineTruncated = false;
      emit(last);
    },
  };
}
