import { describe, expect, it } from "vitest";
import { createStderrTail } from "../../src/process/stderr-tail.js";

/**
 * WP-2 acceptance 12 (CONTRACTS.md §6.4, stderr row; multica `acp_terminal.go`).
 *
 * The three properties, and why each one is not decoration:
 *
 *  - truncation lands on a UTF-8 rune boundary — a byte-bounded ring that starts mid-rune
 *    renders as a permanent U+FFFD at the head of every crash diagnostic;
 *  - `snapshot()` hides an incomplete TRAILING rune — a pipe read splits a rune across two
 *    `write()` calls routinely, and the missing bytes are usually milliseconds away;
 *  - `finalize()` flushes a newline-less last line — which is the crash reason, because a
 *    process that dies mid-write never gets to append the newline.
 */

const enc = new TextEncoder();
/** 3 bytes each: the boundary cases are all interior to a rune. */
const NOISE = "ノイズ";

describe("createStderrTail", () => {
  it("keeps the last maxBytes and nothing more", () => {
    const tail = createStderrTail({ maxBytes: 8 });
    tail.write(enc.encode("abcdefghij"));
    expect(tail.snapshot()).toBe("cdefghij");
  });

  it("advances truncation FORWARD to a rune boundary instead of splitting one", () => {
    const tail = createStderrTail({ maxBytes: 8 });
    // 3 runes x 3 bytes = 9 bytes; the 8-byte window starts one byte into the first rune.
    tail.write(enc.encode(NOISE));
    // Not "�イズ": the partial head rune is dropped, so what is left is valid UTF-8.
    expect(tail.snapshot()).toBe("イズ");
    expect(tail.snapshot()).not.toContain("�");
  });

  it("hides an incomplete trailing rune until its bytes arrive", () => {
    const tail = createStderrTail({ maxBytes: 64 });
    const bytes = enc.encode(`ok ${NOISE}`);
    tail.write(bytes.subarray(0, bytes.length - 1)); // one byte of the last rune missing
    expect(tail.snapshot()).toBe("ok ノイ");
    tail.write(bytes.subarray(bytes.length - 1));
    expect(tail.snapshot()).toBe(`ok ${NOISE}`);
  });

  it("is a BYTE budget: a surrogate pair is never cut in half", () => {
    const tail = createStderrTail({ maxBytes: 5 });
    tail.write(enc.encode("ab🙂c")); // 1 + 1 + 4 + 1 = 7 bytes
    // The window starts inside "b"…"🙂"; it lands on the emoji's lead byte, which is a rune
    // start, so the emoji survives whole and "b" is what falls out.
    expect(tail.snapshot()).toBe("🙂c");
    expect(Buffer.byteLength(tail.snapshot(), "utf8")).toBeLessThanOrEqual(5);
  });

  it("drops a rune it cannot hold rather than emitting half of one", () => {
    const tail = createStderrTail({ maxBytes: 3 });
    tail.write(enc.encode("ab🙂")); // the 4-byte emoji does not fit in a 3-byte ring
    // The window would start on the emoji's second byte; advancing to the next rune start walks
    // straight off the end, which is the honest answer: nothing complete is left.
    expect(tail.snapshot()).toBe("");
  });

  it("emits complete lines only, and strips the CR of a CRLF", () => {
    const tail = createStderrTail({ maxBytes: 1024 });
    const lines: string[] = [];
    tail.onLine((l) => lines.push(l));

    tail.write(enc.encode("first\r\nsec"));
    expect(lines).toEqual(["first"]);
    tail.write(enc.encode("ond\nthird"));
    expect(lines).toEqual(["first", "second"]);
  });

  it("finalize() flushes the newline-less last line — the crash reason", () => {
    const tail = createStderrTail({ maxBytes: 1024 });
    const lines: string[] = [];
    tail.onLine((l) => lines.push(l));

    tail.write(enc.encode("panic: index out of range"));
    expect(lines).toEqual([]);
    tail.finalize();
    expect(lines).toEqual(["panic: index out of range"]);
  });

  it("still flushes a line that arrives AFTER a first finalize()", () => {
    // `spawn.ts` finalizes on the child's `exit`, which can precede the pipe draining: the last
    // stderr bytes of a crash routinely land after the exit event. A latched flag would lose
    // exactly the line this ring exists to keep.
    const tail = createStderrTail({ maxBytes: 1024 });
    const lines: string[] = [];
    tail.onLine((l) => lines.push(l));

    tail.finalize();
    tail.write(enc.encode("Bun panic: out of memory"));
    tail.finalize();
    expect(lines).toEqual(["Bun panic: out of memory"]);
  });

  it("finalize() is idempotent and emits nothing when the last line was terminated", () => {
    const tail = createStderrTail({ maxBytes: 1024 });
    const lines: string[] = [];
    tail.onLine((l) => lines.push(l));

    tail.write(enc.encode("done\n"));
    tail.finalize();
    tail.finalize();
    expect(lines).toEqual(["done"]);
  });

  it("unsubscribes", () => {
    const tail = createStderrTail({ maxBytes: 1024 });
    const lines: string[] = [];
    const off = tail.onLine((l) => lines.push(l));
    tail.write(enc.encode("one\n"));
    off();
    tail.write(enc.encode("two\n"));
    expect(lines).toEqual(["one"]);
  });

  it("bounds the pending line as well as the ring: one endless line cannot grow the heap", () => {
    const tail = createStderrTail({ maxBytes: 16 });
    const lines: string[] = [];
    tail.onLine((l) => lines.push(l));

    for (let i = 0; i < 1000; i += 1) tail.write(enc.encode("0123456789"));
    tail.write(enc.encode("\n"));
    // The head of the line survives — a diagnostic's reason is at its start — and nothing else.
    expect(lines).toEqual(["0123456789012345"]);
    expect(lines[0]?.length).toBeLessThanOrEqual(16);
  });

  it("survives a multibyte flood without ever surfacing a replacement character", () => {
    const tail = createStderrTail({ maxBytes: 97 }); // deliberately not a multiple of 3
    for (let i = 0; i < 500; i += 1) tail.write(enc.encode(`${NOISE.repeat(7)}\n`));
    const snapshot = tail.snapshot();
    expect(snapshot).not.toContain("�");
    expect(Buffer.byteLength(snapshot, "utf8")).toBeLessThanOrEqual(97);
  });

  it("refuses a nonsensical budget", () => {
    expect(() => createStderrTail({ maxBytes: 0 })).toThrow();
    expect(() => createStderrTail({ maxBytes: -8 })).toThrow();
  });
});
