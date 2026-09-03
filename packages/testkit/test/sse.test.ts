import { describe, expect, it } from "vitest";
import { OmniError, SSE_CONTROL, type EventEnvelope } from "@omni-acp/protocol";
import { collectSse, parseSse } from "@omni-acp/testkit";

const envelope = (seq: number, kind = "omni.error"): Record<string, unknown> => ({
  seq,
  ts: `2026-09-03T12:00:00.${String(seq).padStart(3, "0")}Z`,
  daemonId: `d_${"0".repeat(26)}`,
  workerId: `w_${"0".repeat(26)}`,
  sessionId: null,
  turnId: null,
  payloadVersion: 2,
  kind,
  payload: { code: "internal", message: `m${seq}` },
});

const frame = (e: Record<string, unknown>): string =>
  `id: ${e["seq"] as number}\nevent: ${e["kind"] as string}\ndata: ${JSON.stringify(e)}\n\n`;

function sse(body: string): Response {
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

describe("parseSse", () => {
  it("reads id / event / data and strips one leading space", () => {
    expect(parseSse('id: 7\nevent: omni.error\ndata: {"a":1}\n\n')).toEqual([
      { id: "7", event: "omni.error", data: '{"a":1}' },
    ]);
    expect(parseSse("data:no-space\n\n")).toEqual([{ data: "no-space" }]);
  });

  it("joins multiple data lines with a newline", () => {
    expect(parseSse("data: one\ndata: two\n\n")).toEqual([{ data: "one\ntwo" }]);
  });

  it("ignores comment frames, so a heartbeat is not an event", () => {
    expect(parseSse(": hb\n\n")).toEqual([]);
    expect(parseSse("retry: 2000\n\n: hb\n\ndata: x\n\n")).toEqual([{ data: "x" }]);
  });

  it("accepts CRLF and lone-CR separators", () => {
    expect(parseSse("id: 1\r\ndata: x\r\n\r\n")).toEqual([{ id: "1", data: "x" }]);
  });

  it("returns nothing for empty or whitespace-only input", () => {
    expect(parseSse("")).toEqual([]);
    expect(parseSse("\n\n\n\n")).toEqual([]);
  });
});

describe("collectSse", () => {
  it("collects `count` envelopes and stops", async () => {
    const body = `retry: 2000\n\n${frame(envelope(1))}: hb\n\n${frame(envelope(2))}${frame(envelope(3))}`;
    const { envelopes, control } = await collectSse(sse(body), { count: 2 });
    expect(envelopes.map((e) => e.seq)).toEqual([1, 2]);
    expect(control).toEqual([]);
  });

  it("stops on `until`", async () => {
    const body = [1, 2, 3, 4].map((n) => frame(envelope(n))).join("");
    const { envelopes } = await collectSse(sse(body), {
      until: (e: EventEnvelope) => e.seq === 3,
    });
    expect(envelopes.map((e) => e.seq)).toEqual([1, 2, 3]);
  });

  it("separates out-of-band control frames from envelopes, and ends on stream_end", async () => {
    const body =
      `event: ${SSE_CONTROL.truncated}\ndata: {"tail":5}\n\n` +
      frame(envelope(5)) +
      `event: ${SSE_CONTROL.end}\ndata: {"reason":"worker_closed","lastSeq":5}\n\n` +
      frame(envelope(6));
    const { envelopes, control } = await collectSse(sse(body), { count: 99 });
    expect(envelopes.map((e) => e.seq)).toEqual([5]);
    expect(control).toEqual([
      { event: SSE_CONTROL.truncated, data: { tail: 5 } },
      { event: SSE_CONTROL.end, data: { reason: "worker_closed", lastSeq: 5 } },
    ]);
  });

  it("returns what arrived when the stream ends first", async () => {
    const { envelopes } = await collectSse(sse(frame(envelope(1))), { count: 10, timeoutMs: 200 });
    expect(envelopes.map((e) => e.seq)).toEqual([1]);
  });

  it("throws on timeout rather than quietly returning a short result", async () => {
    const never = new ReadableStream<Uint8Array>({ start() {} });
    await expect(
      collectSse(new Response(never), { count: 1, timeoutMs: 30 }),
    ).rejects.toBeInstanceOf(OmniError);
  });

  it("validates each envelope, so a malformed frame fails loudly", async () => {
    const bad = { ...envelope(1), seq: 0 };
    await expect(collectSse(sse(frame(bad)), { count: 1 })).rejects.toThrow();
  });

  it("handles a frame split across chunk boundaries", async () => {
    const text = frame(envelope(1)) + frame(envelope(2));
    const cut = Math.floor(text.length / 2);
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(text.slice(0, cut)));
        controller.enqueue(encoder.encode(text.slice(cut)));
        controller.close();
      },
    });
    const { envelopes } = await collectSse(new Response(stream), { count: 2 });
    expect(envelopes.map((e) => e.seq)).toEqual([1, 2]);
  });
});
