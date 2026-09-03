import { OmniError } from "@omni-acp/protocol";
import { describe, expect, it } from "vitest";
import { createFrameLimit } from "../../src/process/frame-limit.js";

/**
 * WP-2 acceptance 11 — the unit half. The real-agent half (`noisy.mjs` over real pipes) is in
 * `spawn-real.test.ts`.
 *
 * The bound has to hold on the READER's heap, not just produce an error eventually: an agent that
 * never writes a newline is unbounded growth inside `ndJsonStream`'s line buffer, and passing the
 * offending chunk through before complaining would let that buffer sail past the limit
 * (CONTRACTS.md §11.3).
 */

const enc = new TextEncoder();

async function pump(
  limit: number,
  chunks: readonly Uint8Array[],
): Promise<{ received: Uint8Array[]; error: unknown }> {
  const transform = createFrameLimit(limit);
  const writer = transform.writable.getWriter();
  const received: Uint8Array[] = [];
  let error: unknown = null;

  const reading = (async () => {
    const reader = transform.readable.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value !== undefined) received.push(value);
      }
    } catch (e) {
      error = e;
    }
  })();

  try {
    for (const chunk of chunks) await writer.write(chunk);
    await writer.close();
  } catch (e) {
    error ??= e;
  }
  await reading;
  return { received, error };
}

function bytesOf(chunks: readonly Uint8Array[]): number {
  return chunks.reduce((n, c) => n + c.length, 0);
}

describe("createFrameLimit", () => {
  it("passes ordinary ndjson through unchanged", async () => {
    const { received, error } = await pump(64, [enc.encode('{"a":1}\n{"b":2}\n')]);
    expect(error).toBeNull();
    expect(new TextDecoder().decode(Buffer.concat(received.map((c) => Buffer.from(c))))).toBe(
      '{"a":1}\n{"b":2}\n',
    );
  });

  it("accepts a frame of exactly maxFrameBytes and rejects one byte more", async () => {
    const exact = await pump(8, [enc.encode(`${"x".repeat(8)}\n`)]);
    expect(exact.error).toBeNull();

    const over = await pump(8, [enc.encode(`${"x".repeat(9)}\n`)]);
    expect(OmniError.is(over.error, "agent_error")).toBe(true);
    expect((over.error as OmniError).message).toContain("maxFrameBytes");
  });

  it("counts a frame ACROSS chunk boundaries — the way a real pipe delivers one", async () => {
    // Every chunk is comfortably under the limit; only their sum is not.
    const chunk = enc.encode("y".repeat(100));
    const { error, received } = await pump(250, [chunk, chunk, chunk]);
    expect(OmniError.is(error, "agent_error")).toBe(true);
    // The offending chunk was never forwarded, so the reader never held more than the bound.
    expect(bytesOf(received)).toBeLessThanOrEqual(250);
  });

  it("resets the count at every newline, so a long stream of small frames is fine", async () => {
    const line = enc.encode(`${"z".repeat(90)}\n`);
    const { error } = await pump(
      100,
      Array.from({ length: 200 }, () => line),
    );
    expect(error).toBeNull();
  });

  it("bounds what reaches the reader: an agent that never writes a newline", async () => {
    const limit = 4_096;
    const chunk = enc.encode("n".repeat(1_024));
    // 64 KiB offered, never a newline: without the limiter this is the unbounded-heap case.
    const { error, received } = await pump(
      limit,
      Array.from({ length: 64 }, () => chunk),
    );
    expect(OmniError.is(error, "agent_error")).toBe(true);
    expect(bytesOf(received)).toBeLessThanOrEqual(limit);
  });

  it("measured heap does not grow past the bound when 64 MiB is offered", async () => {
    // The unbounded-heap case, at scale: 1024 chunks of 64 KiB with no newline anywhere. The
    // limiter errors at 4 KiB, the writer's next write rejects, and nothing else is ever
    // allocated — so the delta here is test-harness noise rather than a megabyte of agent output.
    const before = process.memoryUsage().heapUsed;
    const chunk = new Uint8Array(64 * 1024).fill(0x6e);
    const { error, received } = await pump(
      4_096,
      Array.from({ length: 1_024 }, () => chunk),
    );
    const grew = process.memoryUsage().heapUsed - before;

    expect(OmniError.is(error, "agent_error")).toBe(true);
    expect(bytesOf(received)).toBeLessThanOrEqual(4_096);
    // 64 MiB was offered. A limiter that merely complained afterwards would have to have kept
    // most of it; a bound of a few MiB is generous for the noise and still an order of magnitude
    // under "it buffered the stream".
    expect(grew).toBeLessThan(8 * 1024 * 1024);
  });

  it("errors on the trailing partial frame too, not only on a completed one", async () => {
    const { error } = await pump(4, [enc.encode("ab\ncdefgh")]);
    expect(OmniError.is(error, "agent_error")).toBe(true);
  });

  it("refuses a nonsensical limit rather than erroring every stream", () => {
    expect(() => createFrameLimit(0)).toThrow(OmniError);
    expect(() => createFrameLimit(-1)).toThrow(OmniError);
    expect(() => createFrameLimit(1.5)).toThrow(OmniError);
  });

  it("carries the limit and the overrun in `detail`, which is logged and never sent", async () => {
    const { error } = await pump(4, [enc.encode("abcdefghij\n")]);
    expect((error as OmniError).detail).toMatchObject({ maxFrameBytes: 4 });
    expect((error as OmniError).toBody()).toEqual({
      code: "agent_error",
      message: expect.stringContaining("maxFrameBytes") as unknown as string,
    });
  });
});
