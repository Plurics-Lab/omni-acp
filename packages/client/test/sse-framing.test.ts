import { OmniACP, type EventEnvelope } from "@omni-acp/client";
import { describe, expect, it } from "vitest";

/**
 * The SSE parser's edge cases, driven through the only door the frozen barrel leaves open:
 * a hand-written event stream behind an injected `fetch`.
 *
 * Each case here is a frame a real daemon (or a proxy between it and us) actually produces, and
 * each one is a way an SSE reader silently loses events rather than failing loudly.
 */

const DAEMON = "d_01J00000000000000000000000";
const WORKER = "w_01J00000000000000000000000";

function envelope(seq: number, text: string): EventEnvelope {
  return {
    seq,
    ts: new Date(seq).toISOString(),
    daemonId: DAEMON,
    workerId: WORKER,
    sessionId: "s1",
    turnId: null,
    payloadVersion: 1,
    kind: "acp.session_update",
    payload: {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text },
    },
  } as EventEnvelope;
}

function frame(e: EventEnvelope): string {
  return `id: ${String(e.seq)}\nevent: ${e.kind}\ndata: ${JSON.stringify(e)}\n\n`;
}

/** A daemon whose only interesting route is `events`, whose body the test writes by hand. */
function daemonServing(chunks: readonly string[], delayMs = 0): typeof globalThis.fetch {
  return (input, init) => {
    const request =
      input instanceof Request && init === undefined ? input : new Request(input, init);
    if (request.url.includes("/v1/whoami")) {
      return Promise.resolve(
        new Response(JSON.stringify({ tokenId: "t", daemonId: DAEMON }), { status: 200 }),
      );
    }
    if (request.url.includes(`/v1/workers/${WORKER}/events`)) {
      const encoder = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          for (const chunk of chunks) {
            if (delayMs > 0) await new Promise<void>((r) => setTimeout(r, delayMs));
            controller.enqueue(encoder.encode(chunk));
          }
          controller.close();
        },
      });
      return Promise.resolve(
        new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } }),
      );
    }
    // The worker snapshot `attach()` needs.
    return Promise.resolve(
      new Response(
        JSON.stringify({
          workerId: WORKER,
          daemonId: DAEMON,
          ref: `${DAEMON}:${WORKER}`,
          sessionId: "s1",
          agentId: "example",
          state: "ready",
          cwd: "/tmp",
          label: null,
          ownerTokenId: "t",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
          headSeq: 0,
          currentTurnId: null,
          capabilities: null,
          process: null,
          closeReason: null,
        }),
        { status: 200 },
      ),
    );
  };
}

/**
 * Reads exactly `count` envelopes and stops.
 *
 * The bound is the point, not a convenience: this worker never closes, so `events()` is an
 * infinite tail by contract. A test that drained it to completion would be asserting that the
 * SDK gives up, which is a different test (and it is the last one in this file).
 */
async function read(chunks: readonly string[], count: number): Promise<EventEnvelope[]> {
  const server = await OmniACP.connect({
    url: "http://sse.invalid",
    token: "t",
    fetch: daemonServing(chunks),
  });
  const worker = await server.attach(WORKER);
  const out: EventEnvelope[] = [];
  for await (const e of worker.events({ since: 0 })) {
    out.push(e);
    if (out.length >= count) break;
  }
  return out;
}

describe("SSE framing", () => {
  it("ignores the retry preamble and comment heartbeats, which consume no seq", async () => {
    const seen = await read(
      ["retry: 2000\n\n", ": hb\n\n", frame(envelope(1, "a")), ": hb\n\n", frame(envelope(2, "b"))],
      2,
    );
    expect(seen.map((e) => e.seq)).toEqual([1, 2]);
  });

  it("reassembles a frame split across chunk boundaries, including a split CRLF", async () => {
    // A `\r\n` cut in half by a chunk boundary is the classic proxy-induced hang: the frame
    // terminator never matches and the reader waits forever for an event it already has.
    const text = frame(envelope(1, "split")).replace(/\n/g, "\r\n");
    const cut = text.length - 3;
    const seen = await read([text.slice(0, cut), text.slice(cut)], 1);
    expect(seen.map((e) => e.seq)).toEqual([1]);
  });

  it("joins multiple data: lines with a newline, as the SSE grammar requires", async () => {
    // A daemon behind a line-length-limiting proxy emits one logical payload as several `data:`
    // lines. Joining them with anything but "\n" — or not joining them at all — loses the event.
    const e = envelope(1, "multi");
    const json = JSON.stringify(e);
    const cut = json.indexOf(",") + 1; // a token boundary, so the rejoined text is valid JSON
    const body = `id: 1\nevent: ${e.kind}\ndata: ${json.slice(0, cut)}\ndata: ${json.slice(cut)}\n\n`;

    const seen = await read([body], 1);

    expect(seen.map((x) => x.seq)).toEqual([1]);
  });

  it("strips exactly one leading space from a field value", async () => {
    const e = envelope(1, "space");
    const withSpace = `id: 1\nevent: ${e.kind}\ndata: ${JSON.stringify(e)}\n\n`;
    const withoutSpace = `id:2\nevent:${e.kind}\ndata:${JSON.stringify({ ...e, seq: 2 })}\n\n`;
    const seen = await read([withSpace, withoutSpace], 2);
    expect(seen.map((x) => x.seq)).toEqual([1, 2]);
  });

  it("rejects a frame that is not a valid EventEnvelope instead of folding garbage", async () => {
    // The envelope is OURS, so it is validated field by field: a `seq` that is not a positive
    // integer is not something a client should reduce over (events.ts, the parse schema).
    const bad = `id: 1\nevent: acp.session_update\ndata: ${JSON.stringify({
      ...envelope(1, "x"),
      seq: -1,
    })}\n\n`;

    const server = await OmniACP.connect({
      url: "http://sse.invalid",
      token: "t",
      fetch: daemonServing([bad]),
    });
    const worker = await server.attach(WORKER);
    const errors: unknown[] = [];
    worker.on("error", (e) => errors.push(e));

    const out: EventEnvelope[] = [];
    // It fails IMMEDIATELY rather than reconnecting: replaying the same cursor against a daemon
    // that speaks a shape we do not understand produces the same frame forever, and a reader
    // that retried it would spin in silence.
    const started = Date.now();
    await expect(
      (async () => {
        for await (const e of worker.events({ since: 0 })) out.push(e);
      })(),
    ).rejects.toMatchObject({ name: "OmniError" });
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(out).toEqual([]);
    expect(errors).toEqual([]);
  });
});
