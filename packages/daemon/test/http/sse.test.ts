import { describe, expect, it } from "vitest";
import {
  SSE_CONTROL,
  type DaemonId,
  type EventEnvelope,
  type EventInput,
  type EventListener,
  type EventLog,
  type Seq,
  type Subscription,
  type TurnId,
  type WorkerId,
} from "@omni-acp/protocol";
import { collectSse, fakeClock, parseSse } from "@omni-acp/testkit";
import { sseResponse } from "../../src/http/sse.js";
import { someWorkerId, testEventLog } from "../fake-core.js";

const WID: WorkerId = someWorkerId(1);
const DID = `d_${"0".repeat(25)}1` as DaemonId;
const TURN = `t_${"0".repeat(25)}1` as TurnId;

const chunk = (text: string): EventInput => ({
  kind: "acp.session_update",
  payloadVersion: 1,
  turnId: TURN,
  payload: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } } as never,
});

const closedState: EventInput = {
  kind: "omni.worker_state",
  payloadVersion: 2,
  turnId: null,
  payload: { state: "closed", previous: "ready", reason: "client_request", treeGone: true },
};

function log(maxEvents = 100): EventLog {
  return testEventLog({
    workerId: WID,
    daemonId: DID,
    clock: fakeClock(),
    maxEvents,
    subscriberQueueSize: 1_024,
  });
}

/**
 * Reads `chunks` writes and hands back a `cancel` the caller decides when to use — a live SSE
 * body never ends on its own, and cancelling it is itself one of the things under test.
 */
async function read(
  res: Response,
  chunks = 1,
): Promise<{ text: string; cancel: () => Promise<void> }> {
  const reader = res.body?.getReader();
  if (reader === undefined) throw new Error("no body");
  const decoder = new TextDecoder();
  let text = "";
  for (let i = 0; i < chunks; i++) {
    const { value, done } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  return {
    text,
    cancel: async () => {
      await reader.cancel();
    },
  };
}

/** Reads `chunks` writes and lets the body go. */
async function drain(res: Response, opts?: { chunks?: number }): Promise<string> {
  const { text, cancel } = await read(res, opts?.chunks ?? 1);
  await cancel();
  return text;
}

/** Reads to the end of the stream. Only safe when the writer is going to close it. */
async function drainAll(res: Response): Promise<string> {
  const reader = res.body?.getReader();
  if (reader === undefined) throw new Error("no body");
  const decoder = new TextDecoder();
  let text = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  return text;
}

const open = (l: EventLog, over?: Partial<Parameters<typeof sseResponse>[1]>): Response =>
  sseResponse(l, {
    since: 0,
    heartbeatMs: 15_000,
    queueSize: 1_024,
    signal: new AbortController().signal,
    ...over,
  });

describe("SSE frames (§8.4)", () => {
  it("writes retry: 2000 once, then id/event/data for each envelope", async () => {
    const l = log();
    const first = l.append(chunk("hello"));
    const res = open(l);
    const text = await drain(res, { chunks: 2 });

    expect(text.startsWith("retry: 2000\n\n")).toBe(true);
    expect(text).toContain(`id: ${first.seq}\nevent: acp.session_update\ndata: `);
    expect(text.endsWith("\n\n")).toBe(true);

    const frames = parseSse(text);
    expect(frames).toHaveLength(1);
    expect(frames[0]?.id).toBe("1");
    expect(frames[0]?.event).toBe("acp.session_update");
    // `data` alone is the whole envelope: one parse, one type.
    expect(JSON.parse(frames[0]?.data ?? "{}")).toEqual(first);
  });

  it("sends the FULL retained replay when ?since= is absent, then goes live", async () => {
    const l = log();
    l.appendAll([chunk("a"), chunk("b")]);
    const res = open(l);
    const collected = collectSse(res, { count: 3, timeoutMs: 2_000 });
    l.append(chunk("c"));
    const { envelopes } = await collected;
    expect(envelopes.map((e) => e.seq)).toEqual([1, 2, 3]);
  });

  it("treats ?since=N as an EXCLUSIVE lower bound", async () => {
    const l = log();
    l.appendAll([chunk("a"), chunk("b"), chunk("c")]);
    const { envelopes } = await collectSse(open(l, { since: 2 }), { count: 1, timeoutMs: 2_000 });
    expect(envelopes.map((e) => e.seq)).toEqual([3]);
  });

  it("accepts a cursor beyond head: no replay, live only — skew is not an error", async () => {
    const l = log();
    l.append(chunk("a"));
    const res = open(l, { since: 99 });
    const collected = collectSse(res, { count: 1, timeoutMs: 2_000 });
    l.append(chunk("live"));
    const { envelopes } = await collected;
    expect(envelopes.map((e) => e.seq)).toEqual([2]);
  });

  it("no event can slip between the replay and the live tail", async () => {
    const l = log();
    for (let i = 0; i < 20; i++) l.append(chunk(`m${i}`));
    const res = open(l, { since: 5 });
    // Appended in the same tick the response was created in.
    for (let i = 0; i < 5; i++) l.append(chunk(`live${i}`));
    const { envelopes } = await collectSse(res, { count: 20, timeoutMs: 2_000 });
    expect(envelopes.map((e) => e.seq)).toEqual(
      Array.from({ length: 20 }, (_, i) => i + 6), // 6..25, gap-free across the handover
    );
  });
});

describe("SSE control frames are OUT OF BAND (D24)", () => {
  it("writes omni.stream_truncated when since < tail and keeps the stream OPEN", async () => {
    const l = log(3); // a ring that evicts
    for (let i = 0; i < 6; i++) l.append(chunk(`m${i}`));
    expect(l.tail).toBe(4);

    const res = open(l, { since: 0 });
    const collected = collectSse(res, { count: 4, timeoutMs: 2_000 });
    l.append(chunk("still-live"));
    const { envelopes, control } = await collected;

    expect(control[0]).toEqual({ event: SSE_CONTROL.truncated, data: { tail: 4 } });
    // Truncated history beats none, and the client is TOLD rather than silently short-changed.
    expect(envelopes.map((e) => e.seq)).toEqual([4, 5, 6, 7]);
  });

  it("does NOT cry truncation on a fresh log — since=0 with tail=1 has lost nothing", async () => {
    const l = log();
    l.append(chunk("a"));
    const { control } = await collectSse(open(l), { count: 1, timeoutMs: 2_000 });
    expect(control).toEqual([]);
  });

  it("writes omni.stream_end after the closed envelope, then closes", async () => {
    const l = log();
    l.append(chunk("a"));
    const res = open(l);
    const collected = collectSse(res, { timeoutMs: 2_000 });
    l.append(closedState);
    const { envelopes, control } = await collected;

    expect(envelopes.map((e) => e.kind)).toEqual(["acp.session_update", "omni.worker_state"]);
    expect(control).toEqual([
      { event: SSE_CONTROL.end, data: { reason: "worker_closed", lastSeq: 2 } },
    ]);
    expect(l.subscriberCount).toBe(0);
  });

  it("ends a stream opened on an ALREADY closed worker, without leaking the subscription", async () => {
    const l = log();
    l.appendAll([chunk("a"), closedState]);
    const res = open(l);
    const text = await drainAll(res);
    expect(text).toContain(`event: ${SSE_CONTROL.end}`);
    expect(l.subscriberCount).toBe(0);
  });

  it("writes omni.stream_overflow with the last delivered seq, then closes", async () => {
    // The overflow path belongs to the log's subscriber queue, so the trigger is injected here
    // rather than simulated by a slow reader that would make the suite timing-dependent.
    let overflow: ((lastDelivered: Seq) => void) | undefined;
    const stub: EventLog = {
      ...log(),
      subscribe: (_since: Seq, _listener: EventListener, opts): Subscription => {
        overflow = opts?.onOverflow;
        return {
          close: () => {},
          get closed() {
            return false;
          },
        };
      },
    };
    const res = sseResponse(stub, {
      since: 0,
      heartbeatMs: 15_000,
      queueSize: 4,
      signal: new AbortController().signal,
    });
    const collected = collectSse(res, { timeoutMs: 2_000 });
    overflow?.(41);
    const { control } = await collected;
    expect(control).toContainEqual({ event: SSE_CONTROL.overflow, data: { lastSeq: 41 } });
  });

  it("gives control frames no id:, so they consume no seq and are not envelopes", async () => {
    const l = log(2);
    for (let i = 0; i < 5; i++) l.append(chunk(`m${i}`));
    const res = open(l, { since: 0 });
    l.append(closedState);
    const text = await drainAll(res);
    for (const frame of parseSse(text)) {
      const isControl = Object.values(SSE_CONTROL).includes(frame.event as never);
      if (isControl) expect(frame.id).toBeUndefined();
      else expect(frame.id).toBeDefined();
    }
  });
});

describe("SSE lifetime", () => {
  it("closes the subscription when the client aborts — subscriberCount returns to 0", async () => {
    const l = log();
    l.append(chunk("a"));
    const controller = new AbortController();
    const res = open(l, { signal: controller.signal });
    await read(res, 2); // read, but do NOT let go: the abort is what must close it
    expect(l.subscriberCount).toBe(1);

    controller.abort();
    expect(l.subscriberCount).toBe(0);
    // …and the producer carries on unharmed.
    expect(() => l.append(chunk("after"))).not.toThrow();
  });

  it("closes the subscription when the reader simply walks away", async () => {
    const l = log();
    l.append(chunk("a"));
    const res = open(l);
    await drain(res); // `drain` cancels the reader on its way out
    expect(l.subscriberCount).toBe(0);
  });

  it("subscribes to nothing at all when the signal is already aborted", async () => {
    const l = log();
    l.append(chunk("a"));
    const controller = new AbortController();
    controller.abort();
    const res = open(l, { signal: controller.signal });
    expect(await drainAll(res)).toBe("");
    expect(l.subscriberCount).toBe(0);
  });

  it("leaks nothing across 20 reconnects — the classic SSE memory leak", async () => {
    const l = log();
    l.append(chunk("a"));
    for (let i = 0; i < 20; i++) {
      const controller = new AbortController();
      const res = open(l, { signal: controller.signal, since: i });
      await drain(res);
      controller.abort();
    }
    expect(l.subscriberCount).toBe(0);
  });

  it("beats a heartbeat that carries no id and consumes no seq", async () => {
    const l = log();
    l.append(chunk("a"));
    const res = open(l, { heartbeatMs: 5 });
    // Three reads past the preamble and the replay: nothing but the interval can produce them,
    // and two of them prove a cadence rather than a single opening beat.
    const text = await drain(res, { chunks: 4 });
    expect(text.match(/: hb\n\n/g)?.length).toBeGreaterThanOrEqual(2);
    expect(l.head).toBe(1); // the heartbeat consumed no seq
    // A comment-only block is not a frame to any spec-shaped parser.
    expect(parseSse(text).filter((f) => f.data !== "")).toHaveLength(1);
  });

  it("serves N concurrent subscribers with different cursors identical envelopes (D5)", async () => {
    const l = log();
    l.appendAll([chunk("a"), chunk("b"), chunk("c")]);
    const streams = [0, 1, 2].map((since) => open(l, { since }));
    expect(l.subscriberCount).toBe(3);

    const collected = streams.map((res, i) => collectSse(res, { count: 4 - i, timeoutMs: 2_000 }));
    l.append(chunk("d"));
    const results = await Promise.all(collected);

    // Same envelopes over the overlapping range — the first thing omni-acp adds over AcpServer,
    // which 409s the second reader.
    expect(results[0]?.envelopes.slice(-1)).toEqual(results[2]?.envelopes.slice(-1));
    expect(results[0]?.envelopes.map((e) => e.seq)).toEqual([1, 2, 3, 4]);
    expect(results[2]?.envelopes.map((e) => e.seq)).toEqual([3, 4]);
  });

  it("sets the headers a proxy must not buffer through", () => {
    const res = open(log());
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream; charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("no-cache, no-transform");
    expect(res.headers.get("x-accel-buffering")).toBe("no");
    void res.body?.cancel();
  });

  it("delivers the SAME envelope object a reader would get from log.read (frozen, §8.2)", async () => {
    const l = log();
    const appended: EventEnvelope = l.append(chunk("a"));
    const { envelopes } = await collectSse(open(l), { count: 1, timeoutMs: 2_000 });
    expect(envelopes[0]).toEqual(appended);
    expect(Object.isFrozen(appended)).toBe(true);
  });
});
